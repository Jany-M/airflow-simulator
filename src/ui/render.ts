// ── Shared canvas rendering ────────────────────────────────────────────────
// Used by both the live editor canvas and the PNG exporter so the exported
// image looks exactly like what the user sees (plus streamline arrows).

import { Plan, Opening, GRID_W, GRID_H, CELL_METERS, windVector } from '../model/types';
import { FlowField, sampleVelocity, DEAD_ZONE_SPEED } from '../sim/solver';
import { Particle } from '../sim/particles';
import { ClimateSystem } from '../sim/climate';

export interface Transform { s: number; ox: number; oy: number }

export function fitTransform(cw: number, ch: number, pad = 0.05): Transform {
  const s = Math.min(cw / GRID_W, ch / GRID_H) * (1 - pad);
  const ox = (cw - GRID_W * s) / 2;
  const oy = (ch - GRID_H * s) / 2;
  return { s, ox, oy };
}

export const wx = (t: Transform, x: number) => t.ox + x * t.s;
export const wy = (t: Transform, y: number) => t.oy + y * t.s;
export const toWorld = (t: Transform, px: number, py: number) => ({ x: (px - t.ox) / t.s, y: (py - t.oy) / t.s });

// Palette
export const COL = {
  bg: '#10141a',
  gridDot: 'rgba(255,255,255,0.05)',
  floor: '#1d2531',
  floorEdge: '#2a3547',
  wall: '#8fa3bf',
  wallSelected: '#ffd166',
  roomName: 'rgba(200,215,235,0.75)',
  /** Open window or door — always green. */
  windowOpen: '#42d77d',
  doorOpen: '#42d77d',
  windowClosed: '#ff5d6c',
  doorClosed: '#ff5d6c', // closed = red, whether door or window
  selected: '#ffd166',   // yellow ring = selected (long-press), never replaces open/closed
  deadZone: 'rgba(255,80,90,0.16)',
  particle: '#7fe8ff',
  streamline: '#37d0ff',
  text: '#dfe8f5',
};

export function speedColor(sp: number, max: number): string {
  const t = max > 0 ? Math.min(sp / (max * 0.7), 1) : 0;
  // deep blue (still) → teal → bright cyan-green (fast)
  const r = Math.round(20 + 30 * t);
  const g = Math.round(60 + 150 * t);
  const b = Math.round(110 + 120 * t);
  const a = 0.10 + 0.28 * t;
  return `rgba(${r},${g},${b},${a})`;
}

// ── Climate colormaps ──────────────────────────────────────────────────────

type Stop = [number, number, number];
function lerpStops(stops: Stop[], t: number): Stop {
  const x = Math.min(Math.max(t, 0), 1) * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  const f = x - i;
  return [
    stops[i][0] + (stops[i + 1][0] - stops[i][0]) * f,
    stops[i][1] + (stops[i + 1][1] - stops[i][1]) * f,
    stops[i][2] + (stops[i + 1][2] - stops[i][2]) * f,
  ];
}

const TEMP_STOPS: Stop[] = [
  [43, 96, 222],   // cold blue
  [58, 186, 214],  // cyan
  [96, 196, 116],  // green
  [232, 194, 66],  // yellow
  [235, 110, 52],  // orange
  [222, 51, 66],   // hot red
];
const RH_STOPS: Stop[] = [
  [214, 178, 108], // dry sand
  [150, 180, 150], // neutral
  [86, 158, 214],  // humid blue
  [46, 100, 210],  // very humid deep blue
];

export function tempColor(v: number, lo: number, hi: number, alpha = 0.42): string {
  const [r, g, b] = lerpStops(TEMP_STOPS, (v - lo) / Math.max(hi - lo, 0.01));
  return `rgba(${r | 0},${g | 0},${b | 0},${alpha})`;
}
export function rhColor(v: number, alpha = 0.42): string {
  const [r, g, b] = lerpStops(RH_STOPS, v / 100);
  return `rgba(${r | 0},${g | 0},${b | 0},${alpha})`;
}

