//! Sessions: each browser tab is attached to one session, which owns a
//! database connection through an actor task. Events are broadcast to every
//! tab viewing the session.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use postgres_protocol::message::backend::Message;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc};

use crate::conninfo::{self, Params};
use crate::describe::{self, Output};
use crate::lexer::{self, Segment};
use crate::pgwire::{self, CancelKey, Column, Conn, DbError, Error, Row, TxStatus};
use crate::store::{ColumnOut, Entry, HistoryRow, Item, ResultData, RowsItem, Settings, Store, now_ms};

/// Rows sent inline with a result; the rest are fetched on demand.
const INLINE_ROWS: usize = 200;
/// Rows kept in memory per result set.
const MAX_ROWS: usize = 1_000_000;
const MAX_RESULT_BYTES: usize = 512 << 20;
/// Close idle connections of sessions nobody is looking at.
const IDLE_CLOSE: Duration = Duration::from_secs(30 * 60);

pub fn new_id() -> String {
    use rand::RngExt;
    const ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789";
    let mut rng = rand::rng();
    (0..12).map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char).collect()
}

pub struct App {
    pub store: Arc<Store>,
    pub sessions: Mutex<HashMap<String, Arc<SessionHandle>>>,
    pub default_conninfo: Mutex<String>,
    /// Passwords entered in the UI, kept in memory only. Keyed by user@host:port.
    pub passwords: Mutex<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ConnState {
    /// disconnected | connecting | connected | error | need_password
    pub status: String,
    pub conninfo: String,
    pub label: Option<String>,
    pub dbname: Option<String>,
    pub user: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub unix_socket: bool,
    pub tls: Option<String>,
    pub server_version: Option<String>,
    pub tx: Option<TxStatus>,
    pub superuser: bool,
    pub pid: Option<i32>,
    pub error: Option<String>,
}

pub struct Shared {
    pub conn: ConnState,
    pub cancel: Option<CancelKey>,
    pub running: Option<String>,
    pub meta: Option<Arc<String>>,
    pub settings: Settings,
}

pub enum Cmd {
    Run { sql: String, entry_id: Option<String> },
    Connect { conninfo: Option<String> },
    Password { password: String },
    RefreshMeta,
    Settings(Settings),
}

pub struct SessionHandle {
    pub id: String,
    pub cmd: mpsc::UnboundedSender<Cmd>,
    pub events: broadcast::Sender<Arc<String>>,
    pub shared: Mutex<Shared>,
}

impl SessionHandle {
    pub fn emit(&self, v: Value) {
        let _ = self.events.send(Arc::new(v.to_string()));
    }

    pub fn cancel(&self) {
        let key = self.shared.lock().unwrap().cancel.clone();
        if let Some(key) = key {
            tokio::spawn(async move {
                if let Err(e) = pgwire::cancel(&key).await {
                    tracing::warn!("cancel failed: {e}");
                }
            });
        }
    }
}

impl App {
    pub fn new(store: Arc<Store>, default_conninfo: String) -> Arc<App> {
        Arc::new(App {
            store,
            sessions: Mutex::new(HashMap::new()),
            default_conninfo: Mutex::new(default_conninfo),
            passwords: Mutex::new(HashMap::new()),
        })
    }

    /// Get the running session, starting its actor if needed.
    pub fn session(self: &Arc<Self>, id: &str) -> anyhow::Result<Arc<SessionHandle>> {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(h) = sessions.get(id) {
            return Ok(h.clone());
        }
        let row = self.store.get_session(id)?.ok_or_else(|| anyhow::anyhow!("no such session"))?;
        let (tx, rx) = mpsc::unbounded_channel();
        let (events, _) = broadcast::channel(4096);
        let h = Arc::new(SessionHandle {
            id: id.to_string(),
            cmd: tx,
            events,
            shared: Mutex::new(Shared {
                conn: ConnState { status: "disconnected".into(), conninfo: row.conninfo.clone(), ..Default::default() },
                cancel: None,
                running: None,
                meta: None,
                settings: row.settings.clone(),
            }),
        });
        sessions.insert(id.to_string(), h.clone());
        let actor = Actor {
            app: self.clone(),
            h: h.clone(),
            conn: None,
            params: conninfo::parse(&row.conninfo).unwrap_or_default(),
            types: HashMap::new(),
            last_sql: None,
            pending: None,
            last_activity: Instant::now(),
            meta_stale: false,
        };
        let _ = h.cmd.send(Cmd::Connect { conninfo: None });
        tokio::spawn(actor.run(rx));
        Ok(h)
    }

    pub fn create_session(&self, conninfo: Option<String>, password: Option<String>) -> anyhow::Result<String> {
        let conninfo = match conninfo.filter(|c| !c.trim().is_empty()) {
            Some(c) => {
                // Validate and normalize (applies service file and environment).
                let r = conninfo::resolve(&conninfo::parse(&c)?)?;
                if let Some(pw) = password.or(r.password.clone()) {
                    self.remember_password(&r, pw);
                }
                conninfo::to_string(&r.params, false)
            }
            None => self.default_conninfo.lock().unwrap().clone(),
        };
        let id = new_id();
        self.store.ensure_session(&id, &conninfo)?;
        Ok(id)
    }

    fn password_key(r: &conninfo::Resolved) -> String {
        let (host, _, port) = r.targets.first().cloned().unwrap_or((conninfo::Host::Tcp(String::new()), None, 5432));
        format!("{}@{}:{}", r.user, host.label(), port)
    }

    pub fn remember_password(&self, r: &conninfo::Resolved, pw: String) {
        self.passwords.lock().unwrap().insert(Self::password_key(r), pw);
    }

