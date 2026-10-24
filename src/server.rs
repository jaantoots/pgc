//! HTTP + WebSocket server. Only listens on localhost; every request must
//! carry the access token (cookie, header or one-time query parameter), and
//! the Host/Origin headers are checked to defeat DNS rebinding and CSRF.

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{delete, get};
use rust_embed::RustEmbed;
use serde::Deserialize;
use serde_json::json;
use tokio::sync::broadcast::error::RecvError;

use crate::conninfo;
use crate::session::{App, Cmd};
use crate::store::{ResultData, Settings};

#[derive(RustEmbed)]
#[folder = "web/dist"]
struct Assets;

#[derive(Clone)]
pub struct Ctx {
    pub app: Arc<App>,
    pub token: Arc<String>,
}

pub fn router(ctx: Ctx) -> Router {
    Router::new()
        .route("/api/ping", get(|| async { Json(json!({"pgc": env!("CARGO_PKG_VERSION")})) }))
        .route("/api/defaults", get(defaults))
        .route("/api/sessions", get(list_sessions).post(create_session))
        .route("/api/sessions/{id}", get(get_session).patch(rename_session).delete(delete_session))
        .route("/api/entries/{id}", delete(hide_entry))
        .route("/api/results/{id}/rows", get(result_rows))
        .route("/api/results/{id}/export", get(export_result))
        .route("/api/history", get(history))
        .route("/api/services", get(services))
        .route("/ws/{id}", get(ws_handler))
        .fallback(static_handler)
        .layer(middleware::from_fn_with_state(ctx.clone(), auth))
        .with_state(ctx)
}

fn is_local_host(host: &str) -> bool {
    let h = if let Some(r) = host.strip_prefix('[') {
        r.split(']').next().unwrap_or("")
    } else {
        host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host)
    };
    matches!(h, "localhost" | "127.0.0.1" | "::1")
}

fn cookie_token(headers: &HeaderMap) -> Option<String> {
    headers.get_all(header::COOKIE).iter().filter_map(|v| v.to_str().ok()).flat_map(|v| v.split(';')).find_map(|kv| {
        let (k, v) = kv.trim().split_once('=')?;
        (k == "pgc_token").then(|| v.to_string())
    })
}

/// Constant-time comparison.
fn token_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn auth(State(ctx): State<Ctx>, req: Request, next: Next) -> Response {
    let headers = req.headers();
    let host = headers.get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("");
    if !is_local_host(host) {
        return (StatusCode::FORBIDDEN, "pgc only accepts requests for localhost").into_response();
    }
    if let Some(origin) = headers.get(header::ORIGIN).and_then(|h| h.to_str().ok()) {
        let o = origin.strip_prefix("http://").unwrap_or("");
        if o != host {
            return (StatusCode::FORBIDDEN, "cross-origin request refused").into_response();
        }
    }
    let token = ctx.token.as_str();
    let ok = cookie_token(headers).is_some_and(|t| token_eq(&t, token))
        || headers.get("x-pgc-token").and_then(|h| h.to_str().ok()).is_some_and(|t| token_eq(t, token));
    if ok {
        return next.run(req).await;
    }
    // One-time token in the URL: set the cookie and redirect to a clean URL.
    if let Some(q) = req.uri().query()
        && let Some(t) = q.split('&').find_map(|kv| kv.strip_prefix("token="))
        && token_eq(t, token)
    {
        let path = req.uri().path().to_string();
        let cookie = format!("pgc_token={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000");
        return Response::builder()
            .status(StatusCode::SEE_OTHER)
            .header(header::LOCATION, path)
            .header(header::SET_COOKIE, cookie)
            .body(Body::empty())
            .unwrap();
    }
    let body = "<!doctype html><meta charset=utf-8><title>pgc</title><body style=\"font:14px system-ui;padding:2em\">\
        <h3>pgc: not authorized</h3><p>Open the URL printed by <code>pgc</code> in your terminal \
        (it includes a one-time token), or run <code>pgc</code> again.</p>";
    (StatusCode::UNAUTHORIZED, [(header::CONTENT_TYPE, "text/html; charset=utf-8")], body).into_response()
}

