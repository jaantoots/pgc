//! Splits an input buffer into SQL statements and backslash commands the way
//! psql's lexer does: semicolons end statements unless inside quotes,
//! comments, parentheses or a `BEGIN ATOMIC` function body.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Segment {
    /// A single SQL statement (including its trailing semicolon, if any).
    /// `offset` is the character offset of `text` within the buffer.
    Sql { text: String, offset: usize },
    /// A backslash command, e.g. `\d+ users`. `name` excludes the backslash.
    Meta { name: String, args: String, offset: usize },
}

struct Stmt {
    start_byte: usize,
    start_char: usize,
    has_content: bool,
    paren: i32,
    begin_depth: i32,
    words: Vec<String>,
}

impl Stmt {
    fn new(byte: usize, ch: usize) -> Stmt {
        Stmt { start_byte: byte, start_char: ch, has_content: false, paren: 0, begin_depth: 0, words: Vec::new() }
    }

    fn is_create_routine(&self) -> bool {
        let w: Vec<&str> = self.words.iter().map(String::as_str).collect();
        matches!(w.as_slice(), ["create", "function" | "procedure", ..] | ["create", "or", "replace", "function" | "procedure", ..])
    }

    fn word(&mut self, w: &str) {
        let lw = w.to_ascii_lowercase();
        if self.words.len() < 4 {
            self.words.push(lw.clone());
        }
        if (lw == "begin" && self.is_create_routine()) || (lw == "case" && self.begin_depth > 0) {
            self.begin_depth += 1;
        } else if lw == "end" && self.begin_depth > 0 {
            self.begin_depth -= 1;
        }
    }
}

