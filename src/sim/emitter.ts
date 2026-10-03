import { Rng, type ParamValues } from "../core/values";
import { ParticleBuffer } from "./buffer";
import type { CompiledModule, EmitterTemplate } from "./compile";
import { EffectTransform, SimContext } from "./context";
import { rotate } from "./math";

/** Floats per queued sub-emitter event: position, velocity, colour, count. */
const EVENT_STRIDE = 11;
const MAX_EVENTS = 512;

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
  }

  reset(seed: number): void {
    this.time = 0;
    this.buf.clear();
    this.state.fill(0);
    this.#eventCount = 0;
    this.#rng.seed(seed);
  }

  get pendingEvents(): number {
    return this.#eventCount;
  }

  /** True once it has nothing left to do (no particles, no queued events, no more spawning). */
  isDone(playing: boolean): boolean {
    if (this.buf.count > 0 || this.#eventCount > 0) return false;
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

  step(dt: number, playing: boolean): void {
    const tpl = this.template;
    const ctx = this.ctx;
    this.time += dt;
    const t = this.time - tpl.startDelay;

    ctx.dt = dt;
    ctx.distance = Math.hypot(
      this.#transform.position[0] - this.#transform.prevPosition[0],
      this.#transform.position[1] - this.#transform.prevPosition[1],
      this.#transform.position[2] - this.#transform.prevPosition[2],
    );
    if (t >= 0) {
      ctx.time = t;
      ctx.cycle = tpl.looping ? Math.floor(t / tpl.duration) : 0;
      ctx.cycleTime = tpl.looping ? t - ctx.cycle * tpl.duration : Math.min(t, tpl.duration);
      ctx.cycleT = ctx.cycleTime / tpl.duration;
    }

    if (playing && !tpl.eventDriven && t >= 0 && (tpl.looping || t - dt < tpl.duration)) {
      let n = 0;
      for (const m of tpl.spawn) n += m.rt.spawn!(ctx, this.state.subarray(m.stateOffset, m.stateOffset + (m.rt.stateSize ?? 0)));
      if (n > 0) this.#spawn(n);
    }
    if (this.#eventCount > 0) this.#spawnEvents();

    const buf = this.buf;
    const count = buf.count;
    if (count === 0) return;

    runModules(tpl.update, ctx, buf, 0, count);

    // integrate
    const { px, py, pz, vx, vy, vz, rot, spin, age } = buf;
    for (let i = 0; i < count; i++) {
      px[i] += vx[i] * dt;
      py[i] += vy[i] * dt;
      pz[i] += vz[i] * dt;
      rot[i] += spin[i] * dt;
      age[i] += dt;
    }

    // deaths (backwards: the particle swapped into slot i was already visited)
    const life = buf.life;
    const death = tpl.death;
    for (let i = count - 1; i >= 0; i--) {
      if (age[i] < life[i]) continue;
      if (death.length) this.#emitEvents(death, i);
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
