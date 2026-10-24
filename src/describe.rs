//! psql-compatible describe commands (\d and friends). The queries follow
//! psql's describe.c closely so the output looks familiar.

use crate::pgwire::{Column, Conn, DbError, Error, Result, Row};

/// A titled table with optional footer lines, like psql's printTable.
pub struct Table {
    pub title: Option<String>,
    pub columns: Vec<Column>,
    pub rows: Vec<Row>,
    pub footer: Vec<String>,
}

pub enum Output {
    Table(Table),
    Text(String),
}

fn text_columns(names: &[&str]) -> Vec<Column> {
    names.iter().map(|n| Column { name: n.to_string(), type_oid: 25, table_oid: 0, column_id: 0, type_modifier: -1 }).collect()
}

/// Quote a string as an SQL literal.
pub fn lit(s: &str) -> String {
    if s.contains('\\') { format!("E'{}'", s.replace('\\', "\\\\").replace('\'', "''")) } else { format!("'{}'", s.replace('\'', "''")) }
}

/// Quote an identifier if needed.
pub fn ident(s: &str) -> String {
    let simple = !s.is_empty()
        && s.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c == '_')
        && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '$');
    if simple { s.to_string() } else { format!("\"{}\"", s.replace('"', "\"\"")) }
}

/// Convert a psql name pattern into (schema regex, name regex), following
/// processSQLNamePattern: `*` -> `.*`, `?` -> `.`, `.` separates parts,
/// unquoted text is lowercased and double-quoted text is taken literally.
pub fn pattern_regexes(pattern: &str) -> (Option<String>, Option<String>) {
    let mut parts: Vec<String> = vec![String::new()];
    let mut in_quotes = false;
    let mut chars = pattern.chars().peekable();
    while let Some(c) = chars.next() {
        let cur = parts.last_mut().unwrap();
        if c == '"' {
            if in_quotes && chars.peek() == Some(&'"') {
                chars.next();
                cur.push('"');
            } else {
                in_quotes = !in_quotes;
            }
        } else if !in_quotes && c.is_uppercase() {
            cur.extend(c.to_lowercase());
        } else if !in_quotes && c == '*' {
            cur.push_str(".*");
        } else if !in_quotes && c == '?' {
            cur.push('.');
        } else if !in_quotes && c == '.' {
            parts.push(String::new());
        } else if c == '$' || (in_quotes && "|*+?()[]{}.^\\".contains(c)) {
            cur.push('\\');
            cur.push(c);
        } else {
            cur.push(c);
        }
    }
    // A name part of `*` matches everything, so it needs no condition; a
    // schema part of `*` still disables the visibility rule.
    let name = |s: &String| if s.is_empty() || s == ".*" { None } else { Some(format!("^({s})$")) };
    let schema = |s: &String| if s.is_empty() { None } else { Some(format!("^({s})$")) };
    let n = parts.len();
    if n == 1 { (None, name(&parts[0])) } else { (schema(&parts[n - 2]), name(&parts[n - 1])) }
}

/// Build WHERE conditions for a pattern. `visibility` is applied when no
/// schema was given (e.g. `pg_catalog.pg_table_is_visible(c.oid)`).
fn pattern_cond(
    pattern: Option<&str>,
    schema_col: &str,
    name_col: &str,
    alt_name_col: Option<&str>,
    visibility: Option<&str>,
) -> Vec<String> {
    let mut conds = Vec::new();
    let (schema, name) = match pattern {
        Some(p) => pattern_regexes(p),
        None => (None, None),
    };
    if let Some(n) = name {
        let l = lit(&n);
        match alt_name_col {
            Some(alt) => conds.push(format!(
                "({name_col} OPERATOR(pg_catalog.~) {l} COLLATE pg_catalog.default OR {alt} OPERATOR(pg_catalog.~) {l} COLLATE pg_catalog.default)"
            )),
            None => conds.push(format!("{name_col} OPERATOR(pg_catalog.~) {l} COLLATE pg_catalog.default")),
        }
    }
    match schema {
        Some(s) => conds.push(format!("{schema_col} OPERATOR(pg_catalog.~) {} COLLATE pg_catalog.default", lit(&s))),
        None => {
            if let Some(v) = visibility {
                conds.push(v.to_string());
            }
        }
    }
    conds
}

fn where_clause(conds: &[String]) -> String {
    if conds.is_empty() { String::new() } else { format!("WHERE {}\n", conds.join("\n  AND ")) }
}

async fn table(conn: &mut Conn, title: &str, sql: &str) -> Result<Output> {
    let (columns, rows) = conn.query(sql).await?;
    Ok(Output::Table(Table { title: Some(title.to_string()), columns, rows, footer: vec![] }))
}

fn get(r: &Row, i: usize) -> &str {
    r.get(i).and_then(|v| v.as_deref()).unwrap_or("")
}

fn truthy(r: &Row, i: usize) -> bool {
    get(r, i) == "t"
}

/// Parsed flags of a command like `\dtS+`.
struct Flags {
    system: bool,
    verbose: bool,
}

fn split_flags(s: &str) -> (String, Flags) {
    let mut base = s.to_string();
    let mut f = Flags { system: false, verbose: false };
    loop {
        if let Some(b) = base.strip_suffix('+') {
            f.verbose = true;
            base = b.to_string();
        } else if base.len() > 1 && base.ends_with('S') && !base.starts_with("dR") {
            f.system = true;
            base.pop();
        } else {
            break;
        }
    }
    (base, f)
}

pub const HELP: &str = r#"General
  \? [commands]          show help on backslash commands
  \h [NAME]              link to SQL command documentation
  \echo TEXT             print text
  \timing [on|off]       toggle timing of commands (always shown)

Query Buffer
  \g                     execute query (same as ;)
  \gx                    execute query in expanded mode
  \i FILE                execute commands from file

Informational
  (options: S = show system objects, + = additional detail)
  \d[S+]                 list tables, views, and sequences
  \d[S+]  NAME           describe table, view, sequence, or index
  \da[S]  [PATTERN]      list aggregates
  \dA[+]  [PATTERN]      list access methods
  \db[+]  [PATTERN]      list tablespaces
  \dconfig[+] [PATTERN]  list configuration parameters
  \dD[S+] [PATTERN]      list domains
  \des    [PATTERN]      list foreign servers
  \dE[S+] [PATTERN]      list foreign tables
  \df[anptw][S+] [FUNCPTRN]  list [only agg/normal/procedure/trigger/window] functions
  \dg[S+] [PATTERN]      list roles
  \di[S+] [PATTERN]      list indexes
  \dm[S+] [PATTERN]      list materialized views
  \dn[S+] [PATTERN]      list schemas
  \dp     [PATTERN]      list table, view, and sequence access privileges
  \ds[S+] [PATTERN]      list sequences
  \dt[S+] [PATTERN]      list tables
  \dT[S+] [PATTERN]      list data types
  \du[S+] [PATTERN]      list roles
  \dv[S+] [PATTERN]      list views
  \dx[+]  [PATTERN]      list extensions
  \dy     [PATTERN]      list event triggers
  \l[+]   [PATTERN]      list databases
  \sf[+]  FUNCNAME       show a function's definition
  \sv[+]  VIEWNAME       show a view's definition
  \z      [PATTERN]      same as \dp

Formatting
  \x [on|off|auto]       toggle expanded output

Connection
  \c[onnect] {[DBNAME|- USER|- HOST|- PORT|-] | conninfo}
                         connect to new database
  \conninfo              display information about current connection

Not applicable in pgc: \e, \q (close the browser tab), \! and \watch."#;