    fn password_for(&self, r: &conninfo::Resolved) -> Option<String> {
        self.passwords.lock().unwrap().get(&Self::password_key(r)).cloned()
    }
}

struct Actor {
    app: Arc<App>,
    h: Arc<SessionHandle>,
    conn: Option<Conn>,
    params: Params,
    types: HashMap<u32, String>,
    last_sql: Option<String>,
    /// A run waiting for a password to be entered.
    pending: Option<(String, Option<String>)>,
    last_activity: Instant,
    meta_stale: bool,
}

fn is_numeric_type(oid: u32) -> bool {
    // int8, int2, int4, oid, xid, cid, float4, float8, money, numeric, xid8
    matches!(oid, 20 | 21 | 23 | 26 | 28 | 29 | 700 | 701 | 790 | 1700 | 5069)
}

fn error_item(e: &Error, offset: Option<usize>) -> Item {
    match e {
        Error::Db(d) => Item::Error { error: d.clone(), offset },
        Error::NeedPassword => Item::Error { error: DbError::simple("password authentication required: enter the password to connect"), offset: None },
        e => Item::Error { error: DbError { severity: "ERROR".into(), message: e.to_string(), ..Default::default() }, offset: None },
    }
}

/// A unit of work while executing an entry.
enum Work {
    Seg(Segment),
}

impl Actor {
    async fn run(mut self, mut rx: mpsc::UnboundedReceiver<Cmd>) {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        loop {
            let cmd = match &mut self.conn {
                Some(conn) => tokio::select! {
                    cmd = rx.recv() => cmd,
                    msg = conn.recv_async() => {
                        match msg {
                            Ok(a) => self.async_message(a),
                            Err(e) => {
                                self.conn = None;
                                self.set_conn_status("disconnected", Some(format!("connection lost: {e}")));
                            }
                        }
                        continue;
                    }
                    _ = tick.tick() => { self.idle_check(); continue; }
                },
                None => tokio::select! {
                    cmd = rx.recv() => cmd,
                    _ = tick.tick() => { self.idle_check(); continue; }
                },
            };
            let Some(cmd) = cmd else { break };
            self.last_activity = Instant::now();
            match cmd {
                Cmd::Run { sql, entry_id } => self.run_entry(sql, entry_id).await,
                Cmd::Connect { conninfo } => {
                    if let Some(c) = conninfo {
                        match conninfo::parse(&c) {
                            Ok(p) => {
                                self.params = p;
                                if let Some(c) = self.conn.take() {
                                    c.terminate().await;
                                }
                            }
                            Err(e) => {
                                self.set_conn_status("error", Some(e.to_string()));
                                continue;
                            }
                        }
                    }
                    if self.conn.is_none() {
                        let _ = self.connect().await;
                    }
                }
                Cmd::Password { password } => {
                    if let Ok(r) = conninfo::resolve(&self.params) {
                        self.app.remember_password(&r, password);
                    }
                    if self.connect().await.is_ok()
                        && let Some((sql, id)) = self.pending.take()
                    {
                        self.run_entry(sql, id).await;
                    }
                }
                Cmd::RefreshMeta => self.refresh_meta().await,
                Cmd::Settings(s) => {
                    let _ = self.app.store.save_settings(&self.h.id, &s);
                    self.h.shared.lock().unwrap().settings = s.clone();
                    self.h.emit(json!({"type": "settings", "settings": s}));
                }
            }
        }
    }

    fn idle_check(&mut self) {
        let unwatched = self.h.events.receiver_count() == 0;
        let idle_tx = self.conn.as_ref().is_some_and(|c| c.tx == TxStatus::Idle);
        if unwatched && idle_tx && self.last_activity.elapsed() > IDLE_CLOSE {
            tracing::info!("closing idle connection of session {}", self.h.id);
            self.conn = None;
            self.set_conn_status("disconnected", None);
        }
    }

    fn async_message(&mut self, a: pgwire::Async) {
        let item = match a {
            pgwire::Async::Notice(n) => Item::Notice { notice: n },
            pgwire::Async::Notification { pid, channel, payload } => Item::Notification { pid, channel, payload },
        };
        // Shown as a lightweight system entry in the flow.
        let mut e = self.new_entry(String::new());
        e.status = "ok".into();
        e.items.push(item);
        e.duration_ms = Some(0.0);
        let _ = self.app.store.ensure_session(&self.h.id, &conninfo::to_string(&self.params, false));
        let _ = self.app.store.save_entry(&e);
        self.h.emit(json!({"type": "entry", "entry": e}));
    }

    fn conn_label(&self) -> String {
        self.h.shared.lock().unwrap().conn.label.clone().unwrap_or_default()
    }

    fn set_conn_status(&self, status: &str, error: Option<String>) {
        let st = {
            let mut sh = self.h.shared.lock().unwrap();
            sh.conn.status = status.into();
            sh.conn.error = error;
            sh.conn.conninfo = conninfo::to_string(&self.params, false);
            if status != "connected" {
                sh.conn.tx = None;
                sh.cancel = None;
            }
            sh.conn.clone()
        };
        self.h.emit(json!({"type": "conn", "conn": st}));
    }

    fn publish_conn(&self) {
        let Some(c) = &self.conn else { return };
        let st = {
            let mut sh = self.h.shared.lock().unwrap();
            let i = &c.info;
            sh.conn = ConnState {
                status: "connected".into(),
                conninfo: conninfo::to_string(&self.params, false),
                label: Some(if i.unix_socket {
                    format!("{}@{}", i.user, i.dbname)
                } else {
                    format!("{}@{}:{}/{}", i.user, i.host, i.port, i.dbname)
                }),
                dbname: Some(i.dbname.clone()),
                user: Some(i.user.clone()),
                host: Some(i.host.clone()),
                port: Some(i.port),
                unix_socket: i.unix_socket,
                tls: i.tls.clone(),
                server_version: c.server_params.get("server_version").cloned(),
                tx: Some(c.tx),
                superuser: c.server_params.get("is_superuser").is_some_and(|v| v == "on"),
                pid: Some(i.process_id),
                error: None,
            };
            sh.cancel = Some(c.cancel_key.clone());
            sh.conn.clone()
        };
        self.h.emit(json!({"type": "conn", "conn": st}));
    }

