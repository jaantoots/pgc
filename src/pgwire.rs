//! A small PostgreSQL client speaking the simple-query protocol, built on
//! `postgres-protocol`. Results come back in text format with full column
//! metadata, which is exactly what a psql-like client wants.

use std::collections::HashMap;
use std::io;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use bytes::BytesMut;
use fallible_iterator::FallibleIterator;
use postgres_protocol::authentication::sasl::{self, ChannelBinding, ScramSha256};
use postgres_protocol::message::{backend::Message, frontend};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpStream, UnixStream};

use crate::conninfo::{self, Host, Resolved, SslMode};

pub trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DbError {
    pub severity: String,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    /// 1-based character position in the statement.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub internal_position: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub internal_query: Option<String>,
    #[serde(rename = "where", default, skip_serializing_if = "Option::is_none")]
    pub where_: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub table: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub constraint: Option<String>,
}

impl DbError {
    fn parse(fields: postgres_protocol::message::backend::ErrorFields<'_>) -> io::Result<DbError> {
        let mut e = DbError::default();
        let mut fields = fields;
        while let Some(f) = fields.next()? {
            let v = String::from_utf8_lossy(f.value_bytes()).into_owned();
            match f.type_() {
                b'V' => e.severity = v,
                b'S' if e.severity.is_empty() => e.severity = v,
                b'C' => e.code = v,
                b'M' => e.message = v,
                b'D' => e.detail = Some(v),
                b'H' => e.hint = Some(v),
                b'P' => e.position = v.parse().ok(),
                b'p' => e.internal_position = v.parse().ok(),
                b'q' => e.internal_query = Some(v),
                b'W' => e.where_ = Some(v),
                b's' => e.schema = Some(v),
                b't' => e.table = Some(v),
                b'c' => e.column = Some(v),
                b'n' => e.constraint = Some(v),
                _ => {}
            }
        }
        Ok(e)
    }

    pub fn simple(message: impl Into<String>) -> DbError {
        DbError { severity: "ERROR".into(), message: message.into(), ..Default::default() }
    }
}

impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.severity, self.message)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Db(Box<DbError>),
    #[error("{0}")]
    Io(#[from] io::Error),
    #[error("password required")]
    NeedPassword,
    #[error("{0}")]
    Other(String),
}