/// Run a describe-type command. Returns None if `cmd` isn't one of ours.
pub async fn run(conn: &mut Conn, cmd: &str, args: &[String]) -> Option<Result<Vec<Output>>> {
    let (base, f) = split_flags(cmd);
    let pat = args.first().map(String::as_str);
    let r = match base.as_str() {
        "d" => match pat {
            None => list_relations(conn, "tvmsE", &f, None).await,
            Some(_) => {
                let mut out = Vec::new();
                for p in args {
                    match describe_relations(conn, p, &f).await {
                        Ok(mut o) => out.append(&mut o),
                        Err(e) => return Some(Err(e)),
                    }
                }
                Ok(out)
            }
        },
        b if b.len() > 1 && b.starts_with('d') && b[1..].chars().all(|c| "tivmsE".contains(c)) => {
            list_relations(conn, &b[1..], &f, pat).await
        }
        "dn" => list_schemas(conn, &f, pat).await,
        b if b.starts_with("df") && b[2..].chars().all(|c| "anptw".contains(c)) => list_functions(conn, &b[2..], &f, pat).await,
        "da" => list_functions(conn, "a", &f, pat).await,
        "dT" => list_types(conn, &f, pat).await,
        "du" | "dg" => list_roles(conn, &f, pat).await,
        "dx" => list_extensions(conn, &f, pat).await,
        "l" | "list" => list_databases(conn, &f, pat).await,
        "db" => list_tablespaces(conn, &f, pat).await,
        "dD" => list_domains(conn, &f, pat).await,
        "dp" | "z" => list_privileges(conn, pat).await,
        "dA" => list_access_methods(conn, &f, pat).await,
        "dy" => list_event_triggers(conn, pat).await,
        "des" => list_foreign_servers(conn, pat).await,
        "dconfig" => list_config(conn, &f, pat).await,
        "sf" => show_function(conn, &f, args).await,
        "sv" => show_view(conn, &f, args).await,
        _ => return None,
    };
    Some(r)
}

async fn list_relations(conn: &mut Conn, kinds: &str, f: &Flags, pat: Option<&str>) -> Result<Vec<Output>> {
    let mut relkinds = Vec::new();
    for k in kinds.chars() {
        match k {
            't' => relkinds.extend(["'r'", "'p'"]),
            'v' => relkinds.push("'v'"),
            'm' => relkinds.push("'m'"),
            'i' => relkinds.extend(["'i'", "'I'"]),
            's' => relkinds.push("'S'"),
            'E' => relkinds.push("'f'"),
            _ => {}
        }
    }
    if f.system && pat.is_none() {
        relkinds.push("'t'");
    }
    let show_idx = kinds.contains('i');
    let mut sql = String::from(
        "SELECT n.nspname as \"Schema\",\n  c.relname as \"Name\",\n  CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' WHEN 'i' THEN 'index' WHEN 'S' THEN 'sequence' WHEN 't' THEN 'TOAST table' WHEN 'f' THEN 'foreign table' WHEN 'p' THEN 'partitioned table' WHEN 'I' THEN 'partitioned index' END as \"Type\",\n  pg_catalog.pg_get_userbyid(c.relowner) as \"Owner\"",
    );
    if show_idx {
        sql.push_str(",\n  c2.relname as \"Table\"");
    }
    if f.verbose {
        sql.push_str(",\n  CASE c.relpersistence WHEN 'p' THEN 'permanent' WHEN 't' THEN 'temporary' WHEN 'u' THEN 'unlogged' END as \"Persistence\"");
        if conn.server_version_num() >= 120000 {
            sql.push_str(",\n  am.amname as \"Access method\"");
        }
        sql.push_str(",\n  pg_catalog.pg_size_pretty(pg_catalog.pg_table_size(c.oid)) as \"Size\",\n  pg_catalog.obj_description(c.oid, 'pg_class') as \"Description\"");
    }
    sql.push_str("\nFROM pg_catalog.pg_class c\n     LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace");
    if f.verbose && conn.server_version_num() >= 120000 {
        sql.push_str("\n     LEFT JOIN pg_catalog.pg_am am ON am.oid = c.relam");
    }
    if show_idx {
        sql.push_str(
            "\n     LEFT JOIN pg_catalog.pg_index i ON i.indexrelid = c.oid\n     LEFT JOIN pg_catalog.pg_class c2 ON i.indrelid = c2.oid",
        );
    }
    let mut conds = vec![format!("c.relkind IN ({})", relkinds.join(","))];
    if !f.system && pat.is_none() {
        conds.push("n.nspname <> 'pg_catalog'".into());
        conds.push("n.nspname !~ '^pg_toast'".into());
        conds.push("n.nspname <> 'information_schema'".into());
    }
    conds.extend(pattern_cond(pat, "n.nspname", "c.relname", None, Some("pg_catalog.pg_table_is_visible(c.oid)")));
    sql.push('\n');
    sql.push_str(&where_clause(&conds));
    sql.push_str("ORDER BY 1,2;");
    let (columns, rows) = conn.query(&sql).await?;
    if rows.is_empty() {
        return Ok(vec![Output::Text(match pat {
            Some(p) => format!("Did not find any relation named \"{p}\"."),
            None => "Did not find any relations.".into(),
        })]);
    }
    Ok(vec![Output::Table(Table { title: Some("List of relations".into()), columns, rows, footer: vec![] })])
}

async fn list_schemas(conn: &mut Conn, f: &Flags, pat: Option<&str>) -> Result<Vec<Output>> {
    let mut sql = String::from("SELECT n.nspname AS \"Name\",\n  pg_catalog.pg_get_userbyid(n.nspowner) AS \"Owner\"");
    if f.verbose {
        sql.push_str(",\n  pg_catalog.array_to_string(n.nspacl, E'\\n') AS \"Access privileges\",\n  pg_catalog.obj_description(n.oid, 'pg_namespace') AS \"Description\"");
    }
    sql.push_str("\nFROM pg_catalog.pg_namespace n\n");
    let mut conds = Vec::new();
    if !f.system && pat.is_none() {
        conds.push("n.nspname !~ '^pg_'".to_string());
        conds.push("n.nspname <> 'information_schema'".to_string());
    }
    conds.extend(pattern_cond(pat, "", "n.nspname", None, None));
    sql.push_str(&where_clause(&conds));
    sql.push_str("ORDER BY 1;");
    Ok(vec![table(conn, "List of schemas", &sql).await?])
}

async fn list_functions(conn: &mut Conn, kinds: &str, f: &Flags, pat: Option<&str>) -> Result<Vec<Output>> {
    let mut sql = String::from(
        "SELECT n.nspname as \"Schema\",\n  p.proname as \"Name\",\n  pg_catalog.pg_get_function_result(p.oid) as \"Result data type\",\n  pg_catalog.pg_get_function_arguments(p.oid) as \"Argument data types\",\n  CASE p.prokind WHEN 'a' THEN 'agg' WHEN 'w' THEN 'window' WHEN 'p' THEN 'proc' ELSE 'func' END as \"Type\"",
    );
    if f.verbose {
        sql.push_str(
            ",\n  CASE WHEN p.provolatile = 'i' THEN 'immutable' WHEN p.provolatile = 's' THEN 'stable' WHEN p.provolatile = 'v' THEN 'volatile' END as \"Volatility\",\n  CASE WHEN p.proparallel = 'r' THEN 'restricted' WHEN p.proparallel = 's' THEN 'safe' WHEN p.proparallel = 'u' THEN 'unsafe' END as \"Parallel\",\n  pg_catalog.pg_get_userbyid(p.proowner) as \"Owner\",\n  CASE WHEN prosecdef THEN 'definer' ELSE 'invoker' END AS \"Security\",\n  pg_catalog.array_to_string(p.proacl, E'\\n') AS \"Access privileges\",\n  l.lanname as \"Language\",\n  CASE WHEN l.lanname IN ('internal', 'c') THEN p.prosrc END as \"Internal name\",\n  pg_catalog.obj_description(p.oid, 'pg_proc') as \"Description\"",
        );
    }
    sql.push_str("\nFROM pg_catalog.pg_proc p\n     LEFT JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace\n");
    if f.verbose {
        sql.push_str("     LEFT JOIN pg_catalog.pg_language l ON l.oid = p.prolang\n");
    }
    let mut conds = Vec::new();
    if !kinds.is_empty() {
        let mut k = Vec::new();
        for c in kinds.chars() {
            match c {
                'a' => k.push("p.prokind = 'a'".to_string()),
                'w' => k.push("p.prokind = 'w'".to_string()),
                'p' => k.push("p.prokind = 'p'".to_string()),
                'n' => k.push("(p.prokind = 'f' AND p.prorettype <> 'pg_catalog.trigger'::pg_catalog.regtype)".to_string()),
                't' => k.push("p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype".to_string()),
                _ => {}
            }
        }
        conds.push(format!("({})", k.join(" OR ")));
    }
    if !f.system && pat.is_none() {
        conds.push("n.nspname <> 'pg_catalog'".into());
        conds.push("n.nspname <> 'information_schema'".into());
    }
    conds.extend(pattern_cond(pat, "n.nspname", "p.proname", None, Some("pg_catalog.pg_function_is_visible(p.oid)")));
    sql.push_str(&where_clause(&conds));
    sql.push_str("ORDER BY 1, 2, 4;");
    Ok(vec![table(conn, "List of functions", &sql).await?])
}

