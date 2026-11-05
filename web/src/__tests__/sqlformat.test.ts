import { describe, expect, it } from 'vitest';
import { type FormatStyle, formatSql, mapPosition, sameTokens } from '../sqlformat';

const indented: FormatStyle = { layout: 'indented', keywordCase: 'preserve' };
const text = (r: ReturnType<typeof formatSql>) => {
  if ('error' in r) throw new Error(r.error);
  return r.text;
};

describe('formatSql', () => {
  it('breaks a query into clauses', () => {
    expect(text(formatSql('select a, b from t where a = 1 and b > 2 order by a;', indented))).toBe(
      ['select', '  a,', '  b', 'from', '  t', 'where', '  a = 1', '  and b > 2', 'order by', '  a;'].join('\n'),
    );
  });

  it('applies the keyword case and layout', () => {
    expect(text(formatSql('select a from t where b', { layout: 'aligned-left', keywordCase: 'upper' }))).toBe(
      ['SELECT    a', 'FROM      t', 'WHERE     b'].join('\n'),
    );
    expect(text(formatSql('select a from t where b', { layout: 'aligned-right', keywordCase: 'preserve' }))).toBe(
      ['   select a', '     from t', '    where b'].join('\n'),
    );
    expect(text(formatSql('SELECT a::INT FROM t',{ layout: 'indented', keywordCase: 'lower' }))).toBe(['select', '  a::int', 'from', '  t'].join('\n'));
  });

  it('keeps strings, quoted identifiers, comments and dollar quotes intact', () => {
    const sql = `select "Mixed Case", E'a\\'b', $1 -- note\nfrom t; create function f() returns int as $$ select   1 $$ language sql;`;
    const out = text(formatSql(sql, { layout: 'indented', keywordCase: 'upper' }));
    expect(out).toContain('"Mixed Case"');
    expect(out).toContain("E'a\\'b'");
    expect(out).toContain('-- note');
    expect(out).toContain('$$ select   1 $$');
  });

  it('leaves backslash commands as they are', () => {
    expect(text(formatSql('select a from t \\gx', indented))).toBe(['select', '  a', 'from', '  t \\gx'].join('\n'));
    expect(text(formatSql('\\x on\nselect 1;\n\\d   t', indented))).toBe(['\\x on', 'select', '  1;', '\\d   t'].join('\n'));
  });

  it('reports what it cannot format', () => {
    expect(formatSql('select (1', indented)).toHaveProperty('error');
  });
});

describe('sameTokens', () => {
  it('ignores whitespace and the case of unquoted words', () => {
    expect(sameTokens('select a<=b from t', 'SELECT\n  a <= b\nFROM t')).toBe(true);
  });
  it('notices changed tokens', () => {
    expect(sameTokens('select a <= b', 'select a < = b')).toBe(false);
    expect(sameTokens('select "A"', 'select "a"')).toBe(false);
    expect(sameTokens("select 'A'", "select 'a'")).toBe(false);
    expect(sameTokens('select 1 -- x\n, 2', 'select 1 -- x , 2')).toBe(false);
  });
});

describe('mapPosition', () => {
  it('keeps the cursor on the same token', () => {
    const from = 'select a from t';
    const to = 'select\n  a\nfrom\n  t';
    expect(mapPosition(from, to, from.indexOf('from'))).toBe(to.indexOf('\nfrom'));
    expect(mapPosition(from, to, from.length)).toBe(to.length);
    expect(mapPosition(from, to, 0)).toBe(0);
  });
});
