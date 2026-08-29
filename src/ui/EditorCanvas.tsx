import { useEffect, useRef } from 'react';
import { useApp } from '../model/store';
import { GRID_W, GRID_H, Opening, Orient, Plan } from '../model/types';
import { hitRoomWall, snapCoord, wallLinesX, wallLinesY, overlapsAnyRoom, Side, openingWallSpan } from '../model/geometry';
import { solve, FlowField, scoreField } from '../sim/solver';
import { SOLVE_ITER_LIVE, DEFAULT_WINDOW_LEN, DEFAULT_DOOR_LEN } from '../sim/constants';
import { ParticleSystem } from '../sim/particles';
import { ClimateSystem } from '../sim/climate';
import {
  editorTransform, editorBaseScale, editorFrameBounds, toWorld, wx, wy, COL, DEFAULT_VIEW,
  drawGrid, drawScaleBar, drawFlowHeatmap, drawRooms, drawOpenings, drawWind, drawParticles,
  drawClimateHeatmap, drawRoomClimate, drawClimateLegend, drawCanvasLegend, drawEmptyCanvasGrabHint, drawCellProbe, legendHitTest, isMobileCanvas,
  type ViewState, type LegendHit,
} from './render';

interface DragRect { x0: number; y0: number; x1: number; y1: number }
interface OpeningPreview { orient: Orient; x: number; y: number; len: number; valid: boolean }

/** Extra pad hint — editorTransform clamps this tightly so the plan fills the canvas. */
const EDITOR_PAD = 0.02;
/** World-cell distance before a press becomes a drag (select stays a click under this). */
const DRAG_THRESH = 0.35;
/** Screen pixels before an empty-canvas press becomes a view pan. */
const PAN_DRAG_PX = 6;
/** Hold this long on an opening to select it (yellow ring) and allow dragging. */
const OPENING_LONG_PRESS_MS = 200;
const VIEW_ZOOM_MIN = 0.75;
const VIEW_ZOOM_MAX = 5;

/**
 * Pending press. Rooms: click selects, drag moves.
 * Openings: short click anywhere toggles open/closed; long-press selects.
 * Drag on body (when selected or after long-press) moves along the wall.
 * Drag on centre glyph when selected resizes span.
 */
interface Press {
  sx: number; sy: number;
  target:
    | { kind: 'room'; id: string; offX: number; offY: number }
    | { kind: 'opening'; id: string; onGlyph: boolean };
  timer?: ReturnType<typeof setTimeout>;
  /** Long-press completed → ready to drag (move). */
  armed?: boolean;
  /** Selected at pointerdown, or long-press finished — drag may start immediately. */
  canDrag?: boolean;
  /** Selected opening + centre glyph → drag resizes. */
  resizeMode?: boolean;
  /** Pointer moved before long-press armed (suppress accidental toggle). */
  moved?: boolean;
}

type DragMode =
  | { kind: 'move'; roomId: string; offX: number; offY: number; gx: number; gy: number }
  | { kind: 'resize'; roomId: string; side: Side; pos: number }
  | { kind: 'opening'; id: string; preview: OpeningPreview | null }
  | { kind: 'openingResize'; id: string; len: number };

/** Find the nearest wall edge to a world point; returns a candidate opening placement. */
function findWallPlacement(
  plan: Plan, wxp: number, wyp: number, len: number, excludeId?: string, maxDist = 1.25,
): OpeningPreview | null {
  let best: { orient: Orient; fixed: number; along: number; from: number; to: number; d: number } | null = null;
  for (const r of plan.rooms) {
    const edges: Array<{ orient: Orient; fixed: number; from: number; to: number; d: number; along: number }> = [
      { orient: 'h', fixed: r.y, from: r.x, to: r.x + r.w, d: Math.abs(wyp - r.y), along: wxp },
      { orient: 'h', fixed: r.y + r.h, from: r.x, to: r.x + r.w, d: Math.abs(wyp - (r.y + r.h)), along: wxp },
      { orient: 'v', fixed: r.x, from: r.y, to: r.y + r.h, d: Math.abs(wxp - r.x), along: wyp },
      { orient: 'v', fixed: r.x + r.w, from: r.y, to: r.y + r.h, d: Math.abs(wxp - (r.x + r.w)), along: wyp },
    ];
    for (const e of edges) {
      if (e.along < e.from - 0.5 || e.along > e.to + 0.5) continue;
      if (e.d > maxDist) continue;
      if (!best || e.d < best.d) best = { orient: e.orient, fixed: e.fixed, along: e.along, from: e.from, to: e.to, d: e.d };
    }
  }
  if (!best) return null;
  const start = Math.round(Math.max(best.from, Math.min(best.along - len / 2, best.to - len)));
  if (best.to - best.from < len) return null;
  const preview: OpeningPreview = best.orient === 'h'
    ? { orient: 'h', x: start, y: best.fixed, len, valid: true }
    : { orient: 'v', x: best.fixed, y: start, len, valid: true };
  // reject overlap with existing openings on the same wall line
  for (const o of plan.openings) {
    if (o.id === excludeId) continue;
    if (o.orient !== preview.orient) continue;
    if (preview.orient === 'h' && o.y === preview.y && o.x < preview.x + preview.len && o.x + o.len > preview.x) preview.valid = false;
    if (preview.orient === 'v' && o.x === preview.x && o.y < preview.y + preview.len && o.y + o.len > preview.y) preview.valid = false;
  }
  return preview;
}