async fn list_types(conn: &mut Conn, f: &Flags, pat: Option<&str>) -> Result<Vec<Output>> {
    let mut sql = String::from("SELECT n.nspname as \"Schema\",\n  pg_catalog.format_type(t.oid, NULL) AS \"Name\",\n");
    if f.verbose {
        sql.push_str(
            "  t.typname AS \"Internal name\",\n  CASE WHEN t.typrelid != 0 THEN CAST('tuple' AS pg_catalog.text) WHEN t.typlen < 0 THEN CAST('var' AS pg_catalog.text) ELSE CAST(t.typlen AS pg_catalog.text) END AS \"Size\",\n  pg_catalog.array_to_string(ARRAY(SELECT e.enumlabel FROM pg_catalog.pg_enum e WHERE e.enumtypid = t.oid ORDER BY e.enumsortorder), E'\\n') AS \"Elements\",\n  pg_catalog.pg_get_userbyid(t.typowner) AS \"Owner\",\n  pg_catalog.array_to_string(t.typacl, E'\\n') AS \"Access privileges\",\n",
        );
    }
    sql.push_str("  pg_catalog.obj_description(t.oid, 'pg_type') as \"Description\"\nFROM pg_catalog.pg_type t\n     LEFT JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace\n");
    let mut conds = vec![
        "(t.typrelid = 0 OR (SELECT c.relkind = 'c' FROM pg_catalog.pg_class c WHERE c.oid = t.typrelid))".to_string(),
        "NOT EXISTS(SELECT 1 FROM pg_catalog.pg_type el WHERE el.oid = t.typelem AND el.typarray = t.oid)".to_string(),
    ];
    if !f.system && pat.is_none() {
        conds.push("n.nspname <> 'pg_catalog'".into());
        conds.push("n.nspname <> 'information_schema'".into());
    }
    conds.extend(pattern_cond(
        pat,
        "n.nspname",
        "t.typname",
        Some("pg_catalog.format_type(t.oid, NULL)"),
        Some("pg_catalog.pg_type_is_visible(t.oid)"),
    ));
    sql.push_str(&where_clause(&conds));
    sql.push_str("ORDER BY 1, 2;");
    Ok(vec![table(conn, "List of data types", &sql).await?])
}

async fn list_roles(conn: &mut Conn, f: &Flags, pat: Option<&str>) -> Result<Vec<Output>> {
    let mut sql = String::from(
        "SELECT r.rolname AS \"Role name\",\n  pg_catalog.concat_ws(', ',\n    CASE WHEN r.rolsuper THEN 'Superuser' END,\n    CASE WHEN NOT r.rolinherit THEN 'No inheritance' END,\n    CASE WHEN r.rolcreaterole THEN 'Create role' END,\n    CASE WHEN r.rolcreatedb THEN 'Create DB' END,\n    CASE WHEN NOT r.rolcanlogin THEN 'Cannot login' END,\n    CASE WHEN r.rolreplication THEN 'Replication' END,\n    CASE WHEN r.rolbypassrls THEN 'Bypass RLS' END,\n    CASE WHEN r.rolconnlimit >= 0 THEN r.rolconnlimit || CASE WHEN r.rolconnlimit = 1 THEN ' connection' ELSE ' connections' END END,\n    CASE WHEN r.rolvaliduntil IS NOT NULL THEN 'Password valid until ' || r.rolvaliduntil END\n  ) AS \"Attributes\"",
    );
    if conn.server_version_num() < 160000 {
        sql.push_str(",\n  ARRAY(SELECT b.rolname FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles b ON (m.roleid = b.oid) WHERE m.member = r.oid) as \"Member of\"");
    }
    if f.verbose {
        sql.push_str(",\n  pg_catalog.shobj_description(r.oid, 'pg_authid') AS \"Description\"");
    }
    sql.push_str("\nFROM pg_catalog.pg_roles r\n");
    let mut conds = Vec::new();
    if !f.system && pat.is_none() {
        conds.push("r.rolname !~ '^pg_'".to_string());
    }
    conds.extend(pattern_cond(pat, "", "r.rolname", None, None));
    sql.push_str(&where_clause(&conds));
    sql.push_str("ORDER BY 1;");
    Ok(vec![table(conn, "List of roles", &sql).await?])
}

async fn list_extensions(conn: &mut Conn, f: &Flags, pat: Option<&str>) -> Result<Vec<Output>> {
    let mut sql = String::from(
        "SELECT e.extname AS \"Name\", e.extversion AS \"Version\", n.nspname AS \"Schema\", c.description AS \"Description\"\nFROM pg_catalog.pg_extension e LEFT JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace LEFT JOIN pg_catalog.pg_description c ON c.objoid = e.oid AND c.classoid = 'pg_catalog.pg_extension'::pg_catalog.regclass\n",
    );
    let conds = pattern_cond(pat, "", "e.extname", None, None);
    sql.push_str(&where_clause(&conds));
    sql.push_str("ORDER BY 1;");
    let mut out = vec![table(conn, "List of installed extensions", &sql).await?];
    if f.verbose {
        let (_, exts) =
            conn.query(&format!("SELECT e.oid, e.extname FROM pg_catalog.pg_extension e {}ORDER BY 2", where_clause(&conds))).await?;
        for e in exts {
            let sql = format!(
                "SELECT pg_catalog.pg_describe_object(classid, objid, 0) AS \"Object description\"\nFROM pg_catalog.pg_depend\nWHERE refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass AND refobjid = '{}' AND deptype = 'e'\nORDER BY 1;",
                get(&e, 0)
            );
            out.push(table(conn, &format!("Objects in extension \"{}\"", get(&e, 1)), &sql).await?);
        }
    }
    Ok(out)
}

async fn list_databases(conn: &mut Conn, f: &Flags, pat: Option<&str>) -> Result<Vec<Output>> {
    let mut sql = String::from(
        "SELECT d.datname as \"Name\",\n  pg_catalog.pg_get_userbyid(d.datdba) as \"Owner\",\n  pg_catalog.pg_encoding_to_char(d.encoding) as \"Encoding\",\n",
    );
    if conn.server_version_num() >= 150000 {
        sql.push_str(
            "  CASE d.datlocprovider WHEN 'b' THEN 'builtin' WHEN 'c' THEN 'libc' WHEN 'i' THEN 'icu' END AS \"Locale Provider\",\n",
        );
    }
    sql.push_str("  d.datcollate as \"Collate\",\n  d.datctype as \"Ctype\",\n");
    sql.push_str("  pg_catalog.array_to_string(d.datacl, E'\\n') AS \"Access privileges\"");
    if f.verbose {
        sql.push_str(",\n  CASE WHEN pg_catalog.has_database_privilege(d.datname, 'CONNECT') THEN pg_catalog.pg_size_pretty(pg_catalog.pg_database_size(d.datname)) ELSE 'No Access' END as \"Size\",\n  t.spcname as \"Tablespace\",\n  pg_catalog.shobj_description(d.oid, 'pg_database') as \"Description\"");
    }
    sql.push_str("\nFROM pg_catalog.pg_database d\n");
    if f.verbose {
        sql.push_str("  JOIN pg_catalog.pg_tablespace t on d.dattablespace = t.oid\n");
    }
    sql.push_str(&where_clause(&pattern_cond(pat, "", "d.datname", None, None)));
    sql.push_str("ORDER BY 1;");
    Ok(vec![table(conn, "List of databases", &sql).await?])
}

