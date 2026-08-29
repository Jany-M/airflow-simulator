// ── Indoor climate simulation ──────────────────────────────────────────────
// Every interior cell carries temperature (°C) and relative humidity (%).
// Each animation frame:
//   1. ADVECTION  — the scalars ride the airflow field (semi-Lagrangian,
//                   wall-aware sampling), so outdoor air visibly travels
//                   from inlets through the rooms.
//   2. INLET SOURCE — cells at inflowing exterior openings blend toward
//                   outdoor conditions at a rate set by the inflow.
//   3. AIR EXCHANGE — anywhere the air moves, conditions drift toward
//                   outdoor values proportionally to local speed (fresh air
//                   replaces stale air); dead zones barely exchange.
//   4. INDOOR PULL — a slow relaxation toward the indoor baseline (thermal
//                   mass, internal moisture) so stagnant rooms stay stale.
//   5. DIFFUSION  — mild smoothing through open faces only (never walls).
//
// This is a comfort visualisation, not building physics: RH is mixed as a
// simple scalar (no psychrometrics), and the vertical dimension is ignored.

import { EnvConditions } from '../model/types';
import { FlowField } from './solver';
import { FIELD_DISPLAY_GAIN } from './constants';

export class ClimateSystem {
  T!: Float32Array;
  RH!: Float32Array;
  private T2!: Float32Array;
  private RH2!: Float32Array;
  private field: FlowField | null = null;
  private gain = 0;
  private prevInside: Uint8Array | null = null;

  setField(f: FlowField | null, env: EnvConditions) {
    this.field = f;
    if (!f) return;
    const n = f.nx * f.ny;
    if (!this.T || this.T.length !== n) {
      this.T = new Float32Array(n);
      this.RH = new Float32Array(n);
      this.T2 = new Float32Array(n);
      this.RH2 = new Float32Array(n);
      this.prevInside = null;
    }
    // Same display normalisation as the particles: fastest cell ≈ 7 cells/s.
    this.gain = f.maxSpeed > 1e-5 ? FIELD_DISPLAY_GAIN / f.maxSpeed : 0;
    // Newly-interior cells start at the indoor baseline; existing cells keep
    // their state so toggling a window doesn't reset the whole building.
    for (let i = 0; i < n; i++) {
      if (f.inside[i] && (!this.prevInside || !this.prevInside[i])) {
        this.T[i] = env.indoorTemp;
        this.RH[i] = env.indoorRH;
      }
    }
    this.prevInside = f.inside.slice();
  }

  /** Reset all interior cells to the indoor baseline. */
  reset(env: EnvConditions) {
    const f = this.field;
    if (!f || !this.T) return;
    for (let i = 0; i < f.nx * f.ny; i++) {
      if (f.inside[i]) { this.T[i] = env.indoorTemp; this.RH[i] = env.indoorRH; }
    }
  }

