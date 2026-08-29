// ── App state (zustand) ─────────────────────────────────────────────────────
// Single source of truth. Every plan mutation bumps `rev`, which the canvas
// watches to re-solve the flow field in real time. The plan autosaves to
// localStorage (debounced) - no backend, no DB.

import { create } from 'zustand';
import { Plan, Room, Opening, Tool, Wind, EnvConditions, ViewMode, Orient, uid, GRID_W, GRID_H, CELL_METERS, ensureEnv } from './types';
import { samplePlan, emptyPlan } from './samples';
import { onRoomBoundary, validateOpenings, overlapsAnyRoom, Side, planHasOverlaps, sanitizePlan, validateOpeningsWithNotice, openingWallSpan } from './geometry';
import { plansEqual } from './plansEqual';
import { FlowField, Score } from '../sim/solver';
import { buildFlowPublish, FlowStats } from '../sim/results';
import { clampWindDeg } from '../lib/format';

const LS_KEY = 'airflow-simulator:plan:v1';
const LS_KEY_LEGACY = 'airflow-planner:plan:v1';
const PREFS_KEY = 'airflow-simulator:prefs:v1';

interface Prefs { gridOpacity: number }

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Prefs;
      if (typeof p.gridOpacity === 'number') return { gridOpacity: Math.min(0.35, Math.max(0.02, p.gridOpacity)) };
    }
  } catch { /* ignore */ }
  return { gridOpacity: 0.08 };
}

function savePrefs(p: Prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* quota */ }
}

let pendingOverlapWarn = false;

export interface AppState {
  plan: Plan;
  rev: number;
  tool: Tool;
  selectedId: string | null;
  simRunning: boolean;
  viewMode: ViewMode;
  optimizing: boolean;
  optProgress: { done: number; total: number } | null;
  lastScoreLabel: string | null;
  lastOptResult: string | null;
  lastFlowStats: FlowStats | null;
  gridOpacity: number;
  canvasToast: string | null;
  mobilePanelOpen: boolean;

  setTool: (t: Tool) => void;
  setSelected: (id: string | null) => void;
  setWind: (w: Partial<Wind>) => void;
  setEnv: (e: Partial<EnvConditions>) => void;
  setViewMode: (m: ViewMode) => void;
  setMobilePanelOpen: (o: boolean) => void;
  setGridOpacity: (v: number) => void;
  flashCanvasToast: (msg: string) => void;
  clearLastOptResult: () => void;
  publishFlowResults: (f: FlowField, score?: Score, solveMs?: number) => void;
  addRoom: (r: Omit<Room, 'id' | 'name'>) => void;
  renameRoom: (id: string, name: string) => void;
  deleteRoom: (id: string) => void;
  moveRoom: (id: string, nx: number, ny: number) => void;
  resizeRoom: (id: string, side: Side, pos: number) => void;
  setRoomSizeM: (id: string, widthM: number, lengthM: number) => void;
  moveOpening: (id: string, orient: Orient, x: number, y: number) => void;
  setOpeningLen: (id: string, len: number) => void;
  addOpening: (o: Omit<Opening, 'id'>) => void;
  toggleOpening: (id: string) => void;
  toggleLock: (id: string) => void;
  deleteOpening: (id: string) => void;
  applyOpenSet: (openIds: string[]) => void;
  recenterPlan: () => void;
  setSimRunning: (r: boolean) => void;
  setOptimizing: (o: boolean, progress?: { done: number; total: number } | null) => void;
  setLastOptResult: (s: string | null) => void;
  loadPlan: (p: Plan) => void;
  newPlan: () => void;
  loadSample: () => void;
  resetPlanToSample: () => void;
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
      const p = ensureEnv(JSON.parse(raw) as Plan);
      if (p && p.version === 1 && Array.isArray(p.rooms)) {
        if (planHasOverlaps(p)) pendingOverlapWarn = true;
        return p;
      }
    }
  } catch { /* corrupted */ }
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

const prefs = loadPrefs();

