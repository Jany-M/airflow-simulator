import { useEffect, useRef } from 'react';
import { useApp } from '../model/store';
import { GRID_W, GRID_H, Opening, Orient, Plan } from '../model/types';
import { hitRoomWall, snapCoord, wallLinesX, wallLinesY, overlapsAnyRoom, Side } from '../model/geometry';
import { solve, scoreField, FlowField } from '../sim/solver';
import { ParticleSystem } from '../sim/particles';
import { ClimateSystem } from '../sim/climate';
import {
  editorTransform, editorBaseScale, editorFrameBounds, toWorld, wx, wy, COL, DEFAULT_VIEW,
  drawGrid, drawScaleBar, drawFlowHeatmap, drawRooms, drawOpenings, drawWind, drawParticles,
  drawClimateHeatmap, drawRoomClimate, drawClimateLegend, drawCanvasLegend, legendHitTest, isMobileCanvas,
  type ViewState, type LegendHit,
} from './render';

interface DragRect { x0: number; y0: number; x1: number; y1: number }
interface OpeningPreview { orient: Orient; x: number; y: number; len: number; valid: boolean }

/** Extra pad so the top scale bar HUD does not sit on the plan. */
const EDITOR_PAD = 0.09;
/** World-cell distance before a press becomes a drag (select stays a click under this). */
const DRAG_THRESH = 0.35;
/** Hold this long on an opening to select it (yellow ring) and allow dragging. */
const OPENING_LONG_PRESS_MS = 200;
const VIEW_ZOOM_MIN = 0.75;
const VIEW_ZOOM_MAX = 5;

/**
 * Pending press. Rooms: click selects, drag moves.
 * Openings: short click toggles open/closed; long-press arms selection + drag.
 */
interface Press {
  sx: number; sy: number;
  target:
    | { kind: 'room'; id: string; offX: number; offY: number }
    | { kind: 'opening'; id: string };
  timer?: ReturnType<typeof setTimeout>;
  /** Opening long-press completed (or already selected) → ready to drag. */
  armed?: boolean;
  /** Opening was already selected at pointerdown. */
  wasSelected?: boolean;
}

type DragMode =
  | { kind: 'move'; roomId: string; offX: number; offY: number; gx: number; gy: number }
  | { kind: 'resize'; roomId: string; side: Side; pos: number }
  | { kind: 'opening'; id: string; preview: OpeningPreview | null };

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

/** Hit-test an opening's glyph / segment. */
function hitOpening(plan: Plan, wxp: number, wyp: number): Opening | null {
  let best: Opening | null = null;
  let bestD = 0.9;
  for (const o of plan.openings) {
    let d: number;
    if (o.orient === 'h') {
      const clx = Math.max(o.x, Math.min(wxp, o.x + o.len));
      d = Math.hypot(wxp - clx, wyp - o.y);
    } else {
      const cly = Math.max(o.y, Math.min(wyp, o.y + o.len));
      d = Math.hypot(wxp - o.x, wyp - cly);
    }
    if (d < bestD) { bestD = d; best = o; }
  }
  return best;
}

function hitRoom(plan: Plan, wxp: number, wyp: number) {
  for (let i = plan.rooms.length - 1; i >= 0; i--) {
    const r = plan.rooms[i];
    if (wxp >= r.x && wxp <= r.x + r.w && wyp >= r.y && wyp <= r.y + r.h) return r;
  }
  return null;
}

