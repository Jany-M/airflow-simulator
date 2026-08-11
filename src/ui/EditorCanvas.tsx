import { useEffect, useRef } from 'react';
import { useApp } from '../model/store';
import { GRID_W, GRID_H, Opening, Orient, Plan } from '../model/types';
import { hitRoomWall, snapCoord, wallLinesX, wallLinesY, overlapsAnyRoom, Side } from '../model/geometry';
import { solve, scoreField, FlowField } from '../sim/solver';
import { ParticleSystem } from '../sim/particles';
import { ClimateSystem } from '../sim/climate';
import {
  fitTransform, toWorld, wx, wy, COL,
  drawGrid, drawFlowHeatmap, drawRooms, drawOpenings, drawWind, drawParticles,
  drawClimateHeatmap, drawRoomClimate, drawClimateLegend,
} from './render';

interface DragRect { x0: number; y0: number; x1: number; y1: number }
interface OpeningPreview { orient: Orient; x: number; y: number; len: number; valid: boolean }

const LONG_PRESS_MS = 280;

/** Pending press: becomes a click on quick release, a drag after a long press. */
interface Press {
  sx: number; sy: number; // world coords at pointerdown
  target: { kind: 'room'; id: string } | { kind: 'opening'; id: string };
  timer: ReturnType<typeof setTimeout>;
}

type DragMode =
  | { kind: 'move'; roomId: string; offX: number; offY: number; gx: number; gy: number }
  | { kind: 'resize'; roomId: string; side: Side; pos: number }
  | { kind: 'opening'; id: string; preview: OpeningPreview | null };

