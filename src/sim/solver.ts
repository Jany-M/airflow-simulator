// ── Airflow solver ─────────────────────────────────────────────────────────
// A lightweight pressure-network / potential-flow solver on a staggered grid.
//
// 1. Rasterize the plan: which cells are interior, which cell-edges are
//    walls, open passages, or exterior openings.
// 2. Assign each exterior opening a boundary pressure from a wind pressure
//    coefficient (windward facades +, leeward −, flanks slightly −).
// 3. Solve ∇·(c∇p) = 0 with Gauss–Seidel (c = face conductance, 0 at walls).
// 4. Velocity through each face = c·Δp; cell velocity = face average.
//
// This is not CFD-grade, but it captures the essence of wind-driven cross
// ventilation: flow enters windward openings, follows connected rooms, and
// exits leeward — and it shows where flow dies (dead zones).

import { GRID_W, GRID_H, Opening, Plan, Wind, windVector } from '../model/types';

export interface FlowField {
  nx: number;
  ny: number;
  scale: number;               // cells per plan-cell (1 = full res)
  inside: Uint8Array;          // nx*ny  1 = interior floor cell
  p: Float32Array;             // nx*ny  pressure (relative)
  u: Float32Array;             // (nx+1)*ny  x-velocity on vertical faces
  v: Float32Array;             // nx*(ny+1)  y-velocity on horizontal faces
  speed: Float32Array;         // nx*ny  cell-centred speed magnitude
  maxSpeed: number;
  interiorCount: number;
  /** For each opening id: signed flow (+ = into the building). */
  openingFlux: Map<string, number>;
  /** Inlet segments used to seed particles: {x, y, dx, dy} in cell coords. */
  inlets: Inlet[];
  /** Face conductances (0 = wall/closed) — exposed for the climate layer. */
  cu: Float32Array;
  cv: Float32Array;
  /** Interior cells adjacent to an exterior opening face, with inflow rate (+ = outdoor air entering here). */
  boundaryCells: Array<{ i: number; inflow: number }>;
}

export interface Inlet {
  openingId: string;
  cx: number; cy: number;     // seed centre (cell coords, world space)
  dirx: number; diry: number; // inflow direction (unit)
  span: number;               // cells
  flux: number;
}

interface Faces {
  // conductance of faces; 0 = blocked
  cu: Float32Array; // (nx+1)*ny vertical faces
  cv: Float32Array; // nx*(ny+1) horizontal faces
  // boundary pressure for exterior-opening faces (NaN = not a boundary face)
  bu: Float32Array;
  bv: Float32Array;
  // opening id per boundary face (index into openings array, -1 none)
  ou: Int16Array;
  ov: Int16Array;
}

/** Which cells are inside any room. */
export function rasterizeInside(plan: Plan, nx = GRID_W, ny = GRID_H): Uint8Array {
  const inside = new Uint8Array(nx * ny);
  for (const r of plan.rooms) {
    for (let y = r.y; y < r.y + r.h; y++) {
      if (y < 0 || y >= ny) continue;
      for (let x = r.x; x < r.x + r.w; x++) {
        if (x < 0 || x >= nx) continue;
        inside[y * nx + x] = 1;
      }
    }
  }
  return inside;
}

/** True if the given edge lies on some room's boundary rectangle. */
function edgeOnRoomBoundary(plan: Plan, orient: 'h' | 'v', x: number, y: number): boolean {
  for (const r of plan.rooms) {
    if (orient === 'h') {
      if ((y === r.y || y === r.y + r.h) && x >= r.x && x < r.x + r.w) return true;
    } else {
      if ((x === r.x || x === r.x + r.w) && y >= r.y && y < r.y + r.h) return true;
    }
  }
  return false;
}

/** Wind pressure coefficient for a facade with outward normal n. */
function pressureCoeff(wind: Wind, nx: number, ny: number): number {
  const wv = windVector(wind);
  // exposure: +1 facade squarely faces the wind, −1 fully leeward
  const e = -(wv.x * nx + wv.y * ny);
  if (e > 0.05) return 0.25 + 0.55 * e;      // windward: up to +0.8
  if (e < -0.05) return -0.25 + 0.15 * e;    // leeward: down to −0.4
  return -0.15;                              // flank suction
}

