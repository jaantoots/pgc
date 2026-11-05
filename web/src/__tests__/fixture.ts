// A small schema shared by the completion and hover tests.
import type { Meta } from '../types';

export const meta: Meta = {
  relations: [
    { schema: 'public', name: 'customers', kind: 'r', columns: [['id', 'integer', 'np'], ['name', 'text', 'n'], ['email', 'text', 'n', 'Login email']] },
    { schema: 'public', name: 'orders', kind: 'r', columns: [['id', 'bigint', 'np'], ['customer_id', 'integer', 'n'], ['placed_at', 'timestamptz']] },
    { schema: 'public', name: 'order_items', kind: 'r', columns: [['order_id', 'bigint', 'np'], ['product_id', 'integer', 'np'], ['quantity', 'integer']] },
    { schema: 'public', name: 'products', kind: 'r', columns: [['id', 'integer', 'np'], ['name', 'text']] },
    { schema: 'public', name: 'employees', kind: 'r', columns: [['id', 'integer', 'np'], ['manager_id', 'integer']] },
    { schema: 'public', name: 'shipments', kind: 'r', columns: [['order_id', 'bigint'], ['product_id', 'integer']] },
    { schema: 'audit', name: 'log', kind: 'r', columns: [['order_id', 'bigint']] },
  ],
  foreign_keys: [
    ['public', 'orders', ['customer_id'], 'public', 'customers', ['id'], 'orders_customer_id_fkey'],
    ['public', 'order_items', ['order_id'], 'public', 'orders', ['id'], 'order_items_order_id_fkey'],
    ['public', 'order_items', ['product_id'], 'public', 'products', ['id'], 'order_items_product_id_fkey'],
    ['public', 'employees', ['manager_id'], 'public', 'employees', ['id'], 'employees_manager_id_fkey'],
    ['public', 'shipments', ['order_id', 'product_id'], 'public', 'order_items', ['order_id', 'product_id'], 'shipments_fkey'],
    ['audit', 'log', ['order_id'], 'public', 'orders', ['id'], 'log_order_id_fkey'],
  ],
  functions: [{ schema: 'pg_catalog', name: 'count', kind: 'a', args: '"any"' }],
  search_path: ['pg_catalog', 'public'],
  schemas: ['audit', 'public'],
  databases: [],
  roles: [],
  types: [['pg_catalog', 'int4']],
  keywords: [['select', 'R'], ['from', 'R'], ['on', 'R']],
};
