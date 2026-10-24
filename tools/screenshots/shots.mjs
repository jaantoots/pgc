// Drives a running pgc (connected to the demo database) and writes the README
// screenshots. Use ./run.sh (or `make screenshots`), which sets everything up.
//
//   node shots.mjs <base-url> <token> <out-dir>
//
// PGC_CHROMIUM may point at a Chromium binary to use instead of Playwright's.

import { chromium } from 'playwright';

const [base, token, out] = process.argv.slice(2);
if (!base || !token || !out) {
  console.error('usage: node shots.mjs <base-url> <token> <out-dir>');
  process.exit(2);
}

const W = 1360;
const H = 900;

let browser;
try {
  browser = await chromium.launch(process.env.PGC_CHROMIUM ? { executablePath: process.env.PGC_CHROMIUM } : {});
} catch (e) {
  console.error(`${e.message}\n\nInstall the browser with: (cd tools/screenshots && npx playwright install chromium)`);
  process.exit(1);
}

async function newPage(scheme = 'light') {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, colorScheme: scheme });
  await ctx.addCookies([{ name: 'pgc_token', value: token, url: base }]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  return page;
}

async function ready(page) {
  await page.waitForFunction(() => document.querySelector('.prompt')?.textContent?.includes('='));
  await page.waitForTimeout(300);
}

/** Open a new session, optionally named. */
async function session(scheme, name) {
  const page = await newPage(scheme);
  await page.goto(base + '/');
  await ready(page);
  if (name) {
    const id = page.url().split('/s/')[1];
    await page.evaluate(
      ([id, name]) => fetch(`/api/sessions/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }),
      [id, name],
    );
    await page.reload();
    await ready(page);
  }
  return page;
}

async function run(page, sql, wait = 600) {
  await page.click('.main-editor .cm-content');
  await page.keyboard.insertText(sql);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(wait);
}

/** Screenshot the viewport, cropped below the last piece of content. */
async function shot(page, name, { parkMouse = true } = {}) {
  if (parkMouse) await page.mouse.move(W - 5, 70); // away from hover highlights
  await page.waitForTimeout(150);
  const bottom = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.composer, .welcome, .menu, .cm-tooltip')];
    return Math.max(...els.map((e) => e.getBoundingClientRect().bottom));
  });
  const height = Math.min(H, Math.ceil(bottom + 20));
  await page.screenshot({ path: `${out}/${name}.png`, clip: { x: 0, y: 0, width: W, height } });
  console.log(`  ${name}.png`);
}

// Saved sessions, so the session list has something to show.
for (const [name, sql] of [
  ['Debug slow checkout', 'explain analyze select * from orders where customer_id = 42 order by placed_at desc limit 20;'],
  ['Order cleanup', 'select status, count(*) from orders group by 1 order by 2 desc;'],
  ['Revenue report', 'select country, sum(revenue) from customer_revenue group by 1 order by 2 desc;'],
]) {
  const p = await session('light', name);
  await run(p, sql);
  await p.context().close();
}

// The linear flow: a collapsed earlier result, a result, an error.
let page = await session('light', 'Revenue by country');
await run(page, 'select * from customers order by signed_up_at desc;');
await run(
  page,
  `select c.country,
       count(distinct c.id)           as customers,
       count(distinct o.id)           as orders,
       sum(oi.quantity * oi.unit_price) as revenue
from customers c
join orders o on o.customer_id = c.id and o.status <> 'cancelled'
join order_items oi on oi.order_id = o.id
group by c.country
order by revenue desc;`,
);
await run(page, "select id, emial from customers where country = 'Estonia';");
await shot(page, 'overview');

// Completions for an alias, in the same session.
await page.click('.main-editor .cm-content');
await page.keyboard.type('select c.name, o.', { delay: 25 });
await page.keyboard.press('Escape');
await page.keyboard.type(' from customers c join orders o on o.customer_id = c.id where o.', { delay: 15 });
await page.waitForSelector('.cm-tooltip-autocomplete');
await shot(page, 'completion', { parkMouse: false });
await page.context().close();

// Backslash commands.
page = await session('light', 'Schema tour');
await run(page, '\\dt+');
await run(page, '\\d orders');
await shot(page, 'describe');
await page.context().close();

// Grid selection and the copy menu.
page = await session('light', 'Recent orders');
await run(
  page,
  'select o.id, o.status, o.placed_at, c.name as customer, c.country, o.note, c.preferences\nfrom orders o join customers c on c.id = o.customer_id\norder by o.placed_at desc;',
  900,
);
const from = await (await page.$('.grid .gc[data-r="2"][data-c="1"]')).boundingBox();
const to = await (await page.$('.grid .gc[data-r="9"][data-c="4"]')).boundingBox();
await page.mouse.move(from.x + 8, from.y + 8);
await page.mouse.down();
await page.mouse.move(to.x + 8, to.y + 8, { steps: 8 });
await page.mouse.up();
await page.mouse.click(to.x + 30, to.y + 4, { button: 'right' });
await page.waitForSelector('.menu');
await shot(page, 'grid', { parkMouse: false });
await page.context().close();

// Dark theme: an open transaction, an expanded record, \d+ of a view.
page = await session('dark', 'Ship old orders');
await run(page, 'begin;');
await run(page, "update orders set status = 'shipped' where status = 'paid' and placed_at < '2026-06-01';");
await run(page, 'select * from customers where id = 1234 \\gx');
await run(page, '\\d+ customer_revenue');
await shot(page, 'dark');
// The open transaction is rolled back when run.sh stops the server.
await page.context().close();

// A new tab: start fresh or resume a session.
page = await session('light');
await page.waitForSelector('.session-item');
await shot(page, 'sessions');
await page.context().close();

await browser.close();