export const useApp = create<AppState>((set, get) => {
  const clearLastOptResult = () => set({ lastOptResult: null });

  const commitPlan = (plan: Plan, bumpRev = true) => {
    scheduleSave(plan);
    set(s => ({ plan, ...(bumpRev ? { rev: s.rev + 1 } : {}) }));
  };

  const mut = (fn: (p: Plan) => Plan, opts?: { userEdit?: boolean; noticeOpenings?: boolean }) => {
    const prev = get().plan;
    const raw = fn(prev);
    const { plan, dropped } = validateOpeningsWithNotice(raw);
    if (plansEqual(prev, plan)) return;
    if (opts?.userEdit) clearLastOptResult();
    if (opts?.noticeOpenings && dropped > 0) {
      get().flashCanvasToast(`${dropped} opening(s) removed — no longer on a wall`);
    }
    commitPlan(plan);
  };

  const mutWind = (w: Partial<Wind>) => {
    const prev = get().plan;
    const wind = { ...prev.wind, ...w };
    if (w.fromDeg != null) wind.fromDeg = clampWindDeg(w.fromDeg);
    const plan = { ...prev, wind };
    if (plansEqual(prev, plan)) return;
    clearLastOptResult();
    commitPlan(plan);
  };

  const mutEnv = (e: Partial<EnvConditions>) => {
    const prev = get().plan;
    const plan = { ...prev, env: { ...prev.env, ...e } };
    if (plansEqual(prev, plan)) return;
    clearLastOptResult();
    commitPlan(plan);
  };

  if (pendingOverlapWarn) {
    setTimeout(() => get().flashCanvasToast(
      'Plan has overlapping rooms — simulation may be inaccurate. Fix layout or import a clean plan.',
    ), 300);
    pendingOverlapWarn = false;
  }

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
    lastOptResult: null,
    lastFlowStats: null,
    gridOpacity: prefs.gridOpacity,
    canvasToast: null,
    mobilePanelOpen: false,

    setTool: t => set({ tool: t, selectedId: null }),
    setSelected: id => set({ selectedId: id }),
    setMobilePanelOpen: o => set({ mobilePanelOpen: o }),
    setGridOpacity: v => {
      const gridOpacity = Math.min(0.35, Math.max(0.02, v));
      savePrefs({ gridOpacity });
      set({ gridOpacity });
    },
    flashCanvasToast: msg => {
      if (toastTimer) clearTimeout(toastTimer);
      set({ canvasToast: msg });
      toastTimer = setTimeout(() => set({ canvasToast: null }), 2800);
    },
    clearLastOptResult,
    publishFlowResults: (f, score, solveMs) => {
      const pub = buildFlowPublish(get().plan, f, solveMs, score);
      set({ lastScoreLabel: pub.scoreLabel, lastFlowStats: pub.flowStats });
    },
    setWind: w => mutWind(w),
    setEnv: e => mutEnv(e),
    setViewMode: m => set({ viewMode: m }),

    addRoom: r => {
      const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
      const x = clamp(r.x, 0, GRID_W - 2), y = clamp(r.y, 0, GRID_H - 2);
      const w = clamp(r.w, 2, GRID_W - x), h = clamp(r.h, 2, GRID_H - y);
      if (overlapsAnyRoom(get().plan, { x, y, w, h })) {
        get().flashCanvasToast('Rooms cannot overlap');
        return;
      }
      mut(p => ({
        ...p,
        rooms: [...p.rooms, { id: uid(), name: `Room ${p.rooms.length + 1}`, x, y, w, h }],
      }), { userEdit: true });
    },
    renameRoom: (id, name) => mut(p => ({ ...p, rooms: p.rooms.map(r => r.id === id ? { ...r, name } : r) })),
    deleteRoom: id => mut(p => ({ ...p, rooms: p.rooms.filter(r => r.id !== id) }), { userEdit: true, noticeOpenings: true }),

    moveRoom: (id, nx, ny) => {
      const p = get().plan;
      const r = p.rooms.find(rr => rr.id === id);
      if (!r) return;
      const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
      nx = clamp(Math.round(nx), 0, GRID_W - r.w);
      ny = clamp(Math.round(ny), 0, GRID_H - r.h);
      const dx = nx - r.x, dy = ny - r.y;
      if (!dx && !dy) return;
      if (overlapsAnyRoom(p, { x: nx, y: ny, w: r.w, h: r.h }, id)) {
        get().flashCanvasToast('Rooms cannot overlap');
        return;
      }
      mut(pp => {
        const room = pp.rooms.find(rr => rr.id === id)!;
        const others = pp.rooms.filter(rr => rr.id !== id);
        const openings = pp.openings.map(o =>
          onRoomBoundary(room, o) && !others.some(rr => onRoomBoundary(rr, o))
            ? { ...o, x: o.x + dx, y: o.y + dy }
            : o,
        );
        const rooms = pp.rooms.map(rr => rr.id === id ? { ...rr, x: nx, y: ny } : rr);
        return { ...pp, rooms, openings };
      }, { userEdit: true, noticeOpenings: true });
    },

    resizeRoom: (id, side, pos) => {
      const p = get().plan;
      const r = p.rooms.find(rr => rr.id === id);
      if (!r) return;
      const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
      let { x, y, w, h } = r;
      const oldLine = side === 'w' ? x : side === 'e' ? x + w : side === 'n' ? y : y + h;
      if (side === 'w') { const np = clamp(Math.round(pos), 0, x + w - 2); w = x + w - np; x = np; }
      else if (side === 'e') { const np = clamp(Math.round(pos), x + 2, GRID_W); w = np - x; }
      else if (side === 'n') { const np = clamp(Math.round(pos), 0, y + h - 2); h = y + h - np; y = np; }
      else { const np = clamp(Math.round(pos), y + 2, GRID_H); h = np - y; }
      const newLine = side === 'w' ? x : side === 'e' ? x + w : side === 'n' ? y : y + h;
      if (newLine === oldLine) return;
      if (overlapsAnyRoom(p, { x, y, w, h }, id)) {
        get().flashCanvasToast('Rooms cannot overlap');
        return;
      }
      mut(pp => {
        const room = pp.rooms.find(rr => rr.id === id)!;
        const others = pp.rooms.filter(rr => rr.id !== id);
        const openings = pp.openings.map(o => {
          const exclusive = onRoomBoundary(room, o) && !others.some(rr => onRoomBoundary(rr, o));
          if (!exclusive) return o;
          if ((side === 'w' || side === 'e') && o.orient === 'v' && o.x === oldLine) return { ...o, x: newLine };
          if ((side === 'n' || side === 's') && o.orient === 'h' && o.y === oldLine) return { ...o, y: newLine };
          return o;
        });
        const rooms = pp.rooms.map(rr => rr.id === id ? { ...rr, x, y, w, h } : rr);
        return { ...pp, rooms, openings };
      }, { userEdit: true, noticeOpenings: true });
    },

    setRoomSizeM: (id, widthM, lengthM) => {
      const p = get().plan;
      const r = p.rooms.find(rr => rr.id === id);
      if (!r) return;
      const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
      const w = clamp(Math.round(widthM / CELL_METERS), 2, GRID_W - r.x);
      const h = clamp(Math.round(lengthM / CELL_METERS), 2, GRID_H - r.y);
      if (w === r.w && h === r.h) return;
      if (overlapsAnyRoom(p, { x: r.x, y: r.y, w, h }, id)) {
        get().flashCanvasToast('Rooms cannot overlap');
        return;
      }
      mut(pp => {
        const room = pp.rooms.find(rr => rr.id === id)!;
        const oldE = room.x + room.w, oldS = room.y + room.h;
        const newE = room.x + w, newS = room.y + h;
        const others = pp.rooms.filter(rr => rr.id !== id);
        const openings = pp.openings.map(o => {
          const exclusive = onRoomBoundary(room, o) && !others.some(rr => onRoomBoundary(rr, o));
          if (!exclusive) return o;
          if (o.orient === 'v' && o.x === oldE) return { ...o, x: newE };
          if (o.orient === 'h' && o.y === oldS) return { ...o, y: newS };
          return o;
        });
        return {
          ...pp,
          rooms: pp.rooms.map(rr => rr.id === id ? { ...rr, w, h } : rr),
          openings,
        };
      }, { userEdit: true, noticeOpenings: true });
    },

    moveOpening: (id, orient, x, y) => mut(p => ({
      ...p,
      openings: p.openings.map(o => o.id === id ? { ...o, orient, x, y } : o),
    }), { userEdit: true, noticeOpenings: true }),

    setOpeningLen: (id, len) => {
      const plan = get().plan;
      const o = plan.openings.find(op => op.id === id);
      if (!o) return;
      const maxLen = openingWallSpan(plan, o);
      const nlen = Math.min(maxLen, Math.max(1, Math.round(len)));
      if (nlen === o.len) return;
      mut(p => ({
        ...p,
        openings: p.openings.map(op => op.id === id ? { ...op, len: nlen } : op),
      }), { userEdit: true, noticeOpenings: true });
    },

    addOpening: o => mut(p => ({ ...p, openings: [...p.openings, { ...o, id: uid() }] }), { userEdit: true }),
    toggleOpening: id => mut(p => ({ ...p, openings: p.openings.map(o => o.id === id ? { ...o, open: !o.open } : o) }), { userEdit: true }),
    toggleLock: id => mut(p => ({ ...p, openings: p.openings.map(o => o.id === id ? { ...o, locked: !o.locked } : o) }), { userEdit: true }),
    deleteOpening: id => mut(p => ({ ...p, openings: p.openings.filter(o => o.id !== id) }), { userEdit: true }),
    applyOpenSet: openIds => {
      const s = new Set(openIds);
      mut(p => ({
        ...p,
        openings: p.openings.map(o => o.locked ? o : { ...o, open: s.has(o.id) }),
      }));
    },

    recenterPlan: () => mut(p => {
      if (!p.rooms.length) return p;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const r of p.rooms) {
        x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
        x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
      }
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      let dx = Math.round(GRID_W / 2 - cx);
      let dy = Math.round(GRID_H / 2 - cy);
      const clampShift = (shift: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, shift));
      dx = clampShift(dx, -x0, GRID_W - x1);
      dy = clampShift(dy, -y0, GRID_H - y1);
      if (!dx && !dy) return p;
      return {
        ...p,
        rooms: p.rooms.map(r => ({ ...r, x: r.x + dx, y: r.y + dy })),
        openings: p.openings.map(o => ({ ...o, x: o.x + dx, y: o.y + dy })),
      };
    }, { userEdit: true, noticeOpenings: true }),

    setSimRunning: r => set({ simRunning: r }),
    setOptimizing: (o, progress = null) => set({ optimizing: o, optProgress: progress }),
    setLastOptResult: s => set({ lastOptResult: s }),

    loadPlan: p => {
      const clean = sanitizePlan(ensureEnv(p));
      scheduleSave(clean);
      clearLastOptResult();
      set(st => ({ plan: clean, rev: st.rev + 1, selectedId: null, lastOptResult: null }));
    },
    newPlan: () => {
      const p = emptyPlan();
      scheduleSave(p);
      clearLastOptResult();
      set(st => ({ plan: p, rev: st.rev + 1, selectedId: null, lastOptResult: null }));
    },
    loadSample: () => {
      const p = samplePlan();
      scheduleSave(p);
      clearLastOptResult();
      set(st => ({ plan: p, rev: st.rev + 1, selectedId: null, lastOptResult: null }));
    },
    resetPlanToSample: () => {
      try {
        localStorage.removeItem(LS_KEY);
        localStorage.removeItem(LS_KEY_LEGACY);
      } catch { /* ignore */ }
      const p = samplePlan();
      scheduleSave(p);
      clearLastOptResult();
      set(st => ({ plan: p, rev: st.rev + 1, selectedId: null, lastOptResult: null }));
      get().flashCanvasToast('Floorplan reset to sample apartment');
    },
    setPlanName: name => mut(p => ({ ...p, name })),
  };
});

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
        const p = sanitizePlan(ensureEnv(JSON.parse(String(reader.result)) as Plan));
        if (!p || p.version !== 1 || !Array.isArray(p.rooms) || !Array.isArray(p.openings)) {
          throw new Error('Not a valid Airflow Simulator file');
        }
        if (planHasOverlaps(p)) {
          throw new Error('Plan has overlapping rooms — fix the layout in the source file before importing.');
        }
        resolve(p);
      } catch (e) { reject(e); }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