function buildFaces(plan: Plan, openings: Opening[], openSet: Set<string>, nx: number, ny: number, inside: Uint8Array): Faces {
  const cu = new Float32Array((nx + 1) * ny);
  const cv = new Float32Array(nx * (ny + 1));
  const bu = new Float32Array((nx + 1) * ny).fill(NaN);
  const bv = new Float32Array(nx * (ny + 1)).fill(NaN);
  const ou = new Int16Array((nx + 1) * ny).fill(-1);
  const ov = new Int16Array(nx * (ny + 1)).fill(-1);

  const ins = (x: number, y: number) => (x >= 0 && x < nx && y >= 0 && y < ny ? inside[y * nx + x] : 0);

  // Interior faces between two inside cells are open unless on a room boundary (wall).
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x <= nx; x++) {
      const a = ins(x - 1, y), b = ins(x, y);
      if (a && b && !edgeOnRoomBoundary(plan, 'v', x, y)) cu[y * (nx + 1) + x] = 1;
    }
  }
  for (let y = 0; y <= ny; y++) {
    for (let x = 0; x < nx; x++) {
      const a = ins(x, y - 1), b = ins(x, y);
      if (a && b && !edgeOnRoomBoundary(plan, 'h', x, y)) cv[y * nx + x] = 1;
    }
  }

  // Openings punch through walls. Exterior ones become pressure boundaries.
  openings.forEach((op, oi) => {
    if (!openSet.has(op.id)) return;
    const cond = op.kind === 'door' ? 1.0 : 0.9;
    for (let i = 0; i < op.len; i++) {
      if (op.orient === 'v') {
        const x = op.x, y = op.y + i;
        if (y < 0 || y >= ny || x < 0 || x > nx) continue;
        const a = ins(x - 1, y), b = ins(x, y);
        const idx = y * (nx + 1) + x;
        if (a && b) { cu[idx] = cond; }
        else if (a || b) {
          // exterior opening: outward normal points to the outside cell
          const outward = a ? 1 : -1; // outside is to the right (+x) if left cell is inside
          cu[idx] = cond;
          bu[idx] = pressureCoeff(plan.wind, outward, 0);
          ou[idx] = oi;
        }
      } else {
        const x = op.x + i, y = op.y;
        if (x < 0 || x >= nx || y < 0 || y > ny) continue;
        const a = ins(x, y - 1), b = ins(x, y);
        const idx = y * nx + x;
        if (a && b) { cv[idx] = cond; }
        else if (a || b) {
          const outward = a ? 1 : -1; // outside below (+y) if upper cell inside
          cv[idx] = cond;
          bv[idx] = pressureCoeff(plan.wind, 0, outward);
          ov[idx] = oi;
        }
      }
    }
  });

  return { cu, cv, bu, bv, ou, ov };
}

export interface SolveOptions {
  iterations?: number;
  /** Override which openings are open (for optimizer what-if runs). */
  openIds?: Set<string>;
}

