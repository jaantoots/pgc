import { type CompletionResult, CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { Catalog } from '../catalog';
import { makeAlias, pgCompletion } from '../completion';
import { meta } from './fixture';

const cat = new Catalog(meta);
const source = pgCompletion(() => cat);

/** Complete at "|"; explicit is like Ctrl+Space. */
function complete(text: string, explicit = true): CompletionResult | null {
  const pos = text.indexOf('|');
  const doc = text.replace('|', '');
  const r = source(new CompletionContext(EditorState.create({ doc }), pos, explicit));
  return r as CompletionResult | null;
}
/** Labels ranked like the popup would for an empty prefix (boost, then order). */
function top(text: string, n = 5, type?: string): string[] {
  const r = complete(text);
  if (!r) return [];
  return r.options
    .map((o, i) => ({ o, i }))
    .filter(({ o }) => !type || o.type === type)
    .sort((a, b) => (b.o.boost ?? 0) - (a.o.boost ?? 0) || a.i - b.i)
    .slice(0, n)
    .map(({ o }) => o.label);
}

describe('join completion', () => {
  it('suggests tables linked by foreign keys after JOIN', () => {
    expect(top('select * from orders o join |', 4)).toEqual([
      'customers c on c.id = o.customer_id',
      'order_items oi on oi.order_id = o.id',
      'audit.log l on l.order_id = o.id',
      // Then CTEs and tables.
      'customers',
    ]);
  });
  it('follows the keyword case and alias style', () => {
    expect(top('SELECT * FROM orders JOIN |', 1)).toEqual(['customers ON customers.id = orders.customer_id']);
    // Self joins need an alias.
    expect(top('select * from employees e join |', 2)).toEqual(['employees e2 on e2.id = e.manager_id', 'employees e2 on e2.manager_id = e.id']);
    // Multi-column keys.
    expect(top('select * from shipments s join |', 1)).toEqual(['order_items oi on oi.order_id = s.order_id and oi.product_id = s.product_id']);
  });
  it('suggests conditions after ON, nearest table first', () => {
    expect(top('select * from customers c join orders o join order_items i on |', 1)).toEqual(['i.order_id = o.id']);
    expect(top('select * from orders o join customers c on |', 1)).toEqual(['c.id = o.customer_id']);
    // Without a foreign key, equal *_id names.
    expect(top('select * from shipments s join (select order_id, product_id from order_items) x on |', 2)).toEqual([
      'x.order_id = s.order_id',
      'x.product_id = s.product_id',
    ]);
  });
  it('correlates subqueries along foreign keys', () => {
    expect(top('select * from customers c where exists (select 1 from orders o where |)', 1)).toEqual(['o.customer_id = c.id']);
  });
  it('makes aliases from initials', () => {
    expect(makeAlias('order_items', new Set())).toBe('oi');
    expect(makeAlias('orderItems', new Set(['oi']))).toBe('oi2');
    expect(makeAlias('order_notes', new Set())).toBe('on2');
  });
});

describe('column completion', () => {
  it('qualifies ambiguous columns', () => {
    const labels = top('select | from orders o join customers c on true', 8, 'property');
    expect(labels).toContain('o.id');
    expect(labels).toContain('c.id');
    expect(labels).toContain('customer_id');
    expect(labels).not.toContain('id');
  });
  it('completes columns of aliases, CTEs and derived tables', () => {
    expect(complete('with r as (select id, customer_id cid from orders) select r.| from r')!.options.map((o) => o.label)).toEqual(['id', 'cid']);
    expect(complete('select s.| from (select name n from customers) s')!.options.map((o) => o.label)).toEqual(['n']);
    expect(top('with r as (select 1) select * from |', 1)).toEqual(['r']);
  });
  it('works in later statements of the buffer', () => {
    expect(top('select 1;\nselect * from |', 1, 'class')).toEqual(['customers']);
    expect(top('select 1;\nselect | from orders', 1, 'property')).toEqual(['id']);
  });
  it('offers output columns after ORDER BY', () => {
    expect(top('select count(*) n, customer_id from orders group by customer_id order by |', 2)).toEqual(['n', 'customer_id']);
  });
  it('expands *', () => {
    expect(complete('select *| from orders')!.options[0].label).toBe('id, customer_id, placed_at');
    expect(complete('select o.*| from orders o join customers c on true')!.options[0].label).toBe('o.id, o.customer_id, o.placed_at');
    expect(complete('select *| from orders o, products p')!.options[0].label).toBe('o.id, o.customer_id, o.placed_at, p.id, p.name');
    expect(complete('select *| from orders', false)).toBeNull();
  });
});