async fn list_tablespaces(conn: &mut Conn, f: &Flags, pat: Option<&str>) -> Result<Vec<Output>> {
    let mut sql = String::from(
        "SELECT spcname AS \"Name\",\n  pg_catalog.pg_get_userbyid(spcowner) AS \"Owner\",\n  pg_catalog.pg_tablespace_location(oid) AS \"Location\"",
    );
    if f.verbose {
        sql.push_str(",\n  pg_catalog.array_to_string(spcacl, E'\\n') AS \"Access privileges\",\n  spcoptions AS \"Options\",\n  pg_catalog.pg_size_pretty(pg_catalog.pg_tablespace_size(oid)) AS \"Size\",\n  pg_catalog.shobj_description(oid, 'pg_tablespace') AS \"Description\"");
    }
    sql.push_str("\nFROM pg_catalog.pg_tablespace\n");
    sql.push_str(&where_clause(&pattern_cond(pat, "", "spcname", None, None)));
    sql.push_str("ORDER BY 1;");
    Ok(vec![table(conn, "List of tablespaces", &sql).await?])
}

async fn list_domains(conn: &mut Conn, f: &Flags, pat: Option<&str>) -> Result<Vec<Output>> {
    let mut sql = String::from(
        "SELECT n.nspname as \"Schema\",\n  t.typname as \"Name\",\n  pg_catalog.format_type(t.typbasetype, t.typtypmod) as \"Type\",\n  (SELECT c.collname FROM pg_catalog.pg_collation c, pg_catalog.pg_type bt WHERE c.oid = t.typcollation AND bt.oid = t.typbasetype AND t.typcollation <> bt.typcollation) as \"Collation\",\n  CASE WHEN t.typnotnull THEN 'not null' END as \"Nullable\",\n  t.typdefault as \"Default\",\n  pg_catalog.array_to_string(ARRAY(SELECT pg_catalog.pg_get_constraintdef(r.oid, true) FROM pg_catalog.pg_constraint r WHERE t.oid = r.contypid), ' ') as \"Check\"",
    );
    if f.verbose {
        sql.push_str(",\n  pg_catalog.array_to_string(t.typacl, E'\\n') AS \"Access privileges\",\n  d.description as \"Description\"");
    }
    sql.push_str("\nFROM pg_catalog.pg_type t\n     LEFT JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace\n");
    if f.verbose {
        sql.push_str("     LEFT JOIN pg_catalog.pg_description d ON d.classoid = t.tableoid AND d.objoid = t.oid AND d.objsubid = 0\n");
    }
    let mut conds = vec!["t.typtype = 'd'".to_string()];
    if !f.system && pat.is_none() {
        conds.push("n.nspname <> 'pg_catalog'".into());
        conds.push("n.nspname <> 'information_schema'".into());
    }
    conds.extend(pattern_cond(pat, "n.nspname", "t.typname", None, Some("pg_catalog.pg_type_is_visible(t.oid)")));
    sql.push_str(&where_clause(&conds));
    sql.push_str("ORDER BY 1, 2;");
    Ok(vec![table(conn, "List of domains", &sql).await?])
}

async fn list_privileges(conn: &mut Conn, pat: Option<&str>) -> Result<Vec<Output>> {
    let mut sql = String::from(
        "SELECT n.nspname as \"Schema\",\n  c.relname as \"Name\",\n  CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' WHEN 'S' THEN 'sequence' WHEN 'f' THEN 'foreign table' WHEN 'p' THEN 'partitioned table' END as \"Type\",\n  pg_catalog.array_to_string(c.relacl, E'\\n') AS \"Access privileges\",\n  pg_catalog.array_to_string(ARRAY(SELECT attname || E':\\n  ' || pg_catalog.array_to_string(attacl, E'\\n  ') FROM pg_catalog.pg_attribute a WHERE attrelid = c.oid AND NOT attisdropped AND attacl IS NOT NULL), E'\\n') AS \"Column privileges\",\n  pg_catalog.array_to_string(ARRAY(SELECT polname || CASE WHEN NOT polpermissive THEN E' (RESTRICTIVE)' ELSE '' END || CASE WHEN polcmd != '*' THEN E' (' || polcmd::pg_catalog.text || E'):' ELSE E':' END || CASE WHEN polqual IS NOT NULL THEN E'\\n  (u): ' || pg_catalog.pg_get_expr(polqual, polrelid) ELSE E'' END || CASE WHEN polwithcheck IS NOT NULL THEN E'\\n  (c): ' || pg_catalog.pg_get_expr(polwithcheck, polrelid) ELSE E'' END || CASE WHEN polroles <> '{0}' THEN E'\\n  to: ' || pg_catalog.array_to_string(ARRAY(SELECT rolname FROM pg_catalog.pg_roles WHERE oid = ANY (polroles) ORDER BY 1), E', ') ELSE E'' END FROM pg_catalog.pg_policy pol WHERE polrelid = c.oid), E'\\n') AS \"Policies\"\nFROM pg_catalog.pg_class c\n     LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace\n",
    );
    let mut conds = vec!["c.relkind IN ('r','v','m','S','f','p')".to_string()];
    if pat.is_none() {
        conds.push("n.nspname !~ '^pg_'".into());
        conds.push("n.nspname <> 'information_schema'".into());
    }
    conds.extend(pattern_cond(pat, "n.nspname", "c.relname", None, Some("pg_catalog.pg_table_is_visible(c.oid)")));
    sql.push_str(&where_clause(&conds));
    sql.push_str("ORDER BY 1, 2;");
    Ok(vec![table(conn, "Access privileges", &sql).await?])
}

async fn list_access_methods(conn: &mut Conn, f: &Flags, pat: Option<&str>) -> Result<Vec<Output>> {
    let mut sql = String::from("SELECT amname AS \"Name\",\n  CASE amtype WHEN 'i' THEN 'Index' WHEN 't' THEN 'Table' END AS \"Type\"");
    if f.verbose {
        sql.push_str(",\n  amhandler AS \"Handler\",\n  pg_catalog.obj_description(oid, 'pg_am') AS \"Description\"");
    }
    sql.push_str("\nFROM pg_catalog.pg_am\n");
    sql.push_str(&where_clause(&pattern_cond(pat, "", "amname", None, None)));
    sql.push_str("ORDER BY 1;");
    Ok(vec![table(conn, "List of access methods", &sql).await?])
}

async fn list_event_triggers(conn: &mut Conn, pat: Option<&str>) -> Result<Vec<Output>> {
    let mut sql = String::from(
        "SELECT evtname as \"Name\", evtevent as \"Event\", pg_catalog.pg_get_userbyid(e.evtowner) as \"Owner\",\n  case evtenabled when 'O' then 'enabled' when 'R' then 'replica' when 'A' then 'always' when 'D' then 'disabled' end as \"Enabled\",\n  e.evtfoid::pg_catalog.regproc as \"Function\",\n  pg_catalog.array_to_string(array(select x from pg_catalog.unnest(evttags) as t(x)), ', ') as \"Tags\"\nFROM pg_catalog.pg_event_trigger e\n",
    );
    sql.push_str(&where_clause(&pattern_cond(pat, "", "evtname", None, None)));
    sql.push_str("ORDER BY 1;");
    Ok(vec![table(conn, "List of event triggers", &sql).await?])
}

