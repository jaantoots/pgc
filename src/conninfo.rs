//! Connection parameter handling compatible with libpq: conninfo strings,
//! postgresql:// URIs, PG* environment variables, pg_service.conf and .pgpass.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};

/// Keywords we understand (a subset of libpq's).
const KEYWORDS: &[&str] = &[
    "host",
    "hostaddr",
    "port",
    "dbname",
    "user",
    "password",
    "passfile",
    "service",
    "sslmode",
    "sslrootcert",
    "sslcert",
    "sslkey",
    "application_name",
    "fallback_application_name",
    "options",
    "connect_timeout",
    "client_encoding",
    "target_session_attrs",
    "channel_binding",
    "sslnegotiation",
    "gssencmode",
    "keepalives",
];

/// Environment variables mapped to keywords, like libpq.
const ENV_VARS: &[(&str, &str)] = &[
    ("host", "PGHOST"),
    ("hostaddr", "PGHOSTADDR"),
    ("port", "PGPORT"),
    ("dbname", "PGDATABASE"),
    ("user", "PGUSER"),
    ("password", "PGPASSWORD"),
    ("passfile", "PGPASSFILE"),
    ("service", "PGSERVICE"),
    ("sslmode", "PGSSLMODE"),
    ("sslrootcert", "PGSSLROOTCERT"),
    ("sslcert", "PGSSLCERT"),
    ("sslkey", "PGSSLKEY"),
    ("application_name", "PGAPPNAME"),
    ("options", "PGOPTIONS"),
    ("connect_timeout", "PGCONNECT_TIMEOUT"),
    ("target_session_attrs", "PGTARGETSESSIONATTRS"),
];

pub type Params = BTreeMap<String, String>;

/// Parse either a `key=value` conninfo string or a `postgresql://` URI.
pub fn parse(s: &str) -> Result<Params> {
    let t = s.trim();
    if t.starts_with("postgresql://") || t.starts_with("postgres://") {
        parse_uri(t)
    } else if t.is_empty() {
        Ok(Params::new())
    } else if t.contains('=') {
        parse_kv(t)
    } else {
        // A bare word is a database name, like `psql mydb`.
        Ok(Params::from([("dbname".to_string(), t.to_string())]))
    }
}

fn check_keyword(k: &str) -> Result<()> {
    if KEYWORDS.contains(&k) {
        Ok(())
    } else {
        bail!("invalid connection option \"{k}\"")
    }
}

fn parse_kv(s: &str) -> Result<Params> {
    let mut out = Params::new();
    let mut chars = s.chars().peekable();
    loop {
        while chars.peek().is_some_and(|c| c.is_whitespace()) {
            chars.next();
        }
        if chars.peek().is_none() {
            break;
        }
        let mut key = String::new();
        while let Some(&c) = chars.peek() {
            if c == '=' || c.is_whitespace() {
                break;
            }
            key.push(c);
            chars.next();
        }
        while chars.peek().is_some_and(|c| c.is_whitespace()) {
            chars.next();
        }
        if chars.next() != Some('=') {
            bail!("missing \"=\" after \"{key}\" in connection info string");
        }
        while chars.peek().is_some_and(|c| c.is_whitespace()) {
            chars.next();
        }
        let mut val = String::new();
        if chars.peek() == Some(&'\'') {
            chars.next();
            let mut closed = false;
            while let Some(c) = chars.next() {
                match c {
                    '\\' => {
                        if let Some(n) = chars.next() {
                            val.push(n);
                        }
                    }
                    '\'' => {
                        closed = true;
                        break;
                    }
                    c => val.push(c),
                }
            }
            if !closed {
                bail!("unterminated quoted string in connection info string");
            }
        } else {
            while let Some(&c) = chars.peek() {
                if c.is_whitespace() {
                    break;
                }
                chars.next();
                if c == '\\' {
                    if let Some(n) = chars.next() {
                        val.push(n);
                    }
                } else {
                    val.push(c);
                }
            }
        }
        check_keyword(&key)?;
        out.insert(key, val);
    }
    Ok(out)
}

fn percent_decode(s: &str) -> Result<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3).ok_or_else(|| anyhow!("invalid percent-encoded token: \"{s}\""))?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| anyhow!("invalid percent-encoded token: \"{s}\""))?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).context("invalid UTF-8 in URI")
}

