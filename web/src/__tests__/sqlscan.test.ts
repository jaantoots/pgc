import { describe, expect, it } from 'vitest';
import { isComplete, scan, statementRange } from '../sqlscan';

describe('isComplete', () => {
  it('runs statements ending in a semicolon', () => {
    expect(isComplete('select 1;')).toBe(true);
    expect(isComplete('select 1;  \n')).toBe(true);
    expect(isComplete('select 1')).toBe(false);
    expect(isComplete('')).toBe(false);
  });
  it('ignores semicolons inside strings, comments and dollar quotes', () => {
    expect(isComplete("select ';")).toBe(false);
    expect(isComplete("select 'a;'")).toBe(false);
    expect(isComplete('select 1 -- ;')).toBe(false);
    expect(isComplete('select /* ; */ 1')).toBe(false);
    expect(isComplete('do $$ begin perform 1;')).toBe(false);
    expect(isComplete('do $$ begin perform 1; end $$;')).toBe(true);
    expect(isComplete("select E'\\';'")).toBe(false);
    expect(isComplete("select E'\\'';")).toBe(true);
  });
  it('waits for closing parentheses', () => {
    expect(isComplete('select (1;')).toBe(false);
  });
  it('waits for the end of BEGIN ATOMIC bodies', () => {
    const f = 'create function f() returns int language sql begin atomic select 1;';
    expect(isComplete(f)).toBe(false);
    expect(isComplete(f + ' end;')).toBe(true);
  });
  it('runs backslash commands immediately', () => {
    expect(isComplete('\\dt')).toBe(true);
    expect(isComplete('select 1 \\gx')).toBe(true);
  });
});

describe('statementRange', () => {
  it('finds the statement around the cursor', () => {
    const t = 'select 1; select 2; select 3';
    expect(t.slice(...statementRange(t, 12))).toBe(' select 2;');
    expect(t.slice(...statementRange(t, t.length))).toBe(' select 3');
  });
  it('treats meta commands as statements', () => {
    const t = 'select 1;\n\\d us';
    expect(t.slice(...statementRange(t, t.length))).toBe('\\d us');
  });
});

describe('scan', () => {
  it('tokenizes', () => {
    const kinds = scan(`select "A", 'x', 1.5, $1::int from t`).tokens.map((t) => t.kind);
    expect(kinds).toEqual(['word', 'quoted', 'punct', 'string', 'punct', 'number', 'punct', 'param', 'op', 'word', 'word', 'word']);
  });
});