async fn list_foreign_servers(conn: &mut Conn, pat: Option<&str>) -> Result<Vec<Output>> {
    let mut sql = String::from(
        "SELECT s.srvname AS \"Name\",\n  pg_catalog.pg_get_userbyid(s.srvowner) AS \"Owner\",\n  f.fdwname AS \"Foreign-data wrapper\"\nFROM pg_catalog.pg_foreign_server s\n     JOIN pg_catalog.pg_foreign_data_wrapper f ON f.oid=s.srvfdw\n",
    );
    sql.push_str(&where_clause(&pattern_cond(pat, "", "s.srvname", None, None)));
    sql.push_str("ORDER BY 1;");
    Ok(vec![table(conn, "List of foreign servers", &sql).await?])
}

async fn list_config(conn: &mut Conn, f: &Flags, pat: Option<&str>) -> Result<Vec<Output>> {
    let mut sql = String::from("SELECT s.name AS \"Parameter\", pg_catalog.current_setting(s.name) AS \"Value\"");
    if f.verbose {
        sql.push_str(", s.vartype AS \"Type\", s.context AS \"Context\"");
    }
    sql.push_str("\nFROM pg_catalog.pg_settings s\n");
    let conds = match pat {
        Some(_) => pattern_cond(pat, "", "pg_catalog.lower(s.name)", None, None),
        None => vec!["s.source <> 'default' AND s.setting IS DISTINCT FROM s.boot_val".to_string()],
    };
    sql.push_str(&where_clause(&conds));
    sql.push_str("ORDER BY 1;");
    let title = if pat.is_some() { "List of configuration parameters" } else { "List of non-default configuration parameters" };
    Ok(vec![table(conn, title, &sql).await?])
}

async fn show_function(conn: &mut Conn, f: &Flags, args: &[String]) -> Result<Vec<Output>> {
    if args.is_empty() {
        return Err(Error::db(DbError::simple("function name is required")));
    }
    let name = args.join(" ");
    let cast = if name.contains('(') { "regprocedure" } else { "regproc" };
    let (_, rows) = conn.query(&format!("SELECT pg_catalog.pg_get_functiondef({}::pg_catalog.{cast}::pg_catalog.oid)", lit(&name))).await?;
    let def = rows.first().map(|r| get(r, 0).to_string()).unwrap_or_default();
    Ok(vec![Output::Text(if f.verbose { number_lines(&def, "AS ") } else { def })])
}

/// Number the lines of a definition, starting at the body like psql's \sf+.
fn number_lines(def: &str, _body_marker: &str) -> String {
    def.lines().enumerate().map(|(i, l)| format!("{:<7} {l}", i + 1)).collect::<Vec<_>>().join("\n")
}

async fn show_view(conn: &mut Conn, f: &Flags, args: &[String]) -> Result<Vec<Output>> {
    if args.is_empty() {
        return Err(Error::db(DbError::simple("view name is required")));
    }
    let name = args.join(" ");
    let (_, rows) = conn
        .query(&format!(
            "SELECT nspname, relname, relkind, pg_catalog.pg_get_viewdef(c.oid, true), pg_catalog.array_remove(pg_catalog.array_remove(c.reloptions,'check_option=local'),'check_option=cascaded') AS reloptions, CASE WHEN 'check_option=local' = ANY (c.reloptions) THEN 'LOCAL'::text WHEN 'check_option=cascaded' = ANY (c.reloptions) THEN 'CASCADED'::text ELSE NULL END AS checkoption FROM pg_catalog.pg_class c LEFT JOIN pg_catalog.pg_namespace n ON c.relnamespace = n.oid WHERE c.oid = {}::pg_catalog.regclass::pg_catalog.oid",
            lit(&name)
        ))
        .await?;
    let r = rows.first().ok_or_else(|| Error::db(DbError::simple(format!("view \"{name}\" not found"))))?;
    let kw = if get(r, 2) == "m" { "CREATE MATERIALIZED VIEW" } else { "CREATE OR REPLACE VIEW" };
    let mut def = format!("{kw} {}.{}", ident(get(r, 0)), ident(get(r, 1)));
    let opts = get(r, 4);
    if !opts.is_empty() && opts != "{}" {
        def.push_str(&format!("\n WITH ({})", opts.trim_matches(|c| c == '{' || c == '}')));
    }
    def.push_str(" AS\n");
    def.push_str(get(r, 3).trim_end_matches(';'));
    if !get(r, 5).is_empty() {
        def.push_str(&format!("\n  WITH {} CHECK OPTION", get(r, 5)));
    }
    Ok(vec![Output::Text(if f.verbose { number_lines(&def, "") } else { def })])
}

async fn describe_relations(conn: &mut Conn, pat: &str, f: &Flags) -> Result<Vec<Output>> {
    let mut sql = String::from(
        "SELECT c.oid, n.nspname, c.relname\nFROM pg_catalog.pg_class c\n     LEFT JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace\n",
    );
    sql.push_str(&where_clause(&pattern_cond(Some(pat), "n.nspname", "c.relname", None, Some("pg_catalog.pg_table_is_visible(c.oid)"))));
    sql.push_str("ORDER BY 2, 3;");
    let (_, rels) = conn.query(&sql).await?;
    if rels.is_empty() {
        return Ok(vec![Output::Text(format!("Did not find any relation named \"{pat}\"."))]);
    }
    let mut out = Vec::new();
    for r in rels {
        out.push(describe_one(conn, get(&r, 0), get(&r, 1), get(&r, 2), f).await?);
    }
    Ok(out)
}

