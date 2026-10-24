-- Demo database for the README screenshots: a small coffee shop.
-- Deterministic (seeded), so regenerated screenshots only change when the UI does.

select setseed(0.42);

create table customers (
  id serial primary key,
  name text not null,
  email text not null unique,
  country text not null,
  signed_up_at timestamptz not null default now(),
  preferences jsonb not null default '{}'
);

create table products (
  id serial primary key,
  sku text not null unique,
  name text not null,
  category text not null,
  price numeric(10,2) not null check (price > 0)
);

create table orders (
  id bigint generated always as identity primary key,
  customer_id int not null references customers(id),
  status text not null default 'pending' check (status in ('pending','paid','shipped','cancelled')),
  placed_at timestamptz not null default now(),
  note text
);

create table order_items (
  order_id bigint not null references orders(id) on delete cascade,
  product_id int not null references products(id),
  quantity int not null check (quantity > 0),
  unit_price numeric(10,2) not null,
  primary key (order_id, product_id)
);

create index orders_customer_idx on orders (customer_id, placed_at desc);
create index orders_status_idx on orders (status) where status <> 'shipped';
comment on table orders is 'Customer orders';

insert into customers (name, email, country, signed_up_at, preferences)
select n.f || ' ' || n.l,
       lower(translate(n.f || '.' || replace(n.l, ' ', ''), 'üöäõéí', 'uoaoei')) || i || '@example.com',
       (array['Estonia','Finland','Germany','Sweden','Netherlands','France','Spain','Norway'])[1 + floor(random() * 8)::int],
       timestamptz '2024-01-01 00:00:00+00' + random() * interval '600 days',
       jsonb_build_object(
         'newsletter', random() < 0.4,
         'language', (array['en','et','fi','de','sv'])[1 + floor(random() * 5)::int],
         'theme', (array['light','dark','system'])[1 + floor(random() * 3)::int])
from generate_series(1, 2400) i,
     -- "+ i * 0" makes the lateral subquery depend on i, so it's re-evaluated per row.
     lateral (select (array['Anna','Mart','Liis','Karl','Sofia','Jonas','Mia','Oskar','Elena','Lukas','Nora','Emil','Ida','Hugo','Lea'])[1 + floor(random() * 15 + i * 0)::int] f,
                     (array['Tamm','Saar','Virtanen','Müller','Andersson','de Vries','Laine','Kask','Martin','García','Berg','Nieminen','Dubois','Lind'])[1 + floor(random() * 14 + i * 0)::int] l) n;

insert into products (sku, name, category, price)
select 'SKU-' || lpad(i::text, 4, '0'), n.name, n.cat, round((5 + (i * 7.31) % 240)::numeric, 2)
from generate_series(1, 60) i,
     lateral (select (array['Espresso beans','Pour-over kettle','Ceramic mug','Burr grinder','Milk frother','Cold brew jar','Tea sampler','Travel tumbler','Scale','Filter papers'])[1 + i % 10]
                     || ' ' || (array['Classic','Pro','Mini','XL','Eco','Duo'])[1 + i % 6] as name,
                     (array['coffee','equipment','drinkware','equipment','equipment','drinkware','tea','drinkware','equipment','supplies'])[1 + i % 10] as cat) n;

insert into orders (customer_id, status, placed_at, note)
select 1 + floor(random() * 2400)::int,
       (array['paid','shipped','shipped','shipped','pending','cancelled'])[1 + floor(random() * 6)::int],
       timestamptz '2025-01-01 00:00:00+00' + random() * interval '640 days',
       case when random() < 0.08 then 'Gift wrap, please'
            when random() < 0.05 then 'Leave at the door'
            when random() < 0.03 then 'Call before delivery' end
from generate_series(1, 18000) i;

insert into order_items (order_id, product_id, quantity, unit_price)
select o.id, p.id, 1 + floor(random() * 3)::int, p.price
from orders o
join lateral (select id, price from products where id in (1 + o.id % 60, 1 + (o.id * 7) % 60, 1 + (o.id * 13) % 60)) p on true
order by o.id, p.id;

create view customer_revenue as
select c.id, c.name, c.country, count(distinct o.id) as orders, sum(oi.quantity * oi.unit_price) as revenue
from customers c
join orders o on o.customer_id = c.id and o.status <> 'cancelled'
join order_items oi on oi.order_id = o.id
group by c.id;

analyze;
