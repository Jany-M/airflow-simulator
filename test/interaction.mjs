// Focused interaction test: select / move / toggle against built dist (port 4173).
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname } from 'node:path';
import { syncCellMapper } from './helpers/coords.mjs';

const BASE = process.env.APP_URL || 'http://localhost:4173/';
const OUT = join(process.cwd(), 'test', 'shots-interaction');
mkdirSync(OUT, { recursive: true });
const DIST = join(process.cwd(), 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
let server = null;
if (!process.env.APP_URL) {
  server = createServer((req, res) => {
    let p = join(DIST, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    if (!existsSync(p)) p = join(DIST, 'index.html');
    res.setHeader('Content-Type', MIME[extname(p)] ?? 'application/octet-stream');
    res.end(readFileSync(p));
  });
  await new Promise(r => server.listen(4173, r));
}


const LS_PLAN = 'airflow-simulator:plan:v1';
const LS_LEGACY = 'airflow-planner:plan:v1';

const browser = await chromium.launch({
  headless: true,
  channel: process.env.PW_CHANNEL || 'chrome',
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (/favicon|404 \(Not Found\)/i.test(t)) return;
  errors.push(t);
});

await page.goto(BASE);
await page.waitForSelector('canvas');
await page.evaluate(([k1, k2]) => {
  localStorage.removeItem(k1);
  localStorage.removeItem(k2);
}, [LS_PLAN, LS_LEGACY]);
await page.reload();
await page.waitForSelector('h1');
await page.waitForSelector('canvas');
await page.waitForTimeout(600);

// Touch the plan name so the in-memory sample is persisted (autosave is mutation-driven).
await page.locator('.plan-name').fill('Interaction Test Plan');
await page.waitForTimeout(600);

const canvas = page.locator('canvas');
const box = await canvas.boundingBox();
const readPlan = () => page.evaluate(k => {
  const raw = localStorage.getItem(k);
  return raw ? JSON.parse(raw) : null;
}, LS_PLAN);

let cell = syncCellMapper(box, await readPlan());
const refreshCell = async () => {
  const b = await canvas.boundingBox();
  cell = syncCellMapper(b, await readPlan());
};

const selectedLabel = async () => {
  const info = page.locator('.sel-info');
  if (await info.count()) return `opening:${(await info.textContent()).trim()}`;
  const room = page.locator('.selection input[aria-label="Room name"]');
  if (await room.count()) return `room:${await room.inputValue()}`;
  return 'none';
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`);
};

// ── 1. Click closed window → toggles open (green), does NOT select ──
const closedWin = cell(15.5, 20); // living S, open:false at load
let before = await readPlan();
if (!before) throw new Error('plan not in localStorage after name touch');
const closedBefore = before.openings.find(o => o.orient === 'h' && o.y === 20 && o.x === 14);
await page.mouse.click(closedWin.x, closedWin.y);
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, '1-select-closed-window.png') });
let after = await readPlan();
const closedAfter = after.openings.find(o => o.id === closedBefore.id);
const sel1 = await selectedLabel();
check(
  'click closed window toggles open without selecting',
  sel1 === 'none' && closedAfter.open === true,
  `sel=${sel1} open=${closedAfter.open}`,
);

// ── 2. Long-press same window → select (yellow ring) ──
await page.mouse.move(closedWin.x, closedWin.y);
await page.mouse.down();
await page.waitForTimeout(300);
await page.mouse.up();
await page.waitForTimeout(300);
after = await readPlan();
const southWin = after.openings.find(o => o.id === closedBefore.id);
const sel2 = await selectedLabel();
await page.screenshot({ path: join(OUT, '2-longpress-select.png') });
check(
  'long-press selects opening without toggling',
  sel2.startsWith('opening:') && southWin.open === true,
  `open=${southWin.open} sel=${sel2}`,
);

// ── 3. Drag opening along wall (already selected from long-press) ──
const openBefore = { ...southWin };
const bodyPick = cell(14.25, 20); // fixture body, not centre glyph (glyph = resize)
await page.mouse.move(bodyPick.x, bodyPick.y);
await page.mouse.down();
await page.mouse.move(cell(16, 20).x, cell(16, 20).y, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(700);
after = await readPlan();
const movedOpen = after.openings.find(o => o.id === openBefore.id);
await page.screenshot({ path: join(OUT, '3-drag-opening.png') });
check(
  'drag opening along wall',
  !!movedOpen && movedOpen.y === 20 && movedOpen.x !== openBefore.x,
  `x ${openBefore.x}→${movedOpen?.x} y=${movedOpen?.y}`,
);

// ── 4. Click room interior → select ──
const livingC = cell(16, 14);
await page.mouse.click(livingC.x, livingC.y);
await page.waitForTimeout(300);
const selRoom = await selectedLabel();
await page.screenshot({ path: join(OUT, '4-select-room.png') });
check('click room selects it', selRoom === 'room:Living room', `sel=${selRoom}`);

// ── 5. Drag bathroom from interior into free space south of living ──
const bathC = cell(29, 23);
await page.mouse.click(bathC.x, bathC.y);
await page.waitForTimeout(200);
before = await readPlan();
const bath = before.rooms.find(r => r.name === 'Bathroom');
const bathCenter = cell(bath.x + bath.w / 2, bath.y + bath.h / 2);
const bathDest = cell(10, 28); // free area under the living room
await page.mouse.move(bathCenter.x, bathCenter.y);
await page.mouse.down();
await page.mouse.move(bathDest.x, bathDest.y, { steps: 16 });
await page.mouse.up();
await page.waitForTimeout(700);
after = await readPlan();
const bathMoved = after.rooms.find(r => r.name === 'Bathroom');
await page.screenshot({ path: join(OUT, '5-drag-room.png') });
check(
  'drag room from interior',
  bathMoved.x !== bath.x || bathMoved.y !== bath.y,
  `(${bath.x},${bath.y})→(${bathMoved.x},${bathMoved.y})`,
);

// ── 6. Resize still works on selected room wall (avoid openings on the wall) ──
await refreshCell();
before = await readPlan();
const bed2 = before.rooms.find(r => r.name === 'Bedroom 2');
const bed2c = cell(bed2.x + bed2.w / 2, bed2.y + bed2.h / 2);
await page.mouse.click(bed2c.x, bed2c.y);
await page.waitForTimeout(200);
// East wall, north of the E window (window spans y=20..23)
const eWall = cell(bed2.x + bed2.w, bed2.y + 1.5);
await page.mouse.move(eWall.x, eWall.y);
await page.mouse.down();
await page.mouse.move(eWall.x + 4 * cell(0, 0).s, eWall.y, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(700);
after = await readPlan();
const bed2r = after.rooms.find(r => r.name === 'Bedroom 2');
await page.screenshot({ path: join(OUT, '6-resize-room.png') });
check('resize selected room wall', bed2r.w !== bed2.w, `w ${bed2.w}→${bed2r.w}`);

// ── 7. Sidebar open/close still works ──
await page.reload();
await page.waitForSelector('canvas');
await page.waitForTimeout(800);
await refreshCell();
const wPick = cell(8, 12.5);
await page.mouse.move(wPick.x, wPick.y);
await page.mouse.down();
await page.waitForTimeout(300);
await page.mouse.up();
await page.waitForTimeout(300); // living W window
await page.waitForTimeout(300);
before = await readPlan();
const wOpen = before.openings.find(o => o.orient === 'v' && o.x === 8 && o.y === 12);
const wasOpen = wOpen.open;
await page.getByRole('button', { name: wasOpen ? 'Close it' : 'Open it' }).click();
await page.waitForTimeout(400);
after = await readPlan();
const wAfter = after.openings.find(o => o.id === wOpen.id);
check('sidebar toggles opening', wAfter.open === !wasOpen, `${wasOpen}→${wAfter.open}`);

await page.screenshot({ path: join(OUT, '7-final.png') });

console.log('\nCONSOLE_ERRORS:', errors.length ? errors : 'none');
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await context.close().catch(() => {});
if (server) server.close();
await browser.close().catch(() => {});
process.exit(failed.length || errors.length ? 1 : 0);
