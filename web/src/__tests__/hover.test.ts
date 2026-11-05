import { describe, expect, it } from 'vitest';
import { Catalog } from '../catalog';
import { hoverTarget } from '../hover';
import { meta } from './fixture';

const cat = new Catalog(meta);

/** Describe what the name at "|" resolves to. */
function hover(text: string): string | null {
  const pos = text.indexOf('|');
  const hit = hoverTarget(cat, text.replace('|', ''), pos);
  if (!hit) return null;
  const t = hit.target;
  switch (t.kind) {
    case 'relation':
      return `relation ${t.rel.schema}.${t.rel.name}${t.alias ? ` as ${t.alias}` : ''}`;
    case 'source':
      return `${t.src.kind} ${t.src.alias ?? t.src.name}`;
    case 'column':
      return `column ${t.col.rel ? `${t.col.rel.name}.` : t.owner ? `${t.owner.alias ?? t.owner.name}.` : ''}${t.col.name} ${t.col.type}`.trim();
    case 'function':
      return `function ${t.fns[0].name}`;
  }
}

describe('hover', () => {
  it('resolves tables, aliases and columns', () => {
    expect(hover('select * from or|ders o')).toBe('relation public.orders as o');
    expect(hover('select * from orders |o')).toBe('relation public.orders as o');
    expect(hover('select |o.id from orders o')).toBe('relation public.orders as o');
    expect(hover('select o.|customer_id from orders o')).toBe('column orders.customer_id integer');
    expect(hover('select |customer_id from orders o')).toBe('column orders.customer_id integer');
    expect(hover('select * from audit.l|og')).toBe('relation audit.log');
    expect(hover('select * from au|dit.log')).toBeNull();
    expect(hover('select public.orders.|id from orders')).toBe('column orders.id bigint');
    expect(hover('select |count(*) from orders')).toBe('function count');
    expect(hover('sel|ect 1')).toBeNull();
  });
  it('resolves CTEs and derived tables', () => {
    expect(hover('with |r as (select id from orders) select * from r')).toBe('cte r');
    expect(hover('with r as (select id from orders) select * from |r')).toBe('cte r');
    expect(hover('with r as (select id x from orders) select r.|x from r')).toBe('column r.x bigint');
    expect(hover('select s.n from (select name n from customers) |s')).toBe('subquery s');
    expect(hover('select |s.n from (select name n from customers) s')).toBe('subquery s');
    expect(hover('select s.n from (select name n from |customers) s')).toBe('relation public.customers');
  });
  it('uses the scope at the cursor', () => {
    expect(hover('select * from customers c where exists (select 1 from orders c where c.|id = 1)')).toBe('column orders.id bigint');
    expect(hover('select 1;\nselect |id from products')).toBe('column products.id integer');
  });
});
