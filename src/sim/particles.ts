// ── Particle system for visualising the flow ──────────────────────────────
// Particles spawn at inlet openings (weighted by flux), ride the velocity
// field with a touch of jitter, and leave fading trails. Slow particles in
// stagnant areas fade out — dead zones stay visibly still.

import { FlowField, sampleVelocity } from './solver';
import { FIELD_DISPLAY_GAIN, PARTICLE_SPAWN_PER_FRAME } from './constants';

export interface Particle {
  x: number; y: number;
  px: number; py: number; // previous position (for trail segment)
  age: number;
  life: number;
  speed: number;
}

export class ParticleSystem {
  particles: Particle[] = [];
  private field: FlowField | null = null;
  private gain = 1;
  maxParticles = 900;

  setField(f: FlowField | null) {
    this.field = f;
    this.particles = [];
    if (!f) return;
    this.gain = f.maxSpeed > 1e-5 ? FIELD_DISPLAY_GAIN / f.maxSpeed : 0;
  }

  step(dt: number) {
    const f = this.field;
    if (!f) return;

    // Spawn at inlets proportional to flux.
    const totalFlux = f.inlets.reduce((s, i) => s + i.flux, 0);
    if (totalFlux > 1e-4 && this.particles.length < this.maxParticles) {
      const spawnCount = Math.min(PARTICLE_SPAWN_PER_FRAME, this.maxParticles - this.particles.length);
      for (let k = 0; k < spawnCount; k++) {
        let r = Math.random() * totalFlux;
        let inlet = f.inlets[0];
        for (const i of f.inlets) { r -= i.flux; if (r <= 0) { inlet = i; break; } }
        if (!inlet) continue;
        const along = (Math.random() - 0.5) * inlet.span * 0.85;
        // perpendicular of inflow dir
        const perpX = -inlet.diry, perpY = inlet.dirx;
        const x = inlet.cx + perpX * along + inlet.dirx * 0.15;
        const y = inlet.cy + perpY * along + inlet.diry * 0.15;
        this.particles.push({ x, y, px: x, py: y, age: 0, life: 9 + Math.random() * 5, speed: 0 });
      }
    }

    const kill: number[] = [];
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      p.px = p.x; p.py = p.y;
      const vel = sampleVelocity(f, p.x, p.y);
      const sp = Math.hypot(vel.x, vel.y);
      p.speed = sp;
      const step = Math.min(dt, 0.05);
      const subSteps = 3;
      const subDt = step / subSteps;
      for (let si = 0; si < subSteps; si++) {
        const v = sampleVelocity(f, p.x, p.y);
        p.x += v.x * subDt * this.gain + (Math.random() - 0.5) * 0.008;
        p.y += v.y * subDt * this.gain + (Math.random() - 0.5) * 0.008;
        const ix = Math.floor(p.x), iy = Math.floor(p.y);
        const insideSub = ix >= 0 && ix < f.nx && iy >= 0 && iy < f.ny && f.inside[iy * f.nx + ix];
        if (!insideSub) break;
      }
      p.age += dt;

      const ix = Math.floor(p.x), iy = Math.floor(p.y);
      const insideNow = ix >= 0 && ix < f.nx && iy >= 0 && iy < f.ny && f.inside[iy * f.nx + ix];
      if (p.age > p.life || (!insideNow && p.age > 0.4)) kill.push(i);
      else if (sp < 1e-3 && p.age > 2.5) kill.push(i); // stuck in a dead zone
    }
    for (let i = kill.length - 1; i >= 0; i--) {
      const last = this.particles.length - 1;
      this.particles[kill[i]] = this.particles[last];
      this.particles.pop();
    }
  }
}