/// Lex `input` into segments.
pub fn split(input: &str) -> Vec<Segment> {
    let chars: Vec<(usize, char)> = input.char_indices().collect();
    let n = chars.len();
    let byte_at = |i: usize| if i < n { chars[i].0 } else { input.len() };
    let mut out = Vec::new();
    let mut st = Stmt::new(0, 0);
    let mut i = 0;

    let flush = |st: &mut Stmt, end_char: usize, out: &mut Vec<Segment>| {
        if st.has_content {
            let text = &input[st.start_byte..byte_at(end_char)];
            // Trim leading whitespace but keep the character offset accurate.
            let lead = text.chars().take_while(|c| c.is_whitespace()).count();
            let lead_bytes: usize = text.chars().take(lead).map(char::len_utf8).sum();
            out.push(Segment::Sql { text: text[lead_bytes..].trim_end().to_string(), offset: st.start_char + lead });
        }
        *st = Stmt::new(byte_at(end_char), end_char);
    };

    while i < n {
        let c = chars[i].1;
        let next = if i + 1 < n { Some(chars[i + 1].1) } else { None };
        match c {
            '-' if next == Some('-') => {
                while i < n && chars[i].1 != '\n' {
                    i += 1;
                }
                continue;
            }
            '/' if next == Some('*') => {
                let mut depth = 0;
                while i < n {
                    if chars[i].1 == '/' && i + 1 < n && chars[i + 1].1 == '*' {
                        depth += 1;
                        i += 2;
                    } else if chars[i].1 == '*' && i + 1 < n && chars[i + 1].1 == '/' {
                        depth -= 1;
                        i += 2;
                        if depth == 0 {
                            break;
                        }
                    } else {
                        i += 1;
                    }
                }
                continue;
            }
            '\'' => {
                st.has_content = true;
                // E'...' strings allow backslash escapes.
                let escape = i > 0 && matches!(chars[i - 1].1, 'e' | 'E') && (i < 2 || !is_ident(chars[i - 2].1));
                i += 1;
                while i < n {
                    let ch = chars[i].1;
                    if escape && ch == '\\' {
                        i += 2;
                        continue;
                    }
                    if ch == '\'' {
                        if i + 1 < n && chars[i + 1].1 == '\'' {
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    i += 1;
                }
                i += 1;
                continue;
            }
            '"' => {
                st.has_content = true;
                i += 1;
                while i < n {
                    if chars[i].1 == '"' {
                        if i + 1 < n && chars[i + 1].1 == '"' {
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    i += 1;
                }
                i += 1;
                continue;
            }
            '$' if !(i > 0 && is_ident(chars[i - 1].1)) => {
                // Dollar quote: $tag$ ... $tag$
                let mut j = i + 1;
                while j < n && (chars[j].1.is_alphanumeric() || chars[j].1 == '_') {
                    j += 1;
                }
                let tag_ok = j < n && chars[j].1 == '$' && !(j > i + 1 && chars[i + 1].1.is_ascii_digit());
                if tag_ok {
                    st.has_content = true;
                    let tag: String = chars[i..=j].iter().map(|x| x.1).collect();
                    let tag_chars: Vec<char> = tag.chars().collect();
                    let mut k = j + 1;
                    loop {
                        if k >= n {
                            i = n;
                            break;
                        }
                        if chars[k].1 == '$'
                            && k + tag_chars.len() <= n
                            && chars[k..k + tag_chars.len()].iter().map(|x| x.1).eq(tag_chars.iter().copied())
                        {
                            i = k + tag_chars.len();
                            break;
                        }
                        k += 1;
                    }
                    continue;
                }
                st.has_content = true;
                i += 1;
                continue;
            }
            '(' => {
                st.has_content = true;
                st.paren += 1;
            }
            ')' => {
                st.has_content = true;
                if st.paren > 0 {
                    st.paren -= 1;
                }
            }
            ';' => {
                if st.paren == 0 && st.begin_depth == 0 {
                    if st.has_content {
                        flush(&mut st, i + 1, &mut out);
                    } else {
                        st = Stmt::new(byte_at(i + 1), i + 1);
                    }
                    i += 1;
                    continue;
                }
            }
            '\\' => {
                // Backslash command: runs to end of line (or a `\\` separator).
                let cmd_start = i;
                let mut j = i + 1;
                while j < n && !chars[j].1.is_whitespace() && chars[j].1 != '\\' {
                    j += 1;
                }
                let name: String = chars[i + 1..j].iter().map(|x| x.1).collect();
                let mut k = j;
                let mut in_sq = false;
                while k < n && chars[k].1 != '\n' {
                    if chars[k].1 == '\'' {
                        in_sq = !in_sq;
                    } else if !in_sq && chars[k].1 == '\\' && k + 1 < n && chars[k + 1].1 == '\\' {
                        break;
                    }
                    k += 1;
                }
                let args: String = chars[j..k].iter().map(|x| x.1).collect::<String>().trim().to_string();
                // Any pending SQL is flushed first; a following \g or \gx is
                // applied to it by the executor.
                flush(&mut st, cmd_start, &mut out);
                out.push(Segment::Meta { name, args, offset: cmd_start });
                i = if k + 1 < n && chars[k].1 == '\\' { k + 2 } else { k };
                st = Stmt::new(byte_at(i), i);
                continue;
            }
            c if is_ident_start(c) => {
                st.has_content = true;
                let mut j = i;
                while j < n && is_ident(chars[j].1) {
                    j += 1;
                }
                let w: String = chars[i..j].iter().map(|x| x.1).collect();
                st.word(&w);
                i = j;
                continue;
            }
            c if c.is_whitespace() => {}
            _ => st.has_content = true,
        }
        i += 1;
    }
    flush(&mut st, n, &mut out);
    out
}

fn is_ident_start(c: char) -> bool {
    c.is_alphabetic() || c == '_'
}

fn is_ident(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

/// Split backslash-command arguments like psql: whitespace separated, with
/// single quotes (removed) and double quotes (kept, for identifier patterns).
pub fn split_args(args: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut has = false;
    let mut chars = args.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                has = true;
                while let Some(c) = chars.next() {
                    if c == '\'' {
                        if chars.peek() == Some(&'\'') {
                            chars.next();
                            cur.push('\'');
                        } else {
                            break;
                        }
                    } else {
                        cur.push(c);
                    }
                }
            }
            '"' => {
                has = true;
                cur.push('"');
                for c in chars.by_ref() {
                    cur.push(c);
                    if c == '"' {
                        break;
                    }
                }
            }
            c if c.is_whitespace() => {
                if has {
                    out.push(std::mem::take(&mut cur));
                    has = false;
                }
            }
            c => {
                has = true;
                cur.push(c);
            }
        }
    }
    if has {
        out.push(cur);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sqls(s: &str) -> Vec<String> {
        split(s)
            .into_iter()
            .map(|s| match s {
                Segment::Sql { text, .. } => text,
                Segment::Meta { name, args, .. } => format!("\\{name} {args}"),
            })
            .collect()
    }

    #[test]
    fn basic() {
        assert_eq!(sqls("select 1; select 2;"), vec!["select 1;", "select 2;"]);
        assert_eq!(sqls("select ';'; select $$a;b$$; select $x$ ; $x$"), vec!["select ';';", "select $$a;b$$;", "select $x$ ; $x$"]);
        assert_eq!(sqls("select 1 -- ; comment\n; select /* ; */ 2"), vec!["select 1 -- ; comment\n;", "select /* ; */ 2"]);
        assert_eq!(sqls("-- only a comment\n"), Vec::<String>::new());
        assert_eq!(sqls("select E'\\';'; select 2"), vec!["select E'\\';';", "select 2"]);
        assert_eq!(sqls("select \"a;b\" from t"), vec!["select \"a;b\" from t"]);
    }

    #[test]
    fn meta() {
        assert_eq!(sqls("\\d users\nselect 1;"), vec!["\\d users", "select 1;"]);
        assert_eq!(sqls("select 1 \\gx"), vec!["select 1", "\\gx "]);
        assert_eq!(sqls("\\x \\\\ select 1"), vec!["\\x ", "select 1"]);
    }

    #[test]
    fn atomic() {
        let s = "create function f() returns int language sql begin atomic select 1; select case when true then 1 end; end; select 2;";
        assert_eq!(sqls(s).len(), 2);
    }

    #[test]
    fn offsets() {
        let segs = split("select 1;\n  select 'é'; select x");
        assert_eq!(segs[1], Segment::Sql { text: "select 'é';".into(), offset: 12 });
        assert_eq!(segs[2], Segment::Sql { text: "select x".into(), offset: 24 });
    }

    #[test]
    fn args() {
        assert_eq!(split_args("public.\"My Table\" 'a b' c"), vec!["public.\"My Table\"", "a b", "c"]);
    }
}