    async fn connect(&mut self) -> Result<(), Error> {
        let r = conninfo::resolve(&self.params).map_err(|e| Error::Other(e.to_string()));
        let r = match r {
            Ok(r) => r,
            Err(e) => {
                self.set_conn_status("error", Some(e.to_string()));
                return Err(e);
            }
        };
        self.set_conn_status("connecting", None);
        let pw = self.app.password_for(&r);
        match Conn::connect(&r, pw.as_deref()).await {
            Ok(c) => {
                if let Some(old) = self.conn.replace(c) {
                    old.terminate().await;
                }
                self.publish_conn();
                let label = self.conn_label();
                let _ = self.app.store.update_session_conn(&self.h.id, &conninfo::to_string(&self.params, false), &label);
                self.load_types().await;
                self.refresh_meta().await;
                Ok(())
            }
            Err(Error::NeedPassword) => {
                self.set_conn_status("need_password", None);
                Err(Error::NeedPassword)
            }
            Err(e) => {
                // A wrong password: ask again rather than just failing.
                let status = if e.to_string().contains("password authentication failed") { "need_password" } else { "error" };
                self.set_conn_status(status, Some(e.to_string()));
                Err(e)
            }
        }
    }

    async fn load_types(&mut self) {
        let Some(c) = &mut self.conn else { return };
        if let Ok((_, rows)) = c
            .query("SELECT oid, pg_catalog.format_type(oid, NULL) FROM pg_catalog.pg_type WHERE typnamespace = 'pg_catalog'::pg_catalog.regnamespace")
            .await
        {
            for r in rows {
                if let (Some(Some(oid)), Some(Some(name))) = (r.first(), r.get(1))
                    && let Ok(oid) = oid.parse()
                {
                    self.types.insert(oid, name.clone());
                }
            }
        }
    }

    /// Look up names of types we haven't seen. Only when it can't disturb
    /// the user's transaction.
    async fn resolve_types(&mut self, oids: &HashSet<u32>) {
        let missing: Vec<String> = oids.iter().filter(|o| !self.types.contains_key(o)).map(|o| o.to_string()).collect();
        if missing.is_empty() {
            return;
        }
        let Some(c) = &mut self.conn else { return };
        if c.tx == TxStatus::Failed {
            return;
        }
        if let Ok((_, rows)) = c
            .query(&format!("SELECT oid, pg_catalog.format_type(oid, NULL) FROM pg_catalog.pg_type WHERE oid IN ({})", missing.join(",")))
            .await
        {
            for r in rows {
                if let (Some(Some(oid)), Some(Some(name))) = (r.first(), r.get(1))
                    && let Ok(oid) = oid.parse()
                {
                    self.types.insert(oid, name.clone());
                }
            }
        }
    }

    async fn refresh_meta(&mut self) {
        let Some(c) = &mut self.conn else { return };
        if c.tx != TxStatus::Idle {
            self.meta_stale = true;
            return;
        }
        self.meta_stale = false;
        let meta = load_meta(c).await;
        let s = Arc::new(json!({"type": "meta", "meta": meta}).to_string());
        self.h.shared.lock().unwrap().meta = Some(s.clone());
        let _ = self.h.events.send(s);
    }

    fn new_entry(&self, sql: String) -> Entry {
        Entry {
            id: new_id(),
            session_id: self.h.id.clone(),
            seq: self.app.store.next_seq(&self.h.id).unwrap_or(1),
            sql,
            status: "running".into(),
            started_at: now_ms(),
            duration_ms: None,
            items: vec![],
            conn_label: self.conn_label(),
            runs: 1,
        }
    }

    fn push_item(&self, entry: &mut Entry, item: Item) {
        self.h.emit(json!({"type": "item", "entry_id": entry.id, "index": entry.items.len(), "item": item}));
        entry.items.push(item);
    }