export function solve(plan: Plan, opts: SolveOptions = {}): FlowField {
  const nx = GRID_W, ny = GRID_H;
  const iterations = opts.iterations ?? 420;
  const inside = rasterizeInside(plan, nx, ny);
  const openSet = opts.openIds ?? new Set(plan.openings.filter(o => o.open).map(o => o.id));
  const faces = buildFaces(plan, plan.openings, openSet, nx, ny, inside);
  const { cu, cv, bu, bv, ou, ov } = faces;

  const p = new Float32Array(nx * ny);

  // Gauss–Seidel with over-relaxation. Boundary faces contribute a Dirichlet
  // ghost pressure; wall faces contribute nothing (pure Neumann).
  const omega = 1.7;
  for (let it = 0; it < iterations; it++) {
    for (let y = 0; y < ny; y++) {
      const row = y * nx;
      for (let x = 0; x < nx; x++) {
        const i = row + x;
        if (!inside[i]) continue;
        let sum = 0, wsum = 0;
        // west face
        let f = y * (nx + 1) + x;
        let c = cu[f];
        if (c > 0) { const b = bu[f]; if (Number.isNaN(b)) { sum += c * p[i - 1]; } else { sum += c * b; } wsum += c; }
        // east face
        f = y * (nx + 1) + x + 1;
        c = cu[f];
        if (c > 0) { const b = bu[f]; if (Number.isNaN(b)) { sum += c * p[i + 1]; } else { sum += c * b; } wsum += c; }
        // north face
        f = y * nx + x;
        c = cv[f];
        if (c > 0) { const b = bv[f]; if (Number.isNaN(b)) { sum += c * p[i - nx]; } else { sum += c * b; } wsum += c; }
        // south face
        f = (y + 1) * nx + x;
        c = cv[f];
        if (c > 0) { const b = bv[f]; if (Number.isNaN(b)) { sum += c * p[i + nx]; } else { sum += c * b; } wsum += c; }
        if (wsum > 0) {
          const target = sum / wsum;
          p[i] += omega * (target - p[i]);
        }
      }
    }
  }

  // Face velocities from pressure gradients.
  const u = new Float32Array((nx + 1) * ny);
  const v = new Float32Array(nx * (ny + 1));
  const gain = 6 * plan.wind.speed; // visual scaling of Δp → m/s-ish numbers

  for (let y = 0; y < ny; y++) {
    for (let x = 0; x <= nx; x++) {
      const f = y * (nx + 1) + x;
      const c = cu[f];
      if (c <= 0) continue;
      const b = bu[f];
      let pl: number, pr: number;
      if (!Number.isNaN(b)) {
        const leftInside = x > 0 && inside[y * nx + x - 1];
        if (leftInside) { pl = p[y * nx + x - 1]; pr = b; } else { pl = b; pr = p[y * nx + x]; }
      } else { pl = p[y * nx + x - 1]; pr = p[y * nx + x]; }
      u[f] = c * (pl - pr) * gain;
    }
  }
  for (let y = 0; y <= ny; y++) {
    for (let x = 0; x < nx; x++) {
      const f = y * nx + x;
      const c = cv[f];
      if (c <= 0) continue;
      const b = bv[f];
      let pt: number, pb: number;
      if (!Number.isNaN(b)) {
        const topInside = y > 0 && inside[(y - 1) * nx + x];
        if (topInside) { pt = p[(y - 1) * nx + x]; pb = b; } else { pt = b; pb = p[y * nx + x]; }
      } else { pt = p[(y - 1) * nx + x]; pb = p[y * nx + x]; }
      v[f] = c * (pt - pb) * gain;
    }
  }

  // Cell-centred speeds.
  const speed = new Float32Array(nx * ny);
  let maxSpeed = 0, interiorCount = 0;
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      if (!inside[i]) continue;
      interiorCount++;
      const ux = (u[y * (nx + 1) + x] + u[y * (nx + 1) + x + 1]) / 2;
      const uy = (v[y * nx + x] + v[(y + 1) * nx + x]) / 2;
      const s = Math.hypot(ux, uy);
      speed[i] = s;
      if (s > maxSpeed) maxSpeed = s;
    }
  }

  // Flux per opening + inlet seeds + inlet cells (outdoor-air sources).
  const openingFlux = new Map<string, number>();
  const inlets: Inlet[] = [];
  const boundaryCells: Array<{ i: number; inflow: number }> = [];
  const acc = new Map<number, { flux: number; sx: number; sy: number; n: number; dirx: number; diry: number }>();

  for (let y = 0; y < ny; y++) {
    for (let x = 0; x <= nx; x++) {
      const f = y * (nx + 1) + x;
      const oi = ou[f];
      if (oi < 0) continue;
      const leftInside = x > 0 && inside[y * nx + x - 1];
      // u>0 flows +x; inflow if outside is left (u>0 into interior) or outside right (u<0)
      const inflow = leftInside ? -u[f] : u[f];
      boundaryCells.push({ i: leftInside ? y * nx + x - 1 : y * nx + x, inflow });
      const a = acc.get(oi) ?? { flux: 0, sx: 0, sy: 0, n: 0, dirx: 0, diry: 0 };
      a.flux += inflow;
      a.sx += x; a.sy += y + 0.5; a.n++;
      a.dirx = leftInside ? -1 : 1;
      acc.set(oi, a);
    }
  }
  for (let y = 0; y <= ny; y++) {
    for (let x = 0; x < nx; x++) {
      const f = y * nx + x;
      const oi = ov[f];
      if (oi < 0) continue;
      const topInside = y > 0 && inside[(y - 1) * nx + x];
      const inflow = topInside ? -v[f] : v[f];
      boundaryCells.push({ i: topInside ? (y - 1) * nx + x : y * nx + x, inflow });
      const a = acc.get(oi) ?? { flux: 0, sx: 0, sy: 0, n: 0, dirx: 0, diry: 0 };
      a.flux += inflow;
      a.sx += x + 0.5; a.sy += y; a.n++;
      a.diry = topInside ? -1 : 1;
      acc.set(oi, a);
    }
  }
  acc.forEach((a, oi) => {
    const op = plan.openings[oi];
    if (!op) return;
    openingFlux.set(op.id, a.flux);
    if (a.flux > 1e-4) {
      inlets.push({
        openingId: op.id,
        cx: a.sx / a.n, cy: a.sy / a.n,
        dirx: a.dirx, diry: a.diry,
        span: op.len,
        flux: a.flux,
      });
    }
  });

  return { nx, ny, scale: 1, inside, p, u, v, speed, maxSpeed, interiorCount, openingFlux, inlets, cu, cv, boundaryCells };
}