fn parse_uri(s: &str) -> Result<Params> {
    let mut out = Params::new();
    let rest = s.split_once("://").map(|x| x.1).unwrap_or("");
    let (main, query) = match rest.split_once('?') {
        Some((m, q)) => (m, Some(q)),
        None => (rest, None),
    };
    let (authority, path) = match main.find('/') {
        Some(i) => (&main[..i], Some(&main[i + 1..])),
        None => (main, None),
    };
    let hostspec = match authority.rfind('@') {
        Some(i) => {
            let userinfo = &authority[..i];
            match userinfo.split_once(':') {
                Some((u, p)) => {
                    out.insert("user".into(), percent_decode(u)?);
                    out.insert("password".into(), percent_decode(p)?);
                }
                None if !userinfo.is_empty() => {
                    out.insert("user".into(), percent_decode(userinfo)?);
                }
                None => {}
            }
            &authority[i + 1..]
        }
        None => authority,
    };
    if !hostspec.is_empty() {
        let mut hosts = Vec::new();
        let mut ports = Vec::new();
        for h in hostspec.split(',') {
            let (host, port) = if let Some(r) = h.strip_prefix('[') {
                let end = r.find(']').ok_or_else(|| anyhow!("missing \"]\" in URI"))?;
                let port = r[end + 1..].strip_prefix(':').unwrap_or("");
                (&r[..end], port)
            } else {
                match h.rsplit_once(':') {
                    Some((h, p)) => (h, p),
                    None => (h, ""),
                }
            };
            hosts.push(percent_decode(host)?);
            ports.push(port.to_string());
        }
        if hosts.iter().any(|h| !h.is_empty()) {
            out.insert("host".into(), hosts.join(","));
        }
        if ports.iter().any(|p| !p.is_empty()) {
            out.insert("port".into(), ports.join(","));
        }
    }
    if let Some(p) = path
        && !p.is_empty()
    {
        out.insert("dbname".into(), percent_decode(p)?);
    }
    if let Some(q) = query {
        for kv in q.split('&').filter(|s| !s.is_empty()) {
            let (k, v) = kv.split_once('=').ok_or_else(|| anyhow!("missing key/value separator \"=\" in URI query parameter: \"{kv}\""))?;
            let k = match k {
                "ssl" if v == "true" => {
                    out.insert("sslmode".into(), "require".into());
                    continue;
                }
                k => k,
            };
            check_keyword(k)?;
            out.insert(k.to_string(), percent_decode(v)?);
        }
    }
    Ok(out)
}