impl Error {
    pub fn db(e: DbError) -> Error {
        Error::Db(Box::new(e))
    }
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TxStatus {
    Idle,
    Transaction,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct Column {
    pub name: String,
    pub type_oid: u32,
    pub table_oid: u32,
    pub column_id: i16,
    pub type_modifier: i32,
}

pub type Row = Vec<Option<String>>;

#[derive(Debug, Clone)]
pub enum Endpoint {
    Tcp(SocketAddr),
    Unix(PathBuf),
}

/// Information needed to cancel a running query from another task.
#[derive(Debug, Clone)]
pub struct CancelKey {
    pub endpoint: Endpoint,
    pub process_id: i32,
    pub secret_key: i32,
}

/// What we know about the established connection.
#[derive(Debug, Clone, Serialize)]
pub struct ConnInfo {
    pub host: String,
    pub hostaddr: Option<String>,
    pub port: u16,
    pub user: String,
    pub dbname: String,
    pub unix_socket: bool,
    pub tls: Option<String>,
    pub process_id: i32,
}

pub struct Conn {
    stream: Box<dyn Stream>,
    rbuf: BytesMut,
    wbuf: BytesMut,
    pub server_params: HashMap<String, String>,
    pub cancel_key: CancelKey,
    pub tx: TxStatus,
    pub info: ConnInfo,
    pub password: Option<String>,
}

/// A message that may arrive at any time, outside of a query's results.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
#[allow(clippy::large_enum_variant)]
pub enum Async {
    Notice(DbError),
    Notification { pid: i32, channel: String, payload: String },
}

mod tls {
    use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
    use rustls::crypto::{CryptoProvider, verify_tls12_signature, verify_tls13_signature};
    use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
    use rustls::{CertificateError, DigitallySignedStruct, Error, SignatureScheme};
    use std::sync::Arc;

    /// Accepts any certificate (sslmode=require/prefer semantics in libpq).
    #[derive(Debug)]
    pub struct NoVerify(pub Arc<CryptoProvider>);

    impl ServerCertVerifier for NoVerify {
        fn verify_server_cert(
            &self,
            _: &CertificateDer<'_>,
            _: &[CertificateDer<'_>],
            _: &ServerName<'_>,
            _: &[u8],
            _: UnixTime,
        ) -> Result<ServerCertVerified, Error> {
            Ok(ServerCertVerified::assertion())
        }
        fn verify_tls12_signature(
            &self,
            m: &[u8],
            c: &CertificateDer<'_>,
            d: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, Error> {
            verify_tls12_signature(m, c, d, &self.0.signature_verification_algorithms)
        }
        fn verify_tls13_signature(
            &self,
            m: &[u8],
            c: &CertificateDer<'_>,
            d: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, Error> {
            verify_tls13_signature(m, c, d, &self.0.signature_verification_algorithms)
        }
        fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
            self.0.signature_verification_algorithms.supported_schemes()
        }
    }

    /// Verifies the chain but not the host name (sslmode=verify-ca).
    #[derive(Debug)]
    pub struct VerifyCa(pub Arc<dyn ServerCertVerifier>);

    impl ServerCertVerifier for VerifyCa {
        fn verify_server_cert(
            &self,
            e: &CertificateDer<'_>,
            i: &[CertificateDer<'_>],
            n: &ServerName<'_>,
            o: &[u8],
            t: UnixTime,
        ) -> Result<ServerCertVerified, Error> {
            match self.0.verify_server_cert(e, i, n, o, t) {
                Err(Error::InvalidCertificate(CertificateError::NotValidForName))
                | Err(Error::InvalidCertificate(CertificateError::NotValidForNameContext { .. })) => Ok(ServerCertVerified::assertion()),
                r => r,
            }
        }
        fn verify_tls12_signature(
            &self,
            m: &[u8],
            c: &CertificateDer<'_>,
            d: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, Error> {
            self.0.verify_tls12_signature(m, c, d)
        }
        fn verify_tls13_signature(
            &self,
            m: &[u8],
            c: &CertificateDer<'_>,
            d: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, Error> {
            self.0.verify_tls13_signature(m, c, d)
        }
        fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
            self.0.supported_verify_schemes()
        }
    }
}

fn tls_config(r: &Resolved) -> Result<rustls::ClientConfig> {
    use rustls::pki_types::pem::PemObject;
    use rustls::pki_types::{CertificateDer, PrivateKeyDer};
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| Error::Other(e.to_string()))?;
    let pgdir = dirs::home_dir().map(|h| h.join(".postgresql"));
    let builder = match r.sslmode {
        SslMode::VerifyCa | SslMode::VerifyFull => {
            let mut roots = rustls::RootCertStore::empty();
            let rootcert =
                r.sslrootcert.clone().or_else(|| pgdir.as_ref().map(|d| d.join("root.crt").display().to_string())).unwrap_or_default();
            if rootcert == "system" {
                for c in rustls_native_certs::load_native_certs().certs {
                    let _ = roots.add(c);
                }
            } else {
                let data = std::fs::read(&rootcert).map_err(|e| {
                    Error::Other(format!(
                        "root certificate file \"{rootcert}\" does not exist or cannot be read ({e}); \
                         either provide the file, use the system's trusted roots with sslrootcert=system, \
                         or change sslmode to disable server certificate verification"
                    ))
                })?;
                for c in CertificateDer::pem_slice_iter(&data) {
                    let c = c.map_err(|e| Error::Other(format!("could not read root certificate: {e}")))?;
                    roots.add(c).map_err(|e| Error::Other(format!("bad root certificate: {e}")))?;
                }
            }
            let webpki = rustls::client::WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider.clone())
                .build()
                .map_err(|e| Error::Other(e.to_string()))?;
            if r.sslmode == SslMode::VerifyCa {
                builder.dangerous().with_custom_certificate_verifier(Arc::new(tls::VerifyCa(webpki)))
            } else {
                builder.with_webpki_verifier(webpki)
            }
        }
        _ => builder.dangerous().with_custom_certificate_verifier(Arc::new(tls::NoVerify(provider.clone()))),
    };
    let cert = r.sslcert.clone().map(PathBuf::from).or_else(|| pgdir.as_ref().map(|d| d.join("postgresql.crt")));
    let key = r.sslkey.clone().map(PathBuf::from).or_else(|| pgdir.as_ref().map(|d| d.join("postgresql.key")));
    if let (Some(cert), Some(key)) = (cert, key)
        && cert.exists()
    {
        let certs = CertificateDer::pem_file_iter(&cert)
            .and_then(|i| i.collect::<std::result::Result<Vec<_>, _>>())
            .map_err(|e| Error::Other(format!("could not read certificate file \"{}\": {e}", cert.display())))?;
        let key = PrivateKeyDer::from_pem_file(&key)
            .map_err(|e| Error::Other(format!("could not read private key file \"{}\": {e}", key.display())))?;
        return builder.with_client_auth_cert(certs, key).map_err(|e| Error::Other(e.to_string()));
    }
    Ok(builder.with_no_client_auth())
}

async fn with_timeout<T>(t: Option<Duration>, f: impl Future<Output = Result<T>>) -> Result<T> {
    match t {
        Some(t) => tokio::time::timeout(t, f).await.map_err(|_| Error::Other("timeout expired".into()))?,
        None => f.await,
    }
}

impl Conn {
    /// Connect trying each host in turn, like libpq.
    pub async fn connect(r: &Resolved, password: Option<&str>) -> Result<Conn> {
        let mut errors = Vec::new();
        for (host, hostaddr, port) in &r.targets {
            let timeout = r.connect_timeout.map(|s| Duration::from_secs(s.max(2)));
            match with_timeout(timeout, Self::connect_one(r, host, hostaddr.as_deref(), *port, password)).await {
                Ok(c) => return Ok(c),
                Err(Error::NeedPassword) => return Err(Error::NeedPassword),
                Err(e) => {
                    let what = match host {
                        Host::Unix(d) => format!("socket \"{}/.s.PGSQL.{port}\"", d.display()),
                        Host::Tcp(h) => format!("server at \"{h}\", port {port}"),
                    };
                    errors.push(format!("connection to {what} failed: {e}"));
                }
            }
        }
        Err(Error::Other(errors.join("\n")))
    }

    async fn connect_one(r: &Resolved, host: &Host, hostaddr: Option<&str>, port: u16, password: Option<&str>) -> Result<Conn> {
        let (stream, endpoint, tls): (Box<dyn Stream>, Endpoint, Option<String>) = match host {
            Host::Unix(dir) => {
                let path = dir.join(format!(".s.PGSQL.{port}"));
                let s = UnixStream::connect(&path).await?;
                (Box::new(s), Endpoint::Unix(path), None)
            }
            Host::Tcp(name) => {
                let target = hostaddr.unwrap_or(name);
                let addrs: Vec<SocketAddr> = tokio::net::lookup_host((target, port)).await?.collect();
                let mut last = None;
                let mut sock = None;
                for a in addrs {
                    match TcpStream::connect(a).await {
                        Ok(s) => {
                            sock = Some((s, a));
                            break;
                        }
                        Err(e) => last = Some(e),
                    }
                }
                let (mut s, addr) = match sock {
                    Some(s) => s,
                    None => {
                        return Err(last
                            .map(Error::Io)
                            .unwrap_or_else(|| Error::Other(format!("could not translate host name \"{target}\" to address"))));
                    }
                };
                s.set_nodelay(true)?;
                if matches!(r.sslmode, SslMode::Disable | SslMode::Allow) {
                    (Box::new(s), Endpoint::Tcp(addr), None)
                } else {
                    let mut buf = BytesMut::new();
                    frontend::ssl_request(&mut buf);
                    s.write_all(&buf).await?;
                    let resp = s.read_u8().await?;
                    if resp == b'S' {
                        let cfg = tls_config(r)?;
                        let connector = tokio_rustls::TlsConnector::from(Arc::new(cfg));
                        let sni = rustls::pki_types::ServerName::try_from(name.clone())
                            .map_err(|e| Error::Other(format!("invalid server name \"{name}\": {e}")))?;
                        let t = connector.connect(sni, s).await.map_err(|e| Error::Other(format!("SSL error: {e}")))?;
                        let ver = t.get_ref().1.protocol_version().map(|v| format!("{v:?}")).unwrap_or_default();
                        (Box::new(t), Endpoint::Tcp(addr), Some(ver.replace('_', ".")))
                    } else if r.sslmode == SslMode::Prefer {
                        (Box::new(s), Endpoint::Tcp(addr), None)
                    } else {
                        return Err(Error::Other("server does not support SSL, but SSL was required".into()));
                    }
                }
            }
        };
        let mut conn = Conn {
            stream,
            rbuf: BytesMut::with_capacity(64 * 1024),
            wbuf: BytesMut::new(),
            server_params: HashMap::new(),
            cancel_key: CancelKey { endpoint, process_id: 0, secret_key: 0 },
            tx: TxStatus::Idle,
            info: ConnInfo {
                host: host.label(),
                hostaddr: hostaddr.map(str::to_string),
                port,
                user: r.user.clone(),
                dbname: r.dbname.clone(),
                unix_socket: matches!(host, Host::Unix(_)),
                tls,
                process_id: 0,
            },
            password: None,
        };
        let password = password
            .map(str::to_string)
            .or_else(|| r.password.clone())
            .or_else(|| r.passfile.as_deref().and_then(|f| conninfo::pgpass_lookup(f, host, port, &r.dbname, &r.user)));
        conn.startup(r, password).await?;
        Ok(conn)
    }

    async fn startup(&mut self, r: &Resolved, password: Option<String>) -> Result<()> {
        let mut params: Vec<(&str, &str)> =
            vec![("user", &r.user), ("database", &r.dbname), ("application_name", &r.application_name), ("client_encoding", "UTF8")];
        if let Some(o) = &r.options {
            params.push(("options", o));
        }
        frontend::startup_message(params, &mut self.wbuf)?;
        self.flush().await?;
        loop {
            match self.recv_raw().await? {
                Message::AuthenticationOk => break,
                Message::AuthenticationCleartextPassword => {
                    let pw = password.as_deref().ok_or(Error::NeedPassword)?;
                    frontend::password_message(pw.as_bytes(), &mut self.wbuf)?;
                    self.flush().await?;
                }
                Message::AuthenticationMd5Password(body) => {
                    let pw = password.as_deref().ok_or(Error::NeedPassword)?;
                    let hash = postgres_protocol::authentication::md5_hash(r.user.as_bytes(), pw.as_bytes(), body.salt());
                    frontend::password_message(hash.as_bytes(), &mut self.wbuf)?;
                    self.flush().await?;
                }
                Message::AuthenticationSasl(body) => {
                    let mut mechs = body.mechanisms();
                    let mut has_scram = false;
                    while let Some(m) = mechs.next()? {
                        if m == sasl::SCRAM_SHA_256 {
                            has_scram = true;
                        }
                    }
                    if !has_scram {
                        return Err(Error::Other("none of the server's SASL authentication mechanisms are supported".into()));
                    }
                    let pw = password.as_deref().ok_or(Error::NeedPassword)?;
                    let mut scram = ScramSha256::new(pw.as_bytes(), ChannelBinding::unsupported());
                    frontend::sasl_initial_response(sasl::SCRAM_SHA_256, scram.message(), &mut self.wbuf)?;
                    self.flush().await?;
                    match self.recv_raw().await? {
                        Message::AuthenticationSaslContinue(b) => scram.update(b.data())?,
                        Message::ErrorResponse(e) => return Err(Error::db(DbError::parse(e.fields())?)),
                        _ => return Err(Error::Other("unexpected message during SASL authentication".into())),
                    }
                    frontend::sasl_response(scram.message(), &mut self.wbuf)?;
                    self.flush().await?;
                    match self.recv_raw().await? {
                        Message::AuthenticationSaslFinal(b) => scram.finish(b.data())?,
                        Message::ErrorResponse(e) => return Err(Error::db(DbError::parse(e.fields())?)),
                        _ => return Err(Error::Other("unexpected message during SASL authentication".into())),
                    }
                }
                Message::AuthenticationKerberosV5
                | Message::AuthenticationGss
                | Message::AuthenticationSspi
                | Message::AuthenticationScmCredential => {
                    return Err(Error::Other("authentication method not supported by pgc (GSSAPI/SSPI)".into()));
                }
                Message::ErrorResponse(e) => return Err(Error::db(DbError::parse(e.fields())?)),
                Message::NoticeResponse(_) => {}
                _ => return Err(Error::Other("unexpected message during authentication".into())),
            }
        }
        self.password = password;
        loop {
            match self.recv_raw().await? {
                Message::BackendKeyData(k) => {
                    self.cancel_key.process_id = k.process_id();
                    self.cancel_key.secret_key = k.secret_key();
                    self.info.process_id = k.process_id();
                }
                Message::ParameterStatus(p) => {
                    self.server_params.insert(p.name()?.to_string(), p.value()?.to_string());
                }
                Message::ReadyForQuery(s) => {
                    self.tx = tx_status(s.status());
                    return Ok(());
                }
                Message::ErrorResponse(e) => return Err(Error::db(DbError::parse(e.fields())?)),
                Message::NoticeResponse(_) => {}
                _ => return Err(Error::Other("unexpected message during startup".into())),
            }
        }
    }

    async fn flush(&mut self) -> Result<()> {
        self.stream.write_all(&self.wbuf).await?;
        self.stream.flush().await?;
        self.wbuf.clear();
        Ok(())
    }

    /// Receive the next backend message. Cancel-safe: partial reads stay buffered.
    async fn recv_raw(&mut self) -> Result<Message> {
        loop {
            if let Some(m) = Message::parse(&mut self.rbuf)? {
                return Ok(m);
            }
            let n = self.stream.read_buf(&mut self.rbuf).await?;
            if n == 0 {
                return Err(Error::Io(io::Error::new(io::ErrorKind::UnexpectedEof, "server closed the connection unexpectedly")));
            }
        }
    }

    /// Receive the next message, handling ParameterStatus transparently.
    pub async fn recv(&mut self) -> Result<Message> {
        loop {
            match self.recv_raw().await? {
                Message::ParameterStatus(p) => {
                    self.server_params.insert(p.name()?.to_string(), p.value()?.to_string());
                }
                m => return Ok(m),
            }
        }
    }

    /// Wait for an asynchronous message while idle. Cancel-safe.
    pub async fn recv_async(&mut self) -> Result<Async> {
        loop {
            match self.recv().await? {
                Message::NoticeResponse(n) => return Ok(Async::Notice(DbError::parse(n.fields())?)),
                Message::NotificationResponse(n) => {
                    return Ok(Async::Notification {
                        pid: n.process_id(),
                        channel: n.channel()?.to_string(),
                        payload: n.message()?.to_string(),
                    });
                }
                Message::ErrorResponse(e) => {
                    // e.g. FATAL: terminating connection due to administrator command
                    let e = DbError::parse(e.fields())?;
                    return Err(Error::Other(format!("{}: {}", e.severity, e.message)));
                }
                _ => {}
            }
        }
    }

    pub async fn send_query(&mut self, sql: &str) -> Result<()> {
        frontend::query(sql, &mut self.wbuf)?;
        self.flush().await
    }

    pub async fn send_copy_fail(&mut self, msg: &str) -> Result<()> {
        frontend::copy_fail(msg, &mut self.wbuf)?;
        self.flush().await
    }

    pub async fn send_copy_data(&mut self, data: &[u8]) -> Result<()> {
        frontend::CopyData::new(data)?.write(&mut self.wbuf);
        if self.wbuf.len() > 256 * 1024 {
            self.flush().await?;
        }
        Ok(())
    }

    pub async fn send_copy_done(&mut self) -> Result<()> {
        frontend::copy_done(&mut self.wbuf);
        self.flush().await
    }

    /// Run a query for internal use and collect all rows of all statements.
    /// Notices are dropped. Returns the last result set.
    pub async fn query(&mut self, sql: &str) -> Result<(Vec<Column>, Vec<Row>)> {
        self.send_query(sql).await?;
        let mut cols = Vec::new();
        let mut rows = Vec::new();
        let mut err = None;
        loop {
            match self.recv().await? {
                Message::RowDescription(d) => {
                    cols = parse_columns(&d)?;
                    rows.clear();
                }
                Message::DataRow(r) => rows.push(parse_row(&r)?),
                Message::ErrorResponse(e) => err = Some(DbError::parse(e.fields())?),
                Message::CopyInResponse(_) => self.send_copy_fail("not supported").await?,
                Message::ReadyForQuery(s) => {
                    self.tx = tx_status(s.status());
                    break;
                }
                _ => {}
            }
        }
        match err {
            Some(e) => Err(Error::db(e)),
            None => Ok((cols, rows)),
        }
    }

    /// Describe a statement's result columns without executing it (\gdesc).
    pub async fn describe_statement(&mut self, sql: &str) -> Result<Option<Vec<Column>>> {
        frontend::parse("", sql, std::iter::empty::<u32>(), &mut self.wbuf)?;
        frontend::describe(b'S', "", &mut self.wbuf)?;
        frontend::sync(&mut self.wbuf);
        self.flush().await?;
        let mut cols = None;
        let mut err = None;
        loop {
            match self.recv().await? {
                Message::RowDescription(d) => cols = Some(parse_columns(&d)?),
                Message::ErrorResponse(e) => err = Some(DbError::parse(e.fields())?),
                Message::ReadyForQuery(s) => {
                    self.tx = tx_status(s.status());
                    break;
                }
                _ => {}
            }
        }
        match err {
            Some(e) => Err(Error::db(e)),
            None => Ok(cols),
        }
    }

    pub fn set_tx(&mut self, status: u8) {
        self.tx = tx_status(status);
    }

    pub async fn terminate(mut self) {
        frontend::terminate(&mut self.wbuf);
        let _ = self.flush().await;
    }

    pub fn server_version_num(&self) -> u32 {
        // server_version is like "16.4 (Ubuntu ...)" or "9.6.24"
        let v = self.server_params.get("server_version").map(String::as_str).unwrap_or("0");
        let mut parts = v.split(|c: char| !c.is_ascii_digit()).filter(|s| !s.is_empty());
        let major: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let minor: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        if major >= 10 { major * 10000 + minor } else { major * 10000 + minor * 100 }
    }
}

pub fn tx_status(b: u8) -> TxStatus {
    match b {
        b'T' => TxStatus::Transaction,
        b'E' => TxStatus::Failed,
        _ => TxStatus::Idle,
    }
}

pub fn parse_columns(d: &postgres_protocol::message::backend::RowDescriptionBody) -> Result<Vec<Column>> {
    let mut out = Vec::new();
    let mut f = d.fields();
    while let Some(f) = f.next()? {
        out.push(Column {
            name: f.name().to_string(),
            type_oid: f.type_oid(),
            table_oid: f.table_oid(),
            column_id: f.column_id(),
            type_modifier: f.type_modifier(),
        });
    }
    Ok(out)
}

pub fn parse_row(r: &postgres_protocol::message::backend::DataRowBody) -> Result<Row> {
    let buf = r.buffer();
    let mut out = Vec::new();
    let mut ranges = r.ranges();
    while let Some(range) = ranges.next()? {
        out.push(range.map(|r| String::from_utf8_lossy(&buf[r]).into_owned()));
    }
    Ok(out)
}

pub fn parse_error(e: &postgres_protocol::message::backend::ErrorResponseBody) -> Result<DbError> {
    Ok(DbError::parse(e.fields())?)
}

pub fn parse_notice(e: &postgres_protocol::message::backend::NoticeResponseBody) -> Result<DbError> {
    Ok(DbError::parse(e.fields())?)
}

/// Send a CancelRequest on a fresh connection.
pub async fn cancel(key: &CancelKey) -> Result<()> {
    let mut buf = BytesMut::new();
    frontend::cancel_request(key.process_id, key.secret_key, &mut buf);
    let mut s: Pin<Box<dyn Stream>> = match &key.endpoint {
        Endpoint::Tcp(a) => Box::pin(TcpStream::connect(a).await?),
        Endpoint::Unix(p) => Box::pin(UnixStream::connect(p).await?),
    };
    s.write_all(&buf).await?;
    s.flush().await?;
    // The server closes the connection when done.
    let mut sink = [0u8; 16];
    let _ = tokio::time::timeout(Duration::from_secs(5), s.read(&mut sink)).await;
    Ok(())
}
