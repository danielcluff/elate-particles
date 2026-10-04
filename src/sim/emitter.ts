import { Rng, type ParamValues } from "../core/values";
import { ParticleBuffer } from "./buffer";
import type { CompiledModule, EmitterTemplate } from "./compile";
import { EffectTransform, SimContext } from "./context";
import { rotate } from "./math";
import { TrailStore } from "./trails";

/** Floats per queued sub-emitter event: position, velocity, colour, count. */
const EVENT_STRIDE = 11;
const MAX_EVENTS = 512;

/**
 * GPU simulation target (see elate-particles/three GpuEmitter). When set, spawn
 * requests are forwarded here instead of creating CPU particles; spawn timing,
 * LOD and budget logic stay on the CPU.
 */
export interface GpuSpawnTarget {
  /** `n` particles requested this step (after LOD scaling). */
  spawn(n: number): void;
  /** Upper-bound estimate of live GPU particles (the CPU can't see them). */
  readonly count: number;
  /** Kill every particle (play / clear). */
  reset(): void;
}

/** Receives sub-emitter events; implemented by EffectSim. */
export interface EventSink {
  emitEvent(target: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, r: number, g: number, b: number, a: number, count: number): void;
}

/** One emitter of one effect instance: its particles, RNG and module state. */
export class EmitterSim {
  readonly template: EmitterTemplate;
  readonly buf: ParticleBuffer;
  readonly ctx: SimContext;
  readonly state: Float64Array;
  /** Per-particle trail history (ribbon mode "particle"), else null. */
  readonly trails: TrailStore | null;
  /** Seconds since the effect started playing. */
  time = 0;

  readonly #transform: EffectTransform;
  readonly #sink: EventSink;
  readonly #rng: Rng;
  readonly #events = new Float32Array(MAX_EVENTS * EVENT_STRIDE);
  #eventCount = 0;
  readonly #tmp = [0, 0, 0];
  /** World-space event coordinates converted to simulation space. */
  readonly #tmp2 = [0, 0, 0];

  constructor(template: EmitterTemplate, transform: EffectTransform, params: ParamValues, seed: number, sink: EventSink) {
    this.template = template;
    this.#transform = transform;
    this.#sink = sink;
    this.#rng = new Rng(seed);
    this.buf = new ParticleBuffer(template.capacity, template.extraChannels);
    this.state = new Float64Array(template.stateSize);
    this.ctx = new SimContext(this.#rng, params, transform, template.space);
    this.#spawnStates = template.spawn.map((m) => this.state.subarray(m.stateOffset, m.stateOffset + (m.rt.stateSize ?? 0)));
    const t = template.trail;
    this.trails = t ? new TrailStore(template.capacity, t.points, t.minDistance, t.lifetime) : null;
    this.#trailSlot = t ? this.buf.channel("trailSlot") : null;
  }

  readonly #trailSlot: Float32Array | null;
  /** Per spawn module state views, created once (subarray allocates). */
  #spawnStates: Float64Array[] = [];

  /** LOD: false stops spawning (and drops queued events); set by the world each frame. */
  lodActive = true;
  /**
   * Bounds of live particles after the last step, simulation space:
   * [minX, minY, minZ, maxX, maxY, maxZ], plus the largest particle size and
   * speed². Meaningful only while buf.count > 0.
   */
  readonly bounds = new Float32Array(6);
  maxSize = 0;
  maxSpeed2 = 0;
  /**
   * Budget prediction (Little's law: population ≈ spawn rate × lifetime):
   * smoothed spawn demand per second *before* LOD scaling, and the smoothed
   * lifetime of particles it spawned.
   */
  demand = 0;
  lifeEstimate = 1;

  #trackLife(start: number, end: number): void {
    let sum = 0;
    const life = this.buf.life;
    for (let i = start; i < end; i++) sum += life[i];
    const mean = sum / (end - start);
    this.lifeEstimate += (mean - this.lifeEstimate) * 0.2;
  }