/** Range shown in the temperature view: spans indoor & outdoor with margin. */
export function tempRange(plan: Plan): { lo: number; hi: number } {
  const lo = Math.min(plan.env.indoorTemp, plan.env.outdoorTemp) - 1.5;
  const hi = Math.max(plan.env.indoorTemp, plan.env.outdoorTemp) + 1.5;
  return { lo, hi };
}

export function drawClimateHeatmap(
  ctx: CanvasRenderingContext2D, t: Transform, f: FlowField, climate: ClimateSystem,
  mode: 'temp' | 'rh', plan: Plan,
) {
  const { lo, hi } = tempRange(plan);
  for (let y = 0; y < f.ny; y++) {
    for (let x = 0; x < f.nx; x++) {
      const i = y * f.nx + x;
      if (!f.inside[i]) continue;
      ctx.fillStyle = mode === 'temp'
        ? tempColor(climate.T[i], lo, hi)
        : rhColor(climate.RH[i]);
      ctx.fillRect(wx(t, x), wy(t, y), t.s + 0.5, t.s + 0.5);
    }
  }
}

/** Per-room average temp/RH badges (climate views). */
export function drawRoomClimate(
  ctx: CanvasRenderingContext2D, t: Transform, plan: Plan, climate: ClimateSystem, mode: 'temp' | 'rh',
) {
  const avgs = climate.roomAverages(plan.rooms);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const r of plan.rooms) {
    const a = avgs.get(r.id);
    if (!a) continue;
    const label = mode === 'temp' ? `${a.t.toFixed(1)} °C` : `${a.rh.toFixed(0)}% RH`;
    const cx = wx(t, r.x + r.w / 2);
    const cy = wy(t, r.y + r.h / 2) + t.s * 2.2;
    const fs = Math.max(10, t.s * 0.95);
    ctx.font = `600 ${fs}px 'Segoe UI', system-ui, sans-serif`;
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(16,20,26,0.72)';
    const pad = fs * 0.4;
    roundRect(ctx, cx - tw / 2 - pad, cy - fs * 0.72, tw + pad * 2, fs * 1.44, fs * 0.4);
    ctx.fill();
    ctx.fillStyle = mode === 'temp' ? '#ffd8a8' : '#a8d8ff';
    ctx.fillText(label, cx, cy);
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Gradient legend bar (bottom-left) for the climate views. */
export function drawClimateLegend(
  ctx: CanvasRenderingContext2D, cw: number, ch: number, mode: 'temp' | 'rh', plan: Plan,
) {
  const W = 180, H = 12, x = 18, y = ch - 40;
  for (let i = 0; i < W; i++) {
    const f = i / (W - 1);
    if (mode === 'temp') {
      const { lo, hi } = tempRange(plan);
      ctx.fillStyle = tempColor(lo + f * (hi - lo), lo, hi, 0.95);
    } else {
      ctx.fillStyle = rhColor(f * 100, 0.95);
    }
    ctx.fillRect(x + i, y, 1.5, H);
  }
  ctx.strokeStyle = 'rgba(150,175,205,0.4)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, W, H);
  ctx.fillStyle = 'rgba(200,215,235,0.85)';
  ctx.font = `500 12px 'Segoe UI', system-ui, sans-serif`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  const { lo, hi } = tempRange(plan);
  ctx.fillText(mode === 'temp' ? `${lo.toFixed(0)}°C` : '0%', x, y + H + 4);
  ctx.textAlign = 'right';
  ctx.fillText(mode === 'temp' ? `${hi.toFixed(0)}°C` : '100%', x + W, y + H + 4);
  ctx.textAlign = 'center';
  ctx.fillText(mode === 'temp' ? 'room temperature' : 'relative humidity', x + W / 2, y - 18);
}

export function drawGrid(ctx: CanvasRenderingContext2D, t: Transform) {
  ctx.fillStyle = COL.gridDot;
  for (let y = 0; y <= GRID_H; y += 2) {
    for (let x = 0; x <= GRID_W; x += 2) {
      ctx.fillRect(wx(t, x) - 1, wy(t, y) - 1, 2, 2);
    }
  }
}

/** Screen-space scale bar at the top of the canvas (metres). */
export function drawScaleBar(ctx: CanvasRenderingContext2D, t: Transform, cw: number) {
  const candidates = [1, 2, 5, 10];
  let metres = 2;
  for (const m of candidates) {
    const px = (m / CELL_METERS) * t.s;
    if (px >= 56 && px <= 150) { metres = m; break; }
    if (px > 150) { metres = m; break; }
  }
  // Prefer the largest candidate that still fits comfortably.
  for (let i = candidates.length - 1; i >= 0; i--) {
    const px = (candidates[i] / CELL_METERS) * t.s;
    if (px <= Math.min(160, cw * 0.35) && px >= 48) { metres = candidates[i]; break; }
  }
  const barW = (metres / CELL_METERS) * t.s;
  const x = 14;
  const y = 18;
  const padX = 10;
  const label = `${metres} m`;
  const sub = `1 cell = ${CELL_METERS} m  ·  plan ${GRID_W * CELL_METERS}×${GRID_H * CELL_METERS} m`;

  ctx.save();
  ctx.font = `600 12px 'Segoe UI', system-ui, sans-serif`;
  const labelW = ctx.measureText(label).width;
  ctx.font = `500 11px 'Segoe UI', system-ui, sans-serif`;
  const subW = ctx.measureText(sub).width;
  const boxW = Math.max(barW + padX * 2, labelW + padX * 2, Math.min(subW + padX * 2, cw - 28));
  const boxH = 44;

  ctx.fillStyle = 'rgba(16, 20, 26, 0.72)';
  ctx.strokeStyle = 'rgba(143, 163, 191, 0.35)';
  ctx.lineWidth = 1;
  roundRect(ctx, x - 4, y - 14, boxW + 8, boxH, 8);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = 'rgba(223, 232, 245, 0.95)';
  ctx.font = `600 12px 'Segoe UI', system-ui, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(label, x + padX, y + 2);

  ctx.strokeStyle = '#ffd166';
  ctx.fillStyle = '#ffd166';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(x + padX, y + 12);
  ctx.lineTo(x + padX + barW, y + 12);
  ctx.stroke();
  // end ticks
  ctx.beginPath();
  ctx.moveTo(x + padX, y + 7); ctx.lineTo(x + padX, y + 17);
  ctx.moveTo(x + padX + barW, y + 7); ctx.lineTo(x + padX + barW, y + 17);
  ctx.stroke();

  ctx.fillStyle = 'rgba(143, 163, 191, 0.95)';
  ctx.font = `500 11px 'Segoe UI', system-ui, sans-serif`;
  ctx.fillText(sub, x + padX, y + 28);
  ctx.restore();
}

export function drawFlowHeatmap(ctx: CanvasRenderingContext2D, t: Transform, f: FlowField, windSpeed: number) {
  const threshold = DEAD_ZONE_SPEED * Math.max(windSpeed, 0.5);
  for (let y = 0; y < f.ny; y++) {
    for (let x = 0; x < f.nx; x++) {
      const i = y * f.nx + x;
      if (!f.inside[i]) continue;
      const sp = f.speed[i];
      ctx.fillStyle = sp < threshold ? COL.deadZone : speedColor(sp, f.maxSpeed);
      ctx.fillRect(wx(t, x), wy(t, y), t.s + 0.5, t.s + 0.5);
    }
  }
}

export function drawRooms(ctx: CanvasRenderingContext2D, t: Transform, plan: Plan, selectedId: string | null, showNames = true) {
  // floors
  for (const r of plan.rooms) {
    ctx.fillStyle = COL.floor;
    ctx.globalAlpha = 0.55;
    ctx.fillRect(wx(t, r.x), wy(t, r.y), r.w * t.s, r.h * t.s);
    ctx.globalAlpha = 1;
  }
  // walls with gaps at open openings
  ctx.lineCap = 'butt';
  for (const r of plan.rooms) {
    ctx.strokeStyle = r.id === selectedId ? COL.wallSelected : COL.wall;
    ctx.lineWidth = Math.max(2, t.s * 0.22);
    strokeRectWithGaps(ctx, t, plan, r.x, r.y, r.w, r.h);
  }
  if (showNames) {
    ctx.fillStyle = COL.roomName;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const r of plan.rooms) {
      const fs = Math.max(10, Math.min(t.s * 1.15, (r.w * t.s) / Math.max(r.name.length * 0.62, 1)));
      ctx.font = `500 ${fs}px 'Segoe UI', system-ui, sans-serif`;
      ctx.fillText(r.name, wx(t, r.x + r.w / 2), wy(t, r.y + r.h / 2));
      ctx.font = `400 ${fs * 0.72}px 'Segoe UI', system-ui, sans-serif`;
      ctx.fillStyle = 'rgba(160,180,205,0.5)';
      ctx.fillText(`${(r.w * CELL_METERS).toFixed(1)}×${(r.h * CELL_METERS).toFixed(1)} m`, wx(t, r.x + r.w / 2), wy(t, r.y + r.h / 2) + fs * 0.95);
      ctx.fillStyle = COL.roomName;
    }
  }
}

/** Stroke a room rectangle but leave gaps where OPEN openings sit on its walls. */
function strokeRectWithGaps(ctx: CanvasRenderingContext2D, t: Transform, plan: Plan, rx: number, ry: number, rw: number, rh: number) {
  const openOnEdge = (orient: 'h' | 'v', fixed: number, from: number, to: number): Array<[number, number]> => {
    const gaps: Array<[number, number]> = [];
    for (const o of plan.openings) {
      if (!o.open || o.orient !== orient) continue;
      if (orient === 'h' && o.y === fixed && o.x < to && o.x + o.len > from) gaps.push([Math.max(o.x, from), Math.min(o.x + o.len, to)]);
      if (orient === 'v' && o.x === fixed && o.y < to && o.y + o.len > from) gaps.push([Math.max(o.y, from), Math.min(o.y + o.len, to)]);
    }
    return gaps.sort((a, b) => a[0] - b[0]);
  };
  const seg = (x1: number, y1: number, x2: number, y2: number) => {
    ctx.beginPath(); ctx.moveTo(wx(t, x1), wy(t, y1)); ctx.lineTo(wx(t, x2), wy(t, y2)); ctx.stroke();
  };
  const runH = (fixed: number, from: number, to: number) => {
    let cur = from;
    for (const [a, b] of openOnEdge('h', fixed, from, to)) {
      if (a > cur) seg(cur, fixed, a, fixed);
      cur = Math.max(cur, b);
    }
    if (cur < to) seg(cur, fixed, to, fixed);
  };
  const runV = (fixed: number, from: number, to: number) => {
    let cur = from;
    for (const [a, b] of openOnEdge('v', fixed, from, to)) {
      if (a > cur) seg(fixed, cur, fixed, a);
      cur = Math.max(cur, b);
    }
    if (cur < to) seg(fixed, cur, fixed, to);
  };
  runH(ry, rx, rx + rw);          // top
  runH(ry + rh, rx, rx + rw);     // bottom
  runV(rx, ry, ry + rh);          // left
  runV(rx + rw, ry, ry + rh);     // right
}

export function drawOpenings(ctx: CanvasRenderingContext2D, t: Transform, plan: Plan, selectedId: string | null) {
  for (const o of plan.openings) {
    const sel = o.id === selectedId;
    // Open = green, closed = red. Selection adds a yellow ring — it does not recolor status.
    const color = o.open ? COL.doorOpen : COL.doorClosed;
    const lw = Math.max(3, t.s * (o.open ? 0.32 : 0.26));

    const x1 = o.orient === 'h' ? o.x : o.x, y1 = o.orient === 'h' ? o.y : o.y;
    const x2 = o.orient === 'h' ? o.x + o.len : o.x, y2 = o.orient === 'h' ? o.y : o.y + o.len;

    ctx.save();
    if (sel) { ctx.shadowColor = '#ffd166'; ctx.shadowBlur = 14; }
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    if (!o.open) {
      ctx.setLineDash([Math.max(3, t.s * 0.35), Math.max(3, t.s * 0.3)]);
    }
    ctx.beginPath();
    ctx.moveTo(wx(t, x1), wy(t, y1));
    ctx.lineTo(wx(t, x2), wy(t, y2));
    ctx.stroke();
    ctx.setLineDash([]);

    // status glyph at the centre
    const cx = wx(t, (x1 + x2) / 2), cy = wy(t, (y1 + y2) / 2);
    const rr = Math.max(4, t.s * 0.42);
    if (sel) {
      ctx.strokeStyle = COL.selected;
      ctx.lineWidth = Math.max(2, t.s * 0.16);
      ctx.beginPath(); ctx.arc(cx, cy, rr + 3.5, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.fillStyle = '#10141a';
    ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.5, t.s * 0.12);
    ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.6, t.s * 0.14);
    if (o.open) { // check mark
      ctx.beginPath();
      ctx.moveTo(cx - rr * 0.45, cy + rr * 0.02);
      ctx.lineTo(cx - rr * 0.1, cy + rr * 0.38);
      ctx.lineTo(cx + rr * 0.48, cy - rr * 0.34);
      ctx.stroke();
    } else { // X
      ctx.beginPath();
      ctx.moveTo(cx - rr * 0.38, cy - rr * 0.38); ctx.lineTo(cx + rr * 0.38, cy + rr * 0.38);
      ctx.moveTo(cx + rr * 0.38, cy - rr * 0.38); ctx.lineTo(cx - rr * 0.38, cy + rr * 0.38);
      ctx.stroke();
    }
    if (o.locked) {
      ctx.fillStyle = '#ffd166';
      ctx.font = `${Math.max(8, t.s * 0.55)}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('🔒', cx + rr * 1.6, cy - rr * 1.2);
    }
    ctx.restore();
  }
}

