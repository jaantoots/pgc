mod conninfo;
mod describe;
mod lexer;
mod pgwire;
mod server;
mod session;
mod store;

use std::io::{Read, Write};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use clap::Parser;

/// A PostgreSQL client with a web UI, served locally.
///
/// Connection arguments work like psql's: `pgc mydb`, `pgc -h host -U user db`,
/// `pgc "service=prod"` or `pgc postgresql://...`. PG* environment variables,
/// ~/.pg_service.conf and ~/.pgpass are honoured.
#[derive(Parser, Debug)]
#[command(version, disable_help_flag = true)]
struct Args {
    /// Database name or connection string
    dbname_pos: Option<String>,
    /// User name
    username_pos: Option<String>,
    /// Database name or connection string
    #[arg(short = 'd', long = "dbname")]
    dbname: Option<String>,
    /// Database server host or socket directory
    #[arg(short = 'h', long = "host")]
    host: Option<String>,
    /// Database server port
    #[arg(short = 'p', long = "port")]
    port: Option<String>,
    /// Database user name
    #[arg(short = 'U', long = "username")]
    username: Option<String>,
    /// Never prompt for password (accepted for psql compatibility)
    #[arg(short = 'w', long = "no-password")]
    no_password: bool,
    /// Force password prompt (accepted for psql compatibility; pgc asks in the browser)
    #[arg(short = 'W', long = "password")]
    password: bool,
    /// Address for the web UI
    #[arg(long, env = "PGC_LISTEN", default_value = "127.0.0.1:8765")]
    listen: SocketAddr,
    /// Don't open a browser
    #[arg(long, env = "PGC_NO_BROWSER")]
    no_browser: bool,
    /// Directory for pgc's history database
    #[arg(long, env = "PGC_DATA_DIR")]
    data_dir: Option<PathBuf>,
    /// Print help
    #[arg(long, action = clap::ArgAction::Help)]
    help: Option<bool>,
}

fn data_dir(args: &Args) -> Result<PathBuf> {
    let dir = match &args.data_dir {
        Some(d) => d.clone(),
        None => dirs::data_dir().context("cannot determine data directory")?.join("pgc"),
    };
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(dir)
}

fn load_token(dir: &std::path::Path) -> Result<String> {
    let path = dir.join("token");
    if let Ok(t) = std::fs::read_to_string(&path) {
        let t = t.trim().to_string();
        if t.len() >= 32 {
            return Ok(t);
        }
    }
    let mut bytes = [0u8; 24];
    rand::fill(&mut bytes);
    let token = hex::encode(bytes);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(&path)?.write_all(token.as_bytes())?;
    Ok(token)
}

/// Build connection params from psql-style arguments.
fn conn_params(args: &Args) -> Result<conninfo::Params> {
    let mut p = conninfo::Params::new();
    if let Some(h) = &args.host {
        p.insert("host".into(), h.clone());
    }
    if let Some(port) = &args.port {
        p.insert("port".into(), port.clone());
    }
    if let Some(u) = args.username.as_ref().or(args.username_pos.as_ref()) {
        p.insert("user".into(), u.clone());
    }
    if let Some(d) = args.dbname.as_ref().or(args.dbname_pos.as_ref()) {
        // A connection string overrides the separate options, like psql.
        for (k, v) in conninfo::parse(d)? {
            p.insert(k, v);
        }
    }
    Ok(p)
}

/// Minimal HTTP/1.1 request to an already running pgc.
fn http_request(addr: SocketAddr, method: &str, path: &str, token: &str, body: Option<&str>) -> Result<(u16, String)> {
    let mut s = std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_secs(2))?;
    s.set_read_timeout(Some(std::time::Duration::from_secs(10)))?;
    let body = body.unwrap_or("");
    write!(
        s,
        "{method} {path} HTTP/1.1\r\nHost: localhost:{}\r\nX-Pgc-Token: {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        addr.port(),
        body.len()
    )?;
    let mut resp = String::new();
    s.read_to_string(&mut resp)?;
    let status = resp.split_whitespace().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    let body = resp.split_once("\r\n\r\n").map(|x| x.1.to_string()).unwrap_or_default();
    // Undo chunked encoding if present.
    let body = if resp.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        let mut out = String::new();
        let mut rest = body.as_str();
        while let Some((len, r)) = rest.split_once("\r\n") {
            let n = usize::from_str_radix(len.trim(), 16).unwrap_or(0);
            if n == 0 || r.len() < n {
                break;
            }
            out.push_str(&r[..n]);
            rest = r[n..].trim_start_matches("\r\n");
        }
        out
    } else {
        body
    };
    Ok((status, body))
}

fn open_browser(url: &str, args: &Args) {
    if args.no_browser {
        return;
    }
    if let Err(e) = open::that_detached(url) {
        tracing::debug!("could not open browser: {e}");
    }
}

fn session_url(addr: SocketAddr, id: &str, token: &str) -> String {
    let host = if addr.ip().is_loopback() || addr.ip().is_unspecified() { "localhost".to_string() } else { addr.ip().to_string() };
    format!("http://{host}:{}/s/{id}?token={token}", addr.port())
}

/// Another pgc is already listening: ask it to create a session for our
/// connection settings and open it.
fn hand_off(args: &Args, token: &str, conninfo: &str, password: Option<String>) -> Result<()> {
    let addr = args.listen;
    let (status, _) = http_request(addr, "GET", "/api/ping", token, None)
        .with_context(|| format!("{addr} is in use and doesn't look like pgc; use --listen to pick another address"))?;
    if status != 200 {
        bail!("{addr} is in use by something that isn't this user's pgc (HTTP {status}); use --listen to pick another address");
    }
    let body = serde_json::json!({"conninfo": conninfo, "password": password}).to_string();
    let (status, resp) = http_request(addr, "POST", "/api/sessions", token, Some(&body))?;
    if status != 200 {
        bail!("{}", resp.trim());
    }
    let v: serde_json::Value = serde_json::from_str(&resp)?;
    let url = session_url(addr, v["id"].as_str().unwrap_or(""), token);
    println!("pgc is already running; opened a new session: {url}");
    open_browser(&url, args);
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt().with_env_filter(std::env::var("PGC_LOG").unwrap_or_else(|_| "pgc=info".into())).init();
    let args = Args::parse();
    let _ = (args.no_password, args.password);
    let dir = data_dir(&args)?;
    let token = load_token(&dir)?;

    let params = conn_params(&args)?;
    let resolved = conninfo::resolve(&params)?;
    let default_conninfo = conninfo::to_string(&resolved.params, false);

    let listener = match tokio::net::TcpListener::bind(args.listen).await {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => return hand_off(&args, &token, &default_conninfo, resolved.password.clone()),
        Err(e) => return Err(e).with_context(|| format!("listening on {}", args.listen)),
    };

    let store = Arc::new(store::Store::open(&dir.join("pgc.db"))?);
    store.gc_empty_sessions()?;
    let app = session::App::new(store, default_conninfo.clone());
    if let Some(pw) = resolved.password.clone() {
        app.remember_password(&resolved, pw);
    }
    let first = app.create_session(None, None)?;
    let url = session_url(args.listen, &first, &token);
    println!("pgc listening on http://{}", args.listen);
    println!("Open: {url}");
    open_browser(&url, &args);

    let ctx = server::Ctx { app, token: Arc::new(token) };
    axum::serve(listener, server::router(ctx))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