/** Wall snap if possible; otherwise a floating (invalid) ghost so the tool always shows something. */
function openingPreviewAt(plan: Plan, wxp: number, wyp: number, len: number, excludeId?: string): OpeningPreview {
  return findWallPlacement(plan, wxp, wyp, len, excludeId) ?? {
    orient: 'h',
    x: Math.round(Math.max(0, Math.min(GRID_W - len, wxp - len / 2))),
    y: Math.round(Math.max(0, Math.min(GRID_H, wyp))),
    len,
    valid: false,
  };
}

/** Hit-test an opening's wall segment or glyph (scale = world cells per screen pixel). */
function hitOpening(plan: Plan, wxp: number, wyp: number, scale = 1): Opening | null {
  const maxDist = Math.max(1.35, 14 / Math.max(scale, 0.5));
  let best: Opening | null = null;
  let bestD = maxDist;
  for (const o of plan.openings) {
    let d: number;
    const cx = o.orient === 'h' ? o.x + o.len / 2 : o.x;
    const cy = o.orient === 'h' ? o.y : o.y + o.len / 2;
    if (o.orient === 'h') {
      const clx = Math.max(o.x, Math.min(wxp, o.x + o.len));
      d = Math.min(Math.hypot(wxp - clx, wyp - o.y), Math.hypot(wxp - cx, wyp - cy));
    } else {
      const cly = Math.max(o.y, Math.min(wyp, o.y + o.len));
      d = Math.min(Math.hypot(wxp - o.x, wyp - cly), Math.hypot(wxp - cx, wyp - cy));
    }
    if (d < bestD) { bestD = d; best = o; }
  }
  return best;
}

/** Hit-test the centre glyph of an opening (resize handle). */
function hitOpeningGlyph(plan: Plan, wxp: number, wyp: number, scale = 1): Opening | null {
  const maxDist = Math.max(0.45, 14 / Math.max(scale, 0.5));
  for (const o of plan.openings) {
    const cx = o.orient === 'h' ? o.x + o.len / 2 : o.x;
    const cy = o.orient === 'h' ? o.y : o.y + o.len / 2;
    if (Math.hypot(wxp - cx, wyp - cy) <= maxDist) return o;
  }
  return null;
}

/** Hit-test an opening wall segment, excluding the centre glyph. */
function hitOpeningBody(plan: Plan, wxp: number, wyp: number, scale = 1): Opening | null {
  const op = hitOpening(plan, wxp, wyp, scale);
  if (!op) return null;
  if (hitOpeningGlyph(plan, wxp, wyp, scale)?.id === op.id) return null;
  return op;
}

function hitRoom(plan: Plan, wxp: number, wyp: number) {
  for (let i = plan.rooms.length - 1; i >= 0; i--) {
    const r = plan.rooms[i];
    if (wxp >= r.x && wxp <= r.x + r.w && wyp >= r.y && wyp <= r.y + r.h) return r;
  }
  return null;
}

/** Pointer is over a room interior or near an opening — floorplan tools, not canvas pan. */
function isFloorplanContent(plan: Plan, wxp: number, wyp: number, scale = 1) {
  return hitOpening(plan, wxp, wyp, scale) != null || hitRoom(plan, wxp, wyp) != null;
}