/** Bottom-left legend for opening / selection colours (drawn last, above particles). */
export function drawCanvasLegend(
  ctx: CanvasRenderingContext2D, cw: number, ch: number, _viewMode: 'flow' | 'temp' | 'rh',
) {
  const pad = 10;
  const rowH = 20;
  const rows: Array<{ draw: (x: number, y: number) => void; label: string }> = [
    {
      label: 'Open — click to toggle',
      draw: (x, y) => {
        ctx.strokeStyle = COL.doorOpen; ctx.lineWidth = 3; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 22, y); ctx.stroke();
        ctx.fillStyle = '#10141a'; ctx.beginPath(); ctx.arc(x + 11, y, 6, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = COL.doorOpen; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x + 11, y, 6, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x + 8, y); ctx.lineTo(x + 10, y + 2.5); ctx.lineTo(x + 14.5, y - 2.5);
        ctx.stroke();
      },
    },
    {
      label: 'Closed — click to toggle',
      draw: (x, y) => {
        ctx.strokeStyle = COL.doorClosed; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
        ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 22, y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#10141a'; ctx.beginPath(); ctx.arc(x + 11, y, 6, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = COL.doorClosed; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x + 11, y, 6, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x + 8.5, y - 2.5); ctx.lineTo(x + 13.5, y + 2.5);
        ctx.moveTo(x + 13.5, y - 2.5); ctx.lineTo(x + 8.5, y + 2.5);
        ctx.stroke();
      },
    },
    {
      label: 'Selected / movable — hold ~0.2s',
      draw: (x, y) => {
        ctx.strokeStyle = COL.doorOpen; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 22, y); ctx.stroke();
        ctx.strokeStyle = COL.selected; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(x + 11, y, 9, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = '#10141a'; ctx.beginPath(); ctx.arc(x + 11, y, 6, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = COL.doorOpen; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x + 11, y, 6, 0, Math.PI * 2); ctx.stroke();
      },
    },
  ];

  ctx.save();
  ctx.font = `600 12px 'Segoe UI', system-ui, sans-serif`;
  let maxLabel = 0;
  for (const r of rows) maxLabel = Math.max(maxLabel, ctx.measureText(r.label).width);
  const boxW = Math.min(cw - 16, Math.max(200, 44 + maxLabel + pad * 2));
  const boxH = pad + rows.length * rowH + 8;
  // Bottom-right — keeps clear of the climate legend (bottom-left) and the scale bar (top-left).
  const x0 = Math.max(10, cw - boxW - 12);
  const y0 = Math.max(8, ch - boxH - 12);

  ctx.fillStyle = 'rgba(16, 20, 26, 0.88)';
  ctx.strokeStyle = 'rgba(255, 209, 102, 0.45)';
  ctx.lineWidth = 1.5;
  roundRect(ctx, x0, y0, boxW, boxH, 8);
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  rows.forEach((r, i) => {
    const y = y0 + pad + i * rowH + rowH / 2;
    r.draw(x0 + 12, y);
    ctx.fillStyle = 'rgba(223, 232, 245, 0.96)';
    ctx.font = `600 12px 'Segoe UI', system-ui, sans-serif`;
    ctx.fillText(r.label, x0 + 42, y);
  });
  ctx.restore();
}