async fn describe_one(conn: &mut Conn, oid: &str, schema: &str, name: &str, f: &Flags) -> Result<Output> {
    let v = conn.server_version_num();
    let (_, info) = conn
        .query(&format!(
            "SELECT c.relchecks, c.relkind, c.relhasindex, c.relhasrules, c.relhastriggers, c.relrowsecurity, c.relforcerowsecurity, c.relispartition, \
             pg_catalog.array_to_string(c.reloptions || array(select 'toast.' || x from pg_catalog.unnest(tc.reloptions) x), ', '), \
             CASE WHEN c.reloftype = 0 THEN '' ELSE c.reloftype::pg_catalog.regtype::pg_catalog.text END, c.relpersistence, c.relreplident, {} \
             FROM pg_catalog.pg_class c LEFT JOIN pg_catalog.pg_class tc ON (c.reltoastrelid = tc.oid) {} WHERE c.oid = '{oid}'",
            if v >= 120000 { "am.amname" } else { "NULL" },
            if v >= 120000 { "LEFT JOIN pg_catalog.pg_am am ON (c.relam = am.oid)" } else { "" }
        ))
        .await?;
    let info = info.into_iter().next().ok_or_else(|| Error::db(DbError::simple("relation disappeared")))?;
    let kind = get(&info, 1).to_string();
    let persistence = get(&info, 10).to_string();
    let qname = format!("{schema}.{name}");
    let unlogged = persistence == "u";
    let title = match kind.as_str() {
        "r" if unlogged => format!("Unlogged table \"{qname}\""),
        "r" => format!("Table \"{qname}\""),
        "v" => format!("View \"{qname}\""),
        "m" if unlogged => format!("Unlogged materialized view \"{qname}\""),
        "m" => format!("Materialized view \"{qname}\""),
        "S" if unlogged => format!("Unlogged sequence \"{qname}\""),
        "S" => format!("Sequence \"{qname}\""),
        "i" if unlogged => format!("Unlogged index \"{qname}\""),
        "i" => format!("Index \"{qname}\""),
        "I" => format!("Partitioned index \"{qname}\""),
        "t" => format!("TOAST table \"{qname}\""),
        "c" => format!("Composite type \"{qname}\""),
        "f" => format!("Foreign table \"{qname}\""),
        "p" if unlogged => format!("Unlogged partitioned table \"{qname}\""),
        "p" => format!("Partitioned table \"{qname}\""),
        _ => format!("?{kind}? \"{qname}\""),
    };

    if kind == "S" {
        return describe_sequence(conn, oid, title).await;
    }

    let is_index = kind == "i" || kind == "I";
    let mut cols = vec!["a.attname", "pg_catalog.format_type(a.atttypid, a.atttypmod)"];
    let def_expr = if v >= 120000 {
        "CASE WHEN a.attidentity = 'a' THEN 'generated always as identity' WHEN a.attidentity = 'd' THEN 'generated by default as identity' \
         WHEN a.attgenerated = 's' THEN 'generated always as (' || (SELECT pg_catalog.pg_get_expr(d.adbin, d.adrelid, true) FROM pg_catalog.pg_attrdef d WHERE d.adrelid = a.attrelid AND d.adnum = a.attnum AND a.atthasdef) || ') stored' \
         ELSE (SELECT pg_catalog.pg_get_expr(d.adbin, d.adrelid, true) FROM pg_catalog.pg_attrdef d WHERE d.adrelid = a.attrelid AND d.adnum = a.attnum AND a.atthasdef) END"
    } else {
        "(SELECT pg_catalog.pg_get_expr(d.adbin, d.adrelid, true) FROM pg_catalog.pg_attrdef d WHERE d.adrelid = a.attrelid AND d.adnum = a.attnum AND a.atthasdef)"
    };
    let coll = "(SELECT c.collname FROM pg_catalog.pg_collation c, pg_catalog.pg_type t WHERE c.oid = a.attcollation AND t.oid = a.atttypid AND a.attcollation <> t.typcollation)";
    let idx_key = format!(
        "CASE WHEN a.attnum <= (SELECT i.indnkeyatts FROM pg_catalog.pg_index i WHERE i.indexrelid = '{oid}') THEN 'yes' ELSE 'no' END"
    );
    let idx_def = "pg_catalog.pg_get_indexdef(a.attrelid, a.attnum, TRUE)";
    let mut headers: Vec<&str> = vec!["Column", "Type"];
    if is_index {
        cols.push(&idx_key);
        cols.push(idx_def);
        headers.extend(["Key?", "Definition"]);
    } else {
        cols.push(coll);
        cols.push("CASE WHEN a.attnotnull THEN 'not null' ELSE '' END");
        cols.push(def_expr);
        headers.extend(["Collation", "Nullable", "Default"]);
    }
    if f.verbose {
        cols.push("CASE a.attstorage WHEN 'p' THEN 'plain' WHEN 'm' THEN 'main' WHEN 'x' THEN 'extended' WHEN 'e' THEN 'external' END");
        headers.push("Storage");
        if matches!(kind.as_str(), "r" | "p" | "m" | "f") || is_index {
            cols.push("CASE WHEN a.attstattarget = -1 OR a.attstattarget IS NULL THEN NULL ELSE a.attstattarget END");
            headers.push("Stats target");
        }
        if !is_index {
            cols.push("pg_catalog.col_description(a.attrelid, a.attnum)");
            headers.push("Description");
        }
    }
    let (_, rows) = conn
        .query(&format!(
            "SELECT {} FROM pg_catalog.pg_attribute a WHERE a.attrelid = '{oid}' AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum;",
            cols.join(", ")
        ))
        .await?;
    let mut footer = Vec::new();

    if is_index {
        let (_, r) = conn
            .query(&format!(
                "SELECT i.indisunique, i.indisprimary, i.indisclustered, i.indisvalid, \
                 (NOT i.indimmediate) AND EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = i.indrelid AND conindid = i.indexrelid AND contype IN ('p','u','x') AND condeferrable), \
                 (NOT i.indimmediate) AND EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = i.indrelid AND conindid = i.indexrelid AND contype IN ('p','u','x') AND condeferred), \
                 i.indisreplident, a.amname, c2.relname, pg_catalog.pg_get_expr(i.indpred, i.indrelid, true) \
                 FROM pg_catalog.pg_index i, pg_catalog.pg_class c, pg_catalog.pg_class c2, pg_catalog.pg_am a \
                 WHERE i.indexrelid = c.oid AND c.oid = '{oid}' AND c.relam = a.oid AND i.indrelid = c2.oid;"
            ))
            .await?;
        if let Some(r) = r.first() {
            let mut s = String::new();
            if truthy(r, 1) {
                s.push_str("primary key, ");
            } else if truthy(r, 0) {
                s.push_str("unique, ");
            }
            s.push_str(&format!("{}, for table \"{schema}.{}\"", get(r, 7), get(r, 8)));
            if !get(r, 9).is_empty() {
                s.push_str(&format!(", predicate ({})", get(r, 9)));
            }
            if truthy(r, 2) {
                s.push_str(", clustered");
            }
            if !truthy(r, 3) {
                s.push_str(", invalid");
            }
            if truthy(r, 4) {
                s.push_str(", deferrable");
            }
            if truthy(r, 5) {
                s.push_str(", initially deferred");
            }
            if truthy(r, 6) {
                s.push_str(", replica identity");
            }
            footer.push(s);
        }
    }

    if matches!(kind.as_str(), "v" | "m") && f.verbose {
        let (_, r) = conn.query(&format!("SELECT pg_catalog.pg_get_viewdef('{oid}'::pg_catalog.oid, true);")).await?;
        if let Some(r) = r.first() {
            footer.push("View definition:".into());
            footer.extend(get(r, 0).lines().map(str::to_string));
        }
    }

    if get(&info, 7) == "t" {
        let (_, r) = conn
            .query(&format!(
                "SELECT inhparent::pg_catalog.regclass, pg_catalog.pg_get_expr(c.relpartbound, c.oid), {} FROM pg_catalog.pg_class c JOIN pg_catalog.pg_inherits i ON c.oid = inhrelid WHERE c.oid = '{oid}';",
                if f.verbose { "pg_catalog.pg_get_partition_constraintdef(c.oid)" } else { "NULL" }
            ))
            .await?;
        if let Some(r) = r.first() {
            footer.push(format!("Partition of: {} {}", get(r, 0), get(r, 1)));
            if f.verbose {
                let c = get(r, 2);
                footer.push(if c.is_empty() { "No partition constraint".into() } else { format!("Partition constraint: {c}") });
            }
        }
    }
    if kind == "p" {
        let (_, r) = conn.query(&format!("SELECT pg_catalog.pg_get_partkeydef('{oid}'::pg_catalog.oid);")).await?;
        if let Some(r) = r.first() {
            footer.push(format!("Partition key: {}", get(r, 0)));
        }
    }

    if matches!(kind.as_str(), "r" | "p" | "m" | "f" | "t") {
        if truthy(&info, 2) || kind == "p" {
            let (_, r) = conn
                .query(&format!(
                    "SELECT c2.relname, i.indisprimary, i.indisunique, i.indisclustered, i.indisvalid, pg_catalog.pg_get_indexdef(i.indexrelid, 0, true), \
                     pg_catalog.pg_get_constraintdef(con.oid, true), contype, condeferrable, condeferred, i.indisreplident \
                     FROM pg_catalog.pg_class c, pg_catalog.pg_class c2, pg_catalog.pg_index i \
                     LEFT JOIN pg_catalog.pg_constraint con ON (conrelid = i.indrelid AND conindid = i.indexrelid AND contype IN ('p','u','x')) \
                     WHERE c.oid = '{oid}' AND c.oid = i.indrelid AND i.indexrelid = c2.oid ORDER BY i.indisprimary DESC, c2.relname;"
                ))
                .await?;
            if !r.is_empty() {
                footer.push("Indexes:".into());
                for r in &r {
                    let mut s = format!("    \"{}\"", get(r, 0));
                    if get(r, 7) == "x" {
                        s.push_str(&format!(" {}", get(r, 6)));
                    } else {
                        if truthy(r, 1) {
                            s.push_str(" PRIMARY KEY,");
                        } else if truthy(r, 2) {
                            s.push_str(if get(r, 7) == "u" { " UNIQUE CONSTRAINT," } else { " UNIQUE," });
                        }
                        let def = get(r, 5);
                        let using = def.find(" USING ").map(|i| &def[i + 7..]).unwrap_or(def);
                        s.push_str(&format!(" {using}"));
                        if truthy(r, 8) {
                            s.push_str(" DEFERRABLE");
                        }
                        if truthy(r, 9) {
                            s.push_str(" INITIALLY DEFERRED");
                        }
                    }
                    if truthy(r, 3) {
                        s.push_str(" CLUSTER");
                    }
                    if !truthy(r, 4) {
                        s.push_str(" INVALID");
                    }
                    if truthy(r, 10) {
                        s.push_str(" REPLICA IDENTITY");
                    }
                    footer.push(s);
                }
            }
        }
        if get(&info, 0) != "0" && !get(&info, 0).is_empty() {
            let (_, r) = conn
                .query(&format!(
                    "SELECT r.conname, pg_catalog.pg_get_constraintdef(r.oid, true) FROM pg_catalog.pg_constraint r WHERE r.conrelid = '{oid}' AND r.contype = 'c' ORDER BY 1;"
                ))
                .await?;
            if !r.is_empty() {
                footer.push("Check constraints:".into());
                footer.extend(r.iter().map(|r| format!("    \"{}\" {}", get(r, 0), get(r, 1))));
            }
        }
        let (_, r) = conn
            .query(&format!(
                "SELECT conname, pg_catalog.pg_get_constraintdef(r.oid, true) FROM pg_catalog.pg_constraint r WHERE r.conrelid = '{oid}' AND r.contype = 'f' {} ORDER BY 1;",
                if v >= 120000 { "AND r.conparentid = 0" } else { "" }
            ))
            .await?;
        if !r.is_empty() {
            footer.push("Foreign-key constraints:".into());
            footer.extend(r.iter().map(|r| format!("    \"{}\" {}", get(r, 0), get(r, 1))));
        }
        let (_, r) = conn
            .query(&format!(
                "SELECT conname, conrelid::pg_catalog.regclass, pg_catalog.pg_get_constraintdef(c.oid, true) FROM pg_catalog.pg_constraint c WHERE c.confrelid = '{oid}' AND c.contype = 'f' {} ORDER BY 1;",
                if v >= 120000 { "AND c.conparentid = 0" } else { "" }
            ))
            .await?;
        if !r.is_empty() {
            footer.push("Referenced by:".into());
            footer.extend(r.iter().map(|r| format!("    TABLE \"{}\" CONSTRAINT \"{}\" {}", get(r, 1), get(r, 0), get(r, 2))));
        }
        let (_, r) = conn
            .query(&format!(
                "SELECT pol.polname, pol.polpermissive, CASE WHEN pol.polroles = '{{0}}' THEN NULL ELSE pg_catalog.array_to_string(array(select rolname from pg_catalog.pg_roles where oid = any (pol.polroles) order by 1),',') END, \
                 pg_catalog.pg_get_expr(pol.polqual, pol.polrelid), pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid), \
                 CASE pol.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' END AS cmd \
                 FROM pg_catalog.pg_policy pol WHERE pol.polrelid = '{oid}' ORDER BY 1;"
            ))
            .await?;
        let rls = truthy(&info, 5);
        if rls || !r.is_empty() {
            let mut head = "Policies:".to_string();
            if truthy(&info, 6) {
                head = "Policies (forced row security enabled):".into();
            } else if !rls {
                head = "Policies (row security disabled):".into();
            }
            if r.is_empty() {
                head = if truthy(&info, 6) {
                    "Policies (forced row security enabled): (none)".into()
                } else {
                    "Policies (row security enabled): (none)".into()
                };
            }
            footer.push(head);
            for r in &r {
                let mut s = format!("    POLICY \"{}\"", get(r, 0));
                if !truthy(r, 1) {
                    s.push_str(" AS RESTRICTIVE");
                }
                if !get(r, 5).is_empty() {
                    s.push_str(&format!(" FOR {}", get(r, 5)));
                }
                if !get(r, 2).is_empty() {
                    s.push_str(&format!("\n      TO {}", get(r, 2)));
                }
                if !get(r, 3).is_empty() {
                    s.push_str(&format!("\n      USING ({})", get(r, 3)));
                }
                if !get(r, 4).is_empty() {
                    s.push_str(&format!("\n      WITH CHECK ({})", get(r, 4)));
                }
                footer.extend(s.lines().map(str::to_string));
            }
        }
    }

    if truthy(&info, 4) {
        let (_, r) = conn
            .query(&format!(
                "SELECT t.tgname, pg_catalog.pg_get_triggerdef(t.oid, true), t.tgenabled FROM pg_catalog.pg_trigger t WHERE t.tgrelid = '{oid}' AND NOT t.tgisinternal ORDER BY 1;"
            ))
            .await?;
        let groups: [(&str, &[&str]); 4] = [
            ("Triggers:", &["O"]),
            ("Disabled user triggers:", &["D"]),
            ("Triggers firing always:", &["A"]),
            ("Triggers firing on replica only:", &["R"]),
        ];
        for (head, states) in groups {
            let lines: Vec<String> = r
                .iter()
                .filter(|r| states.contains(&get(r, 2)))
                .map(|r| {
                    let def = get(r, 1);
                    let after = def.find("TRIGGER ").map(|i| &def[i + 8..]).unwrap_or(def);
                    format!("    {after}")
                })
                .collect();
            if !lines.is_empty() {
                footer.push(head.into());
                footer.extend(lines);
            }
        }
    }

    if matches!(kind.as_str(), "r" | "p" | "f") {
        let (_, r) = conn
            .query(&format!(
                "SELECT c.oid::pg_catalog.regclass FROM pg_catalog.pg_class c, pg_catalog.pg_inherits i WHERE c.oid = i.inhparent AND i.inhrelid = '{oid}' AND c.relkind != 'p' AND c.relkind != 'I' ORDER BY inhseqno;"
            ))
            .await?;
        if !r.is_empty() {
            for (i, r) in r.iter().enumerate() {
                footer.push(if i == 0 { format!("Inherits: {}", get(r, 0)) } else { format!("          {}", get(r, 0)) });
            }
        }
        let (_, r) = conn
            .query(&format!(
                "SELECT c.oid::pg_catalog.regclass, c.relkind, inhdetachpending, pg_catalog.pg_get_expr(c.relpartbound, c.oid) FROM pg_catalog.pg_inherits i, pg_catalog.pg_class c WHERE c.oid = i.inhrelid AND i.inhparent = '{oid}' ORDER BY pg_catalog.pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT', c.oid::pg_catalog.regclass::pg_catalog.text;"
            ))
            .await
            .unwrap_or_default();
        let is_part = kind == "p";
        if !r.is_empty() && !f.verbose {
            footer.push(if is_part {
                format!("Number of partitions: {} (Use \\d+ to list them.)", r.len())
            } else {
                format!("Number of child tables: {} (Use \\d+ to list them.)", r.len())
            });
        } else if !r.is_empty() {
            let label = if is_part { "Partitions: " } else { "Child tables: " };
            for (i, row) in r.iter().enumerate() {
                let mut s = if i == 0 { label.to_string() } else { " ".repeat(label.len()) };
                s.push_str(get(row, 0));
                if is_part {
                    s.push_str(&format!(" {}", get(row, 3)));
                }
                if get(row, 1) == "p" {
                    s.push_str(", PARTITIONED");
                }
                if truthy(row, 2) {
                    s.push_str(" (DETACH PENDING)");
                }
                if i + 1 < r.len() {
                    s.push(',');
                }
                footer.push(s);
            }
        } else if is_part {
            footer.push("Number of partitions: 0".into());
        }
    }

    if !get(&info, 9).is_empty() {
        footer.push(format!("Typed table of type: {}", get(&info, 9)));
    }
    if f.verbose && matches!(kind.as_str(), "r" | "p" | "m") {
        let ri = get(&info, 11);
        if ri != "d" && ri != "n" || (ri == "n" && kind != "m") {
            let s = match ri {
                "f" => Some("FULL"),
                "n" if !matches!(schema, "pg_catalog" | "information_schema") => Some("NOTHING"),
                "i" => Some("USING INDEX"),
                _ => None,
            };
            if let Some(s) = s {
                footer.push(format!("Replica Identity: {s}"));
            }
        }
        let am = get(&info, 12);
        if !am.is_empty() {
            footer.push(format!("Access method: {am}"));
        }
    }
    if f.verbose && !get(&info, 8).is_empty() {
        footer.push(format!("Options: {}", get(&info, 8)));
    }

    Ok(Output::Table(Table { title: Some(title), columns: text_columns(&headers), rows, footer }))
}

