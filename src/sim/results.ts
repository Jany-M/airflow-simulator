import { Plan } from '../model/types';
import { openingLabel } from '../model/geometry';
import { FlowField, Score, scoreField } from './solver';

export interface FlowOpeningFlux {
  id: string;
  kind: 'window' | 'door';
  label: string;
  flux: number;
}

export interface FlowStats {
  totalInflow: number;
  topOpenings: FlowOpeningFlux[];
}

export function computeFlowStats(plan: Plan, f: FlowField): FlowStats {
  const topOpenings: FlowOpeningFlux[] = [];
  for (const op of plan.openings) {
    if (!op.open) continue;
    const flux = f.openingFlux.get(op.id) ?? 0;
    if (flux <= 1e-5) continue;
    topOpenings.push({
      id: op.id,
      kind: op.kind,
      label: openingLabel(plan, op),
      flux,
    });
  }
  topOpenings.sort((a, b) => b.flux - a.flux);
  let totalInflow = 0;
  f.openingFlux.forEach(fl => { if (fl > 0) totalInflow += fl; });
  return { totalInflow, topOpenings: topOpenings.slice(0, 8) };
}

export function formatScoreLabel(s: Score, solveMs?: number): string {
  const rooms = s.roomsReached != null ? `${(s.roomsReached * 100).toFixed(0)}% rooms reached` : '';
  const base = `Ventilated area: ${(s.coverage * 100).toFixed(0)}% · mean airflow ${s.meanSpeed.toFixed(2)}${rooms ? ` · ${rooms}` : ''}`;
  return solveMs != null ? `${base} · solve ${solveMs.toFixed(0)} ms` : base;
}

export function buildFlowPublish(plan: Plan, f: FlowField, solveMs?: number, score?: Score) {
  const s = score ?? scoreField(f, plan.wind.speed, plan.rooms);
  return {
    score: s,
    scoreLabel: formatScoreLabel(s, solveMs),
    flowStats: computeFlowStats(plan, f),
  };
}
