// Headless smoke test: loads the built app, exercises the editor,
// runs the optimizer, triggers the PNG export, captures screenshots.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';

const DIST = new URL('../dist', import.meta.url).pathname;
const OUT = new URL('./shots', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  let p = join(DIST, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!existsSync(p)) p = join(DIST, 'index.html');
  res.setHeader('Content-Type', MIME[extname(p)] ?? 'application/octet-stream');
  res.end(readFileSync(p));
});
await new Promise(r => server.listen(4173, r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  geolocation: { latitude: 41.9028, longitude: 12.4964 }, // Rome
  permissions: ['geolocation'],
});
// Mock Open-Meteo + reverse geocoding so the test is deterministic and offline-safe.
await context.route('**/api.open-meteo.com/**', route => route.fulfill({
  contentType: 'application/json',
  body: JSON.stringify({
    current: {
      time: '2026-08-10T16:00',
      temperature_2m: 31.4,
      relative_humidity_2m: 48,
      wind_speed_10m: 5.2,
      wind_direction_10m: 45,
    },
  }),
}));
await context.route('**/geocoding-api.open-meteo.com/**', route => route.fulfill({
  contentType: 'application/json',
  body: JSON.stringify({
    results: [
      { name: "Torre dell'Orso", admin1: 'Apulia', admin2: 'Lecce', country: 'Italy', latitude: 40.2717, longitude: 18.4283 },
      { name: 'Torre del Greco', admin1: 'Campania', admin2: 'Naples', country: 'Italy', latitude: 40.7846, longitude: 14.3676 },
    ],
  }),
}));
await context.route('**/api.bigdatacloud.net/**', route => route.fulfill({
  contentType: 'application/json',
  body: JSON.stringify({
    locality: "Torre dell'Orso",
    city: 'Melendugno',
    principalSubdivision: 'Apulia',
    countryName: 'Italy',
    localityInfo: {
      administrative: [
        { adminLevel: 4, isoCode: 'IT-75', name: 'Apulia' },
        { adminLevel: 6, isoCode: 'IT-LE', name: 'Lecce' },
      ],
    },
  }),
}));
const page = await context.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));

await page.goto('http://localhost:4173/');
await page.waitForTimeout(2500); // let sim solve + particles flow
await page.screenshot({ path: join(OUT, '1-sample-plan.png') });

// Toggle an opening: click sample living-room west window glyph (select tool default).
// Canvas world: GRID 56x36 fit into canvas area (right of 300px sidebar).
const canvas = page.locator('canvas');
const box = await canvas.boundingBox();
const s = Math.min(box.width / 56, box.height / 36) * 0.95;
const ox = box.x + (box.width - 56 * s) / 2;
const oy = box.y + (box.height - 36 * s) / 2;
const cellToScreen = (x, y) => ({ x: ox + x * s, y: oy + y * s });

// Click the living-room S window centre (h edge x=14..17, y=20) to open it
const p1 = cellToScreen(15.5, 20);
await page.mouse.click(p1.x, p1.y);
await page.waitForTimeout(1200);
await page.screenshot({ path: join(OUT, '2-toggled-window.png') });

