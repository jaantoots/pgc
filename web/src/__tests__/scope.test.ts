import { describe, expect, it } from 'vitest';
import { analyze, type CatalogLike, type CatalogRelation, findSource, queryColumns, scopeAt, sourceColumns, visibleCtes, visibleSources } from '../scope';
import { scan } from '../sqlscan';

const rels: CatalogRelation[] = [
  { schema: 'public', name: 'users', kind: 'r', columns: [['id', 'integer', 'np'], ['name', 'text', 'n'], ['email', 'text']] },
  { schema: 'public', name: 'orders', kind: 'r', columns: [['id', 'integer', 'np'], ['user_id', 'integer', 'n'], ['total', 'numeric']] },
  { schema: 's', name: 't', kind: 'r', columns: [['a', 'integer'], ['b', 'text']] },
];
const cat: CatalogLike = { resolve: (name, schema) => rels.find((r) => r.name === name && (schema ? r.schema === schema : r.schema === 'public')) };

const parse = (sql: string) => analyze(scan(sql).tokens, sql.length);
/** Scope at the "|" marker (removed from the text). */
const at = (sqlWithCursor: string) => {
  const pos = sqlWithCursor.indexOf('|');
  const sql = sqlWithCursor.replace('|', '');
  return scopeAt(parse(sql), pos);
};
const refs = (sqlWithCursor: string) => visibleSources(at(sqlWithCursor)).map(({ src, depth }) => `${depth}:${src.kind}:${src.schema ? src.schema + '.' : ''}${src.name}${src.alias ? ' ' + src.alias : ''}`);
const cols = (sql: string, qual: string) => {
  const pos = sql.indexOf('|');
  const scope = scopeAt(parse(sql.replace('|', '')), pos);
  const src = findSource(scope, qual);
  return src ? sourceColumns(src, cat).map((c) => (c.type ? `${c.name}:${c.type}` : c.name)) : undefined;
};

describe('analyze', () => {
  it('finds tables and aliases', () => {
    expect(refs('select | from users u join public.orders as o on o.user_id = u.id')).toEqual(['0:table:users u', '0:table:public.orders o']);
    expect(refs('select | from a, "My Table" t where x')).toEqual(['0:table:a', '0:table:My Table t']);
    expect(refs('update t set x = | from u where t.id = u.id')).toEqual(['0:table:t', '0:table:u']);
    expect(refs('insert into s.t (a) values (|)')).toEqual(['0:table:s.t']);
    expect(refs('delete from a using b where |')).toEqual(['0:table:a', '0:table:b']);
    expect(refs('merge into a t using b s on |')).toEqual(['0:table:a t', '0:table:b s']);
    expect(refs('select | from a join b using (id), c')).toEqual(['0:table:a', '0:table:b', '0:table:c']);
    expect(refs('select | from a join b on a.x = b.x, c')).toEqual(['0:table:a', '0:table:b', '0:table:c']);
    expect(refs('explain analyze update t set x = |')).toEqual(['0:table:t']);
    expect(refs('create index on orders (|)')).toEqual(['0:table:orders']);
  });

  it('handles keywords that are not names', () => {
    expect(refs('select * from a join | on true')).toEqual(['0:table:a']);
    expect(refs('select * from a where | ')).toEqual(['0:table:a']);
    expect(refs('select * from a natural join b |')).toEqual(['0:table:a', '0:table:b']);
  });

  it('handles derived tables, lateral and functions', () => {
    expect(refs('select | from a join lateral (select 1 x) s on true')).toEqual(['0:table:a', '0:subquery: s']);
    expect(refs('select | from generate_series(1, 3) g(i)')).toEqual(['0:function:generate_series g']);
    expect(cols('select | from generate_series(1, 3) g(i)', 'g')).toEqual(['i']);
    expect(cols('select | from generate_series(1, 3) g', 'g')).toEqual(['g']);
    expect(cols('select | from (select id, name as n, count(*), 1 from users) s', 's')).toEqual(['id:integer', 'n:text', 'count', '?column?']);
    expect(cols('select | from (select u.*, o.total from users u join orders o on true) s', 's')).toEqual(['id:integer', 'name:text', 'email:text', 'total:numeric']);
    expect(cols('select | from (values (1, 2)) v(a, b)', 'v')).toEqual(['a', 'b']);
  });

  it('scopes subqueries', () => {
    const sql = 'select | from users u where exists (select 1 from orders o where o.user_id = u.id)';
    expect(refs(sql)).toEqual(['0:table:users u']);
    expect(refs('select * from users u where exists (select 1 from orders o where |)')).toEqual(['0:table:orders o', '1:table:users u']);
    // Inside a derived table that's still being typed.
    expect(refs('select * from users u join (select * from orders o where |')).toEqual(['0:table:orders o', '1:table:users u']);
    // Functions with FROM in their arguments don't start a FROM clause.
    expect(refs('select extract(year from |) from orders')).toEqual(['0:table:orders']);
  });

  it('knows CTEs', () => {
    const sql = 'with recent as (select id, user_id uid from orders), x(a) as (select 1) select | from recent r, x';
    expect(refs(sql)).toEqual(['0:cte:recent r', '0:cte:x']);
    expect(cols(sql, 'r')).toEqual(['id:integer', 'uid:integer']);
    expect(cols(sql, 'x')).toEqual(['a']);
    expect(visibleCtes(at(sql)).map((c) => c.name)).toEqual(['recent', 'x']);
    // A CTE shadows a table of the same name.
    expect(cols('with users as (select 1 as one) select | from users', 'users')).toEqual(['one']);
    // Recursive CTEs don't loop.
    expect(cols('with recursive r as (select 1 n union all select n + 1 from r) select | from r', 'r')).toEqual(['n']);
    // CTEs are visible inside subqueries and other CTEs.
    expect(refs('with a as (select 1) select * from users where id in (select * from a where |)')).toEqual(['0:cte:a', '1:table:users']);
  });

  it('separates set-operation branches', () => {
    expect(refs('select id from users union select | from orders')).toEqual(['0:table:orders']);
    expect(refs('select | from users union select id from orders')).toEqual(['0:table:users']);
    expect(cols('select | from (select id a from users union all select id from orders) s', 's')).toEqual(['a:integer']);
  });

  it('names select items like PostgreSQL', () => {
    const items = (sql: string) => queryColumns(parse(sql).children[0], cat).map((c) => c.name);
    expect(items('select a, t.b, c::int, d::int e, f g, h as "I", count(*), coalesce(x, 1), case when 1 then 2 end, 1 + 2, x is null from t')).toEqual([
      'a', 'b', 'c', 'e', 'g', 'I', 'count', 'coalesce', 'case', '?column?', '?column?',
    ]);
    expect(items('select distinct on (a) a, ts::timestamp with time zone from t')).toEqual(['a', 'ts']);
  });
});
