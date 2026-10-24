import { describe, expect, it } from 'vitest';
import { formatRows } from '../format';
import type { Column } from '../types';

const cols: Column[] = [
  { name: 'id', type_oid: 23, type_name: 'integer', numeric: true },
  { name: 'note', type_oid: 25, type_name: 'text', numeric: false },
];

describe('formatRows', () => {
  it('produces spreadsheet-friendly TSV', () => {
    expect(formatRows('tsv', cols, [['1', 'a\tb'], ['2', null]], true)).toBe('id\tnote\n1\t"a\tb"\n2\t');
  });
  it('quotes CSV', () => {
    expect(formatRows('csv', cols, [['1', 'say "hi", ok']], false)).toBe('1,"say ""hi"", ok"');
  });
  it('makes JSON with typed numbers', () => {
    expect(JSON.parse(formatRows('json', cols, [['1', null]], false))).toEqual([{ id: 1, note: null }]);
  });
  it('makes SQL lists', () => {
    expect(formatRows('sql-in', cols.slice(1), [["it's"], ['x']], false)).toBe("('it''s', 'x')");
    expect(formatRows('sql-values', cols, [['1', null]], false)).toBe('(1, NULL)');
  });
  it('makes Markdown', () => {
    expect(formatRows('markdown', cols, [['1', 'a|b']], false)).toBe('| id | note |\n| ---: | --- |\n| 1 | a\\|b |');
  });
});
