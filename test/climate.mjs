import { samplePlan } from '../src/model/samples.ts';
import { solve } from '../src/sim/solver.ts';
import { ClimateSystem } from '../src/sim/climate.ts';

const plan = samplePlan();
const env = { ...plan.env, outdoorTemp: 22, outdoorRH: 50, indoorTemp: 22, indoorRH: 50 };
const f = solve(plan);
const climate = new ClimateSystem();
climate.setField(f, env);
for (let i = 0; i < 120; i++) climate.step(0.05, env);

const avgs = climate.roomAverages(plan.rooms);
let maxTDelta = 0, maxRhDelta = 0;
for (const r of plan.rooms) {
  const a = avgs.get(r.id);
  if (!a) continue;
  maxTDelta = Math.max(maxTDelta, Math.abs(a.t - 22));
  maxRhDelta = Math.max(maxRhDelta, Math.abs(a.rh - 50));
}
if (maxTDelta > 0.15 || maxRhDelta > 0.5) {
  throw new Error(`equal env should stay uniform: max dT=${maxTDelta} dRH=${maxRhDelta}`);
}
console.log('climate equal temp/RH check passed');
