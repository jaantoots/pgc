//! Persistence: sessions, displayed entries, stored result rows and the full
//! query history live in a SQLite database in the user's data directory.

use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::pgwire::{DbError, Row};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnOut {
    pub name: String,
    pub type_oid: u32,
    pub type_name: String,
    pub numeric: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RowsItem {
    pub result_id: String,
    pub columns: Vec<ColumnOut>,
    /// The first rows, sent inline. More are fetched on demand.
    pub rows: Vec<Row>,
    /// Rows returned by the server.
    pub row_count: u64,
    /// Rows we kept (and can serve); less than row_count if truncated.
    pub stored: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub footer: Vec<String>,
    #[serde(default)]
    pub expanded: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Item {
    Rows(RowsItem),
    Command {
        tag: String,
    },
    Notice {
        notice: DbError,
    },
    Error {
        error: DbError,
        /// Character offset of the failing statement within the entry text.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        offset: Option<usize>,
    },
    Text {
        text: String,
    },
    Notification {
        pid: i32,
        channel: String,
        payload: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    pub session_id: String,
    pub seq: i64,
    pub sql: String,
    pub status: String,
    pub started_at: i64,
    pub duration_ms: Option<f64>,
    pub items: Vec<Item>,
    pub conn_label: String,
    /// How many times this entry has been (re-)run.
    pub runs: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Settings {
    #[serde(default = "default_expanded")]
    pub expanded: String,
}

fn default_expanded() -> String {
    "off".into()
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionRow {
    pub id: String,
    pub name: Option<String>,
    pub conninfo: String,
    pub conn_label: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub settings: Settings,
    pub entry_count: i64,
    pub last_sql: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HistoryRow {
    pub id: i64,
    pub session_id: String,
    pub entry_id: Option<String>,
    pub sql: String,
    pub executed_at: i64,
    pub duration_ms: Option<f64>,
    pub status: String,
    pub conn_label: String,
}

pub struct ResultData {
    pub columns: Vec<ColumnOut>,
    pub rows: Vec<Row>,
    pub row_count: u64,
}

impl ResultData {
    fn approx_bytes(&self) -> usize {
        self.rows.iter().map(|r| 24 + r.iter().map(|v| v.as_ref().map_or(8, |s| s.len() + 24)).sum::<usize>()).sum()
    }
}

/// Recently produced results kept in memory for paging, copying and export.
pub struct ResultCache {
    map: HashMap<String, (Arc<ResultData>, usize)>,
    order: VecDeque<String>,
    bytes: usize,
    limit: usize,
}

impl ResultCache {
    pub fn new(limit: usize) -> ResultCache {
        ResultCache { map: HashMap::new(), order: VecDeque::new(), bytes: 0, limit }
    }

    pub fn insert(&mut self, id: String, data: Arc<ResultData>) {
        let size = data.approx_bytes();
        if let Some((_, old)) = self.map.insert(id.clone(), (data, size)) {
            self.bytes -= old;
            self.order.retain(|x| x != &id);
        }
        self.bytes += size;
        self.order.push_back(id);
        while self.bytes > self.limit && self.order.len() > 1 {
            if let Some(old) = self.order.pop_front()
                && let Some((_, s)) = self.map.remove(&old)
            {
                self.bytes -= s;
            }
        }
    }

    pub fn get(&mut self, id: &str) -> Option<Arc<ResultData>> {
        let d = self.map.get(id)?.0.clone();
        self.order.retain(|x| x != id);
        self.order.push_back(id.to_string());
        Some(d)
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub struct Store {
    db: Mutex<Connection>,
    pub cache: Mutex<ResultCache>,
    /// Max rows persisted per result set.
    pub persist_rows: usize,
    pub persist_bytes: usize,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    name TEXT,
    conninfo TEXT NOT NULL,
    conn_label TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    settings TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    sql TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    duration_ms REAL,
    items TEXT NOT NULL,
    conn_label TEXT NOT NULL DEFAULT '',
    runs INTEGER NOT NULL DEFAULT 1,
    hidden INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS entries_session ON entries(session_id, seq);
CREATE TABLE IF NOT EXISTS results (
    id TEXT PRIMARY KEY,
    entry_id TEXT NOT NULL,
    columns TEXT NOT NULL,
    rows TEXT NOT NULL,
    row_count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS results_entry ON results(entry_id);
CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    entry_id TEXT,
    sql TEXT NOT NULL,
    executed_at INTEGER NOT NULL,
    duration_ms REAL,
    status TEXT NOT NULL,
    conn_label TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS history_time ON history(executed_at);
"#;

impl Store {
    pub fn open(path: &Path) -> Result<Store> {
        let db = Connection::open(path)?;
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.pragma_update(None, "foreign_keys", "ON")?;
        db.pragma_update(None, "synchronous", "NORMAL")?;
        db.execute_batch(SCHEMA)?;
        // Anything still "running" was interrupted by a previous shutdown.
        db.execute("UPDATE entries SET status = 'interrupted' WHERE status = 'running'", [])?;
        Ok(Store { db: Mutex::new(db), cache: Mutex::new(ResultCache::new(1 << 30)), persist_rows: 20_000, persist_bytes: 16 << 20 })
    }

    #[cfg(test)]
    pub fn memory() -> Store {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(SCHEMA).unwrap();
        Store { db: Mutex::new(db), cache: Mutex::new(ResultCache::new(1 << 20)), persist_rows: 100, persist_bytes: 1 << 20 }
    }

    pub fn ensure_session(&self, id: &str, conninfo: &str) -> Result<()> {
        let db = self.db.lock().unwrap();
        let now = now_ms();
        db.execute(
            "INSERT INTO sessions (id, conninfo, created_at, updated_at) VALUES (?1, ?2, ?3, ?3) ON CONFLICT(id) DO NOTHING",
            params![id, conninfo, now],
        )?;
        Ok(())
    }

    pub fn update_session_conn(&self, id: &str, conninfo: &str, label: &str) -> Result<()> {
        let db = self.db.lock().unwrap();
        db.execute("UPDATE sessions SET conninfo = ?2, conn_label = ?3 WHERE id = ?1", params![id, conninfo, label])?;
        Ok(())
    }

    pub fn rename_session(&self, id: &str, name: Option<&str>) -> Result<()> {
        let db = self.db.lock().unwrap();
        db.execute("UPDATE sessions SET name = ?2 WHERE id = ?1", params![id, name])?;
        Ok(())
    }

    pub fn save_settings(&self, id: &str, s: &Settings) -> Result<()> {
        let db = self.db.lock().unwrap();
        db.execute("UPDATE sessions SET settings = ?2 WHERE id = ?1", params![id, serde_json::to_string(s)?])?;
        Ok(())
    }

    pub fn delete_session(&self, id: &str) -> Result<()> {
        let db = self.db.lock().unwrap();
        db.execute("DELETE FROM results WHERE entry_id IN (SELECT id FROM entries WHERE session_id = ?1)", [id])?;
        db.execute("DELETE FROM sessions WHERE id = ?1", [id])?;
        Ok(())
    }

    fn session_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<SessionRow> {
        let settings: String = r.get(6)?;
        Ok(SessionRow {
            id: r.get(0)?,
            name: r.get(1)?,
            conninfo: r.get(2)?,
            conn_label: r.get(3)?,
            created_at: r.get(4)?,
            updated_at: r.get(5)?,
            settings: serde_json::from_str(&settings).unwrap_or_default(),
            entry_count: r.get(7)?,
            last_sql: r.get(8)?,
        })
    }

    const SESSION_COLS: &str = "s.id, s.name, s.conninfo, s.conn_label, s.created_at, s.updated_at, s.settings, \
        (SELECT count(*) FROM entries e WHERE e.session_id = s.id AND NOT e.hidden), \
        (SELECT e.sql FROM entries e WHERE e.session_id = s.id AND NOT e.hidden AND e.sql <> '' ORDER BY e.seq DESC LIMIT 1)";

    pub fn get_session(&self, id: &str) -> Result<Option<SessionRow>> {
        let db = self.db.lock().unwrap();
        let sql = format!("SELECT {} FROM sessions s WHERE s.id = ?1", Self::SESSION_COLS);
        Ok(db.query_row(&sql, [id], Self::session_from_row).optional()?)
    }

    pub fn list_sessions(&self, limit: i64) -> Result<Vec<SessionRow>> {
        let db = self.db.lock().unwrap();
        let sql = format!(
            "SELECT {} FROM sessions s WHERE EXISTS (SELECT 1 FROM entries e WHERE e.session_id = s.id) ORDER BY s.updated_at DESC LIMIT ?1",
            Self::SESSION_COLS
        );
        let mut st = db.prepare(&sql)?;
        let rows = st.query_map([limit], Self::session_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Remove sessions that never ran anything and are older than a day.
    pub fn gc_empty_sessions(&self) -> Result<()> {
        let db = self.db.lock().unwrap();
        db.execute(
            "DELETE FROM sessions WHERE updated_at < ?1 AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.session_id = sessions.id)",
            [now_ms() - 86_400_000],
        )?;
        Ok(())
    }

    pub fn next_seq(&self, session_id: &str) -> Result<i64> {
        let db = self.db.lock().unwrap();
        Ok(db.query_row("SELECT coalesce(max(seq), 0) + 1 FROM entries WHERE session_id = ?1", [session_id], |r| r.get(0))?)
    }

    pub fn get_entry(&self, id: &str) -> Result<Option<Entry>> {
        let db = self.db.lock().unwrap();
        Ok(db
            .query_row(
                "SELECT id, session_id, seq, sql, status, started_at, duration_ms, items, conn_label, runs FROM entries WHERE id = ?1 AND NOT hidden",
                [id],
                Self::entry_from_row,
            )
            .optional()?)
    }

    fn entry_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Entry> {
        let items: String = r.get(7)?;
        Ok(Entry {
            id: r.get(0)?,
            session_id: r.get(1)?,
            seq: r.get(2)?,
            sql: r.get(3)?,
            status: r.get(4)?,
            started_at: r.get(5)?,
            duration_ms: r.get(6)?,
            items: serde_json::from_str(&items).unwrap_or_default(),
            conn_label: r.get(8)?,
            runs: r.get(9)?,
        })
    }

    pub fn list_entries(&self, session_id: &str) -> Result<Vec<Entry>> {
        let db = self.db.lock().unwrap();
        let mut st = db.prepare(
            "SELECT id, session_id, seq, sql, status, started_at, duration_ms, items, conn_label, runs FROM entries WHERE session_id = ?1 AND NOT hidden ORDER BY seq",
        )?;
        let rows = st.query_map([session_id], Self::entry_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn save_entry(&self, e: &Entry) -> Result<()> {
        let db = self.db.lock().unwrap();
        db.execute(
            "INSERT INTO entries (id, session_id, seq, sql, status, started_at, duration_ms, items, conn_label, runs) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) \
             ON CONFLICT(id) DO UPDATE SET sql = ?4, status = ?5, started_at = ?6, duration_ms = ?7, items = ?8, conn_label = ?9, runs = ?10",
            params![e.id, e.session_id, e.seq, e.sql, e.status, e.started_at, e.duration_ms, serde_json::to_string(&e.items)?, e.conn_label, e.runs],
        )?;
        db.execute("UPDATE sessions SET updated_at = ?2 WHERE id = ?1", params![e.session_id, now_ms()])?;
        Ok(())
    }

    pub fn hide_entry(&self, id: &str) -> Result<()> {
        let db = self.db.lock().unwrap();
        db.execute("UPDATE entries SET hidden = 1 WHERE id = ?1", [id])?;
        db.execute("DELETE FROM results WHERE entry_id = ?1", [id])?;
        Ok(())
    }

    pub fn delete_results_for_entry(&self, entry_id: &str) -> Result<()> {
        let db = self.db.lock().unwrap();
        db.execute("DELETE FROM results WHERE entry_id = ?1", [entry_id])?;
        Ok(())
    }

    /// Persist (a prefix of) a result's rows and cache all of it in memory.
    pub fn save_result(&self, id: &str, entry_id: &str, data: Arc<ResultData>) -> Result<()> {
        let mut bytes = 0;
        let mut n = 0;
        for r in data.rows.iter().take(self.persist_rows) {
            bytes += r.iter().map(|v| v.as_ref().map_or(5, |s| s.len() + 3)).sum::<usize>();
            if bytes > self.persist_bytes {
                break;
            }
            n += 1;
        }
        let rows_json = serde_json::to_string(&data.rows[..n])?;
        {
            let db = self.db.lock().unwrap();
            db.execute(
                "INSERT OR REPLACE INTO results (id, entry_id, columns, rows, row_count) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, entry_id, serde_json::to_string(&data.columns)?, rows_json, data.row_count as i64],
            )?;
        }
        self.cache.lock().unwrap().insert(id.to_string(), data);
        Ok(())
    }

    /// Get a result, from memory or from the database.
    pub fn get_result(&self, id: &str) -> Result<Option<Arc<ResultData>>> {
        if let Some(d) = self.cache.lock().unwrap().get(id) {
            return Ok(Some(d));
        }
        let row = {
            let db = self.db.lock().unwrap();
            db.query_row("SELECT columns, rows, row_count FROM results WHERE id = ?1", [id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
            })
            .optional()?
        };
        let Some((cols, rows, count)) = row else { return Ok(None) };
        let data =
            Arc::new(ResultData { columns: serde_json::from_str(&cols)?, rows: serde_json::from_str(&rows)?, row_count: count as u64 });
        self.cache.lock().unwrap().insert(id.to_string(), data.clone());
        Ok(Some(data))
    }

    pub fn add_history(&self, h: &HistoryRow) -> Result<()> {
        let db = self.db.lock().unwrap();
        db.execute(
            "INSERT INTO history (session_id, entry_id, sql, executed_at, duration_ms, status, conn_label) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![h.session_id, h.entry_id, h.sql, h.executed_at, h.duration_ms, h.status, h.conn_label],
        )?;
        Ok(())
    }

    /// Search the full history, newest first, de-duplicated by text.
    pub fn search_history(&self, q: &str, session_id: Option<&str>, limit: i64) -> Result<Vec<HistoryRow>> {
        let db = self.db.lock().unwrap();
        let pattern = format!("%{}%", q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
        let mut st = db.prepare(
            "SELECT h.id, h.session_id, h.entry_id, h.sql, h.executed_at, h.duration_ms, h.status, h.conn_label FROM history h \
             JOIN (SELECT max(id) AS id FROM history WHERE sql LIKE ?1 ESCAPE '\\' AND (?2 IS NULL OR session_id = ?2) GROUP BY sql) m ON m.id = h.id \
             ORDER BY h.id DESC LIMIT ?3",
        )?;
        let rows = st
            .query_map(params![pattern, session_id, limit], |r| {
                Ok(HistoryRow {
                    id: r.get(0)?,
                    session_id: r.get(1)?,
                    entry_id: r.get(2)?,
                    sql: r.get(3)?,
                    executed_at: r.get(4)?,
                    duration_ms: r.get(5)?,
                    status: r.get(6)?,
                    conn_label: r.get(7)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let s = Store::memory();
        s.ensure_session("s1", "dbname=x").unwrap();
        let e = Entry {
            id: "e1".into(),
            session_id: "s1".into(),
            seq: s.next_seq("s1").unwrap(),
            sql: "select 1".into(),
            status: "ok".into(),
            started_at: 1,
            duration_ms: Some(1.5),
            items: vec![Item::Command { tag: "SELECT 1".into() }],
            conn_label: "x".into(),
            runs: 1,
        };
        s.save_entry(&e).unwrap();
        assert_eq!(s.list_entries("s1").unwrap().len(), 1);
        assert_eq!(s.list_sessions(10).unwrap()[0].last_sql.as_deref(), Some("select 1"));
        let rows: Vec<Row> = (0..200).map(|i| vec![Some(i.to_string()), None]).collect();
        s.save_result("r1", "e1", Arc::new(ResultData { columns: vec![], rows, row_count: 200 })).unwrap();
        s.cache.lock().unwrap().map.clear();
        let r = s.get_result("r1").unwrap().unwrap();
        assert_eq!(r.rows.len(), 100);
        assert_eq!(r.row_count, 200);
        s.add_history(&HistoryRow {
            id: 0,
            session_id: "s1".into(),
            entry_id: None,
            sql: "select 100%".into(),
            executed_at: 1,
            duration_ms: None,
            status: "ok".into(),
            conn_label: "".into(),
        })
        .unwrap();
        assert_eq!(s.search_history("100%", None, 10).unwrap().len(), 1);
        assert_eq!(s.search_history("x%", None, 10).unwrap().len(), 0);
    }
}