/// Format params back into a conninfo string (password omitted unless asked).
pub fn to_string(p: &Params, with_password: bool) -> String {
    p.iter()
        .filter(|(k, _)| with_password || k.as_str() != "password")
        .map(|(k, v)| {
            if !v.is_empty() && !v.chars().any(|c| c.is_whitespace() || c == '\'' || c == '\\') {
                format!("{k}={v}")
            } else {
                format!("{k}='{}'", v.replace('\\', "\\\\").replace('\'', "\\'"))
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn home() -> Option<PathBuf> {
    dirs::home_dir()
}

/// Candidate system configuration directories for pg_service.conf.
fn sysconfdirs() -> Vec<PathBuf> {
    if let Ok(d) = std::env::var("PGSYSCONFDIR") {
        return vec![PathBuf::from(d)];
    }
    ["/etc/postgresql-common", "/etc/sysconfig/pgsql", "/usr/local/etc", "/opt/homebrew/etc", "/etc"]
        .iter()
        .map(PathBuf::from)
        .collect()
}

fn service_files() -> Vec<PathBuf> {
    let mut files = Vec::new();
    match std::env::var("PGSERVICEFILE") {
        Ok(f) => files.push(PathBuf::from(f)),
        Err(_) => {
            if let Some(h) = home() {
                files.push(h.join(".pg_service.conf"));
            }
        }
    }
    for d in sysconfdirs() {
        files.push(d.join("pg_service.conf"));
    }
    files
}

/// Parse an ini-style service file into service name -> params.
fn parse_service_file(path: &Path) -> Result<BTreeMap<String, Params>> {
    let text = std::fs::read_to_string(path)?;
    let mut out: BTreeMap<String, Params> = BTreeMap::new();
    let mut current: Option<String> = None;
    for (n, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            current = Some(name.to_string());
            out.entry(name.to_string()).or_default();
        } else if let Some(svc) = &current {
            let (k, v) = line
                .split_once('=')
                .ok_or_else(|| anyhow!("syntax error in service file \"{}\", line {}", path.display(), n + 1))?;
            out.get_mut(svc).unwrap().insert(k.trim().to_string(), v.trim().to_string());
        }
    }
    Ok(out)
}

/// All services defined in user and system service files.
pub fn list_services() -> Vec<(String, Params, PathBuf)> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for f in service_files() {
        if let Ok(svcs) = parse_service_file(&f) {
            for (name, params) in svcs {
                if seen.insert(name.clone()) {
                    out.push((name, params, f.clone()));
                }
            }
        }
    }
    out
}

fn lookup_service(name: &str) -> Result<Params> {
    for f in service_files() {
        if !f.exists() {
            continue;
        }
        let svcs = parse_service_file(&f)?;
        if let Some(p) = svcs.get(name) {
            return Ok(p.clone());
        }
    }
    bail!("definition of service \"{name}\" not found")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SslMode {
    Disable,
    Allow,
    Prefer,
    Require,
    VerifyCa,
    VerifyFull,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Host {
    Tcp(String),
    Unix(PathBuf),
}

impl Host {
    pub fn label(&self) -> String {
        match self {
            Host::Tcp(h) => h.clone(),
            Host::Unix(p) => p.display().to_string(),
        }
    }
}

/// Fully resolved connection parameters, ready to connect.
#[derive(Debug, Clone)]
pub struct Resolved {
    /// The params after applying service file and environment (no password).
    pub params: Params,
    pub targets: Vec<(Host, Option<String>, u16)>, // host, hostaddr, port
    pub user: String,
    pub dbname: String,
    pub password: Option<String>,
    pub passfile: Option<PathBuf>,
    pub sslmode: SslMode,
    pub sslrootcert: Option<String>,
    pub sslcert: Option<String>,
    pub sslkey: Option<String>,
    pub application_name: String,
    pub options: Option<String>,
    pub connect_timeout: Option<u64>,
}

const DEFAULT_SOCKET_DIRS: &[&str] = &["/var/run/postgresql", "/run/postgresql", "/tmp"];

fn default_socket_dir(port: u16) -> PathBuf {
    for d in DEFAULT_SOCKET_DIRS {
        let p = Path::new(d).join(format!(".s.PGSQL.{port}"));
        if p.exists() {
            return PathBuf::from(d);
        }
    }
    PathBuf::from(if cfg!(target_os = "macos") { "/tmp" } else { "/var/run/postgresql" })
}

/// Resolve the given explicit params into connection settings following the
/// libpq order: explicit > service file > environment > defaults.
pub fn resolve(explicit: &Params) -> Result<Resolved> {
    let mut p = explicit.clone();
    let service = p.get("service").cloned().or_else(|| std::env::var("PGSERVICE").ok());
    if let Some(svc) = service.filter(|s| !s.is_empty()) {
        for (k, v) in lookup_service(&svc)? {
            check_keyword(&k).with_context(|| format!("in service \"{svc}\""))?;
            p.entry(k).or_insert(v);
        }
    }
    for (k, var) in ENV_VARS {
        if !p.contains_key(*k)
            && let Ok(v) = std::env::var(var)
        {
            p.insert(k.to_string(), v);
        }
    }
    let get = |k: &str| p.get(k).filter(|v| !v.is_empty()).cloned();

    let ports: Vec<u16> = match get("port") {
        Some(s) => s
            .split(',')
            .map(|x| if x.is_empty() { Ok(5432) } else { x.trim().parse::<u16>() })
            .collect::<Result<_, _>>()
            .map_err(|_| anyhow!("invalid port number: \"{s}\""))?,
        None => vec![5432],
    };
    let hosts: Vec<String> = get("host").map(|h| h.split(',').map(str::to_string).collect()).unwrap_or_default();
    let hostaddrs: Vec<String> = get("hostaddr").map(|h| h.split(',').map(str::to_string).collect()).unwrap_or_default();
    let n = hosts.len().max(hostaddrs.len()).max(1);
    if ports.len() != 1 && ports.len() != n {
        bail!("could not match {} port numbers to {} hosts", ports.len(), n);
    }
    let mut targets = Vec::new();
    for i in 0..n {
        let port = if ports.len() == 1 { ports[0] } else { ports[i] };
        let host = hosts.get(i).filter(|h| !h.is_empty()).cloned();
        let addr = hostaddrs.get(i).filter(|h| !h.is_empty()).cloned();
        let host = match (host, &addr) {
            (Some(h), _) if h.starts_with('/') || h.starts_with('@') => Host::Unix(PathBuf::from(h)),
            (Some(h), _) => Host::Tcp(h),
            (None, Some(a)) => Host::Tcp(a.clone()),
            (None, None) => Host::Unix(default_socket_dir(port)),
        };
        targets.push((host, addr, port));
    }

    let os_user = whoami::username().unwrap_or_else(|_| "postgres".into());
    let user = get("user").unwrap_or(os_user);
    let dbname = get("dbname").unwrap_or_else(|| user.clone());
    let sslmode = match get("sslmode").as_deref() {
        None | Some("prefer") => SslMode::Prefer,
        Some("disable") => SslMode::Disable,
        Some("allow") => SslMode::Allow,
        Some("require") => SslMode::Require,
        Some("verify-ca") => SslMode::VerifyCa,
        Some("verify-full") => SslMode::VerifyFull,
        Some(o) => bail!("invalid sslmode value: \"{o}\""),
    };
    let password = get("password");
    let passfile = get("passfile").map(PathBuf::from).or_else(|| home().map(|h| h.join(".pgpass")));
    let connect_timeout = get("connect_timeout").and_then(|s| s.parse().ok()).filter(|&t| t > 0);
    let application_name = get("application_name").or_else(|| get("fallback_application_name")).unwrap_or_else(|| "pgc".into());

    let mut stored = p.clone();
    stored.remove("password");
    stored.remove("service");
    Ok(Resolved {
        params: stored,
        targets,
        user,
        dbname,
        password,
        passfile,
        sslmode,
        sslrootcert: get("sslrootcert"),
        sslcert: get("sslcert"),
        sslkey: get("sslkey"),
        application_name,
        options: get("options"),
        connect_timeout,
    })
}

fn split_pgpass_line(line: &str) -> Vec<String> {
    let mut fields = vec![String::new()];
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                if let Some(n) = chars.next() {
                    fields.last_mut().unwrap().push(n);
                }
            }
            ':' if fields.len() < 5 => fields.push(String::new()),
            c => fields.last_mut().unwrap().push(c),
        }
    }
    fields
}

/// Look up a password in the pgpass file, like libpq's passwordFromFile.
pub fn pgpass_lookup(file: &Path, host: &Host, port: u16, db: &str, user: &str) -> Option<String> {
    let meta = std::fs::metadata(file).ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if !meta.is_file() {
            return None;
        }
        if meta.permissions().mode() & 0o077 != 0 {
            tracing::warn!(
                "password file \"{}\" has group or world access; permissions should be u=rw (0600) or less",
                file.display()
            );
            return None;
        }
    }
    let host = match host {
        Host::Tcp(h) => h.as_str(),
        Host::Unix(_) => "localhost",
    };
    let port = port.to_string();
    let text = std::fs::read_to_string(file).ok()?;
    for line in text.lines() {
        if line.trim_start().starts_with('#') || line.trim().is_empty() {
            continue;
        }
        let f = split_pgpass_line(line);
        if f.len() < 5 {
            continue;
        }
        let m = |pat: &str, val: &str| pat == "*" || pat == val;
        if m(&f[0], host) && m(&f[1], &port) && m(&f[2], db) && m(&f[3], user) {
            return Some(f[4].clone());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kv() {
        let p = parse("host=localhost port=5433 dbname='my db' user=bob\\ x").unwrap();
        assert_eq!(p["host"], "localhost");
        assert_eq!(p["port"], "5433");
        assert_eq!(p["dbname"], "my db");
        assert_eq!(p["user"], "bob x");
        assert!(parse("foo=bar").is_err());
    }

    #[test]
    fn uri() {
        let p = parse("postgresql://al%40ice:pw@db.example.com:6543/app?sslmode=require&application_name=x").unwrap();
        assert_eq!(p["user"], "al@ice");
        assert_eq!(p["password"], "pw");
        assert_eq!(p["host"], "db.example.com");
        assert_eq!(p["port"], "6543");
        assert_eq!(p["dbname"], "app");
        assert_eq!(p["sslmode"], "require");
        let p = parse("postgresql://%2Fvar%2Frun%2Fpostgresql/db").unwrap();
        assert_eq!(p["host"], "/var/run/postgresql");
        let p = parse("postgres://[::1]:5432,other/db").unwrap();
        assert_eq!(p["host"], "::1,other");
        assert_eq!(p["port"], "5432,");
        let p = parse("postgresql:///mydb?host=/tmp").unwrap();
        assert_eq!(p["host"], "/tmp");
        assert_eq!(p["dbname"], "mydb");
    }

    #[test]
    fn bare_dbname() {
        assert_eq!(parse("mydb").unwrap()["dbname"], "mydb");
    }

    #[test]
    fn roundtrip() {
        let p = parse("host=a dbname='x y' user=it\\'s").unwrap();
        assert_eq!(parse(&to_string(&p, false)).unwrap(), p);
    }

    #[test]
    fn pgpass_fields() {
        assert_eq!(split_pgpass_line(r"h:5432:d\:b:u:p\:w:x"), vec!["h", "5432", "d:b", "u", "p:w:x"]);
    }
}
