import { samplePlan } from '../src/model/samples.ts';
import { solve, scoreField, ROOM_REACHED_COV } from '../src/sim/solver.ts';
import { optimize } from '../src/sim/optimizer.ts';
import { SOLVE_ITER_OPT } from '../src/sim/constants.ts';

const plan = samplePlan();
const closed = new Set(plan.openings.filter(o => o.open).map(o => o.id));
const baseline = solve(plan);
let totalOpen = 0;
baseline.openingFlux.forEach(v => { if (v > 0) totalOpen += v; });

// Open living west window (v x=8) if present
const bypass = plan.openings.find(o => o.orient === 'v' && o.x === 8 && o.y === 12);
if (!bypass) throw new Error('sample bypass opening missing');
closed.add(bypass.id);
const withBypass = solve(plan, { openIds: closed });
let totalBypass = 0;
withBypass.openingFlux.forEach(v => { if (v > 0) totalBypass += v; });

if (!(totalBypass >= totalOpen * 0.95)) {
  throw new Error(`expected inflow not to drop when bypass opens: ${totalBypass} vs ${totalOpen}`);
}

// Wider opening should not reduce its own flux vs half-width (conductance * len)
const widePlan = structuredClone(plan);
const target = widePlan.openings.find(o => o.kind === 'window' && o.open);
if (target) {
  const narrow = { ...target, len: 2 };
  const wide = { ...target, len: 4 };
  const pN = { ...widePlan, openings: widePlan.openings.map(o => o.id === target.id ? narrow : o) };
  const pW = { ...widePlan, openings: widePlan.openings.map(o => o.id === target.id ? wide : o) };
  const fN = solve(pN);
  const fW = solve(pW);
  const flN = fN.openingFlux.get(target.id) ?? 0;
  const flW = fW.openingFlux.get(target.id) ?? 0;
  if (flW <= flN * 1.05) throw new Error(`wider opening flux ${flW} vs narrow ${flN}`);
}

// Optimizer scoring: prefer balanced cross-ventilation over short-circuit paths
plan.wind = { fromDeg: 257, speed: 3.7 };
const tunnelIds = new Set(plan.openings.filter(o => {
  if (o.kind === 'door') return true;
  if (o.orient === 'v' && o.x === 8 && o.y === 12) return true;
  if (o.orient === 'v' && o.x === 46 && o.y === 10) return true;
  if (o.orient === 'h' && o.y === 26 && o.x === 38) return true;
  return false;
}).map(o => o.id));
const tunnelScore = scoreField(
  solve(plan, { iterations: SOLVE_ITER_OPT, openIds: tunnelIds }),
  plan.wind.speed,
  plan.rooms,
).score;

const best = await optimize(plan);
const bestField = solve(plan, { iterations: SOLVE_ITER_OPT, openIds: new Set(best.openIds) });
const bestScore = scoreField(bestField, plan.wind.speed, plan.rooms).score;
if (bestScore <= tunnelScore) {
  throw new Error(`optimizer should beat wind-tunnel config: ${bestScore} vs ${tunnelScore}`);
}

const inflows = [...bestField.openingFlux.values()].filter(v => v > 1e-5).sort((a, b) => b - a);
if (inflows.length >= 2) {
  const spread = (inflows[0] - inflows[inflows.length - 1]) / inflows[0];
  if (spread > 0.65) throw new Error(`optimizer inflow too lopsided: spread ${spread.toFixed(2)}`);
}

if (ROOM_REACHED_COV < 0.25 || ROOM_REACHED_COV > 0.30) {
  throw new Error(`ROOM_REACHED_COV expected in 25–30% retune band: ${ROOM_REACHED_COV}`);
}

console.log('solver unit checks passed');