    async fn run_entry(&mut self, sql: String, entry_id: Option<String>) {
        let _ = self.app.store.ensure_session(&self.h.id, &conninfo::to_string(&self.params, false));
        let existing = entry_id.as_deref().and_then(|id| self.app.store.get_entry(id).ok().flatten());
        let mut entry = match existing {
            Some(mut e) => {
                let _ = self.app.store.delete_results_for_entry(&e.id);
                e.sql = sql.clone();
                e.items.clear();
                e.status = "running".into();
                e.started_at = now_ms();
                e.duration_ms = None;
                e.runs += 1;
                e
            }
            None => self.new_entry(sql.clone()),
        };
        self.h.shared.lock().unwrap().running = Some(entry.id.clone());
        let _ = self.app.store.save_entry(&entry);
        self.h.emit(json!({"type": "entry", "entry": entry}));
        let started = Instant::now();

        if self.conn.is_none()
            && let Err(e) = self.connect().await
        {
            if matches!(e, Error::NeedPassword) {
                self.pending = Some((sql.clone(), Some(entry.id.clone())));
            }
            let item = error_item(&e, None);
            self.push_item(&mut entry, item);
            self.finish(entry, "error", started, Vec::new());
            return;
        }
        entry.conn_label = self.conn_label();

        let mut work: VecDeque<Work> = lexer::split(&sql).into_iter().map(Work::Seg).collect();
        let mut status = "ok";
        let mut results: Vec<(String, Arc<ResultData>)> = Vec::new();
        let mut ddl = false;
        let mut depth = 0;
        while let Some(Work::Seg(seg)) = work.pop_front() {
            let res = match seg {
                Segment::Sql { text, offset } => {
                    // A following \g, \gx or \gdesc applies to this statement.
                    let mut mode = "";
                    if let Some(Work::Seg(Segment::Meta { name, .. })) = work.front()
                        && matches!(name.as_str(), "g" | "gx" | "G" | "gdesc")
                    {
                        mode = if name == "gdesc" { "gdesc" } else if name == "g" { "" } else { "gx" };
                        work.pop_front();
                    }
                    self.last_sql = Some(text.clone());
                    if mode == "gdesc" {
                        self.gdesc(&mut entry, &text, &mut results).await
                    } else {
                        self.exec_sql(&mut entry, &text, Some(offset), mode == "gx", &mut results, &mut ddl).await
                    }
                }
                Segment::Meta { name, args, offset } => {
                    if matches!(name.as_str(), "i" | "ir" | "include" | "include_relative") {
                        depth += 1;
                        match std::fs::read_to_string(expand_home(args.trim())) {
                            Ok(text) if depth < 16 => {
                                let segs: Vec<Work> = lexer::split(&text)
                                    .into_iter()
                                    .map(|s| match s {
                                        Segment::Sql { text, .. } => Segment::Sql { text, offset: usize::MAX },
                                        m => m,
                                    })
                                    .map(Work::Seg)
                                    .collect();
                                for s in segs.into_iter().rev() {
                                    work.push_front(s);
                                }
                                Ok(())
                            }
                            Ok(_) => {
                                let e = Error::Other("\\i: include nesting too deep".into());
                                self.push_item(&mut entry, error_item(&e, None));
                                Err(e)
                            }
                            Err(e) => {
                                let e = Error::Other(format!("{}: {e}", args.trim()));
                                self.push_item(&mut entry, error_item(&e, None));
                                Err(e)
                            }
                        }
                    } else {
                        self.exec_meta(&mut entry, &name, &args, offset, &mut results, &mut ddl).await
                    }
                }
            };
            if let Err(e) = res {
                let cancelled = matches!(&e, Error::Db(d) if d.code == "57014");
                status = if cancelled { "cancelled" } else { "error" };
                if matches!(e, Error::Io(_)) {
                    // Lost the connection mid-query; it is re-established on the next run.
                    self.push_item(&mut entry, error_item(&e, None));
                    self.conn = None;
                    self.set_conn_status("disconnected", Some(e.to_string()));
                }
                break;
            }
        }
        if let Some(c) = &self.conn {
            let tx = c.tx;
            let changed = self.h.shared.lock().unwrap().conn.tx != Some(tx);
            if changed {
                self.publish_conn();
            }
        }
        self.finish(entry, status, started, results);
        if (ddl || self.meta_stale) && self.conn.as_ref().is_some_and(|c| c.tx == TxStatus::Idle) {
            self.refresh_meta().await;
        }
    }

    fn finish(&self, mut entry: Entry, status: &str, started: Instant, results: Vec<(String, Arc<ResultData>)>) {
        entry.status = status.into();
        entry.duration_ms = Some(started.elapsed().as_secs_f64() * 1000.0);
        for (id, data) in results {
            if let Err(e) = self.app.store.save_result(&id, &entry.id, data) {
                tracing::error!("saving result: {e}");
            }
        }
        if let Err(e) = self.app.store.save_entry(&entry) {
            tracing::error!("saving entry: {e}");
        }
        if !entry.sql.trim().is_empty() {
            let _ = self.app.store.add_history(&HistoryRow {
                id: 0,
                session_id: self.h.id.clone(),
                entry_id: Some(entry.id.clone()),
                sql: entry.sql.clone(),
                executed_at: entry.started_at,
                duration_ms: entry.duration_ms,
                status: entry.status.clone(),
                conn_label: entry.conn_label.clone(),
            });
        }
        self.h.shared.lock().unwrap().running = None;
        self.h.emit(json!({"type": "entry", "entry": entry}));
    }

    fn make_rows_item(
        &self,
        columns: &[Column],
        rows: Vec<Row>,
        row_count: u64,
        tag: Option<String>,
        expanded: bool,
        results: &mut Vec<(String, Arc<ResultData>)>,
    ) -> Item {
        let cols: Vec<ColumnOut> = columns
            .iter()
            .map(|c| ColumnOut {
                name: c.name.clone(),
                type_oid: c.type_oid,
                type_name: self.types.get(&c.type_oid).cloned().unwrap_or_else(|| c.type_oid.to_string()),
                numeric: is_numeric_type(c.type_oid),
            })
            .collect();
        let id = new_id();
        let inline = rows.iter().take(INLINE_ROWS).cloned().collect();
        let stored = rows.len() as u64;
        let data = Arc::new(ResultData { columns: cols.clone(), rows, row_count });
        self.app.store.cache.lock().unwrap().insert(id.clone(), data.clone());
        results.push((id.clone(), data));
        let expanded = expanded || self.h.shared.lock().unwrap().settings.expanded == "on";
        Item::Rows(RowsItem { result_id: id, columns: cols, rows: inline, row_count, stored, tag, title: None, footer: vec![], expanded })
    }