export default function EditorCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fieldRef = useRef<FlowField | null>(null);
  const particlesRef = useRef(new ParticleSystem());
  const climateRef = useRef(new ClimateSystem());
  const dragRef = useRef<DragRect | null>(null);
  const previewRef = useRef<OpeningPreview | null>(null);
  const mouseRef = useRef<{ x: number; y: number } | null>(null);
  const mouseScreenRef = useRef<{ x: number; y: number } | null>(null);
  const pressRef = useRef<Press | null>(null);
  const dragModeRef = useRef<DragMode | null>(null);
  const viewRef = useRef<ViewState>({ ...DEFAULT_VIEW });
  /** Active pointers for pinch-zoom / two-finger pan (client coords relative to canvas). */
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{
    startDist: number;
    startZoom: number;
    worldMid: { x: number; y: number };
  } | null>(null);
  /** After a pinch, ignore the leftover pointer-up so we don't toggle openings. */
  const gestureSuppressRef = useRef(false);
  /** Active view pan (screen coords). */
  const viewPanRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  /** Empty-canvas press waiting to become a pan (floorplan hits never set this). */
  const pendingPanRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  /** Mobile colour-legend popover (collapsed to icon by default). */
  const legendOpenRef = useRef(false);
  const legendHitRef = useRef<LegendHit | null>(null);

  const plan = useApp(s => s.plan);
  const rev = useApp(s => s.rev);
  const tool = useApp(s => s.tool);
  const selectedId = useApp(s => s.selectedId);
  const simRunning = useApp(s => s.simRunning);
  const viewMode = useApp(s => s.viewMode);
  const gridOpacity = useApp(s => s.gridOpacity);

  // Keep latest values available inside the rAF loop without re-subscribing.
  const stateRef = useRef({ plan, tool, selectedId, simRunning, viewMode, gridOpacity });
  stateRef.current = { plan, tool, selectedId, simRunning, viewMode, gridOpacity };

  // Switching tools cancels in-progress select drags and refreshes the placement ghost.
  useEffect(() => {
    if (pressRef.current?.timer) clearTimeout(pressRef.current.timer);
    pressRef.current = null;
    dragModeRef.current = null;
    dragRef.current = null;
    const m = mouseRef.current;
    if (m && (tool === 'window' || tool === 'door')) {
      previewRef.current = openingPreviewAt(useApp.getState().plan, m.x, m.y, tool === 'door' ? DEFAULT_DOOR_LEN : DEFAULT_WINDOW_LEN);
    } else {
      previewRef.current = null;
    }
  }, [tool]);

  // ── Re-solve (throttled) whenever the plan changes ──
  useEffect(() => {
    let cancelled = false;
    const id = setTimeout(() => {
      if (cancelled) return;
      const t0 = performance.now();
      const planNow = useApp.getState().plan;
      const f = solve(planNow, { iterations: SOLVE_ITER_LIVE });
      fieldRef.current = f;
      particlesRef.current.setField(f);
      climateRef.current.setField(f, planNow.env);
      const sc = scoreField(f, planNow.wind.speed, planNow.rooms);
      useApp.getState().publishFlowResults(f, sc, performance.now() - t0);
    }, 60);
    return () => { cancelled = true; clearTimeout(id); };
  }, [rev]);

  // ── Animation loop ──
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    let last = performance.now();

    const resize = () => {
      const parent = canvas.parentElement!;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = parent.clientWidth * dpr;
      canvas.height = parent.clientHeight * dpr;
      canvas.style.width = `${parent.clientWidth}px`;
      canvas.style.height = `${parent.clientHeight}px`;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement!);

    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const { plan, tool, selectedId, simRunning, viewMode, gridOpacity } = stateRef.current;
      const f = fieldRef.current;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cw = canvas.width / dpr, ch = canvas.height / dpr;
      const t = editorTransform(cw, ch, viewRef.current, EDITOR_PAD, plan);

      ctx.fillStyle = COL.bg;
      ctx.fillRect(0, 0, cw, ch);
      drawGrid(ctx, t, gridOpacity, plan);
      drawScaleBar(ctx, t, cw);

      // Climate always evolves while the sim runs, whatever the view.
      if (f && simRunning) climateRef.current.step(dt, plan.env);

      drawRooms(ctx, t, plan, selectedId);
      // Heatmaps over floors so dynamic temp / RH / airflow colours stay readable.
      if (f && simRunning) {
        if (viewMode === 'flow') drawFlowHeatmap(ctx, t, f, plan.wind.speed);
        else drawClimateHeatmap(ctx, t, f, climateRef.current, viewMode, plan);
      }
      drawOpenings(ctx, t, plan, selectedId);
      drawWind(ctx, t, plan, cw, ch, now);

      if (f && simRunning) {
        particlesRef.current.step(dt);
        drawParticles(ctx, t, particlesRef.current.particles, f.maxSpeed);
        if (viewMode === 'flow') {
          drawClimateLegend(ctx, cw, ch, 'flow', plan);
        } else {
          drawRoomClimate(ctx, t, plan, climateRef.current, viewMode);
          drawClimateLegend(ctx, cw, ch, viewMode, plan);
        }
      }

      // drag ghosts (move / resize / opening reposition)
      const dm = dragModeRef.current;
      if (dm) {
        ctx.save();
        ctx.strokeStyle = COL.wallSelected;
        ctx.setLineDash([7, 5]);
        ctx.lineWidth = 2.5;
        if (dm.kind === 'move') {
          const room = plan.rooms.find(r => r.id === dm.roomId);
          if (room) {
            const bad = overlapsAnyRoom(plan, { x: dm.gx, y: dm.gy, w: room.w, h: room.h }, room.id);
            ctx.strokeStyle = bad ? COL.windowClosed : COL.wallSelected;
            ctx.fillStyle = bad ? 'rgba(255,93,108,0.10)' : 'rgba(255,209,102,0.10)';
            ctx.fillRect(wx(t, dm.gx), wy(t, dm.gy), room.w * t.s, room.h * t.s);
            ctx.strokeRect(wx(t, dm.gx), wy(t, dm.gy), room.w * t.s, room.h * t.s);
          }
        } else if (dm.kind === 'resize') {
          const room = plan.rooms.find(r => r.id === dm.roomId);
          if (room) {
            let { x, y, w, h } = room;
            if (dm.side === 'w') { const np = Math.min(dm.pos, x + w - 2); w = x + w - np; x = np; }
            else if (dm.side === 'e') { w = Math.max(dm.pos - x, 2); }
            else if (dm.side === 'n') { const np = Math.min(dm.pos, y + h - 2); h = y + h - np; y = np; }
            else { h = Math.max(dm.pos - y, 2); }
            const bad = overlapsAnyRoom(plan, { x, y, w, h }, room.id);
            ctx.strokeStyle = bad ? COL.windowClosed : COL.wallSelected;
            ctx.fillStyle = bad ? 'rgba(255,93,108,0.08)' : 'rgba(255,209,102,0.08)';
            ctx.fillRect(wx(t, x), wy(t, y), w * t.s, h * t.s);
            ctx.strokeRect(wx(t, x), wy(t, y), w * t.s, h * t.s);
          }
        } else if (dm.kind === 'openingResize') {
          const op = plan.openings.find(o => o.id === dm.id);
          if (op) {
            ctx.setLineDash([]);
            ctx.strokeStyle = COL.selected;
            ctx.lineWidth = Math.max(3, t.s * 0.34);
            ctx.lineCap = 'round';
            ctx.globalAlpha = 0.9;
            ctx.beginPath();
            if (op.orient === 'h') {
              ctx.moveTo(wx(t, op.x), wy(t, op.y));
              ctx.lineTo(wx(t, op.x + dm.len), wy(t, op.y));
            } else {
              ctx.moveTo(wx(t, op.x), wy(t, op.y));
              ctx.lineTo(wx(t, op.x), wy(t, op.y + dm.len));
            }
            ctx.stroke();
          }
        } else if (dm.kind === 'opening' && dm.preview) {
          ctx.setLineDash([]);
          ctx.strokeStyle = dm.preview.valid ? COL.wallSelected : COL.windowClosed;
          ctx.lineWidth = Math.max(3, t.s * 0.3);
          ctx.lineCap = 'round';
          ctx.globalAlpha = 0.85;
          ctx.beginPath();
          if (dm.preview.orient === 'h') {
            ctx.moveTo(wx(t, dm.preview.x), wy(t, dm.preview.y));
            ctx.lineTo(wx(t, dm.preview.x + dm.preview.len), wy(t, dm.preview.y));
          } else {
            ctx.moveTo(wx(t, dm.preview.x), wy(t, dm.preview.y));
            ctx.lineTo(wx(t, dm.preview.x), wy(t, dm.preview.y + dm.preview.len));
          }
          ctx.stroke();
        }
        ctx.restore();
      }