async fn static_handler(req: Request) -> Response {
    let path = req.uri().path().trim_start_matches('/');
    let file = if path.is_empty() || path.starts_with("s/") || !path.contains('.') { "index.html" } else { path };
    match Assets::get(file) {
        Some(f) => {
            let mime = f.metadata.mimetype().to_string();
            let cache = if file.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
            ([(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, cache.to_string())], f.data).into_response()
        }
        None if file == "index.html" => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/html")],
            "<p>pgc was built without the web UI. Run <code>npm run build</code> in <code>web/</code> and rebuild.</p>",
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

type ApiResult<T> = Result<T, (StatusCode, String)>;

fn internal(e: impl std::fmt::Display) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

async fn defaults(State(ctx): State<Ctx>) -> Json<serde_json::Value> {
    Json(json!({"conninfo": *ctx.app.default_conninfo.lock().unwrap()}))
}

async fn list_sessions(State(ctx): State<Ctx>) -> ApiResult<Json<serde_json::Value>> {
    let rows = ctx.app.store.list_sessions(500).map_err(internal)?;
    let active: Vec<String> = ctx.app.sessions.lock().unwrap().keys().cloned().collect();
    let rows: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|r| {
            let mut v = serde_json::to_value(&r).unwrap();
            let viewers = ctx.app.sessions.lock().unwrap().get(&r.id).map(|h| h.events.receiver_count()).unwrap_or(0);
            v["active"] = json!(active.contains(&r.id));
            v["viewers"] = json!(viewers);
            v
        })
        .collect();
    Ok(Json(json!(rows)))
}

#[derive(Deserialize)]
struct NewSession {
    conninfo: Option<String>,
    password: Option<String>,
}

async fn create_session(State(ctx): State<Ctx>, Json(body): Json<NewSession>) -> ApiResult<Json<serde_json::Value>> {
    let id = ctx.app.create_session(body.conninfo, body.password).map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(Json(json!({"id": id})))
}

async fn get_session(State(ctx): State<Ctx>, Path(id): Path<String>) -> ApiResult<Json<serde_json::Value>> {
    match ctx.app.store.get_session(&id).map_err(internal)? {
        Some(s) => Ok(Json(serde_json::to_value(s).unwrap())),
        None => Err((StatusCode::NOT_FOUND, "no such session".into())),
    }
}

#[derive(Deserialize)]
struct Rename {
    name: Option<String>,
}

async fn rename_session(State(ctx): State<Ctx>, Path(id): Path<String>, Json(body): Json<Rename>) -> ApiResult<StatusCode> {
    let name = body.name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
    ctx.app.store.rename_session(&id, name.as_deref()).map_err(internal)?;
    if let Some(h) = ctx.app.sessions.lock().unwrap().get(&id) {
        h.emit(json!({"type": "renamed", "name": name}));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_session(State(ctx): State<Ctx>, Path(id): Path<String>) -> ApiResult<StatusCode> {
    ctx.app.store.delete_session(&id).map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn hide_entry(State(ctx): State<Ctx>, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let entry = ctx.app.store.get_entry(&id).map_err(internal)?;
    ctx.app.store.hide_entry(&id).map_err(internal)?;
    if let Some(e) = entry
        && let Some(h) = ctx.app.sessions.lock().unwrap().get(&e.session_id)
    {
        h.emit(json!({"type": "entry_removed", "id": id}));
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct RowsQuery {
    offset: Option<usize>,
    limit: Option<usize>,
}

fn get_result(ctx: &Ctx, id: &str) -> ApiResult<Arc<ResultData>> {
    ctx.app.store.get_result(id).map_err(internal)?.ok_or((StatusCode::NOT_FOUND, "result not available".into()))
}

async fn result_rows(State(ctx): State<Ctx>, Path(id): Path<String>, Query(q): Query<RowsQuery>) -> ApiResult<Json<serde_json::Value>> {
    let data = get_result(&ctx, &id)?;
    let offset = q.offset.unwrap_or(0).min(data.rows.len());
    let end = (offset + q.limit.unwrap_or(1000).min(100_000)).min(data.rows.len());
    Ok(Json(json!({"offset": offset, "rows": &data.rows[offset..end], "available": data.rows.len(), "row_count": data.row_count})))
}

#[derive(Deserialize)]
struct ExportQuery {
    format: Option<String>,
    filename: Option<String>,
    header: Option<bool>,
}

pub fn csv_field(v: &str, sep: char) -> String {
    if v.contains(sep) || v.contains('"') || v.contains('\n') || v.contains('\r') {
        format!("\"{}\"", v.replace('"', "\"\""))
    } else {
        v.to_string()
    }
}

async fn export_result(State(ctx): State<Ctx>, Path(id): Path<String>, Query(q): Query<ExportQuery>) -> ApiResult<Response> {
    let data = get_result(&ctx, &id)?;
    let format = q.format.as_deref().unwrap_or("csv");
    let header = q.header.unwrap_or(true);
    let (body, mime, ext) = match format {
        "csv" | "tsv" => {
            let sep = if format == "csv" { ',' } else { '\t' };
            let mut out = String::new();
            if header {
                out.push_str(&data.columns.iter().map(|c| csv_field(&c.name, sep)).collect::<Vec<_>>().join(&sep.to_string()));
                out.push_str("\r\n");
            }
            for r in &data.rows {
                out.push_str(&r.iter().map(|v| v.as_deref().map(|v| csv_field(v, sep)).unwrap_or_default()).collect::<Vec<_>>().join(&sep.to_string()));
                out.push_str("\r\n");
            }
            (out, if format == "csv" { "text/csv" } else { "text/tab-separated-values" }, format)
        }
        "json" => {
            let rows: Vec<serde_json::Map<String, serde_json::Value>> = data
                .rows
                .iter()
                .map(|r| data.columns.iter().zip(r).map(|(c, v)| (c.name.clone(), json!(v))).collect())
                .collect();
            (serde_json::to_string_pretty(&rows).map_err(internal)?, "application/json", "json")
        }
        _ => return Err((StatusCode::BAD_REQUEST, "unknown format".into())),
    };
    let name = q.filename.unwrap_or_else(|| format!("result-{id}"));
    let name: String = name.chars().filter(|c| c.is_alphanumeric() || "-_.".contains(*c)).collect();
    let disp = format!("attachment; filename=\"{name}.{ext}\"");
    Ok((
        [(header::CONTENT_TYPE, HeaderValue::from_str(&format!("{mime}; charset=utf-8")).unwrap()), (header::CONTENT_DISPOSITION, HeaderValue::from_str(&disp).unwrap())],
        body,
    )
        .into_response())
}

#[derive(Deserialize)]
struct HistoryQuery {
    q: Option<String>,
    session: Option<String>,
    limit: Option<i64>,
}

async fn history(State(ctx): State<Ctx>, Query(q): Query<HistoryQuery>) -> ApiResult<Json<serde_json::Value>> {
    let rows = ctx
        .app
        .store
        .search_history(q.q.as_deref().unwrap_or(""), q.session.as_deref(), q.limit.unwrap_or(200).min(5000))
        .map_err(internal)?;
    Ok(Json(json!(rows)))
}

async fn services() -> Json<serde_json::Value> {
    let s: Vec<serde_json::Value> = conninfo::list_services()
        .into_iter()
        .map(|(name, params, file)| {
            let mut p = params.clone();
            p.remove("password");
            json!({"name": name, "params": p, "file": file.display().to_string()})
        })
        .collect();
    Json(json!(s))
}

async fn ws_handler(State(ctx): State<Ctx>, Path(id): Path<String>, ws: WebSocketUpgrade) -> Response {
    ws.max_message_size(64 << 20).on_upgrade(move |socket| handle_socket(socket, ctx, id))
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMsg {
    Run { sql: String, entry_id: Option<String> },
    Cancel,
    Password { password: String },
    Connect { conninfo: Option<String> },
    Settings { settings: Settings },
    RefreshMeta,
}

fn snapshot(ctx: &Ctx, id: &str) -> anyhow::Result<String> {
    let session = ctx.app.store.get_session(id)?;
    let entries = ctx.app.store.list_entries(id)?;
    let h = ctx.app.session(id)?;
    let sh = h.shared.lock().unwrap();
    Ok(json!({
        "type": "snapshot",
        "session": session,
        "entries": entries,
        "conn": sh.conn,
        "running": sh.running,
        "settings": sh.settings,
    })
    .to_string())
}

async fn handle_socket(mut socket: WebSocket, ctx: Ctx, id: String) {
    let h = match ctx.app.session(&id) {
        Ok(h) => h,
        Err(e) => {
            let _ = socket.send(WsMessage::Text(json!({"type": "fatal", "error": e.to_string()}).to_string().into())).await;
            return;
        }
    };
    let mut rx = h.events.subscribe();
    let send_snapshot = |ctx: &Ctx| -> Vec<String> {
        let mut out = vec![];
        match snapshot(ctx, &id) {
            Ok(s) => out.push(s),
            Err(e) => out.push(json!({"type": "fatal", "error": e.to_string()}).to_string()),
        }
        if let Some(m) = h.shared.lock().unwrap().meta.clone() {
            out.push(m.to_string());
        }
        out
    };
    for m in send_snapshot(&ctx) {
        if socket.send(WsMessage::Text(m.into())).await.is_err() {
            return;
        }
    }
    loop {
        tokio::select! {
            ev = rx.recv() => match ev {
                Ok(s) => {
                    if socket.send(WsMessage::Text(s.as_str().into())).await.is_err() {
                        break;
                    }
                }
                Err(RecvError::Lagged(_)) => {
                    for m in send_snapshot(&ctx) {
                        if socket.send(WsMessage::Text(m.into())).await.is_err() {
                            return;
                        }
                    }
                }
                Err(RecvError::Closed) => break,
            },
            msg = socket.recv() => match msg {
                Some(Ok(WsMessage::Text(t))) => {
                    match serde_json::from_str::<ClientMsg>(&t) {
                        Ok(ClientMsg::Cancel) => h.cancel(),
                        Ok(ClientMsg::Run { sql, entry_id }) => { let _ = h.cmd.send(Cmd::Run { sql, entry_id }); }
                        Ok(ClientMsg::Password { password }) => { let _ = h.cmd.send(Cmd::Password { password }); }
                        Ok(ClientMsg::Connect { conninfo }) => { let _ = h.cmd.send(Cmd::Connect { conninfo }); }
                        Ok(ClientMsg::Settings { settings }) => { let _ = h.cmd.send(Cmd::Settings(settings)); }
                        Ok(ClientMsg::RefreshMeta) => { let _ = h.cmd.send(Cmd::RefreshMeta); }
                        Err(e) => tracing::warn!("bad client message: {e}"),
                    }
                }
                Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts() {
        assert!(is_local_host("localhost:8765"));
        assert!(is_local_host("127.0.0.1:1"));
        assert!(is_local_host("[::1]:8765"));
        assert!(!is_local_host("evil.com:8765"));
        assert!(!is_local_host("localhost.evil.com"));
    }

    #[test]
    fn csv() {
        assert_eq!(csv_field("a,b", ','), "\"a,b\"");
        assert_eq!(csv_field("a\"b", '\t'), "\"a\"\"b\"");
        assert_eq!(csv_field("plain", ','), "plain");
    }
}