// Draw a new room with the Room tool in empty space
await page.getByRole('button', { name: 'Room' }).click();
const r1 = cellToScreen(10, 24);
const r2 = cellToScreen(22, 32);
await page.mouse.move(r1.x, r1.y);
await page.mouse.down();
await page.mouse.move(r2.x, r2.y, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(500);

// Add a window on the new room's south wall
await page.getByRole('button', { name: 'Window' }).click();
const wpos = cellToScreen(16, 32);
await page.mouse.click(wpos.x, wpos.y);
await page.waitForTimeout(1200);
await page.screenshot({ path: join(OUT, '3-new-room-window.png') });

// Long-press + drag the new room (Room 7 at 10,24 → 12x8) to a new spot
await page.getByRole('button', { name: 'Select' }).click();
const readPlan = () => page.evaluate(() => JSON.parse(localStorage.getItem('airflow-simulator:plan:v1')));
let planState = await readPlan();
let room7 = planState.rooms.find(r => r.name === 'Room 7');
const r7c = cellToScreen(room7.x + room7.w / 2, room7.y + room7.h / 2);
await page.mouse.move(r7c.x, r7c.y);
await page.mouse.down();
await page.waitForTimeout(450); // long press
await page.mouse.move(r7c.x + 2 * s, r7c.y + 2 * s, { steps: 10 }); // to a free spot (overlaps are rejected)
await page.mouse.up();
await page.waitForTimeout(800); // debounce save
planState = await readPlan();
const room7b = planState.rooms.find(r => r.name === 'Room 7');
console.log('MOVE:', `(${room7.x},${room7.y}) -> (${room7b.x},${room7b.y})`);

// Resize: click to select Room 7, then drag its east wall 4 cells right
const r7c2 = cellToScreen(room7b.x + room7b.w / 2, room7b.y + room7b.h / 2);
await page.mouse.click(r7c2.x, r7c2.y); // short click selects
await page.waitForTimeout(300);
const eWall = cellToScreen(room7b.x + room7b.w, room7b.y + 1.5); // grab wall away from any opening
await page.mouse.move(eWall.x, eWall.y);
await page.mouse.down();
await page.mouse.move(eWall.x + 4 * s, eWall.y, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(800);
planState = await readPlan();
const room7d = planState.rooms.find(r => r.name === 'Room 7');
console.log('RESIZE:', `w ${room7b.w} -> ${room7d.w}`);

// Run the optimizer
await page.getByRole('button', { name: /Suggest best/ }).click();
await page.waitForFunction(
  () => !document.querySelector('button')?.textContent?.includes('Searching') &&
        ![...document.querySelectorAll('button')].some(b => b.textContent.includes('Searching')),
  { timeout: 120000 },
);
await page.waitForTimeout(1500);
await page.screenshot({ path: join(OUT, '4-optimized.png') });
const optMsg = await page.locator('.opt-result').textContent().catch(() => null);

// Manual location search (geocoding mocked below via context.route)
await page.locator('.loc-search input').fill('Torre dell');
await page.locator('.loc-search .btn').click();
await page.waitForSelector('.loc-result', { timeout: 10000 });
await page.locator('.loc-result').first().click();
await page.waitForSelector('.weather-msg', { timeout: 15000 });
const manualMsg = await page.locator('.weather-msg').textContent();
console.log('MANUAL_LOC:', manualMsg);
// back to auto for the geolocation test
await page.locator('.linkish').click();

// Live weather button (geolocation + Open-Meteo both mocked)
await page.getByRole('button', { name: /Use my current weather/ }).click();
await page.waitForSelector('.weather-msg', { timeout: 15000 });
const weatherMsg = await page.locator('.weather-msg').textContent();
const windReadout = await page.locator('.wind-dir').textContent();

// Climate views: let temperature field evolve, then screenshot temp + humidity
await page.getByRole('button', { name: /Temp/ }).click();
await page.waitForTimeout(4000);
await page.screenshot({ path: join(OUT, '6-temperature-view.png') });
await page.getByRole('button', { name: /Humidity/ }).click();
await page.waitForTimeout(1500);
await page.screenshot({ path: join(OUT, '7-humidity-view.png') });
await page.getByRole('button', { name: /Airflow/ }).click();

// Export PNG (capture the download)
const dlPromise = page.waitForEvent('download', { timeout: 30000 });
await page.getByRole('button', { name: /Export PNG/ }).click();
const dl = await dlPromise;
await dl.saveAs(join(OUT, '5-exported-plan.png'));

// Reload → localStorage persistence check
await page.reload();
await page.waitForTimeout(1500);
const roomCount = await page.evaluate(() => {
  const raw = localStorage.getItem('airflow-simulator:plan:v1');
  return raw ? JSON.parse(raw).rooms.length : -1;
});

console.log('OPTIMIZER:', optMsg);
console.log('WEATHER:', weatherMsg);
console.log('WIND_READOUT:', windReadout);
console.log('ROOMS_AFTER_RELOAD:', roomCount);
console.log('CONSOLE_ERRORS:', errors.length ? errors : 'none');

await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