    async fn exec_sql(
        &mut self,
        entry: &mut Entry,
        text: &str,
        offset: Option<usize>,
        expanded: bool,
        results: &mut Vec<(String, Arc<ResultData>)>,
        ddl: &mut bool,
    ) -> Result<(), Error> {
        let conn = self.conn.as_mut().ok_or_else(|| Error::Other("not connected".into()))?;
        conn.send_query(text).await?;
        // Statement results are collected until ReadyForQuery so unknown
        // type names can be resolved before they're shown.
        enum Pending {
            Rows(Vec<Column>, Vec<Row>, u64, Option<String>),
            Item(Item),
        }
        let mut pending: Vec<Pending> = Vec::new();
        let mut cur: Option<(Vec<Column>, Vec<Row>, u64, usize)> = None;
        let mut error: Option<DbError> = None;
        let mut copy_out: Option<Vec<u8>> = None;
        let mut last_progress = Instant::now();
        loop {
            let msg = conn.recv().await?;
            match msg {
                Message::RowDescription(d) => cur = Some((pgwire::parse_columns(&d)?, Vec::new(), 0, 0)),
                Message::DataRow(r) => {
                    if let Some((_, rows, count, bytes)) = &mut cur {
                        *count += 1;
                        if rows.len() < MAX_ROWS && *bytes < MAX_RESULT_BYTES {
                            *bytes += r.buffer().len() + 24 * 4;
                            rows.push(pgwire::parse_row(&r)?);
                        }
                        if *count % 1000 == 0 && last_progress.elapsed() > Duration::from_millis(250) {
                            last_progress = Instant::now();
                            self.h.emit(json!({"type": "progress", "entry_id": entry.id, "rows": *count}));
                        }
                    }
                }
                Message::CommandComplete(c) => {
                    let tag = c.tag()?.to_string();
                    let first = tag.split_whitespace().next().unwrap_or("");
                    if matches!(first, "CREATE" | "ALTER" | "DROP" | "COMMENT" | "IMPORT" | "GRANT" | "REVOKE") {
                        *ddl = true;
                    }
                    if let Some((cols, rows, count, _)) = cur.take() {
                        pending.push(Pending::Rows(cols, rows, count, Some(tag)));
                    } else if let Some(data) = copy_out.take() {
                        let mut text = String::from_utf8_lossy(&data).into_owned();
                        if text.ends_with('\n') {
                            text.pop();
                        }
                        pending.push(Pending::Item(Item::Text { text }));
                        pending.push(Pending::Item(Item::Command { tag }));
                    } else {
                        pending.push(Pending::Item(Item::Command { tag }));
                    }
                }
                Message::EmptyQueryResponse => {}
                Message::ErrorResponse(e) => {
                    let e = pgwire::parse_error(&e)?;
                    if let Some((cols, rows, count, _)) = cur.take() {
                        pending.push(Pending::Rows(cols, rows, count, None));
                    }
                    error = Some(e.clone());
                    pending.push(Pending::Item(Item::Error { error: e, offset }));
                }
                Message::NoticeResponse(n) => {
                    // Notices are shown immediately so long-running scripts show progress.
                    let item = Item::Notice { notice: pgwire::parse_notice(&n)? };
                    self.h.emit(json!({"type": "item", "entry_id": entry.id, "index": entry.items.len(), "item": item}));
                    entry.items.push(item);
                }
                Message::NotificationResponse(n) => pending.push(Pending::Item(Item::Notification {
                    pid: n.process_id(),
                    channel: n.channel()?.to_string(),
                    payload: n.message()?.to_string(),
                })),
                Message::CopyOutResponse(_) => copy_out = Some(Vec::new()),
                Message::CopyData(d) => {
                    if let Some(buf) = &mut copy_out
                        && buf.len() < 64 << 20
                    {
                        buf.extend_from_slice(d.data());
                    }
                }
                Message::CopyInResponse(_) => {
                    conn.send_copy_fail("COPY FROM STDIN is not supported here; use \\copy ... from 'file'").await?;
                }
                Message::ReadyForQuery(s) => {
                    conn.set_tx(s.status());
                    break;
                }
                _ => {}
            }
        }
        let oids: HashSet<u32> = pending
            .iter()
            .filter_map(|p| if let Pending::Rows(c, ..) = p { Some(c.iter().map(|c| c.type_oid)) } else { None })
            .flatten()
            .collect();
        self.resolve_types(&oids).await;
        for p in pending {
            let item = match p {
                Pending::Rows(cols, rows, count, tag) => self.make_rows_item(&cols, rows, count, tag, expanded, results),
                Pending::Item(i) => i,
            };
            self.push_item(entry, item);
        }
        match error {
            Some(e) => Err(Error::Db(e)),
            None => Ok(()),
        }
    }

    async fn gdesc(&mut self, entry: &mut Entry, text: &str, results: &mut Vec<(String, Arc<ResultData>)>) -> Result<(), Error> {
        let conn = self.conn.as_mut().ok_or_else(|| Error::Other("not connected".into()))?;
        let sql = text.trim_end().trim_end_matches(';');
        match conn.describe_statement(sql).await {
            Ok(Some(cols)) => {
                let values: Vec<String> = cols
                    .iter()
                    .map(|c| format!("({}, {}::pg_catalog.oid, {})", describe::lit(&c.name), c.type_oid, c.type_modifier))
                    .collect();
                let q = format!(
                    "SELECT name AS \"Column\", pg_catalog.format_type(tp, tpm) AS \"Type\" FROM (VALUES {}) s(name, tp, tpm)",
                    values.join(", ")
                );
                let (c, rows) = conn.query(&q).await?;
                let n = rows.len() as u64;
                let item = self.make_rows_item(&c, rows, n, None, false, results);
                self.push_item(entry, item);
                Ok(())
            }
            Ok(None) => {
                self.push_item(entry, Item::Text { text: "The command has no result, or the result has no columns.".into() });
                Ok(())
            }
            Err(e) => {
                self.push_item(entry, error_item(&e, None));
                Err(e)
            }
        }
    }

