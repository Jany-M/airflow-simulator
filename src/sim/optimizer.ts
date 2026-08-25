// ── Best-configuration search ──────────────────────────────────────────────
// Finds which openings to open so wind flows THROUGH as many rooms as possible
// (distributed cross-ventilation), not a strong breeze trapped in one room.
// Exhaustive for small numbers of toggleable openings; greedy + local-search
// refinement for larger plans. Runs in async chunks so the UI stays responsive.

import { Plan, OptimizerResult } from '../model/types';
import { solve, scoreField } from './solver';

const OPT_ITERATIONS = 200; // coarser solve for what-if runs

function evaluate(plan: Plan, openIds: Set<string>): {
  score: number; coverage: number; meanSpeed: number; roomsReached: number;
} {
  const f = solve(plan, { iterations: OPT_ITERATIONS, openIds });
  const s = scoreField(f, plan.wind.speed, plan.rooms);
  return { score: s.score, coverage: s.coverage, meanSpeed: s.meanSpeed, roomsReached: s.roomsReached };
}

export interface OptimizeProgress {
  done: number;
  total: number;
  best: OptimizerResult | null;
}

export async function optimize(
  plan: Plan,
  onProgress?: (p: OptimizeProgress) => void,
  shouldCancel?: () => boolean,
): Promise<OptimizerResult | null> {
  const locked = plan.openings.filter(o => o.locked);
  const lockedOpen = locked.filter(o => o.open).map(o => o.id);
  const free = plan.openings.filter(o => !o.locked);
  if (free.length === 0) return null;

  const yield_ = () => new Promise<void>(r => setTimeout(r, 0));

  let best: OptimizerResult | null = null;
  const consider = (openIds: string[], s: {
    score: number; coverage: number; meanSpeed: number; roomsReached: number;
  }) => {
    if (!best || s.score > best.score) {
      best = {
        openIds,
        score: s.score,
        coverage: s.coverage,
        meanSpeed: s.meanSpeed,
        roomsReached: s.roomsReached,
      };
    }
  };

  if (free.length <= 10) {
    // Exhaustive: up to 1024 coarse solves (includes all-closed for locked-open baselines).
    const total = 1 << free.length;
    for (let mask = 0; mask < total; mask++) {
      if (shouldCancel?.()) return best;
      const ids = [...lockedOpen];
      for (let b = 0; b < free.length; b++) if (mask & (1 << b)) ids.push(free[b].id);
      consider(ids, evaluate(plan, new Set(ids)));
      if (mask % 16 === 0) { onProgress?.({ done: mask + 1, total, best }); await yield_(); }
    }
    onProgress?.({ done: total, total, best });
    return best;
  }

  // Backward elimination: start with everything open (through-paths already
  // formed), then close openings one at a time as long as the score doesn't
  // drop. This keeps inlet→outlet chains intact — a myopic forward search
  // can't discover them, because a door and a window must open TOGETHER
  // before a new room ventilates.
  const EPS = 1e-4;
  const current = new Set<string>([...lockedOpen, ...free.map(o => o.id)]);
  let s0 = evaluate(plan, current);
  consider([...current], s0);
  let currentScore = s0.score;
  const totalEst = (free.length * (free.length + 1)) / 2 + free.length + 1;
  let done = 1;

  for (;;) {
    if (shouldCancel?.()) return best;
    let bestRemoval: string | null = null;
    let bestRemovalScore = -Infinity;
    for (const o of free) {
      if (!current.has(o.id)) continue;
      const trial = new Set(current); trial.delete(o.id);
      const s = evaluate(plan, trial);
      done++;
      consider([...trial], s);
      if (s.score > bestRemovalScore) { bestRemovalScore = s.score; bestRemoval = o.id; }
    }
    onProgress?.({ done, total: totalEst, best }); await yield_();
    // Accept the best removal if it doesn't make things worse (ties → fewer openings).
    if (bestRemoval !== null && bestRemovalScore >= currentScore - EPS) {
      current.delete(bestRemoval);
      currentScore = Math.max(currentScore, bestRemovalScore);
    } else break;
  }

  // One forward refinement pass: re-add anything that strictly helps.
  for (const o of free) {
    if (shouldCancel?.()) return best;
    if (current.has(o.id)) continue;
    const trial = new Set(current); trial.add(o.id);
    const s = evaluate(plan, trial);
    done++;
    consider([...trial], s);
    if (s.score > currentScore + EPS) {
      currentScore = s.score;
      current.add(o.id);
    }
    if (done % 8 === 0) { onProgress?.({ done, total: totalEst, best }); await yield_(); }
  }

  onProgress?.({ done: totalEst, total: totalEst, best });
  return best;
}
