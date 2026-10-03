import type { ParamValues } from "../core/values";
import type { EffectTemplate } from "./compile";
import { EffectTransform } from "./context";
import { EmitterSim, type EventSink } from "./emitter";
import { composeMatrix } from "./math";

export type EffectState = "playing" | "stopping" | "stopped";

interface XYZ {
  x: number;
  y: number;
  z: number;
}
interface XYZW extends XYZ {
  w: number;
}

const PREWARM_STEP = 1 / 30;

/**
 * A running instance of an effect: transform, parameters and one EmitterSim
 * per emitter. Framework-free; the three.js layer only reads its buffers.
 *
 * Per frame: setTransform(...) (if it moves), then step(dt).
 */
export class EffectSim implements EventSink {
  readonly template: EffectTemplate;
  readonly transform = new EffectTransform();
  readonly params: ParamValues;
  readonly emitters: EmitterSim[];
  /** World matrix (column-major), updated every step; used to draw local-space emitters. */
  readonly matrix = new Float32Array(16);
  state: EffectState = "stopped";
  /** Seconds since play(). */
  time = 0;

  #seed: number;
  #velocityOverride = false;

  constructor(template: EffectTemplate, seed = 1) {
    this.template = template;
    this.#seed = seed;
    this.params = { ...template.paramDefaults };
    this.emitters = template.emitters.map((e) => new EmitterSim(e, this.transform, this.params, this.#emitterSeed(e.seed), this));
    composeMatrix(this.transform.position, this.transform.rotation, 1, this.matrix);
  }

  #emitterSeed(s: number): number {
    return (Math.imul(s ^ this.#seed, 2654435761) >>> 0) || 1;
  }

  // ---- transform -----------------------------------------------------------

  setPosition(x: number, y: number, z: number): this {
    const p = this.transform.position;
    p[0] = x;
    p[1] = y;
    p[2] = z;
    return this;
  }

  setRotation(x: number, y: number, z: number, w: number): this {
    const q = this.transform.rotation;
    q[0] = x;
    q[1] = y;
    q[2] = z;
    q[3] = w;
    return this;
  }

  /** Accepts three.js Vector3 / Quaternion (or any {x,y,z(,w)}). */
  setTransform(position: XYZ, rotation?: XYZW, scale?: number): this {
    this.setPosition(position.x, position.y, position.z);
    if (rotation) this.setRotation(rotation.x, rotation.y, rotation.z, rotation.w);
    if (scale !== undefined) this.transform.scale = scale;
    return this;
  }

  /** Overrides the velocity otherwise derived from movement (e.g. from physics). Pass null to derive again. */
  setVelocity(v: XYZ | null): this {
    this.#velocityOverride = !!v;
    if (v) {
      const tv = this.transform.velocity;
      tv[0] = v.x;
      tv[1] = v.y;
      tv[2] = v.z;
    }
    return this;
  }

  /** Moves without interpolating spawns along the path (call after a jump). */
  teleport(): this {
    const t = this.transform;
    t.prevPosition[0] = t.position[0];
    t.prevPosition[1] = t.position[1];
    t.prevPosition[2] = t.position[2];
    return this;
  }

  setParam(name: string, value: number): this {
    this.params[name] = value;
    return this;
  }

  // ---- lifecycle -----------------------------------------------------------

  /** (Re)starts the effect from time 0. */
  play(seed?: number): this {
    if (seed !== undefined) this.#seed = seed;
    this.time = 0;
    this.state = "playing";
    for (const e of this.emitters) e.reset(this.#emitterSeed(e.template.seed));
    this.teleport();
    if (!this.#velocityOverride) this.transform.velocity.fill(0);
    this.#syncDerived(0);
    for (const e of this.emitters) {
      if (!e.template.prewarm || !e.template.looping) continue;
      for (let t = 0; t < e.template.duration; t += PREWARM_STEP) e.step(PREWARM_STEP, true);
      e.time = 0;
    }
    return this;
  }

  /** Stops spawning; live particles finish their lives, then the effect is "stopped". */
  stop(): this {
    if (this.state === "playing") this.state = "stopping";
    return this;
  }

  /** Removes every particle immediately. */
  clear(): this {
    for (const e of this.emitters) e.reset(this.#emitterSeed(e.template.seed));
    this.state = "stopped";
    return this;
  }

  get alive(): boolean {
    return this.state !== "stopped";
  }

  get particleCount(): number {
    let n = 0;
    for (const e of this.emitters) n += e.buf.count;
    return n;
  }

  step(dt: number): void {
    if (this.state === "stopped") return;
    if (dt <= 0) return;
    this.time += dt;
    this.#syncDerived(dt);
    const playing = this.state === "playing";
    let done = true;
    for (const e of this.emitters) {
      e.step(dt, playing);
      if (!e.isDone(playing)) done = false;
    }
    // events pushed to emitters already stepped this frame keep the effect alive
    if (done) for (const e of this.emitters) if (e.pendingEvents > 0) done = false;
    if (done) this.state = "stopped";
    this.teleport();
  }

  #syncDerived(dt: number): void {
    const t = this.transform;
    const q = t.rotation;
    const inv = t.inverseRotation;
    inv[0] = -q[0];
    inv[1] = -q[1];
    inv[2] = -q[2];
    inv[3] = q[3];
    if (!this.#velocityOverride && dt > 0) {
      t.velocity[0] = (t.position[0] - t.prevPosition[0]) / dt;
      t.velocity[1] = (t.position[1] - t.prevPosition[1]) / dt;
      t.velocity[2] = (t.position[2] - t.prevPosition[2]) / dt;
    }
    composeMatrix(t.position, q, t.scale, this.matrix);
  }

  /** @internal EventSink */
  emitEvent(target: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, r: number, g: number, b: number, a: number, count: number): void {
    this.emitters[target]?.pushEvent(x, y, z, vx, vy, vz, r, g, b, a, count);
  }
}
