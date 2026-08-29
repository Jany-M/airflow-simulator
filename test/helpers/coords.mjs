// Mirror editorTransform / editorFrameBounds for Playwright clicks (built dist, port 4173).

export const GRID_W = 56;
export const GRID_H = 36;

export function isMobileCanvas(cw) {
  return cw < 520;
}

export function editorChromePad(cw, pad = 0.09) {
  if (isMobileCanvas(cw)) return 0.015;
  return Math.min(pad, 0.02);
}

export function editorFrameBounds(cw, plan) {
  const full = { x0: 0, y0: 0, x1: GRID_W, y1: GRID_H };
  if (!plan?.rooms?.length) return full;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of plan.rooms) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  const margin = isMobileCanvas(cw) ? 2 : 3;
  return {
    x0: Math.max(0, x0 - margin),
    y0: Math.max(0, y0 - margin),
    x1: Math.min(GRID_W, x1 + margin),
    y1: Math.min(GRID_H, y1 + margin),
  };
}

export function editorTransform(cw, ch, plan, pad = 0.02, view = { zoom: 1, panX: 0, panY: 0 }) {
  const { x0, y0, x1, y1 } = editorFrameBounds(cw, plan);
  const bw = Math.max(1, x1 - x0);
  const bh = Math.max(1, y1 - y0);
  const effectivePad = editorChromePad(cw, pad);
  const baseS = Math.min(cw / bw, ch / bh) * (1 - effectivePad);
  const s = baseS * view.zoom;
  return {
    s,
    ox: (cw - bw * s) / 2 - x0 * s + view.panX,
    oy: (ch - bh * s) / 2 - y0 * s + view.panY,
  };
}

/** Map grid cell (x,y) to screen coords given canvas bounding box + plan. */
export function cellToScreen(box, plan, x, y, pad = 0.02) {
  const t = editorTransform(box.width, box.height, plan, pad);
  return { x: box.x + t.ox + x * t.s, y: box.y + t.oy + y * t.s, s: t.s };
}

export function syncCellMapper(box, plan, pad = 0.02) {
  const t = editorTransform(box.width, box.height, plan, pad);
  const s = t.s;
  return (x, y) => ({ x: box.x + t.ox + x * t.s, y: box.y + t.oy + y * t.s, s });
}

/** Grid coords on a room wall for resize hit-testing (fraction along wall, 0–1). */
export function wallGrip(room, side, along = 0.2) {
  const t = Math.max(0.1, Math.min(0.9, along));
  switch (side) {
    case 'w': return { x: room.x, y: room.y + room.h * t };
    case 'e': return { x: room.x + room.w, y: room.y + room.h * t };
    case 'n': return { x: room.x + room.w * t, y: room.y };
    case 's': return { x: room.x + room.w * t, y: room.y + room.h };
    default: throw new Error(`unknown wall side: ${side}`);
  }
}

/** Screen delta for dragging a wall outward by deltaCells grid units. */
export function wallDragScreen(mapper, grip, side, deltaCells) {
  const dx = side === 'w' ? -deltaCells : side === 'e' ? deltaCells : 0;
  const dy = side === 'n' ? -deltaCells : side === 's' ? deltaCells : 0;
  const end = mapper(grip.x + dx, grip.y + dy);
  const start = mapper(grip.x, grip.y);
  return { start, end, s: start.s };
}

export function makeCellMapper(page, lsKey = 'airflow-simulator:plan:v1') {
  const readPlan = () => page.evaluate(k => {
    const raw = localStorage.getItem(k);
    return raw ? JSON.parse(raw) : null;
  }, lsKey);
  return async (x, y) => {
    const plan = await readPlan();
    const box = await page.locator('canvas').boundingBox();
    if (!plan || !box) throw new Error('plan or canvas missing');
    return cellToScreen(box, plan, x, y);
  };
}