export function drawWind(ctx: CanvasRenderingContext2D, t: Transform, plan: Plan, cw: number, ch: number) {
  const wv = windVector(plan.wind);
  // Ambient wind arrows drifting outside the building, upwind side
  ctx.save();
  ctx.strokeStyle = 'rgba(120,200,255,0.35)';
  ctx.lineWidth = Math.max(1.5, t.s * 0.1);
  ctx.lineCap = 'round';
  const cx0 = GRID_W / 2 - wv.x * (GRID_W / 2 + 3);
  const cy0 = GRID_H / 2 - wv.y * (GRID_H / 2 + 3);
  const perpX = -wv.y, perpY = wv.x;
  for (let k = -3; k <= 3; k++) {
    const bx = cx0 + perpX * k * 4;
    const by = cy0 + perpY * k * 4;
    const len = 2.4;
    arrow(ctx, wx(t, bx), wy(t, by), wx(t, bx + wv.x * len), wy(t, by + wv.y * len), Math.max(4, t.s * 0.35));
  }
  ctx.restore();

  // Compass rose, top-right corner
  const R = Math.min(cw, ch) * 0.055;
  const px = cw - R - 16, py = R + 16;
  ctx.save();
  ctx.fillStyle = 'rgba(16,20,26,0.85)';
  ctx.beginPath(); ctx.arc(px, py, R + 8, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(150,175,205,0.4)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(px, py, R, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = 'rgba(200,215,235,0.8)';
  ctx.font = `600 ${R * 0.38}px 'Segoe UI', sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('N', px, py - R * 0.68);
  ctx.font = `400 ${R * 0.3}px 'Segoe UI', sans-serif`;
  ctx.fillStyle = 'rgba(160,180,205,0.6)';
  ctx.fillText('S', px, py + R * 0.68);
  ctx.fillText('E', px + R * 0.68, py);
  ctx.fillText('W', px - R * 0.68, py);
  ctx.strokeStyle = COL.windowOpen;
  ctx.fillStyle = COL.windowOpen;
  ctx.lineWidth = Math.max(2, R * 0.12);
  ctx.lineCap = 'round';
  arrow(ctx, px - wv.x * R * 0.55, py - wv.y * R * 0.55, px + wv.x * R * 0.55, py + wv.y * R * 0.55, R * 0.28);
  ctx.font = `500 ${R * 0.34}px 'Segoe UI', sans-serif`;
  ctx.fillStyle = 'rgba(200,225,245,0.9)';
  ctx.fillText(`${plan.wind.speed.toFixed(1)} m/s`, px, py + R + 20);
  ctx.restore();
}

export function arrow(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, head: number) {
  const a = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(a - 0.45), y2 - head * Math.sin(a - 0.45));
  ctx.lineTo(x2 - head * Math.cos(a + 0.45), y2 - head * Math.sin(a + 0.45));
  ctx.closePath(); ctx.fill();
}

export function drawParticles(ctx: CanvasRenderingContext2D, t: Transform, particles: Particle[], maxSpeed: number) {
  ctx.save();
  ctx.lineCap = 'round';
  for (const p of particles) {
    const fade = Math.min(1, p.age * 2.5) * Math.min(1, (p.life - p.age) * 0.8);
    const st = maxSpeed > 0 ? Math.min(p.speed / (maxSpeed * 0.7), 1) : 0;
    ctx.strokeStyle = `rgba(${130 + 90 * st | 0}, ${215 + 30 * st | 0}, 255, ${(0.25 + 0.55 * st) * fade})`;
    ctx.lineWidth = Math.max(1.2, t.s * (0.08 + 0.1 * st));
    const dx = p.x - p.px, dy = p.y - p.py;
    const mag = Math.hypot(dx, dy) || 1e-6;
    const tail = Math.min(mag * 3.5, 0.9) / mag;
    ctx.beginPath();
    ctx.moveTo(wx(t, p.x - dx * tail), wy(t, p.y - dy * tail));
    ctx.lineTo(wx(t, p.x), wy(t, p.y));
    ctx.stroke();
  }
  ctx.restore();
}

/** Integrate streamlines from each inlet and draw them with arrowheads (for export / overlay). */
export function drawStreamlines(ctx: CanvasRenderingContext2D, t: Transform, f: FlowField, opts: { color?: string; width?: number } = {}) {
  ctx.save();
  ctx.strokeStyle = opts.color ?? COL.streamline;
  ctx.fillStyle = opts.color ?? COL.streamline;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const inlet of f.inlets) {
    const seeds = Math.max(1, Math.min(3, Math.round(inlet.span / 2)));
    for (let s = 0; s < seeds; s++) {
      const frac = seeds === 1 ? 0 : (s / (seeds - 1) - 0.5) * 0.6;
      const perpX = -inlet.diry, perpY = inlet.dirx;
      let x = inlet.cx + perpX * frac * inlet.span + inlet.dirx * 0.3;
      let y = inlet.cy + perpY * frac * inlet.span + inlet.diry * 0.3;

      const pts: Array<{ x: number; y: number }> = [{ x, y }];
      for (let i = 0; i < 600; i++) {
        const vel = sampleVelocity(f, x, y);
        const sp = Math.hypot(vel.x, vel.y);
        if (sp < 1e-3) break;
        const step = 0.35 / sp;
        x += vel.x * step; y += vel.y * step;
        const ix = Math.floor(x), iy = Math.floor(y);
        pts.push({ x, y });
        if (ix < 0 || ix >= f.nx || iy < 0 || iy >= f.ny || !f.inside[iy * f.nx + ix]) break;
      }
      if (pts.length < 4) continue;

      const lw = opts.width ?? Math.max(2, t.s * 0.16);
      ctx.lineWidth = lw;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.moveTo(wx(t, pts[0].x), wy(t, pts[0].y));
      for (let i = 1; i < pts.length; i++) ctx.lineTo(wx(t, pts[i].x), wy(t, pts[i].y));
      ctx.stroke();

      // arrowheads roughly every 5 cells of arc length
      let acc2 = 0;
      for (let i = 1; i < pts.length; i++) {
        acc2 += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        if (acc2 >= 5) {
          acc2 = 0;
          const a = Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x);
          const hx = wx(t, pts[i].x), hy = wy(t, pts[i].y);
          const head = lw * 3;
          ctx.beginPath();
          ctx.moveTo(hx + head * Math.cos(a), hy + head * Math.sin(a));
          ctx.lineTo(hx + head * Math.cos(a + 2.6), hy + head * Math.sin(a + 2.6));
          ctx.lineTo(hx + head * Math.cos(a - 2.6), hy + head * Math.sin(a - 2.6));
          ctx.closePath(); ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }
  }
  ctx.restore();
}