/** Bilinear-ish velocity sample at world position (cell units). */
export function sampleVelocity(f: FlowField, x: number, y: number): { x: number; y: number } {
  const { nx, ny, u, v } = f;
  // u lives at integer x, cell-centre y
  const ux = (() => {
    const gx = Math.min(Math.max(x, 0), nx);
    const gy = Math.min(Math.max(y - 0.5, 0), ny - 1);
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const x1 = Math.min(x0 + 1, nx), y1 = Math.min(y0 + 1, ny - 1);
    const tx = gx - x0, ty = gy - y0;
    const a = u[y0 * (nx + 1) + x0], b = u[y0 * (nx + 1) + x1];
    const c = u[y1 * (nx + 1) + x0], d = u[y1 * (nx + 1) + x1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  })();
  const vy = (() => {
    const gx = Math.min(Math.max(x - 0.5, 0), nx - 1);
    const gy = Math.min(Math.max(y, 0), ny);
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const x1 = Math.min(x0 + 1, nx - 1), y1 = Math.min(y0 + 1, ny);
    const tx = gx - x0, ty = gy - y0;
    const a = v[y0 * nx + x0], b = v[y0 * nx + x1];
    const c = v[y1 * nx + x0], d = v[y1 * nx + x1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  })();
  return { x: ux, y: vy };
}

export interface Score {
  score: number;
  coverage: number;   // fraction of interior cells above threshold
  meanSpeed: number;
  totalFlow: number;  // total inflow
  /** Mean of per-room coverage (0..1). */
  roomBalance: number;
  /** Fraction of rooms that receive meaningful airflow (through-flow goal). */
  roomsReached: number;
}

/** Threshold below which a cell counts as a "dead zone" (fraction of a good breeze). */
export const DEAD_ZONE_SPEED = 0.08;

/** A room counts as "reached" once this fraction of its floor is above the dead-zone threshold. */
const ROOM_REACHED_COV = 0.12;

export function scoreField(
  f: FlowField,
  windSpeed: number,
  rooms?: Array<{ x: number; y: number; w: number; h: number }>,
): Score {
  const threshold = DEAD_ZONE_SPEED * Math.max(windSpeed, 0.5);
  let vent = 0, sum = 0;
  for (let i = 0; i < f.speed.length; i++) {
    if (!f.inside[i]) continue;
    sum += f.speed[i];
    if (f.speed[i] >= threshold) vent++;
  }
  const coverage = f.interiorCount ? vent / f.interiorCount : 0;
  const meanSpeed = f.interiorCount ? sum / f.interiorCount : 0;
  let totalFlow = 0;
  f.openingFlux.forEach(fl => { if (fl > 0) totalFlow += fl; });

  // Per-room stats — optimise for flow *through* the plan, not one strong room.
  let roomBalance = coverage;
  let roomsReached = coverage > 0 ? 1 : 0;
  let minRoomCov = coverage;
  if (rooms && rooms.length > 0) {
    let acc = 0, counted = 0, reached = 0;
    minRoomCov = 1;
    for (const r of rooms) {
      let n = 0, v = 0;
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          if (x < 0 || y < 0 || x >= f.nx || y >= f.ny) continue;
          const i = y * f.nx + x;
          if (!f.inside[i]) continue;
          n++;
          if (f.speed[i] >= threshold) v++;
        }
      }
      if (n <= 0) continue;
      const cov = v / n;
      acc += cov;
      counted++;
      if (cov < minRoomCov) minRoomCov = cov;
      if (cov >= ROOM_REACHED_COV) reached++;
    }
    if (counted > 0) {
      roomBalance = acc / counted;
      roomsReached = reached / counted;
    } else {
      minRoomCov = 0;
      roomBalance = 0;
      roomsReached = 0;
    }
  }

  // Prefer configs that push air through as many rooms as possible:
  //  1) roomsReached — most rooms get a usable breeze
  //  2) roomBalance  — equal per-room coverage (not one big room)
  //  3) minRoomCov   — lift the worst room (reduce dead rooms)
  //  4) coverage     — overall floor area still matters, lightly
  // Mean speed / throughflow only break ties. Penalise "hot corridor" setups
  // where mean speed is high but few rooms are reached.
  const concentration = Math.max(0, Math.min(meanSpeed * 2, 1) - roomsReached);
  const score =
    roomsReached * 50
    + roomBalance * 22
    + minRoomCov * 18
    + coverage * 10
    + Math.min(meanSpeed * 5, 8)
    + Math.min(totalFlow, 6)
    - 0.2 * f.openingFlux.size
    - concentration * 20;
  return { score, coverage, meanSpeed, totalFlow, roomBalance, roomsReached };
}