  /** New particles [start, end) are in simulation space: give each a trail slot starting at its birth position. */
  #startTrails(start: number, end: number): void {
    const trails = this.trails;
    if (!trails) return;
    const b = this.buf;
    const slots = this.#trailSlot!;
    for (let i = start; i < end; i++) slots[i] = trails.start(b.px[i], b.py[i], b.pz[i], this.time);
  }

  /** Set by the runtime for GPU-simulated emitters. */
  gpu: GpuSpawnTarget | null = null;

  /** Live particles: CPU buffer count, or the GPU target's estimate. */
  get particleCount(): number {
    return this.gpu ? this.gpu.count : this.buf.count;
  }

  reset(seed: number): void {
    this.time = 0;
    this.demand = 0;
    this.buf.clear();
    this.state.fill(0);
    this.#eventCount = 0;
    this.#rng.seed(seed);
    this.trails?.reset();
    this.gpu?.reset();
  }

  get pendingEvents(): number {
    return this.#eventCount;
  }

  /** True once it has nothing left to do (no particles, no queued events, no more spawning). */
  isDone(playing: boolean): boolean {
    if (this.particleCount > 0 || this.#eventCount > 0) return false;
    const t = this.template;
    if (t.eventDriven || !playing) return true;
    return !t.looping && this.time - t.startDelay >= t.duration;
  }

  /** Queue a world-space spawn event (sub-emitters). */
  pushEvent(x: number, y: number, z: number, vx: number, vy: number, vz: number, r: number, g: number, b: number, a: number, count: number): void {
    if (this.#eventCount >= MAX_EVENTS || count <= 0) return;
    const e = this.#events;
    const o = this.#eventCount++ * EVENT_STRIDE;
    e[o] = x;
    e[o + 1] = y;
    e[o + 2] = z;
    e[o + 3] = vx;
    e[o + 4] = vy;
    e[o + 5] = vz;
    e[o + 6] = r;
    e[o + 7] = g;
    e[o + 8] = b;
    e[o + 9] = a;
    e[o + 10] = count;
  }

  /** Stochastic rounding of a scaled count: keeps the average rate, deterministic per seed. */
  #scaleCount(n: number, scale: number): number {
    const x = n * scale;
    const k = Math.floor(x);
    return k + (this.#rng.next() < x - k ? 1 : 0);
  }

  /** @param spawnScale world LOD/budget multiplier for spawn counts (ignored when the emitter opts out) */
  step(dt: number, playing: boolean, spawnScale = 1): void {
    const tpl = this.template;
    const ctx = this.ctx;
    this.time += dt;
    const t = this.time - tpl.startDelay;

    ctx.dt = dt;
    const tp = this.#transform.position, pp = this.#transform.prevPosition;
    const ddx = tp[0] - pp[0], ddy = tp[1] - pp[1], ddz = tp[2] - pp[2];
    ctx.distance = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
    if (t >= 0) {
      ctx.time = t;
      ctx.cycle = tpl.looping ? Math.floor(t / tpl.duration) : 0;
      ctx.cycleTime = tpl.looping ? t - ctx.cycle * tpl.duration : Math.min(t, tpl.duration);
      ctx.cycleT = ctx.cycleTime / tpl.duration;
    }

    let requested = 0;
    if (playing && !tpl.eventDriven && t >= 0 && (tpl.looping || t - dt < tpl.duration)) {
      let n = 0;
      const spawn = tpl.spawn;
      for (let m = 0; m < spawn.length; m++) n += spawn[m].rt.spawn!(ctx, this.#spawnStates[m]);
      requested = n;
      if (n > 0 && tpl.scaleSpawn && spawnScale !== 1) n = this.lodActive ? this.#scaleCount(n, spawnScale) : 0;
      else if (!this.lodActive) n = 0;
      if (n > 0) this.#spawn(n);
    }
    for (let k = 0; k < this.#eventCount; k++) requested += this.#events[k * EVENT_STRIDE + 10];
    // ~0.5 s window: smooths bursts into a rate
    this.demand += (requested / dt - this.demand) * Math.min(1, dt * 2);
    if (this.#eventCount > 0) {
      if (!this.lodActive) this.#eventCount = 0;
      else {
        if (tpl.scaleSpawn && spawnScale !== 1) for (let k = 0; k < this.#eventCount; k++) this.#events[k * EVENT_STRIDE + 10] = this.#scaleCount(this.#events[k * EVENT_STRIDE + 10], spawnScale);
        this.#spawnEvents();
      }
    }

    const buf = this.buf;
    const count = buf.count;
    if (count === 0) return;

    runModules(tpl.update, ctx, buf, 0, count);

    // integrate, tracking bounds for culling on the way
    const { px, py, pz, vx, vy, vz, rot, spin, age, size } = buf;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity, ms = 0, mv = 0;
    for (let i = 0; i < count; i++) {
      const ux = vx[i], uy = vy[i], uz = vz[i];
      const x = (px[i] += ux * dt);
      const y = (py[i] += uy * dt);
      const z = (pz[i] += uz * dt);
      rot[i] += spin[i] * dt;
      age[i] += dt;
      // Math.min/max compile to branch-free instructions: ~1.5 ns/particle here vs ~8 ns with if-compares
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
      z0 = Math.min(z0, z);
      z1 = Math.max(z1, z);
      ms = Math.max(ms, size[i]);
      mv = Math.max(mv, ux * ux + uy * uy + uz * uz);
    }
    const bb = this.bounds;
    bb[0] = x0;
    bb[1] = y0;
    bb[2] = z0;
    bb[3] = x1;
    bb[4] = y1;
    bb[5] = z1;
    this.maxSize = ms;
    this.maxSpeed2 = mv;

    const trails = this.trails;
    const slots = this.#trailSlot;
    if (trails) for (let i = 0; i < count; i++) trails.record(slots![i], px[i], py[i], pz[i], this.time);

    const life = buf.life;
    const death = tpl.death;
    if (tpl.ordered) {
      // order-preserving compaction: survivors slide down, spawn order is kept
      let w = 0;
      for (let i = 0; i < count; i++) {
        if (age[i] >= life[i]) {
          if (death.length) this.#emitEvents(death, i);
          if (trails) trails.release(slots![i]);
          continue;
        }
        if (w !== i) buf.copy(i, w);
        w++;
      }
      buf.count = w;
      return;
    }
    // deaths (backwards: the particle swapped into slot i was already visited)
    for (let i = count - 1; i >= 0; i--) {
      if (age[i] < life[i]) continue;
      if (death.length) this.#emitEvents(death, i);
      if (trails) trails.release(slots![i]);
      buf.remove(i);
    }
  }

  /** Resets new particles [start, end) to defaults. */
  #initDefaults(start: number, end: number): void {
    const b = this.buf;
    const rng = this.#rng;
    for (let i = start; i < end; i++) {
      b.px[i] = b.py[i] = b.pz[i] = 0;
      b.vx[i] = b.vy[i] = b.vz[i] = 0;
      b.age[i] = 0;
      b.life[i] = 1;
      b.seed[i] = rng.next();
      b.size[i] = 1;
      b.rot[i] = b.spin[i] = 0;
      b.r[i] = b.g[i] = b.b[i] = b.a[i] = 1;
    }
    for (const name of this.template.extraChannels) b.channel(name).fill(0, start, end);
  }

  /** Allocates up to `n` particles; returns the range actually created. */
  #alloc(n: number): [number, number] {
    const b = this.buf;
    const start = b.count;
    const end = Math.min(b.capacity, start + n);
    this.#initDefaults(start, end);
    return [start, end];
  }

  #spawn(n: number): void {
    if (this.gpu) {
      this.gpu.spawn(n);
      return;
    }
    const [start, end] = this.#alloc(n);
    if (end === start) return;
    const tpl = this.template;
    const b = this.buf;
    runModules(tpl.initLocal, this.ctx, b, start, end);

    if (tpl.space === "world") {
      // local → world, spreading births along the path travelled this step
      const tr = this.#transform;
      const s = tr.scale;
      const [x0, y0, z0] = tr.prevPosition;
      const [x1, y1, z1] = tr.position;
      const q = tr.rotation;
      const tmp = this.#tmp;
      const n = end - start;
      for (let i = start; i < end; i++) {
        const f = (i - start + 1) / n;
        rotate(q, b.px[i] * s, b.py[i] * s, b.pz[i] * s, tmp);
        b.px[i] = tmp[0] + x0 + (x1 - x0) * f;
        b.py[i] = tmp[1] + y0 + (y1 - y0) * f;
        b.pz[i] = tmp[2] + z0 + (z1 - z0) * f;
        rotate(q, b.vx[i] * s, b.vy[i] * s, b.vz[i] * s, tmp);
        b.vx[i] = tmp[0];
        b.vy[i] = tmp[1];
        b.vz[i] = tmp[2];
        b.size[i] *= s;
      }
    }
    this.#trackLife(start, end);
    this.#startTrails(start, end);
    b.count = end;
    runModules(tpl.initSim, this.ctx, b, start, end);
    if (tpl.birth.length) for (let i = start; i < end; i++) this.#emitEvents(tpl.birth, i);
  }

  #spawnEvents(): void {
    const tpl = this.template;
    const b = this.buf;
    const e = this.#events;
    const events = this.#eventCount;
    this.#eventCount = 0;

    let total = 0;
    for (let k = 0; k < events; k++) total += e[k * EVENT_STRIDE + 10];
    const [start, end] = this.#alloc(total);
    if (end === start) return;
    runModules(tpl.initLocal, this.ctx, b, start, end);

    const tr = this.#transform;
    const s = tr.scale;
    const q = tr.rotation;
    const tmp = this.#tmp;
    const ev = this.#tmp2;
    let i = start;
    for (let k = 0; k < events && i < end; k++) {
      const o = k * EVENT_STRIDE;
      const last = Math.min(end, i + e[o + 10]);
      // event position/velocity arrive in world space
      let evx = e[o + 3], evy = e[o + 4], evz = e[o + 5];
      if (tpl.space === "world") {
        ev[0] = e[o];
        ev[1] = e[o + 1];
        ev[2] = e[o + 2];
      } else {
        rotate(tr.inverseRotation, (e[o] - tr.position[0]) / s, (e[o + 1] - tr.position[1]) / s, (e[o + 2] - tr.position[2]) / s, ev);
        rotate(tr.inverseRotation, evx / s, evy / s, evz / s, tmp);
        evx = tmp[0];
        evy = tmp[1];
        evz = tmp[2];
      }
      for (; i < last; i++) {
        if (tpl.space === "world") {
          rotate(q, b.px[i] * s, b.py[i] * s, b.pz[i] * s, tmp);
          b.px[i] = tmp[0] + ev[0];
          b.py[i] = tmp[1] + ev[1];
          b.pz[i] = tmp[2] + ev[2];
          rotate(q, b.vx[i] * s, b.vy[i] * s, b.vz[i] * s, tmp);
          b.vx[i] = tmp[0] + evx;
          b.vy[i] = tmp[1] + evy;
          b.vz[i] = tmp[2] + evz;
          b.size[i] *= s;
        } else {
          b.px[i] += ev[0];
          b.py[i] += ev[1];
          b.pz[i] += ev[2];
          b.vx[i] += evx;
          b.vy[i] += evy;
          b.vz[i] += evz;
        }
        b.r[i] *= e[o + 6];
        b.g[i] *= e[o + 7];
        b.b[i] *= e[o + 8];
        b.a[i] *= e[o + 9];
      }
    }
    this.#trackLife(start, end);
    this.#startTrails(start, end);
    b.count = end;
    runModules(tpl.initSim, this.ctx, b, start, end);
  }

  #emitEvents(list: EmitterTemplate["death"], i: number): void {
    const sink = this.#sink;
    const b = this.buf;
    const tpl = this.template;
    const tmp = this.#tmp;
    let x = b.px[i], y = b.py[i], z = b.pz[i];
    let vx = b.vx[i], vy = b.vy[i], vz = b.vz[i];
    if (tpl.space === "local") {
      const tr = this.#transform;
      rotate(tr.rotation, x * tr.scale, y * tr.scale, z * tr.scale, tmp);
      x = tmp[0] + tr.position[0];
      y = tmp[1] + tr.position[1];
      z = tmp[2] + tr.position[2];
      rotate(tr.rotation, vx * tr.scale, vy * tr.scale, vz * tr.scale, tmp);
      vx = tmp[0];
      vy = tmp[1];
      vz = tmp[2];
    }
    for (const s of list) {
      if (s.probability < 1 && this.#rng.next() >= s.probability) continue;
      const k = s.inheritVelocity;
      if (s.inheritColor) sink.emitEvent(s.target, x, y, z, vx * k, vy * k, vz * k, b.r[i], b.g[i], b.b[i], b.a[i], s.count);
      else sink.emitEvent(s.target, x, y, z, vx * k, vy * k, vz * k, 1, 1, 1, 1, s.count);
    }
  }
}

function runModules(list: CompiledModule[], ctx: SimContext, buf: ParticleBuffer, start: number, end: number): void {
  for (let m = 0; m < list.length; m++) list[m].rt.run!(ctx, buf, start, end);
}