export default function EditorCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fieldRef = useRef<FlowField | null>(null);
  const particlesRef = useRef(new ParticleSystem());
  const climateRef = useRef(new ClimateSystem());
  const dragRef = useRef<DragRect | null>(null);
  const previewRef = useRef<OpeningPreview | null>(null);
  const mouseRef = useRef<{ x: number; y: number } | null>(null);
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
  /** Mobile colour-legend popover (collapsed to icon by default). */
  const legendOpenRef = useRef(false);
  const legendHitRef = useRef<LegendHit | null>(null);

  const plan = useApp(s => s.plan);
  const rev = useApp(s => s.rev);
  const tool = useApp(s => s.tool);
  const selectedId = useApp(s => s.selectedId);
  const simRunning = useApp(s => s.simRunning);
  const viewMode = useApp(s => s.viewMode);

  // Keep latest values available inside the rAF loop without re-subscribing.
  const stateRef = useRef({ plan, tool, selectedId, simRunning, viewMode });
  stateRef.current = { plan, tool, selectedId, simRunning, viewMode };

  // Switching tools cancels in-progress select drags and refreshes the placement ghost.
  useEffect(() => {
    if (pressRef.current?.timer) clearTimeout(pressRef.current.timer);
    pressRef.current = null;
    dragModeRef.current = null;
    dragRef.current = null;
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
    }
    const m = mouseRef.current;
    if (m && (tool === 'window' || tool === 'door')) {
      previewRef.current = openingPreviewAt(useApp.getState().plan, m.x, m.y, 2);
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
      const f = solve(useApp.getState().plan);
      fieldRef.current = f;
      particlesRef.current.setField(f);
      climateRef.current.setField(f, useApp.getState().plan.env);
      const s = scoreField(f, useApp.getState().plan.wind.speed);
      useApp.getState().setScoreLabel(
        `Ventilated area: ${(s.coverage * 100).toFixed(0)}%  ·  mean airflow ${(s.meanSpeed).toFixed(2)}  ·  solve ${(performance.now() - t0).toFixed(0)} ms`,
      );
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
      const { plan, tool, selectedId, simRunning, viewMode } = stateRef.current;
      const f = fieldRef.current;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cw = canvas.width / dpr, ch = canvas.height / dpr;
      const t = editorTransform(cw, ch, viewRef.current, EDITOR_PAD, plan);

      ctx.fillStyle = COL.bg;
      ctx.fillRect(0, 0, cw, ch);
      drawGrid(ctx, t);
      drawScaleBar(ctx, t, cw);

      // Climate always evolves while the sim runs, whatever the view.
      if (f && simRunning) climateRef.current.step(dt, plan.env);

      if (f && simRunning) {
        if (viewMode === 'flow') drawFlowHeatmap(ctx, t, f, plan.wind.speed);
        else drawClimateHeatmap(ctx, t, f, climateRef.current, viewMode, plan);
      }
      drawRooms(ctx, t, plan, selectedId);
      drawOpenings(ctx, t, plan, selectedId);
      drawWind(ctx, t, plan, cw, ch);

      if (f && simRunning) {
        particlesRef.current.step(dt);
        drawParticles(ctx, t, particlesRef.current.particles, f.maxSpeed);
        if (viewMode !== 'flow') {
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
        } else if (dm.preview) {
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

      // drawing-in-progress room rect
      const dr = dragRef.current;
      if (dr) {
        const x = Math.min(dr.x0, dr.x1), y = Math.min(dr.y0, dr.y1);
        const w = Math.abs(dr.x1 - dr.x0), h = Math.abs(dr.y1 - dr.y0);
        ctx.strokeStyle = COL.wallSelected;
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 2;
        ctx.strokeRect(wx(t, x), wy(t, y), w * t.s, h * t.s);
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(255,209,102,0.08)';
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

      // bright tool cursor halo so the pointer stays visible on the dark canvas
      if (mouse && tool !== 'select') {
        const mx = wx(t, mouse.x), my = wy(t, mouse.y);
        ctx.save();
        ctx.strokeStyle = tool === 'erase' ? COL.windowClosed
          : tool === 'window' ? COL.windowOpen
          : tool === 'door' ? COL.doorOpen
          : COL.wallSelected;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.arc(mx, my, 10, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(mx - 14, my); ctx.lineTo(mx + 14, my);
        ctx.moveTo(mx, my - 14); ctx.lineTo(mx, my + 14);
        ctx.stroke();
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
    };

    const applyPinch = () => {
      const pts = [...pointersRef.current.values()];
      if (pts.length < 2 || !pinchRef.current) return;
      const a = pts[0], b = pts[1];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const { startDist, startZoom, worldMid } = pinchRef.current;
      const zoom = Math.max(VIEW_ZOOM_MIN, Math.min(VIEW_ZOOM_MAX, startZoom * (dist / startDist)));
      setViewAround(zoom, mid.x, mid.y, worldMid);
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
        previewRef.current = openingPreviewAt(plan, w.x, w.y, 2);
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

      if (tool === 'room') {
        const gx = Math.round(Math.max(0, Math.min(w.x, GRID_W)));
        const gy = Math.round(Math.max(0, Math.min(w.y, GRID_H)));
        dragRef.current = { x0: gx, y0: gy, x1: gx, y1: gy };
      } else if (tool === 'window' || tool === 'door') {
        const len = 2;
        const pv = findWallPlacement(plan, w.x, w.y, len);
        if (pv && pv.valid) {
          st.addOpening({ kind: tool, orient: pv.orient, x: pv.x, y: pv.y, len: pv.len, open: true });
        }
      } else if (tool === 'erase') {
        const op = hitOpening(plan, w.x, w.y);
        if (op) { st.deleteOpening(op.id); return; }
        const rm = hitRoom(plan, w.x, w.y);
        if (rm) st.deleteRoom(rm.id);
      } else {
        // Select tool:
        //  - Opening short-click = open/close (green/red)
        //  - Opening long-press (~200 ms) = select (yellow ring) + drag along walls
        //  - Room click = select; drag from interior = move; wall drag = resize
        const op = hitOpening(plan, w.x, w.y);
        if (op) {
          const alreadySelected = selectedId === op.id;
          pressRef.current = {
            sx: w.x, sy: w.y,
            target: { kind: 'opening', id: op.id },
            armed: alreadySelected,
            wasSelected: alreadySelected,
            timer: alreadySelected ? undefined : setTimeout(() => {
              const p = pressRef.current;
              if (!p || p.target.kind !== 'opening' || p.target.id !== op.id) return;
              p.armed = true;
              useApp.getState().setSelected(op.id);
            }, OPENING_LONG_PRESS_MS),
          };
          return;
        }
        // Wall of the already-selected room → resize (takes priority over interior move).
        const selRoom = plan.rooms.find(r => r.id === selectedId);
        if (selRoom) {
          const side = hitRoomWall(selRoom, w.x, w.y);
          if (side) {
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
          // Drag from interior moves the room (after / including this selection).
          pressRef.current = {
            sx: w.x, sy: w.y,
            target: { kind: 'room', id: rm.id, offX: w.x - rm.x, offY: w.y - rm.y },
          };
          return;
        }
        st.setSelected(null);
        pressRef.current = null;
      }
    };

    const updateCursor = (w: { x: number; y: number }) => {
      const { plan, tool, selectedId } = stateRef.current;
      let cur = 'crosshair';
      if (tool === 'select') {
        cur = 'default';
        if (dragModeRef.current) {
          const dm = dragModeRef.current;
          cur = dm.kind === 'resize' ? (dm.side === 'e' || dm.side === 'w' ? 'ew-resize' : 'ns-resize') : 'grabbing';
        } else {
          const selRoom = plan.rooms.find(r => r.id === selectedId);
          const side = selRoom ? hitRoomWall(selRoom, w.x, w.y) : null;
          if (side && !hitOpening(plan, w.x, w.y)) cur = side === 'e' || side === 'w' ? 'ew-resize' : 'ns-resize';
          else if (hitOpening(plan, w.x, w.y)) cur = 'pointer';
          else if (hitRoom(plan, w.x, w.y)) cur = selectedId && hitRoom(plan, w.x, w.y)?.id === selectedId ? 'grab' : 'pointer';
        }
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

      const { plan, tool } = stateRef.current;
      const w = worldPos(e);
      mouseRef.current = w;

      // Stale select-drag must not block placement tools after a sidebar tool switch.
      if (tool !== 'select' && (dragModeRef.current || pressRef.current)) {
        if (pressRef.current?.timer) clearTimeout(pressRef.current.timer);
        dragModeRef.current = null;
        pressRef.current = null;
      }

      // Pending press → drag once the pointer travels enough.
      if (tool === 'select' && pressRef.current && Math.hypot(w.x - pressRef.current.sx, w.y - pressRef.current.sy) > DRAG_THRESH) {
        const press = pressRef.current;
        if (press.target.kind === 'opening' && !press.armed) {
          // Moved before long-press armed → cancel (don't toggle, don't drag).
          if (press.timer) clearTimeout(press.timer);
          pressRef.current = null;
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
        } else {
          const op = plan.openings.find(o => o.id === dm.id);
          dm.preview = op ? findWallPlacement(plan, w.x, w.y, op.len, op.id) : null;
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
      refreshPlacementPreview(w);
      updateCursor(w);
    };

    const onLeave = () => {
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
        else if (dm.preview?.valid) st.moveOpening(dm.id, dm.preview.orient, dm.preview.x, dm.preview.y);
        return;
      }

      // Click (no drag).
      if (pressRef.current) {
        const press = pressRef.current;
        if (press.timer) clearTimeout(press.timer);
        pressRef.current = null;
        if (press.target.kind === 'opening') {
          if (!press.armed) {
            // Short click: toggle open/closed — keep green/red, do not select.
            st.toggleOpening(press.target.id);
            if (st.selectedId === press.target.id) st.setSelected(null);
          } else if (press.wasSelected) {
            // Already selected + short click (no drag): still toggle open/closed.
            st.toggleOpening(press.target.id);
          } else {
            // Fresh long-press without move: stay selected for sidebar / next drag.
            st.setSelected(press.target.id);
          }
        }
        // Room short-click already selected on down.
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
      // Pinch-to-zoom on trackpads sends ctrl+wheel; also allow plain wheel over the canvas.
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
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
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
