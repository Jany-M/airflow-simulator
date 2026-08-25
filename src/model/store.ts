// ── App state (zustand) ────────────────────────────────────────────────────
// Single source of truth. Every plan mutation bumps `rev`, which the canvas
// watches to re-solve the flow field in real time. The plan autosaves to
// localStorage (debounced) — no backend, no DB.

import { create } from 'zustand';
import { Plan, Room, Opening, Tool, Wind, EnvConditions, ViewMode, Orient, uid, GRID_W, GRID_H, CELL_METERS, ensureEnv } from './types';
import { samplePlan, emptyPlan } from './samples';
import { onRoomBoundary, validateOpenings, overlapsAnyRoom, Side } from './geometry';

const LS_KEY = 'airflow-simulator:plan:v1';
const LS_KEY_LEGACY = 'airflow-planner:plan:v1';

export interface AppState {
  plan: Plan;
  rev: number;               // increments on any plan change → triggers re-solve
  tool: Tool;
  selectedId: string | null; // room or opening id
  simRunning: boolean;
  viewMode: ViewMode;
  optimizing: boolean;
  optProgress: { done: number; total: number } | null;
  lastScoreLabel: string | null;
  /** Brief status shown over the canvas (e.g. after import). */
  canvasToast: string | null;
  /** Mobile controls drawer open (ignored on wide screens via CSS). */
  mobilePanelOpen: boolean;

  setTool: (t: Tool) => void;
  setSelected: (id: string | null) => void;
  setWind: (w: Partial<Wind>) => void;
  setEnv: (e: Partial<EnvConditions>) => void;
  setViewMode: (m: ViewMode) => void;
  setMobilePanelOpen: (o: boolean) => void;
  flashCanvasToast: (msg: string) => void;
  addRoom: (r: Omit<Room, 'id' | 'name'>) => void;
  renameRoom: (id: string, name: string) => void;
  deleteRoom: (id: string) => void;
  moveRoom: (id: string, nx: number, ny: number) => void;
  resizeRoom: (id: string, side: Side, pos: number) => void;
  /** Set room size from metres (width = east–west, length = north–south). Anchored at top-left. */
  setRoomSizeM: (id: string, widthM: number, lengthM: number) => void;
  moveOpening: (id: string, orient: Orient, x: number, y: number) => void;
  addOpening: (o: Omit<Opening, 'id'>) => void;
  toggleOpening: (id: string) => void;
  toggleLock: (id: string) => void;
  deleteOpening: (id: string) => void;
  applyOpenSet: (openIds: string[]) => void;
  setSimRunning: (r: boolean) => void;
  setOptimizing: (o: boolean, progress?: { done: number; total: number } | null) => void;
  setScoreLabel: (s: string | null) => void;
  loadPlan: (p: Plan) => void;
  newPlan: () => void;
  loadSample: () => void;
  setPlanName: (name: string) => void;
}

