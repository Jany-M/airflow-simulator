// ── Core data model ────────────────────────────────────────────────────────
// All geometry lives on an integer grid. One grid cell = 0.5 m.
// Rooms are axis-aligned rectangles of cells. Openings (doors/windows) sit on
// cell EDGES: a 'h' edge at (x, y) separates cell (x, y-1) from cell (x, y);
// a 'v' edge at (x, y) separates cell (x-1, y) from cell (x, y).

export const CELL_METERS = 0.5;
export const GRID_W = 56; // 28 m
export const GRID_H = 36; // 18 m

export type OpeningKind = 'window' | 'door';
export type Orient = 'h' | 'v';

export interface Room {
  id: string;
  name: string;
  x: number; // cell coords of top-left
  y: number;
  w: number; // in cells (>= 2)
  h: number;
}

export interface Opening {
  id: string;
  kind: OpeningKind;
  orient: Orient;
  x: number;   // edge coordinate (see header comment)
  y: number;
  len: number; // span in cells along the wall (window: 2 = 1 m, door: 2 = 0.9 m)
  open: boolean;
  locked?: boolean; // excluded from the optimizer (kept as-is)
}

export interface Wind {
  /** Meteorological direction the wind comes FROM, degrees. 0 = North, 90 = East. */
  fromDeg: number;
  /** Wind speed in m/s (affects particle speed + pressure magnitude). */
  speed: number;
}

export interface EnvConditions {
  outdoorTemp: number; // °C
  outdoorRH: number;   // % relative humidity
  indoorTemp: number;  // °C — baseline of stale indoor air (thermal mass, internal gains)
  indoorRH: number;    // %
}

export const DEFAULT_ENV: EnvConditions = { outdoorTemp: 24, outdoorRH: 55, indoorTemp: 28, indoorRH: 65 };

export interface Plan {
  version: 1;
  name: string;
  rooms: Room[];
  openings: Opening[];
  wind: Wind;
  env: EnvConditions;
}

/** Migration: older saved/imported plans may lack `env`. */
export function ensureEnv(p: Plan): Plan {
  if (!p.env || typeof p.env.outdoorTemp !== 'number') {
    return { ...p, env: { ...DEFAULT_ENV } };
  }
  return p;
}

export type ViewMode = 'flow' | 'temp' | 'rh';

export type Tool = 'select' | 'room' | 'window' | 'door' | 'erase';

export interface OptimizerResult {
  openIds: string[];
  score: number;
  coverage: number; // 0..1 fraction of floor area well ventilated
  meanSpeed: number;
}

export const uid = () => Math.random().toString(36).slice(2, 10);

/** Unit vector the wind blows TOWARD (screen coords: +x east, +y south). */
export function windVector(w: Wind): { x: number; y: number } {
  const rad = ((w.fromDeg + 180) % 360) * (Math.PI / 180);
  // 0° = from North → blows toward south (+y). sin for x (east), -cos for y-up → +y down:
  return { x: Math.sin(rad), y: -Math.cos(rad) };
}