    async fn exec_meta(
        &mut self,
        entry: &mut Entry,
        name: &str,
        args: &str,
        _offset: usize,
        results: &mut Vec<(String, Arc<ResultData>)>,
        ddl: &mut bool,
    ) -> Result<(), Error> {
        let argv = lexer::split_args(args);
        let text = |s: String| Item::Text { text: s };
        match name {
            "?" => self.push_item(entry, text(describe::HELP.into())),
            "x" => {
                let mut s = self.h.shared.lock().unwrap().settings.clone();
                s.expanded = match argv.first().map(String::as_str) {
                    Some("on") => "on".into(),
                    Some("off") => "off".into(),
                    Some("auto") => "auto".into(),
                    Some(o) => {
                        let e = Error::Db(DbError::simple(format!("\\x: unrecognized value \"{o}\": Boolean expected")));
                        self.push_item(entry, error_item(&e, None));
                        return Err(e);
                    }
                    None => if s.expanded == "on" { "off".into() } else { "on".into() },
                };
                let msg = match s.expanded.as_str() {
                    "on" => "Expanded display is on.",
                    "auto" => "Expanded display is used automatically.",
                    _ => "Expanded display is off.",
                };
                let _ = self.app.store.save_settings(&self.h.id, &s);
                self.h.shared.lock().unwrap().settings = s.clone();
                self.h.emit(json!({"type": "settings", "settings": s}));
                self.push_item(entry, text(msg.into()));
            }
            "timing" => self.push_item(entry, text("Timing is always on in pgc.".into())),
            "echo" | "qecho" | "warn" => self.push_item(entry, text(argv.join(" "))),
            "q" | "quit" => self.push_item(entry, text("Close the browser tab to leave this session; it stays saved and can be resumed.".into())),
            "conninfo" => {
                let s = self.conninfo_text();
                self.push_item(entry, text(s));
            }
            "encoding" => {
                let enc = self.conn.as_ref().and_then(|c| c.server_params.get("client_encoding").cloned()).unwrap_or_default();
                self.push_item(entry, text(enc));
            }
            "c" | "connect" => return self.meta_connect(entry, &argv).await,
            "g" | "gx" | "G" => {
                let Some(sql) = self.last_sql.clone() else {
                    let e = Error::Db(DbError::simple("\\g: query buffer is empty"));
                    self.push_item(entry, error_item(&e, None));
                    return Err(e);
                };
                return self.exec_sql(entry, &sql, None, name != "g", results, ddl).await;
            }
            "h" | "help" => {
                let topic = argv.join(" ").to_lowercase();
                let s = if topic.is_empty() {
                    "SQL command reference: https://www.postgresql.org/docs/current/sql-commands.html".to_string()
                } else {
                    format!("https://www.postgresql.org/docs/current/sql-{}.html", topic.replace(' ', ""))
                };
                self.push_item(entry, text(s));
            }
            "copy" => return self.meta_copy(entry, args).await,
            "e" | "edit" | "ef" | "ev" | "!" | "watch" | "w" | "write" | "o" | "out" | "s" | "password" | "set" | "unset" | "pset" | "a" | "t" | "H" | "f" | "C" | "T"
            | "gset" | "gexec" | "if" | "elif" | "else" | "endif" | "prompt" | "setenv" | "cd" | "lo_import" | "lo_export" | "lo_list" | "lo_unlink" | "bind" | "crosstabview" => {
                let e = Error::Db(DbError::simple(format!("\\{name} is not supported in pgc")));
                self.push_item(entry, error_item(&e, None));
                return Err(e);
            }
            _ => {
                let conn = self.conn.as_mut().ok_or_else(|| Error::Other("not connected".into()))?;
                match describe::run(conn, name, &argv).await {
                    None => {
                        let e = Error::Db(DbError::simple(format!("invalid command \\{name}\nTry \\? for help.")));
                        self.push_item(entry, error_item(&e, None));
                        return Err(e);
                    }
                    Some(Err(e)) => {
                        self.push_item(entry, error_item(&e, None));
                        return Err(e);
                    }
                    Some(Ok(outputs)) => {
                        for o in outputs {
                            let item = match o {
                                Output::Text(t) => text(t),
                                Output::Table(t) => {
                                    let n = t.rows.len() as u64;
                                    let mut item = self.make_rows_item(&t.columns, t.rows, n, None, false, results);
                                    if let Item::Rows(r) = &mut item {
                                        r.title = t.title;
                                        r.footer = t.footer;
                                    }
                                    item
                                }
                            };
                            self.push_item(entry, item);
                        }
                    }
                }
            }
        }
        Ok(())
    }

    fn conninfo_text(&self) -> String {
        let Some(c) = &self.conn else { return "You are currently not connected to a database.".into() };
        let i = &c.info;
        let mut s = if i.unix_socket {
            format!("You are connected to database \"{}\" as user \"{}\" via socket in \"{}\" at port \"{}\".", i.dbname, i.user, i.host, i.port)
        } else if let Some(addr) = &i.hostaddr {
            format!("You are connected to database \"{}\" as user \"{}\" on host \"{}\" (address \"{addr}\") at port \"{}\".", i.dbname, i.user, i.host, i.port)
        } else {
            format!("You are connected to database \"{}\" as user \"{}\" on host \"{}\" at port \"{}\".", i.dbname, i.user, i.host, i.port)
        };
        if let Some(t) = &i.tls {
            s.push_str(&format!("\nSSL connection (protocol: {t})"));
        }
        if let Some(v) = c.server_params.get("server_version") {
            s.push_str(&format!("\nServer version: {v}, backend PID {}", i.process_id));
        }
        s
    }

