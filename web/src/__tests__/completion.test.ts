import { describe, expect, it } from 'vitest';
import { tableRefs } from '../completion';
import { scan } from '../sqlscan';

const refs = (sql: string) => tableRefs(scan(sql).tokens);

describe('tableRefs', () => {
  it('finds tables and aliases', () => {
    expect(refs('select * from users u join public.orders as o on o.user_id = u.id')).toEqual([
      { schema: undefined, name: 'users', alias: 'u' },
      { schema: 'public', name: 'orders', alias: 'o' },
    ]);
  });
  it('handles comma lists, quoting and keywords that are not aliases', () => {
    expect(refs('select 1 from a, "My Table" t where x')).toEqual([
      { schema: undefined, name: 'a', alias: undefined },
      { schema: undefined, name: 'My Table', alias: 't' },
    ]);
    expect(refs('update t set x = 1')).toEqual([{ schema: undefined, name: 't', alias: undefined }]);
    expect(refs('insert into s.t (a) values (1)')).toEqual([{ schema: 's', name: 't', alias: undefined }]);
  });
});