const dr = dragRef.current;
      if (dr) {
        const x = Math.min(dr.x0, dr.x1), y = Math.min(dr.y0, dr.y1);
        const w = Math.abs(dr.x1 - dr.x0), h = Math.abs(dr.y1 - dr.y0);
        const bad = w >= 2 && h >= 2 && overlapsAnyRoom(plan, { x, y, w, h });
        ctx.strokeStyle = bad ? COL.windowClosed : COL.wallSelected;
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 2;
        ctx.strokeRect(wx(t, x), wy(t, y), w * t.s, h * t.s);
        ctx.setLineDash([]);
        ctx.fillStyle = bad ? 'rgba(255,93,108,0.12)' : 'rgba(255,209,102,0.08)';
        ctx.fillRect(wx(t, x), wy(t, y), w * t.s, h * t.s);
      }

      // opening placement preview (always drawn for window/door so the tool feels “armed”)
      const pv = previewRef.current;
      if (pv && (tool === 'window' || tool === 'door')) {
        ctx.save();
        ctx.strokeStyle = pv.valid ? (tool === 'window' ? COL.windowOpen : COL.doorOpen) : COL.windowClosed;
        ctx.globalAlpha = pv.valid ? 0.9 : 0.55;
        ctx.lineWidth = Math.max(3, t.s * 0.35);
        ctx.lineCap = 'round';
        if (!pv.valid) ctx.setLineDash([6, 5]);
        ctx.beginPath();
        if (pv.orient === 'h') { ctx.moveTo(wx(t, pv.x), wy(t, pv.y)); ctx.lineTo(wx(t, pv.x + pv.len), wy(t, pv.y)); }
        else { ctx.moveTo(wx(t, pv.x), wy(t, pv.y)); ctx.lineTo(wx(t, pv.x), wy(t, pv.y + pv.len)); }
        ctx.stroke();
        // centre glyph so it reads like a placeable opening
        const cx = wx(t, pv.orient === 'h' ? pv.x + pv.len / 2 : pv.x);
        const cy = wy(t, pv.orient === 'h' ? pv.y : pv.y + pv.len / 2);
        const rr = Math.max(5, t.s * 0.4);
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#10141a';
        ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = pv.valid ? (tool === 'window' ? COL.windowOpen : COL.doorOpen) : COL.windowClosed;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }

      // room tool: show snap point + starter footprint under the cursor
      const mouse = mouseRef.current;
      const mouseScreen = mouseScreenRef.current;
      if (tool === 'room' && mouse && !dragRef.current) {
        const gx = Math.round(Math.max(0, Math.min(mouse.x, GRID_W)));
        const gy = Math.round(Math.max(0, Math.min(mouse.y, GRID_H)));
        ctx.save();
        ctx.strokeStyle = COL.wallSelected;
        ctx.fillStyle = 'rgba(255,209,102,0.12)';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 4]);
        // 4×4 cell starter ghost anchored at the snap corner
        const rw = 4, rh = 4;
        const rx = Math.max(0, Math.min(GRID_W - rw, gx));
        const ry = Math.max(0, Math.min(GRID_H - rh, gy));
        ctx.fillRect(wx(t, rx), wy(t, ry), rw * t.s, rh * t.s);
        ctx.strokeRect(wx(t, rx), wy(t, ry), rw * t.s, rh * t.s);
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(wx(t, gx), wy(t, gy), Math.max(3, t.s * 0.22), 0, Math.PI * 2);
        ctx.fillStyle = COL.wallSelected;
        ctx.fill();
        ctx.restore();
      }

      // empty-state hint
      if (plan.rooms.length === 0) {
        ctx.fillStyle = 'rgba(200,215,235,0.5)';
        ctx.font = `500 16px 'Segoe UI', system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText('Pick the Room tool and drag to draw your first room —', cw / 2, ch / 2 - 12);
        ctx.fillText('or load the sample apartment from the sidebar.', cw / 2, ch / 2 + 12);
      }

      // Hover cell probe (live sim values beside cursor).
      if (f && simRunning && mouse && mouseScreen) {
        drawCellProbe(
          ctx, t, mouseScreen.x, mouseScreen.y, cw, ch,
          viewMode, f, climateRef.current, mouse.x, mouse.y, plan.wind.speed,
        );
      }

      // Visible grab hand on empty canvas (OS grab cursor disappears on dark bg).
      if (mouse) {
        const st = stateRef.current;
        const onEmpty = !isFloorplanContent(st.plan, mouse.x, mouse.y, t.s);
        if (onEmpty && st.tool !== 'room') {
          drawEmptyCanvasGrabHint(
            ctx,
            wx(t, mouse.x),
            wy(t, mouse.y),
            viewPanRef.current != null,
          );
        }
      }

      // Always on top so particles / ghosts never hide it.
      legendHitRef.current = drawCanvasLegend(ctx, cw, ch, viewMode, {
        expanded: legendOpenRef.current,
      });

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  // ── Pointer handling ──
  useEffect(() => {
    const canvas = canvasRef.current!;

    const canvasSize = () => {
      const rect = canvas.getBoundingClientRect();
      return { cw: rect.width, ch: rect.height, rect };
    };

    const currentTransform = () => {
      const { cw, ch } = canvasSize();
      return editorTransform(cw, ch, viewRef.current, EDITOR_PAD, stateRef.current.plan);
    };

    const screenPos = (e: PointerEvent) => {
      const { rect } = canvasSize();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    const worldPos = (e: PointerEvent) => {
      const p = screenPos(e);
      return toWorld(currentTransform(), p.x, p.y);
    };

    const setViewAround = (zoom: number, screenX: number, screenY: number, world: { x: number; y: number }) => {
      const { cw, ch } = canvasSize();
      const plan = stateRef.current.plan;
      const s = editorBaseScale(cw, ch, EDITOR_PAD, plan) * zoom;
      const { x0, y0, x1, y1 } = editorFrameBounds(cw, plan);
      const bw = Math.max(1, x1 - x0);
      const bh = Math.max(1, y1 - y0);
      viewRef.current = {
        zoom,
        panX: screenX - (cw - bw * s) / 2 + x0 * s - world.x * s,
        panY: screenY - (ch - bh * s) / 2 + y0 * s - world.y * s,
      };
    };

    const cancelToolGesture = () => {
      if (pressRef.current?.timer) clearTimeout(pressRef.current.timer);
      pressRef.current = null;
      dragModeRef.current = null;
      dragRef.current = null;
      viewPanRef.current = null;
      pendingPanRef.current = null;
    };

    const applyViewPan = (sp: { x: number; y: number }) => {
      const p = viewPanRef.current;
      if (!p) return;
      viewRef.current.panX = p.panX + (sp.x - p.startX);
      viewRef.current.panY = p.panY + (sp.y - p.startY);
    };

    const promotePendingPan = (sp: { x: number; y: number }) => {
      const pending = pendingPanRef.current;
      if (!pending || viewPanRef.current || pressRef.current || dragModeRef.current || dragRef.current) return false;
      if (Math.hypot(sp.x - pending.startX, sp.y - pending.startY) < PAN_DRAG_PX) return false;
      pendingPanRef.current = null;
      viewPanRef.current = {
        startX: pending.startX,
        startY: pending.startY,
        panX: pending.panX,
        panY: pending.panY,
      };
      return true;
    };

    const beginEmptyCanvasPan = (sp: { x: number; y: number }) => {
      pendingPanRef.current = {
        startX: sp.x,
        startY: sp.y,
        panX: viewRef.current.panX,
        panY: viewRef.current.panY,
      };
    };

    const applyPinch = () => {
      const pts = [...pointersRef.current.values()];
      if (pts.length < 2 || !pinchRef.current) return;
      const a = pts[0], b = pts[1];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const { startDist, startZoom, worldMid } = pinchRef.current;
      const zoom = Math.max(VIEW_ZOOM_MIN, Math.min(VIEW_ZOOM_MAX, startZoom * (dist / startDist)));
      const { cw, ch } = canvasSize();
      const plan = stateRef.current.plan;
      const s = editorBaseScale(cw, ch, EDITOR_PAD, plan) * zoom;
      const { x0, y0, x1, y1 } = editorFrameBounds(cw, plan);
      const bw = Math.max(1, x1 - x0);
      const bh = Math.max(1, y1 - y0);
      viewRef.current = {
        zoom,
        panX: mid.x - (cw - bw * s) / 2 + x0 * s - worldMid.x * s,
        panY: mid.y - (ch - bh * s) / 2 + y0 * s - worldMid.y * s,
      };
    };

    const startPinch = () => {
      const pts = [...pointersRef.current.values()];
      if (pts.length < 2) return;
      cancelToolGesture();
      gestureSuppressRef.current = true;
      const a = pts[0], b = pts[1];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const t = currentTransform();
      pinchRef.current = {
        startDist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        startZoom: viewRef.current.zoom,
        worldMid: toWorld(t, mid.x, mid.y),
      };
    };

    const refreshPlacementPreview = (w: { x: number; y: number }) => {
      const { plan, tool } = stateRef.current;
      if (tool === 'window' || tool === 'door') {
        previewRef.current = openingPreviewAt(plan, w.x, w.y, tool === 'door' ? DEFAULT_DOOR_LEN : DEFAULT_WINDOW_LEN);
      } else {
        previewRef.current = null;
      }
    };

    const onDown = (e: PointerEvent) => {
      const sp = screenPos(e);
      pointersRef.current.set(e.pointerId, sp);
      canvas.setPointerCapture(e.pointerId);

      // Mobile legend icon / panel — tap icon to open/close; swallow hits on the open panel.
      if (isMobileCanvas(canvasSize().cw)) {
        const kind = legendHitTest(legendHitRef.current, sp.x, sp.y);
        if (kind === 'toggle') {
          legendOpenRef.current = !legendOpenRef.current;
          e.preventDefault();
          return;
        }
        if (kind === 'panel') {
          e.preventDefault();
          return;
        }
      }

      if (pointersRef.current.size >= 2) {
        startPinch();
        e.preventDefault();
        return;
      }

      if (gestureSuppressRef.current) return;

      const { plan, tool, selectedId } = stateRef.current;
      const st = useApp.getState();
      const w = worldPos(e);
      const scale = currentTransform().s;
      const onFloorplan = isFloorplanContent(plan, w.x, w.y, scale);

      if (e.button === 1) {
        cancelToolGesture();
        viewPanRef.current = {
          startX: sp.x,
          startY: sp.y,
          panX: viewRef.current.panX,
          panY: viewRef.current.panY,
        };
        e.preventDefault();
        return;
      }

      // ── Floorplan content: rooms & openings (never start canvas pan) ──
      if (e.button === 0 && onFloorplan) {
        const op = tool === 'select' ? hitOpening(plan, w.x, w.y, scale) : hitOpening(plan, w.x, w.y, scale);

        if (tool === 'select' && op) {
          const onGlyph = hitOpeningGlyph(plan, w.x, w.y, scale)?.id === op.id;
          const alreadySelected = selectedId === op.id;

          pressRef.current = {
            sx: w.x, sy: w.y,
            target: { kind: 'opening', id: op.id, onGlyph },
            canDrag: alreadySelected,
            resizeMode: alreadySelected && onGlyph,
            timer: alreadySelected ? undefined : setTimeout(() => {
              const p = pressRef.current;
              if (!p || p.target.kind !== 'opening' || p.target.id !== op.id) return;
              p.armed = true;
              p.canDrag = true;
              useApp.getState().setSelected(op.id);
            }, OPENING_LONG_PRESS_MS),
          };
          return;
        }

        if (tool === 'room') {
          const gx = Math.round(Math.max(0, Math.min(w.x, GRID_W)));
          const gy = Math.round(Math.max(0, Math.min(w.y, GRID_H)));
          dragRef.current = { x0: gx, y0: gy, x1: gx, y1: gy };
          return;
        }

        if ((tool === 'window' || tool === 'door') && !op) {
          const len = tool === 'door' ? DEFAULT_DOOR_LEN : DEFAULT_WINDOW_LEN;
          const pv = findWallPlacement(plan, w.x, w.y, len);
          if (pv && pv.valid) {
            st.addOpening({ kind: tool, orient: pv.orient, x: pv.x, y: pv.y, len: pv.len, open: true });
          }
          return;
        }

        if (tool === 'erase') {
          if (op) { st.deleteOpening(op.id); return; }
          const rm = hitRoom(plan, w.x, w.y);
          if (rm) st.deleteRoom(rm.id);
          return;
        }

        // Select on rooms / walls
        const selRoom = plan.rooms.find(r => r.id === selectedId);
        if (selRoom) {
          const side = hitRoomWall(selRoom, w.x, w.y);
          if (side && !op) {
            dragModeRef.current = {
              kind: 'resize', roomId: selRoom.id, side,
              pos: side === 'w' ? selRoom.x : side === 'e' ? selRoom.x + selRoom.w : side === 'n' ? selRoom.y : selRoom.y + selRoom.h,
            };
            return;
          }
        }
        const rm = hitRoom(plan, w.x, w.y);
        if (rm) {
          st.setSelected(rm.id);
          pressRef.current = {
            sx: w.x, sy: w.y,
            target: { kind: 'room', id: rm.id, offX: w.x - rm.x, offY: w.y - rm.y },
          };
          return;
        }
        return;
      }

      // ── Empty canvas: pan on drag (room tool draws here instead) ──
      if (e.button === 0 && !onFloorplan) {
        if (tool === 'room') {
          const gx = Math.round(Math.max(0, Math.min(w.x, GRID_W)));
          const gy = Math.round(Math.max(0, Math.min(w.y, GRID_H)));
          dragRef.current = { x0: gx, y0: gy, x1: gx, y1: gy };
        } else {
          beginEmptyCanvasPan(sp);
        }
      }
    };

    const updateCursor = (w: { x: number; y: number }) => {
      const { plan, tool, selectedId } = stateRef.current;
      const scale = currentTransform().s;
      const onFloorplan = isFloorplanContent(plan, w.x, w.y, scale);
      if (viewPanRef.current) {
        canvas.style.cursor = onFloorplan ? 'grabbing' : 'none';
        return;
      }
      let cur = tool === 'room' ? 'crosshair' : onFloorplan ? 'pointer' : 'grab';
      if (tool === 'select') {
        if (dragModeRef.current) {
          const dm = dragModeRef.current;
          if (dm.kind === 'resize' || dm.kind === 'openingResize') {
            const op = dm.kind === 'openingResize'
              ? plan.openings.find(o => o.id === dm.id)
              : null;
            cur = op?.orient === 'v' || (dm.kind === 'resize' && (dm.side === 'n' || dm.side === 's'))
              ? 'ns-resize' : 'ew-resize';
          } else {
            cur = 'grabbing';
          }
        } else if (onFloorplan) {
          const selOpening = plan.openings.find(o => o.id === selectedId);
          const onGlyph = hitOpeningGlyph(plan, w.x, w.y, scale);
          const selRoom = plan.rooms.find(r => r.id === selectedId);
          const side = selRoom ? hitRoomWall(selRoom, w.x, w.y) : null;
          if (onGlyph && selOpening && onGlyph.id === selOpening.id) {
            cur = selOpening.orient === 'h' ? 'ew-resize' : 'ns-resize';
          } else if (side && !hitOpening(plan, w.x, w.y, scale)) {
            cur = side === 'e' || side === 'w' ? 'ew-resize' : 'ns-resize';
          } else if (hitOpening(plan, w.x, w.y, scale)) cur = 'pointer';
          else if (hitRoom(plan, w.x, w.y)) cur = selectedId && hitRoom(plan, w.x, w.y)?.id === selectedId ? 'grab' : 'pointer';
        } else {
          cur = 'grab';
        }
      } else if (tool !== 'room' && onFloorplan) {
        cur = 'crosshair';
      }
      if (!onFloorplan && tool !== 'room' && (cur === 'grab' || cur === 'grabbing')) {
        cur = 'none';
      }
      canvas.style.cursor = cur;
    };

    const beginPressDrag = (press: Press, w: { x: number; y: number }) => {
      const { plan } = stateRef.current;
      if (press.target.kind === 'room') {
        const room = plan.rooms.find(r => r.id === press.target.id);
        if (!room) return;
        dragModeRef.current = {
          kind: 'move',
          roomId: room.id,
          offX: press.target.offX,
          offY: press.target.offY,
          gx: room.x,
          gy: room.y,
        };
      } else if (press.resizeMode) {
        const op = plan.openings.find(o => o.id === press.target.id);
        dragModeRef.current = { kind: 'openingResize', id: press.target.id, len: op?.len ?? 1 };
      } else {
        dragModeRef.current = { kind: 'opening', id: press.target.id, preview: null };
      }
      pressRef.current = null;
      // Seed first preview / position immediately.
      const dm = dragModeRef.current;
      if (dm?.kind === 'move') {
        const room = plan.rooms.find(r => r.id === dm.roomId);
        if (room) {
          const rawX = w.x - dm.offX, rawY = w.y - dm.offY;
          const xs = wallLinesX(plan, room.id);
          const ys = wallLinesY(plan, room.id);
          const sx = snapCoord([...xs, ...xs.map(v => v - room.w)], rawX);
          const sy = snapCoord([...ys, ...ys.map(v => v - room.h)], rawY);
          dm.gx = Math.max(0, Math.min(GRID_W - room.w, sx ?? Math.round(rawX)));
          dm.gy = Math.max(0, Math.min(GRID_H - room.h, sy ?? Math.round(rawY)));
        }
      } else if (dm?.kind === 'opening') {
        const op = plan.openings.find(o => o.id === dm.id);
        dm.preview = op ? findWallPlacement(plan, w.x, w.y, op.len, op.id) : null;
      } else if (dm?.kind === 'openingResize') {
        const op = plan.openings.find(o => o.id === dm.id);
        if (op) {
          const maxLen = openingWallSpan(plan, op);
          const raw = op.orient === 'h' ? w.x - op.x : w.y - op.y;
          dm.len = Math.max(1, Math.min(maxLen, Math.round(raw)));
        }
      }
    };

    const onMove = (e: PointerEvent) => {
      if (pointersRef.current.has(e.pointerId)) {
        pointersRef.current.set(e.pointerId, screenPos(e));
      }

      if (pointersRef.current.size >= 2) {
        if (!pinchRef.current) startPinch();
        applyPinch();
        e.preventDefault();
        return;
      }

      if (pinchRef.current) return;
      if (gestureSuppressRef.current) return;

      const sp = screenPos(e);
      if (promotePendingPan(sp)) {
        canvas.style.cursor = 'none';
        e.preventDefault();
      }
      if (viewPanRef.current) {
        applyViewPan(sp);
        canvas.style.cursor = isFloorplanContent(stateRef.current.plan, worldPos(e).x, worldPos(e).y, currentTransform().s)
          ? 'grabbing' : 'none';
        e.preventDefault();
        return;
      }

      const { plan, tool } = stateRef.current;
      const w = worldPos(e);
      const scale = currentTransform().s;
      mouseRef.current = w;
      mouseScreenRef.current = screenPos(e);

      // Stale select-drag must not block placement tools after a sidebar tool switch.
      if (tool !== 'select' && (dragModeRef.current || pressRef.current)) {
        if (pressRef.current?.timer) clearTimeout(pressRef.current.timer);
        dragModeRef.current = null;
        pressRef.current = null;
      }

      // Pending press → drag once the pointer travels enough.
      if (tool === 'select' && pressRef.current && Math.hypot(w.x - pressRef.current.sx, w.y - pressRef.current.sy) > DRAG_THRESH) {
        const press = pressRef.current;
        if (press.target.kind === 'opening' && !press.canDrag && !press.armed) {
          if (press.timer) clearTimeout(press.timer);
          press.timer = undefined;
          press.moved = true;
        } else {
          if (press.timer) clearTimeout(press.timer);
          beginPressDrag(press, w);
        }
      }

      const dm = tool === 'select' ? dragModeRef.current : null;
      if (dm) {
        if (dm.kind === 'move') {
          const room = plan.rooms.find(r => r.id === dm.roomId);
          if (room) {
            const rawX = w.x - dm.offX, rawY = w.y - dm.offY;
            // Snap: room edges attach or align to other rooms' walls.
            const xs = wallLinesX(plan, room.id);
            const ys = wallLinesY(plan, room.id);
            const sx = snapCoord([...xs, ...xs.map(v => v - room.w)], rawX);
            const sy = snapCoord([...ys, ...ys.map(v => v - room.h)], rawY);
            dm.gx = Math.max(0, Math.min(GRID_W - room.w, sx ?? Math.round(rawX)));
            dm.gy = Math.max(0, Math.min(GRID_H - room.h, sy ?? Math.round(rawY)));
          }
        } else if (dm.kind === 'resize') {
          const raw = dm.side === 'e' || dm.side === 'w' ? w.x : w.y;
          const cands = dm.side === 'e' || dm.side === 'w' ? wallLinesX(plan, dm.roomId) : wallLinesY(plan, dm.roomId);
          dm.pos = snapCoord(cands, raw) ?? Math.round(raw);
        } else if (dm.kind === 'opening') {
          const op = plan.openings.find(o => o.id === dm.id);
          dm.preview = op ? findWallPlacement(plan, w.x, w.y, op.len, op.id) : null;
        } else if (dm.kind === 'openingResize') {
          const op = plan.openings.find(o => o.id === dm.id);
          if (op) {
            const maxLen = openingWallSpan(plan, op);
            const raw = op.orient === 'h' ? w.x - op.x : w.y - op.y;
            dm.len = Math.max(1, Math.min(maxLen, Math.round(raw)));
          }
        }
        updateCursor(w);
        return;
      }

      if (dragRef.current) {
        dragRef.current.x1 = Math.round(Math.max(0, Math.min(w.x, GRID_W)));
        dragRef.current.y1 = Math.round(Math.max(0, Math.min(w.y, GRID_H)));
      }
      refreshPlacementPreview(w);
      updateCursor(w);
    };

    const onEnter = (e: PointerEvent) => {
      const w = worldPos(e);
      mouseRef.current = w;
      mouseScreenRef.current = screenPos(e);
      refreshPlacementPreview(w);
      updateCursor(w);
    };

    const onLeave = () => {
      mouseScreenRef.current = null;
      // Keep last mouse for tool-switch refresh, but hide floating ghosts off-canvas.
      if (stateRef.current.tool !== 'select') {
        previewRef.current = null;
        mouseRef.current = null;
      }
    };

    const onUp = (e: PointerEvent) => {
      pointersRef.current.delete(e.pointerId);
      if (pointersRef.current.size < 2) {
        pinchRef.current = null;
      }
      viewPanRef.current = null;
      if (gestureSuppressRef.current) {
        if (pointersRef.current.size === 0) gestureSuppressRef.current = false;
        return;
      }

      const st = useApp.getState();

      // Commit an active drag.
      const dm = dragModeRef.current;
      if (dm) {
        dragModeRef.current = null;
        if (pressRef.current?.timer) clearTimeout(pressRef.current.timer);
        pressRef.current = null;
        if (dm.kind === 'move') st.moveRoom(dm.roomId, dm.gx, dm.gy);
        else if (dm.kind === 'resize') st.resizeRoom(dm.roomId, dm.side, dm.pos);
        else if (dm.kind === 'openingResize') st.setOpeningLen(dm.id, dm.len);
        else if (dm.kind === 'opening' && dm.preview?.valid) {
          st.moveOpening(dm.id, dm.preview.orient, dm.preview.x, dm.preview.y);
        }
        return;
      }

      // Click (no drag).
      if (pressRef.current) {
        const press = pressRef.current;
        if (press.timer) clearTimeout(press.timer);
        pressRef.current = null;
        if (press.target.kind === 'opening') {
          const dist = Math.hypot(
            worldPos(e).x - press.sx,
            worldPos(e).y - press.sy,
          );
          const shortClick = dist <= DRAG_THRESH;
          if (press.moved && !press.armed && !press.canDrag) {
            // Dragged before long-press finished — no action.
          } else if (shortClick && !press.armed) {
            // Short click anywhere on the fixture toggles open/closed.
            st.toggleOpening(press.target.id);
            if (st.selectedId === press.target.id) st.setSelected(null);
          }
          // Long-press release without drag: selection already set in timer; no toggle.
        }
        // Room short-click already selected on down.
        return;
      }

      if (pendingPanRef.current) {
        if (stateRef.current.tool === 'select') st.setSelected(null);
        pendingPanRef.current = null;
        return;
      }

      const dr = dragRef.current;
      dragRef.current = null;
      if (dr && stateRef.current.tool === 'room') {
        const x = Math.min(dr.x0, dr.x1), y = Math.min(dr.y0, dr.y1);
        const w = Math.abs(dr.x1 - dr.x0), h = Math.abs(dr.y1 - dr.y0);
        if (w >= 2 && h >= 2) st.addRoom({ x, y, w, h });
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { rect } = canvasSize();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      const before = currentTransform();
      const world = toWorld(before, mx, my);
      const factor = Math.exp(-e.deltaY * 0.0015);
      const zoom = Math.max(VIEW_ZOOM_MIN, Math.min(VIEW_ZOOM_MAX, viewRef.current.zoom * factor));
      setViewAround(zoom, mx, my, world);
    };

    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (inField) return;
        const st = useApp.getState();
        const id = st.selectedId;
        if (!id) return;
        if (st.plan.openings.some(o => o.id === id)) st.deleteOpening(id);
        else if (st.plan.rooms.some(r => r.id === id)) st.deleteRoom(id);
        st.setSelected(null);
      }
      if (e.key === 'Escape') {
        dragRef.current = null;
        dragModeRef.current = null;
        viewPanRef.current = null;
        pendingPanRef.current = null;
        if (pressRef.current?.timer) clearTimeout(pressRef.current.timer);
        pressRef.current = null;
        useApp.getState().setSelected(null);
      }
      if ((e.key === '0' || e.key === 'Home') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        viewRef.current = { ...DEFAULT_VIEW };
      }
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('pointerenter', onEnter);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey);
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerenter', onEnter);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <div className="canvas-wrap" data-tool={tool}>
      <canvas ref={canvasRef} />
    </div>
  );
}
