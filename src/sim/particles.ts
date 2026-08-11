// ── Particle system for visualising the flow ──────────────────────────────
// Particles spawn at inlet openings (weighted by flux), ride the velocity
// field with a touch of jitter, and leave fading trails. Slow particles in
// stagnant areas fade out — dead zones stay visibly still.

import { FlowField, sampleVelocity } from './solver';

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
    if (!f) { this.particles = []; return; }
    // Normalise display speed: fastest point in the field moves ~7 cells/s
    // regardless of absolute pressure numbers, so motion always reads well.
    this.gain = f.maxSpeed > 1e-5 ? 7 / f.maxSpeed : 0;
  }

  step(dt: number) {
    const f = this.field;
    if (!f) return;

    // Spawn at inlets proportional to flux.
    const totalFlux = f.inlets.reduce((s, i) => s + i.flux, 0);
    if (totalFlux > 1e-4 && this.particles.length < this.maxParticles) {
      const spawnCount = Math.min(3, this.maxParticles - this.particles.length);
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
      // advect (gain normalises the field to a good visual pace)
      const step = Math.min(dt, 0.05);
      p.x += vel.x * step * this.gain + (Math.random() - 0.5) * 0.02;
      p.y += vel.y * step * this.gain + (Math.random() - 0.5) * 0.02;
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
