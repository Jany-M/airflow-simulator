// ── PNG export ─────────────────────────────────────────────────────────────
// Renders the current configuration to an offscreen canvas at 2× resolution:
// floor plan, open/closed markers, flow heatmap + dead zones, streamline
// arrows showing exactly how the wind travels through, wind rose, legend.

import { Plan, CELL_METERS, GRID_W, GRID_H } from '../model/types';
import { solve, scoreField } from '../sim/solver';
import {
  fitTransform, COL, drawGrid, drawFlowHeatmap, drawRooms, drawOpenings,
  drawWind, drawStreamlines,
} from '../ui/render';

export function exportPNG(plan: Plan) {
  const W = 1800, H = 1300;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  // High-quality solve for the export.
  const field = solve(plan, { iterations: 900 });
  const s = scoreField(field, plan.wind.speed, plan.rooms);

  ctx.fillStyle = COL.bg;
  ctx.fillRect(0, 0, W, H);

  // Title block
  ctx.fillStyle = COL.text;
  ctx.font = `600 40px 'Segoe UI', system-ui, sans-serif`;
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText(plan.name || 'Floor plan', 40, 30);
  ctx.font = `400 24px 'Segoe UI', system-ui, sans-serif`;
  ctx.fillStyle = 'rgba(180,200,225,0.85)';
  const openCount = plan.openings.filter(o => o.open).length;
  ctx.fillText(
    `Natural ventilation plan  ·  wind from ${dirName(plan.wind.fromDeg)} (${plan.wind.fromDeg}°) at ${plan.wind.speed.toFixed(1)} m/s  ·  outdoor ${plan.env.outdoorTemp.toFixed(0)} °C / ${plan.env.outdoorRH.toFixed(0)}% RH  ·  ${openCount}/${plan.openings.length} openings open  ·  ventilated area ${(s.coverage * 100).toFixed(0)}%`,
    40, 84,
  );

  // Plan area
  const pad = 40, top = 130, bottom = 120;
  const areaW = W - pad * 2, areaH = H - top - bottom;
  ctx.save();
  ctx.translate(pad, top);
  const t = fitTransform(areaW, areaH, 0.04);
  drawGrid(ctx, t);
  drawFlowHeatmap(ctx, t, field, plan.wind.speed);
  drawRooms(ctx, t, plan, null);
  drawStreamlines(ctx, t, field, { width: 5 });
  drawOpenings(ctx, t, plan, null);
  drawWind(ctx, t, plan, areaW, areaH);
  ctx.restore();

  // Legend
  const ly = H - 84;
  ctx.font = `400 22px 'Segoe UI', system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  let lx = 40;
  const item = (draw: (x: number, y: number) => void, label: string) => {
    draw(lx, ly);
    ctx.fillStyle = 'rgba(200,215,235,0.9)';
    ctx.textAlign = 'left';
    ctx.fillText(label, lx + 44, ly);
    lx += 44 + ctx.measureText(label).width + 46;
  };
  item((x, y) => { ctx.strokeStyle = COL.doorOpen; ctx.lineWidth = 8; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 34, y); ctx.stroke(); }, 'open');
  item((x, y) => { ctx.strokeStyle = COL.doorClosed; ctx.lineWidth = 6; ctx.setLineDash([8, 7]); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 34, y); ctx.stroke(); ctx.setLineDash([]); }, 'closed (keep shut)');
  item((x, y) => { ctx.strokeStyle = COL.streamline; ctx.fillStyle = COL.streamline; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 26, y); ctx.stroke(); ctx.beginPath(); ctx.moveTo(x + 36, y); ctx.lineTo(x + 24, y - 7); ctx.lineTo(x + 24, y + 7); ctx.closePath(); ctx.fill(); }, 'airflow path');
  item((x, y) => { ctx.fillStyle = 'rgba(255,80,90,0.45)'; ctx.fillRect(x, y - 14, 34, 28); }, 'dead zone (little airflow)');

  ctx.fillStyle = 'rgba(140,160,185,0.55)';
  ctx.textAlign = 'right';
  ctx.font = `400 19px 'Segoe UI', system-ui, sans-serif`;
  ctx.fillText(`grid: 1 cell = ${CELL_METERS} m  ·  plan ${GRID_W * CELL_METERS}×${GRID_H * CELL_METERS} m  ·  made with Airflow Simulator`, W - 40, H - 30);

  // Download
  canvas.toBlob(blob => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(plan.name || 'floor-plan').replace(/[^\w\-]+/g, '_')}_airflow.png`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, 'image/png');
}

export function dirName(deg: number): string {
  const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return names[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}