    async fn meta_connect(&mut self, entry: &mut Entry, argv: &[String]) -> Result<(), Error> {
        let mut params = self.params.clone();
        let first = argv.first().map(String::as_str).unwrap_or("");
        if argv.len() == 1 && (first.contains('=') || first.starts_with("postgres")) {
            let p = conninfo::parse(first).map_err(|e| Error::Other(e.to_string()));
            match p {
                Ok(p) => {
                    // A new conninfo replaces connection settings, keeping the
                    // ones it doesn't mention (as psql does).
                    for (k, v) in p {
                        params.insert(k, v);
                    }
                }
                Err(e) => {
                    self.push_item(entry, error_item(&e, None));
                    return Err(e);
                }
            }
        } else {
            for (i, key) in ["dbname", "user", "host", "port"].iter().enumerate() {
                match argv.get(i).map(String::as_str) {
                    None | Some("-") => {}
                    Some(v) => {
                        params.insert(key.to_string(), v.to_string());
                    }
                }
            }
        }
        // Keep the resolved settings of the current connection for the parts
        // not overridden.
        if let Some(c) = &self.conn {
            let i = &c.info;
            params.entry("user".into()).or_insert(i.user.clone());
            params.entry("host".into()).or_insert(i.host.clone());
            params.entry("port".into()).or_insert(i.port.to_string());
        }
        let old_params = std::mem::replace(&mut self.params, params);
        let old_conn = self.conn.take();
        match self.connect().await {
            Ok(()) => {
                if let Some(c) = old_conn {
                    c.terminate().await;
                }
                let i = &self.conn.as_ref().unwrap().info;
                let msg = format!("You are now connected to database \"{}\" as user \"{}\".", i.dbname, i.user);
                entry.conn_label = self.conn_label();
                self.push_item(entry, Item::Text { text: msg });
                Ok(())
            }
            Err(Error::NeedPassword) => {
                if let Some(c) = old_conn {
                    c.terminate().await;
                }
                let e = Error::Other("password required: enter it to connect".into());
                self.push_item(entry, error_item(&e, None));
                Err(e)
            }
            Err(e) => {
                // Like psql, stay on the previous connection if the new one fails.
                self.params = old_params;
                let had_conn = old_conn.is_some();
                self.conn = old_conn;
                if had_conn {
                    self.publish_conn();
                }
                let e = Error::Other(if had_conn { format!("{e}\nPrevious connection kept") } else { e.to_string() });
                self.push_item(entry, error_item(&e, None));
                Err(e)
            }
        }
    }