async fn describe_sequence(conn: &mut Conn, oid: &str, title: String) -> Result<Output> {
    let (_, rows) = conn
        .query(&format!(
            "SELECT pg_catalog.format_type(seqtypid, NULL) AS \"Type\", seqstart AS \"Start\", seqmin AS \"Minimum\", seqmax AS \"Maximum\", seqincrement AS \"Increment\", \
             CASE WHEN seqcycle THEN 'yes' ELSE 'no' END AS \"Cycles?\", seqcache AS \"Cache\" FROM pg_catalog.pg_sequence WHERE seqrelid = '{oid}';"
        ))
        .await?;
    let (_, owner) = conn
        .query(&format!(
            "SELECT pg_catalog.quote_ident(nspname) || '.' || pg_catalog.quote_ident(relname) || '.' || pg_catalog.quote_ident(attname), d.deptype \
             FROM pg_catalog.pg_class c INNER JOIN pg_catalog.pg_depend d ON c.oid=d.refobjid \
             INNER JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace \
             INNER JOIN pg_catalog.pg_attribute a ON (a.attrelid=c.oid AND a.attnum=d.refobjsubid) \
             WHERE d.classid='pg_catalog.pg_class'::pg_catalog.regclass AND d.refclassid='pg_catalog.pg_class'::pg_catalog.regclass \
             AND d.objid='{oid}' AND d.deptype IN ('a', 'i')"
        ))
        .await?;
    let mut footer = Vec::new();
    if let Some(o) = owner.first() {
        footer.push(if get(o, 1) == "i" {
            format!("Sequence for identity column: {}", get(o, 0))
        } else {
            format!("Owned by: {}", get(o, 0))
        });
    }
    let columns = vec!["Type", "Start", "Minimum", "Maximum", "Increment", "Cycles?", "Cache"]
        .into_iter()
        .enumerate()
        .map(|(i, n)| Column {
            name: n.into(),
            type_oid: if (1..=4).contains(&i) || i == 6 { 20 } else { 25 },
            table_oid: 0,
            column_id: 0,
            type_modifier: -1,
        })
        .collect();
    Ok(Output::Table(Table { title: Some(title), columns, rows, footer }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns() {
        assert_eq!(pattern_regexes("foo"), (None, Some("^(foo)$".into())));
        assert_eq!(pattern_regexes("Foo*"), (None, Some("^(foo.*)$".into())));
        assert_eq!(pattern_regexes("public.t?"), (Some("^(public)$".into()), Some("^(t.)$".into())));
        assert_eq!(pattern_regexes("\"My.Table\""), (None, Some("^(My\\.Table)$".into())));
        assert_eq!(pattern_regexes("s.*"), (Some("^(s)$".into()), None));
        assert_eq!(pattern_regexes("a$"), (None, Some("^(a\\$)$".into())));
    }

    #[test]
    fn flags() {
        let (b, f) = split_flags("dtS+");
        assert_eq!(b, "dt");
        assert!(f.system && f.verbose);
        let (b, f) = split_flags("dS");
        assert_eq!(b, "d");
        assert!(f.system);
        let (b, _) = split_flags("dT");
        assert_eq!(b, "dT");
    }

    #[test]
    fn quoting() {
        assert_eq!(lit("it's"), "'it''s'");
        assert_eq!(lit("a\\b"), "E'a\\\\b'");
        assert_eq!(ident("users"), "users");
        assert_eq!(ident("My Table"), "\"My Table\"");
    }
}

/// Tests against a live server; set PGC_TEST_CONNINFO to run them.
#[cfg(test)]
mod db_tests {
    use super::*;
    use crate::conninfo;

    async fn conn() -> Option<Conn> {
        let ci = std::env::var("PGC_TEST_CONNINFO").ok()?;
        let r = conninfo::resolve(&conninfo::parse(&ci).unwrap()).unwrap();
        Some(Conn::connect(&r, None).await.expect("connect"))
    }

    fn table(o: &Output) -> &Table {
        match o {
            Output::Table(t) => t,
            Output::Text(t) => panic!("expected a table, got {t}"),
        }
    }

    #[tokio::test]
    async fn describe_table() {
        let Some(mut c) = conn().await else { return };
        c.query(
            "CREATE TEMP TABLE pgc_t (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL DEFAULT 'x', \
             n numeric CHECK (n > 0)); CREATE INDEX pgc_t_name ON pgc_t (lower(name));",
        )
        .await
        .unwrap();
        let out = run(&mut c, "d", &["pgc_t".into()]).await.unwrap().unwrap();
        let t = table(&out[0]);
        assert!(t.title.as_deref().unwrap().starts_with("Table \"pg_temp"));
        let names: Vec<&str> = t.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["Column", "Type", "Collation", "Nullable", "Default"]);
        assert_eq!(t.rows[0][4].as_deref(), Some("generated always as identity"));
        assert_eq!(t.rows[1][3].as_deref(), Some("not null"));
        assert_eq!(t.rows[1][4].as_deref(), Some("'x'::text"));
        let f = t.footer.join("\n");
        assert!(f.contains("Indexes:\n    \"pgc_t_pkey\" PRIMARY KEY, btree (id)\n    \"pgc_t_name\" btree (lower(name))"), "{f}");
        assert!(f.contains("Check constraints:\n    \"pgc_t_n_check\" CHECK (n > 0::numeric)"), "{f}");

        let out = run(&mut c, "d", &["pgc_t_pkey".into()]).await.unwrap().unwrap();
        assert!(table(&out[0]).footer[0].starts_with("primary key, btree, for table"));

        let out = run(&mut c, "d", &["nonexistent_xyz".into()]).await.unwrap().unwrap();
        assert!(matches!(&out[0], Output::Text(t) if t.contains("Did not find")));
        assert!(run(&mut c, "nope", &[]).await.is_none());
    }

    #[tokio::test]
    async fn lists_and_errors() {
        let Some(mut c) = conn().await else { return };
        for cmd in ["l", "dn+", "df", "dT", "du", "dx", "dt", "di", "dv", "ds", "db", "dD", "dp", "dA", "dy", "des", "dconfig"] {
            let r = run(&mut c, cmd, &[]).await.unwrap();
            assert!(r.is_ok(), "\\{cmd}: {:?}", r.err());
        }
        let out = run(&mut c, "sf", &["pg_catalog.lower(text)".into()]).await.unwrap();
        assert!(out.is_ok());
        let e = c.query("select 1/0").await.unwrap_err();
        assert!(matches!(&e, Error::Db(d) if d.code == "22012"));
        // The connection is usable after an error.
        let (cols, rows) = c.query("select 1 as a, null::text as b").await.unwrap();
        assert_eq!(cols[0].name, "a");
        assert_eq!(rows, vec![vec![Some("1".to_string()), None]]);
    }
}