  step(dtRaw: number, env: EnvConditions) {
    const f = this.field;
    if (!f || !this.T) return;
    const dt = Math.min(dtRaw, 0.05);
    const { nx, ny, inside, u, v, cu, cv, speed } = f;
    const g = this.gain;
    const T = this.T, RH = this.RH, T2 = this.T2, RH2 = this.RH2;

    // 1. Semi-Lagrangian advection (wall-aware: sample corners weighted by
    //    the interior mask so values never bleed through walls diagonally).
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const i = y * nx + x;
        if (!inside[i]) { T2[i] = T[i]; RH2[i] = RH[i]; continue; }
        const ux = (u[y * (nx + 1) + x] + u[y * (nx + 1) + x + 1]) / 2;
        const uy = (v[y * nx + x] + v[(y + 1) * nx + x]) / 2;
        // backtrace (in cell units)
        const bx = x + 0.5 - ux * g * dt;
        const by = y + 0.5 - uy * g * dt;
        const cx0 = Math.floor(bx - 0.5), cy0 = Math.floor(by - 0.5);
        const tx = bx - 0.5 - cx0, ty = by - 0.5 - cy0;
        let wsum = 0, tAcc = 0, rhAcc = 0;
        for (let dy = 0; dy <= 1; dy++) {
          for (let dx = 0; dx <= 1; dx++) {
            const sx = cx0 + dx, sy = cy0 + dy;
            if (sx < 0 || sx >= nx || sy < 0 || sy >= ny) continue;
            const si = sy * nx + sx;
            if (!inside[si]) continue;
            const w = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty);
            wsum += w; tAcc += w * T[si]; rhAcc += w * RH[si];
          }
        }
        if (wsum > 1e-6) { T2[i] = tAcc / wsum; RH2[i] = rhAcc / wsum; }
        else { T2[i] = T[i]; RH2[i] = RH[i]; }
      }
    }

    // 2. Outdoor-air source at inflowing exterior openings.
    //    Rates use ABSOLUTE flow (which scales with wind speed), so changing
    //    the wind, or opening/closing any door or window, changes how fast
    //    each room's temperature and humidity move — in real time.
    for (const bc of f.boundaryCells) {
      if (bc.inflow <= 0 || !inside[bc.i]) continue;
      const k = 1 - Math.exp(-Math.min(bc.inflow, 5) * dt * 1.4);
      T2[bc.i] += k * (env.outdoorTemp - T2[bc.i]);
      RH2[bc.i] += k * (env.outdoorRH - RH2[bc.i]);
    }

    // 3+4. Airflow-proportional exchange with outdoor air, slow pull to
    //      indoor baseline (thermal mass / internal moisture sources).
    for (let i = 0; i < nx * ny; i++) {
      if (!inside[i]) continue;
      const kOut = 1 - Math.exp(-0.5 * speed[i] * dt);
      T2[i] += kOut * (env.outdoorTemp - T2[i]);
      RH2[i] += kOut * (env.outdoorRH - RH2[i]);
      const kIn = 1 - Math.exp(-0.02 * dt);
      T2[i] += kIn * (env.indoorTemp - T2[i]);
      RH2[i] += kIn * (env.indoorRH - RH2[i]);
    }

    // 5. Diffusion through open faces only (walls block heat/moisture mixing
    //    on the timescale we visualise).
    const kd = Math.min(0.35, 2.0 * dt);
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const i = y * nx + x;
        if (!inside[i]) { T[i] = T2[i]; RH[i] = RH2[i]; continue; }
        let wsum = 0, tAcc = 0, rhAcc = 0;
        const fW = y * (nx + 1) + x, fE = fW + 1;
        const fN = y * nx + x, fS = fN + nx;
        if (x > 0 && cu[fW] > 0 && inside[i - 1]) { wsum++; tAcc += T2[i - 1]; rhAcc += RH2[i - 1]; }
        if (x < nx - 1 && cu[fE] > 0 && inside[i + 1]) { wsum++; tAcc += T2[i + 1]; rhAcc += RH2[i + 1]; }
        if (y > 0 && cv[fN] > 0 && inside[i - nx]) { wsum++; tAcc += T2[i - nx]; rhAcc += RH2[i - nx]; }
        if (y < ny - 1 && cv[fS] > 0 && inside[i + nx]) { wsum++; tAcc += T2[i + nx]; rhAcc += RH2[i + nx]; }
        if (wsum > 0) {
          T[i] = T2[i] + kd * (tAcc / wsum - T2[i]);
          RH[i] = RH2[i] + kd * (rhAcc / wsum - RH2[i]);
        } else { T[i] = T2[i]; RH[i] = RH2[i]; }
      }
    }
  }

  /** Per-room averages for labels/readouts. */
  roomAverages(rooms: Array<{ id: string; x: number; y: number; w: number; h: number }>): Map<string, { t: number; rh: number }> {
    const out = new Map<string, { t: number; rh: number }>();
    const f = this.field;
    if (!f || !this.T) return out;
    for (const r of rooms) {
      let n = 0, tAcc = 0, rhAcc = 0;
      for (let y = r.y; y < r.y + r.h; y++) {
        if (y < 0 || y >= f.ny) continue;
        for (let x = r.x; x < r.x + r.w; x++) {
          if (x < 0 || x >= f.nx) continue;
          const i = y * f.nx + x;
          if (!f.inside[i]) continue;
          n++; tAcc += this.T[i]; rhAcc += this.RH[i];
        }
      }
      if (n > 0) out.set(r.id, { t: tAcc / n, rh: rhAcc / n });
    }
    return out;
  }
}