function loadInitial(): Plan {
  try {
    let raw = localStorage.getItem(LS_KEY);
    if (!raw) {
      raw = localStorage.getItem(LS_KEY_LEGACY);
      if (raw) {
        localStorage.setItem(LS_KEY, raw);
        localStorage.removeItem(LS_KEY_LEGACY);
      }
    }
    if (raw) {
      const p = JSON.parse(raw) as Plan;
      if (p && p.version === 1 && Array.isArray(p.rooms)) return ensureEnv(p);
    }
  } catch { /* corrupted → fall through */ }
  return samplePlan();
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(plan: Plan) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(plan)); } catch { /* quota */ }
  }, 400);
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export const useApp = create<AppState>((set, get) => {
  const mut = (fn: (p: Plan) => Plan) => {
    const plan = fn(get().plan);
    scheduleSave(plan);
    set(s => ({ plan, rev: s.rev + 1 }));
  };

  return {
    plan: loadInitial(),
    rev: 0,
    tool: 'select',
    selectedId: null,
    simRunning: true,
    viewMode: 'flow',
    optimizing: false,
    optProgress: null,
    lastScoreLabel: null,
    canvasToast: null,
    mobilePanelOpen: false,

    setTool: t => set({ tool: t, selectedId: null }),
    setSelected: id => set({ selectedId: id }),
    setMobilePanelOpen: o => set({ mobilePanelOpen: o }),
    flashCanvasToast: msg => {
      if (toastTimer) clearTimeout(toastTimer);
      set({ canvasToast: msg });
      toastTimer = setTimeout(() => set({ canvasToast: null }), 2800);
    },
    setWind: w => mut(p => ({ ...p, wind: { ...p.wind, ...w } })),
    setEnv: e => mut(p => ({ ...p, env: { ...p.env, ...e } })),
    setViewMode: m => set({ viewMode: m }),

    addRoom: r => {
      const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
      const x = clamp(r.x, 0, GRID_W - 2), y = clamp(r.y, 0, GRID_H - 2);
      const w = clamp(r.w, 2, GRID_W - x), h = clamp(r.h, 2, GRID_H - y);
      mut(p => ({
        ...p,
        rooms: [...p.rooms, { id: uid(), name: `Room ${p.rooms.length + 1}`, x, y, w, h }],
      }));
    },
    renameRoom: (id, name) => mut(p => ({ ...p, rooms: p.rooms.map(r => r.id === id ? { ...r, name } : r) })),
    deleteRoom: id => mut(p => validateOpenings({ ...p, rooms: p.rooms.filter(r => r.id !== id) })),

    moveRoom: (id, nx, ny) => mut(p => {
      const r = p.rooms.find(rr => rr.id === id);
      if (!r) return p;
      const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
      nx = clamp(Math.round(nx), 0, GRID_W - r.w);
      ny = clamp(Math.round(ny), 0, GRID_H - r.h);
      const dx = nx - r.x, dy = ny - r.y;
      if (!dx && !dy) return p;
      if (overlapsAnyRoom(p, { x: nx, y: ny, w: r.w, h: r.h }, id)) return p; // rooms can touch, not overlap
      const others = p.rooms.filter(rr => rr.id !== id);
      // Openings exclusively on this room's walls travel with it; openings on
      // a wall shared with another room stay with that room.
      const openings = p.openings.map(o =>
        onRoomBoundary(r, o) && !others.some(rr => onRoomBoundary(rr, o))
          ? { ...o, x: o.x + dx, y: o.y + dy }
          : o,
      );
      const rooms = p.rooms.map(rr => rr.id === id ? { ...rr, x: nx, y: ny } : rr);
      return validateOpenings({ ...p, rooms, openings });
    }),

    resizeRoom: (id, side, pos) => mut(p => {
      const r = p.rooms.find(rr => rr.id === id);
      if (!r) return p;
      const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
      let { x, y, w, h } = r;
      const oldLine = side === 'w' ? x : side === 'e' ? x + w : side === 'n' ? y : y + h;
      if (side === 'w') { const np = clamp(Math.round(pos), 0, x + w - 2); w = x + w - np; x = np; }
      else if (side === 'e') { const np = clamp(Math.round(pos), x + 2, GRID_W); w = np - x; }
      else if (side === 'n') { const np = clamp(Math.round(pos), 0, y + h - 2); h = y + h - np; y = np; }
      else { const np = clamp(Math.round(pos), y + 2, GRID_H); h = np - y; }
      const newLine = side === 'w' ? x : side === 'e' ? x + w : side === 'n' ? y : y + h;
      if (newLine === oldLine) return p;
      if (overlapsAnyRoom(p, { x, y, w, h }, id)) return p; // growing into another room is not allowed
      const others = p.rooms.filter(rr => rr.id !== id);
      // Openings exclusively on the dragged wall follow it.
      const openings = p.openings.map(o => {
        const exclusive = onRoomBoundary(r, o) && !others.some(rr => onRoomBoundary(rr, o));
        if (!exclusive) return o;
        if ((side === 'w' || side === 'e') && o.orient === 'v' && o.x === oldLine) return { ...o, x: newLine };
        if ((side === 'n' || side === 's') && o.orient === 'h' && o.y === oldLine) return { ...o, y: newLine };
        return o;
      });
      const rooms = p.rooms.map(rr => rr.id === id ? { ...rr, x, y, w, h } : rr);
      return validateOpenings({ ...p, rooms, openings });
    }),

    setRoomSizeM: (id, widthM, lengthM) => mut(p => {
      const r = p.rooms.find(rr => rr.id === id);
      if (!r) return p;
      const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
      // Metres → cells (0.5 m each). Grow/shrink from the top-left corner.
      const w = clamp(Math.round(widthM / CELL_METERS), 2, GRID_W - r.x);
      const h = clamp(Math.round(lengthM / CELL_METERS), 2, GRID_H - r.y);
      if (w === r.w && h === r.h) return p;
      if (overlapsAnyRoom(p, { x: r.x, y: r.y, w, h }, id)) return p;
      const oldE = r.x + r.w, oldS = r.y + r.h;
      const newE = r.x + w, newS = r.y + h;
      const others = p.rooms.filter(rr => rr.id !== id);
      const openings = p.openings.map(o => {
        const exclusive = onRoomBoundary(r, o) && !others.some(rr => onRoomBoundary(rr, o));
        if (!exclusive) return o;
        if (o.orient === 'v' && o.x === oldE) return { ...o, x: newE };
        if (o.orient === 'h' && o.y === oldS) return { ...o, y: newS };
        return o;
      });
      return validateOpenings({
        ...p,
        rooms: p.rooms.map(rr => rr.id === id ? { ...rr, w, h } : rr),
        openings,
      });
    }),

    moveOpening: (id, orient, x, y) => mut(p => validateOpenings({
      ...p,
      openings: p.openings.map(o => o.id === id ? { ...o, orient, x, y } : o),
    })),

    addOpening: o => mut(p => ({ ...p, openings: [...p.openings, { ...o, id: uid() }] })),
    toggleOpening: id => mut(p => ({ ...p, openings: p.openings.map(o => o.id === id ? { ...o, open: !o.open } : o) })),
    toggleLock: id => mut(p => ({ ...p, openings: p.openings.map(o => o.id === id ? { ...o, locked: !o.locked } : o) })),
    deleteOpening: id => mut(p => ({ ...p, openings: p.openings.filter(o => o.id !== id) })),
    applyOpenSet: openIds => {
      const s = new Set(openIds);
      // Locked openings keep their state; only free openings are rewritten.
      mut(p => ({
        ...p,
        openings: p.openings.map(o => o.locked ? o : { ...o, open: s.has(o.id) }),
      }));
    },

    setSimRunning: r => set({ simRunning: r }),
    setOptimizing: (o, progress = null) => set({ optimizing: o, optProgress: progress }),
    setScoreLabel: s => set({ lastScoreLabel: s }),

    loadPlan: p => { scheduleSave(p); set(st => ({ plan: p, rev: st.rev + 1, selectedId: null })); },
    newPlan: () => { const p = emptyPlan(); scheduleSave(p); set(st => ({ plan: p, rev: st.rev + 1, selectedId: null })); },
    loadSample: () => { const p = samplePlan(); scheduleSave(p); set(st => ({ plan: p, rev: st.rev + 1, selectedId: null })); },
    setPlanName: name => mut(p => ({ ...p, name })),
  };
});

// ── JSON import/export ─────────────────────────────────────────────────────

export function exportPlanJSON(plan: Plan) {
  const blob = new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${plan.name.replace(/[^\w\-]+/g, '_') || 'floor-plan'}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function importPlanJSON(file: File): Promise<Plan> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const p = JSON.parse(String(reader.result)) as Plan;
        if (!p || p.version !== 1 || !Array.isArray(p.rooms) || !Array.isArray(p.openings)) {
          throw new Error('Not a valid Airflow Simulator file');
        }
        resolve(ensureEnv(p));
      } catch (e) { reject(e); }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