    /// Client-side COPY: `\copy table|(query) from|to 'file' [options]`.
    async fn meta_copy(&mut self, entry: &mut Entry, args: &str) -> Result<(), Error> {
        let parsed = parse_copy(args);
        let (target, dir, file, opts) = match parsed {
            Some(p) => p,
            None => {
                let e = Error::Db(DbError::simple("\\copy: parse error; expected \\copy table|(query) from|to 'file'"));
                self.push_item(entry, error_item(&e, None));
                return Err(e);
            }
        };
        let conn = self.conn.as_mut().ok_or_else(|| Error::Other("not connected".into()))?;
        let to = dir == "to";
        let is_std = matches!(file.to_lowercase().as_str(), "stdin" | "stdout" | "pstdin" | "pstdout");
        let sql = format!("COPY {target} {} {opts}", if to { "TO STDOUT" } else { "FROM STDIN" });
        let path = expand_home(&file);
        let mut input = None;
        if !to {
            if is_std {
                let e = Error::Db(DbError::simple("\\copy from stdin is not supported in pgc; copy from a file instead"));
                self.push_item(entry, error_item(&e, None));
                return Err(e);
            }
            match std::fs::read(&path) {
                Ok(d) => input = Some(d),
                Err(e) => {
                    let e = Error::Other(format!("{file}: {e}"));
                    self.push_item(entry, error_item(&e, None));
                    return Err(e);
                }
            }
        }
        conn.send_query(&sql).await?;
        let mut out: Vec<u8> = Vec::new();
        let mut error = None;
        let mut tag = None;
        loop {
            match conn.recv().await? {
                Message::CopyInResponse(_) => {
                    if let Some(data) = input.take() {
                        for chunk in data.chunks(64 * 1024) {
                            conn.send_copy_data(chunk).await?;
                        }
                    }
                    conn.send_copy_done().await?;
                }
                Message::CopyData(d) => out.extend_from_slice(d.data()),
                Message::CommandComplete(c) => tag = Some(c.tag()?.to_string()),
                Message::ErrorResponse(e) => error = Some(pgwire::parse_error(&e)?),
                Message::NoticeResponse(n) => {
                    let item = Item::Notice { notice: pgwire::parse_notice(&n)? };
                    self.h.emit(json!({"type": "item", "entry_id": entry.id, "index": entry.items.len(), "item": item}));
                    entry.items.push(item);
                }
                Message::ReadyForQuery(s) => {
                    conn.set_tx(s.status());
                    break;
                }
                _ => {}
            }
        }
        if let Some(e) = error {
            self.push_item(entry, Item::Error { error: e.clone(), offset: None });
            return Err(Error::Db(e));
        }
        if to {
            if is_std {
                let mut t = String::from_utf8_lossy(&out).into_owned();
                if t.ends_with('\n') {
                    t.pop();
                }
                self.push_item(entry, Item::Text { text: t });
            } else if let Err(e) = std::fs::write(&path, &out) {
                let e = Error::Other(format!("{file}: {e}"));
                self.push_item(entry, error_item(&e, None));
                return Err(e);
            }
        }
        if let Some(tag) = tag {
            let tag = if !is_std { format!("{tag}  ({} {})", if to { "written to" } else { "read from" }, path) } else { tag };
            self.push_item(entry, Item::Command { tag });
        }
        Ok(())
    }
}

fn expand_home(p: &str) -> String {
    let p = p.trim().trim_matches('\'');
    match (p.strip_prefix("~/"), dirs::home_dir()) {
        (Some(rest), Some(h)) => h.join(rest).display().to_string(),
        _ => p.to_string(),
    }
}

/// Split `\copy` arguments into (target, "from"|"to", file, options).
fn parse_copy(args: &str) -> Option<(String, String, String, String)> {
    let chars: Vec<char> = args.chars().collect();
    let mut depth = 0;
    let mut in_q = false;
    let mut in_dq = false;
    let mut i = 0;
    let lower: Vec<char> = args.to_lowercase().chars().collect();
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\'' if !in_dq => in_q = !in_q,
            '"' if !in_q => in_dq = !in_dq,
            '(' if !in_q && !in_dq => depth += 1,
            ')' if !in_q && !in_dq => depth -= 1,
            c if c.is_whitespace() && depth == 0 && !in_q && !in_dq => {
                for kw in ["from", "to"] {
                    let end = i + 1 + kw.len();
                    if end <= chars.len()
                        && lower[i + 1..end].iter().collect::<String>() == kw
                        && (end == chars.len() || chars[end].is_whitespace())
                    {
                        let target = chars[..i].iter().collect::<String>().trim().to_string();
                        let rest: String = chars[end..].iter().collect::<String>().trim().to_string();
                        let (file, opts) = if let Some(r) = rest.strip_prefix('\'') {
                            let close = r.find('\'')?;
                            (r[..close].to_string(), r[close + 1..].trim().to_string())
                        } else {
                            match rest.split_once(char::is_whitespace) {
                                Some((f, o)) => (f.to_string(), o.trim().to_string()),
                                None => (rest.clone(), String::new()),
                            }
                        };
                        if target.is_empty() || file.is_empty() {
                            return None;
                        }
                        return Some((target, kw.to_string(), file, opts));
                    }
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Load catalog information used for completions in the editor.
async fn load_meta(c: &mut Conn) -> Value {
    async fn q(c: &mut Conn, sql: &str) -> Vec<Row> {
        match c.query(sql).await {
            Ok((_, rows)) => rows,
            Err(e) => {
                tracing::debug!("meta query failed: {e}");
                vec![]
            }
        }
    }
    let s = |r: &Row, i: usize| r.get(i).cloned().flatten().unwrap_or_default();
    let rels = q(
        c,
        "SELECT n.nspname, c.relname, c.relkind, \
         coalesce(pg_catalog.string_agg(a.attname || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod), E'\\n' ORDER BY a.attnum), '') \
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped \
         WHERE c.relkind IN ('r','p','v','m','f','S') AND n.nspname !~ '^pg_toast' AND n.nspname !~ '^pg_temp_' \
         GROUP BY 1, 2, 3 ORDER BY 1, 2 LIMIT 20000",
    )
    .await;
    let relations: Vec<Value> = rels
        .iter()
        .map(|r| {
            let cols: Vec<Value> = s(r, 3)
                .lines()
                .filter_map(|l| l.split_once(' ').map(|(n, t)| json!([n, t])))
                .collect();
            json!({"schema": s(r, 0), "name": s(r, 1), "kind": s(r, 2), "columns": cols})
        })
        .collect();
    let funcs = q(
        c,
        "SELECT n.nspname, p.proname, pg_catalog.min(p.prokind::text), pg_catalog.min(pg_catalog.pg_get_function_identity_arguments(p.oid)) \
         FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
         WHERE n.nspname !~ '^pg_toast' GROUP BY 1, 2 ORDER BY 1, 2 LIMIT 20000",
    )
    .await;
    let functions: Vec<Value> = funcs.iter().map(|r| json!({"schema": s(r, 0), "name": s(r, 1), "kind": s(r, 2), "args": s(r, 3)})).collect();
    let search_path: Vec<String> = q(c, "SELECT pg_catalog.unnest(pg_catalog.current_schemas(true))").await.iter().map(|r| s(r, 0)).collect();
    let schemas: Vec<String> = q(c, "SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname !~ '^pg_toast' AND nspname !~ '^pg_temp_' ORDER BY 1")
        .await
        .iter()
        .map(|r| s(r, 0))
        .collect();
    let databases: Vec<String> = q(c, "SELECT datname FROM pg_catalog.pg_database WHERE datallowconn ORDER BY 1").await.iter().map(|r| s(r, 0)).collect();
    let roles: Vec<String> = q(c, "SELECT rolname FROM pg_catalog.pg_roles ORDER BY 1").await.iter().map(|r| s(r, 0)).collect();
    let types: Vec<Value> = q(
        c,
        "SELECT n.nspname, t.typname FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace \
         WHERE (t.typrelid = 0 OR (SELECT c.relkind = 'c' FROM pg_catalog.pg_class c WHERE c.oid = t.typrelid)) \
         AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_type el WHERE el.oid = t.typelem AND el.typarray = t.oid) \
         AND n.nspname !~ '^pg_toast' AND t.typname !~ '^_' ORDER BY 1, 2 LIMIT 5000",
    )
    .await
    .iter()
    .map(|r| json!([s(r, 0), s(r, 1)]))
    .collect();
    let keywords: Vec<Value> = q(c, "SELECT word, catcode FROM pg_catalog.pg_get_keywords() ORDER BY 1").await.iter().map(|r| json!([s(r, 0), s(r, 1)])).collect();
    json!({
        "relations": relations,
        "functions": functions,
        "search_path": search_path,
        "schemas": schemas,
        "databases": databases,
        "roles": roles,
        "types": types,
        "keywords": keywords,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_args() {
        assert_eq!(
            parse_copy("users to '/tmp/u.csv' with csv header"),
            Some(("users".into(), "to".into(), "/tmp/u.csv".into(), "with csv header".into()))
        );
        assert_eq!(
            parse_copy("(select 1 from t) TO stdout"),
            Some(("(select 1 from t)".into(), "to".into(), "stdout".into(), "".into()))
        );
        assert_eq!(parse_copy("t(a, b) from data.csv csv"), Some(("t(a, b)".into(), "from".into(), "data.csv".into(), "csv".into())));
        assert_eq!(parse_copy("nothing"), None);
    }
}