/** Find the nearest wall edge to a world point; returns a candidate opening placement. */
function findWallPlacement(plan: Plan, wxp: number, wyp: number, len: number, excludeId?: string): OpeningPreview | null {
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
      if (e.d > 0.8) continue;
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

  const plan = useApp(s => s.plan);
  const rev = useApp(s => s.rev);
  const tool = useApp(s => s.tool);
  const selectedId = useApp(s => s.selectedId);
  const simRunning = useApp(s => s.simRunning);
  const viewMode = useApp(s => s.viewMode);

  // Keep latest values available inside the rAF loop without re-subscribing.
  const stateRef = useRef({ plan, tool, selectedId, simRunning, viewMode });
  stateRef.current = { plan, tool, selectedId, simRunning, viewMode };

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
      const t = fitTransform(cw, ch);

      ctx.fillStyle = COL.bg;
      ctx.fillRect(0, 0, cw, ch);
      drawGrid(ctx, t);

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

      // opening placement preview
      const pv = previewRef.current;
      if (pv && (tool === 'window' || tool === 'door')) {
        ctx.strokeStyle = pv.valid ? (tool === 'window' ? COL.windowOpen : COL.doorOpen) : COL.windowClosed;
        ctx.globalAlpha = 0.7;
        ctx.lineWidth = Math.max(3, t.s * 0.3);
        ctx.lineCap = 'round';
        ctx.beginPath();
        if (pv.orient === 'h') { ctx.moveTo(wx(t, pv.x), wy(t, pv.y)); ctx.lineTo(wx(t, pv.x + pv.len), wy(t, pv.y)); }
        else { ctx.moveTo(wx(t, pv.x), wy(t, pv.y)); ctx.lineTo(wx(t, pv.x), wy(t, pv.y + pv.len)); }
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // empty-state hint
      if (plan.rooms.length === 0) {
        ctx.fillStyle = 'rgba(200,215,235,0.5)';
        ctx.font = `500 16px 'Segoe UI', system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText('Pick the Room tool and drag to draw your first room —', cw / 2, ch / 2 - 12);
        ctx.fillText('or load the sample apartment from the sidebar.', cw / 2, ch / 2 + 12);
      }

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  // ── Pointer handling ──
  useEffect(() => {
    const canvas = canvasRef.current!;

    const worldPos = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const t = fitTransform(rect.width, rect.height);
      return toWorld(t, e.clientX - rect.left, e.clientY - rect.top);
    };

    const clearPress = () => {
      if (pressRef.current) { clearTimeout(pressRef.current.timer); pressRef.current = null; }
    };

    const onDown = (e: PointerEvent) => {
      const { plan, tool } = stateRef.current;
      const st = useApp.getState();
      const w = worldPos(e);
      canvas.setPointerCapture(e.pointerId);

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
      } else { // select: click toggles/selects, long-press drags, wall-drag resizes
        const op = hitOpening(plan, w.x, w.y);
        if (op) {
          pressRef.current = {
            sx: w.x, sy: w.y,
            target: { kind: 'opening', id: op.id },
            timer: setTimeout(() => {
              pressRef.current = null;
              useApp.getState().setSelected(op.id);
              dragModeRef.current = { kind: 'opening', id: op.id, preview: null };
            }, LONG_PRESS_MS),
          };
          return;
        }
        // Wall of the SELECTED room → immediate resize drag.
        const selRoom = plan.rooms.find(r => r.id === stateRef.current.selectedId);
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
          pressRef.current = {
            sx: w.x, sy: w.y,
            target: { kind: 'room', id: rm.id },
            timer: setTimeout(() => {
              pressRef.current = null;
              useApp.getState().setSelected(rm.id);
              const cur = useApp.getState().plan.rooms.find(r => r.id === rm.id);
              if (!cur) return;
              dragModeRef.current = {
                kind: 'move', roomId: cur.id,
                offX: w.x - cur.x, offY: w.y - cur.y,
                gx: cur.x, gy: cur.y,
              };
            }, LONG_PRESS_MS),
          };
          return;
        }
        st.setSelected(null);
      }
    };

    const updateCursor = (w: { x: number; y: number }) => {
      const { plan, tool, selectedId } = stateRef.current;
      let cur = 'default';
      if (tool !== 'select') cur = 'crosshair';
      else if (dragModeRef.current) {
        const dm = dragModeRef.current;
        cur = dm.kind === 'resize' ? (dm.side === 'e' || dm.side === 'w' ? 'ew-resize' : 'ns-resize') : 'grabbing';
      } else {
        const selRoom = plan.rooms.find(r => r.id === selectedId);
        const side = selRoom ? hitRoomWall(selRoom, w.x, w.y) : null;
        if (side && !hitOpening(plan, w.x, w.y)) cur = side === 'e' || side === 'w' ? 'ew-resize' : 'ns-resize';
        else if (hitOpening(plan, w.x, w.y) || hitRoom(plan, w.x, w.y)) cur = 'pointer';
      }
      canvas.style.cursor = cur;
    };

    const onMove = (e: PointerEvent) => {
      const { plan, tool } = stateRef.current;
      const w = worldPos(e);
      mouseRef.current = w;

      // A pending long-press dies if the pointer wanders before it fires.
      if (pressRef.current && Math.hypot(w.x - pressRef.current.sx, w.y - pressRef.current.sy) > 0.6) {
        clearPress();
      }

      const dm = dragModeRef.current;
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
      if (tool === 'window' || tool === 'door') {
        previewRef.current = findWallPlacement(plan, w.x, w.y, 2);
      } else {
        previewRef.current = null;
      }
      updateCursor(w);
    };

    const onUp = () => {
      const st = useApp.getState();

      // Commit an active drag.
      const dm = dragModeRef.current;
      if (dm) {
        dragModeRef.current = null;
        if (dm.kind === 'move') st.moveRoom(dm.roomId, dm.gx, dm.gy);
        else if (dm.kind === 'resize') st.resizeRoom(dm.roomId, dm.side, dm.pos);
        else if (dm.preview?.valid) st.moveOpening(dm.id, dm.preview.orient, dm.preview.x, dm.preview.y);
        return;
      }

      // Quick release before the long-press fired → it's a click.
      if (pressRef.current) {
        const t = pressRef.current.target;
        clearPress();
        if (t.kind === 'opening') {
          st.setSelected(t.id);
          st.toggleOpening(t.id); // one click = open/close — the core interaction
        } else {
          st.setSelected(t.id);
        }
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
        if (pressRef.current) { clearTimeout(pressRef.current.timer); pressRef.current = null; }
        useApp.getState().setSelected(null);
      }
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <div className="canvas-wrap">
      <canvas ref={canvasRef} style={{ display: 'block', cursor: tool === 'select' ? 'default' : 'crosshair' }} />
    </div>
  );
}
