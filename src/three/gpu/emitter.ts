// GPU-simulated emitter instance: particle data lives in storage buffers that
// compute kernels write and the regular sprite/mesh materials read as
// instanced attributes (same pA..pD layout as the CPU path).
//
// Allocation is a ring buffer: each frame's spawns take the next `n` slots
// (overwriting the oldest particles if the emitter outruns its capacity), so
// no atomics are needed. The update kernel runs over every slot; dead slots
// return early and have size 0, so they draw nothing.

import * as THREE from "three/webgpu";
import { Fn, If, Return, float, instanceIndex, mix, storage, uint, vec3, vec4 } from "three/tsl";
import type { EffectDoc } from "../../core/types";
import { resolveParams } from "../../core/params";
import type { CompiledModule, EmitterTemplate } from "../../sim/compile";
import type { EffectSim } from "../../sim/effect";
import type { EmitterSim, GpuSpawnTarget } from "../../sim/emitter";
import { PARTICLE_ATTRIBUTES } from "../materials/common";
import type { Node } from "../materials/common";
import { GpuBuildContext, GpuUniforms, rotateQ, type FrameInfo, type GpuParticle } from "./context";
import { getGpuModule } from "./modules";
import "./modules";

/** Reasons `tpl` can't be simulated on the GPU (empty = supported). */
export function gpuSupport(tpl: EmitterTemplate, doc: EffectDoc): string[] {
  const why = new Set<string>();
  if (tpl.birth.length || tpl.death.length) why.add("sub-emitters");
  if (tpl.eventDriven || doc.emitters.some((e) => e.subEmitters?.some((s) => s.emitter === tpl.id))) why.add("being a sub-emitter target");
  for (const r of tpl.renderers) {
    if (r.type === "ribbon") why.add("ribbon renderers");
    if (r.sort && r.sort !== "none") why.add("sorting");
    if (r.type === "sprite" && r.sortGroup) why.add("sort groups");
  }
  for (const m of [...tpl.initLocal, ...tpl.initSim, ...tpl.update]) {
    const impl = getGpuModule(m.def.type);
    if (!impl) {
      why.add(`${m.def.label} has no GPU implementation`);
      continue;
    }
    const reason = impl.unsupported?.(resolveParams(m.def.params, m.instance.params));
    if (reason) why.add(`${m.def.label}: ${reason}`);
  }
  return [...why];
}

interface SpawnRecord {
  t: number;
  n: number;
  life: number;
}

export class GpuEmitter implements GpuSpawnTarget {
  readonly template: EmitterTemplate;
  readonly capacity: number;
  readonly #sim: EmitterSim;
  readonly #attrs: THREE.StorageInstancedBufferAttribute[];
  readonly #u = new GpuUniforms();
  readonly #state: FrameInfo = { cycleT: 0, params: {} };
  readonly #textures: THREE.Texture[] = [];
  readonly #init: Node;
  readonly #update: Node;
  readonly #clear: Node;
  readonly #geometries: THREE.BufferGeometry[] = [];
  #initCtx: GpuBuildContext | null = null;
  #pending = 0;
  #head = 0;
  #needsClear = true;
  #records: SpawnRecord[] = [];
  #rng = 0x9e3779b9;

  constructor(tpl: EmitterTemplate, sim: EmitterSim) {
    this.template = tpl;
    this.#sim = sim;
    this.capacity = tpl.capacity;
    this.#attrs = [0, 1, 2, 3].map(() => new THREE.StorageInstancedBufferAttribute(this.capacity, 4));
    const [A, B, C, D] = this.#attrs.map((a) => storage(a, "vec4", this.capacity));
    const cap = this.capacity;
    const u = this.#u;

    const emit = (list: CompiledModule[], p: GpuParticle, ctx: GpuBuildContext) => {
      for (const m of list) getGpuModule(m.def.type)!.emit(p, ctx, resolveParams(m.def.params, m.instance.params));
    };

    this.#init = Fn(() => {
      If(instanceIndex.greaterThanEqual(u.spawnCount), () => {
        Return();
      });
      const ctx = new GpuBuildContext("init", tpl.space, u, this.#state, this.#textures);
      this.#initCtx = ctx;
      const slot: Node = u.spawnStart.add(instanceIndex).mod(uint(cap));
      const seed: Node = ctx.rand(0).toVar();
      const p: GpuParticle = {
        pos: vec3(0).toVar(),
        vel: vec3(0).toVar(),
        age01: float(0).toVar(),
        life: float(1).toVar(),
        size: float(1).toVar(),
        rot: float(0).toVar(),
        spin: float(0).toVar(),
        seed,
        color: vec4(1).toVar(),
      };
      emit(tpl.initLocal, p, ctx);
      if (tpl.space === "world") {
        // local → world, spreading births along the path travelled this frame
        const f: Node = float(instanceIndex.add(1)).div(float(u.spawnCount));
        const origin: Node = mix(u.prevPosition, u.position, f);
        p.pos.assign(rotateQ(u.rotation, p.pos.mul(u.scale)).add(origin));
        p.vel.assign(rotateQ(u.rotation, p.vel.mul(u.scale)));
        p.size.mulAssign(u.scale);
      }
      emit(tpl.initSim, p, ctx);
      A.element(slot).assign(vec4(p.pos, 0));
      B.element(slot).assign(vec4(p.vel, p.seed));
      C.element(slot).assign(vec4(p.size, p.rot, p.life, p.spin));
      D.element(slot).assign(p.color);
    })().compute(cap);

    this.#update = Fn(() => {
      const i = instanceIndex;
      const a: Node = A.element(i);
      If(a.w.greaterThanEqual(1), () => {
        Return();
      });
      const b: Node = B.element(i);
      const c: Node = C.element(i);
      const ctx = new GpuBuildContext("update", tpl.space, u, this.#state, this.#textures);
      const p: GpuParticle = {
        pos: a.xyz.toVar(),
        vel: b.xyz.toVar(),
        age01: a.w.toVar(),
        life: c.z,
        size: c.x.toVar(),
        rot: c.y.toVar(),
        spin: c.w,
        seed: b.w,
        color: D.element(i).toVar(),
      };
      ctx.bindSeed(p.seed);
      emit(tpl.update, p, ctx);
      p.pos.addAssign(p.vel.mul(u.dt));
      p.rot.addAssign(p.spin.mul(u.dt));
      p.age01.addAssign(u.dt.div(p.life));
      // dead: collapse the instance so it draws nothing
      If(p.age01.greaterThanEqual(1), () => {
        p.size.assign(0);
      });
      A.element(i).assign(vec4(p.pos, p.age01));
      B.element(i).assign(vec4(p.vel, p.seed));
      C.element(i).assign(vec4(p.size, p.rot, p.life, p.spin));
      D.element(i).assign(p.color);
    })().compute(cap);

    this.#clear = Fn(() => {
      A.element(instanceIndex).assign(vec4(0, 0, 0, 2));
      C.element(instanceIndex).assign(vec4(0));
    })().compute(cap);
  }

  /** An instanced geometry over `base` (a quad, a mesh primitive) reading this emitter's particles. */
  geometryFor(base: THREE.BufferGeometry): THREE.InstancedBufferGeometry {
    const g = new THREE.InstancedBufferGeometry().copy(base as THREE.InstancedBufferGeometry);
    Object.values(PARTICLE_ATTRIBUTES).forEach((name, k) => g.setAttribute(name, this.#attrs[k]));
    g.instanceCount = this.capacity;
    this.#geometries.push(g);
    return g;
  }

  // ---- GpuSpawnTarget --------------------------------------------------------

  spawn(n: number): void {
    this.#pending = Math.min(this.capacity, this.#pending + n);
  }

  get count(): number {
    const now = this.#sim.time;
    const r = this.#records;
    while (r.length && r[0].t + r[0].life < now) r.shift();
    let n = 0;
    for (let i = 0; i < r.length; i++) if (r[i].t + r[i].life >= now) n += r[i].n;
    return Math.min(this.capacity, n);
  }

  reset(): void {
    this.#needsClear = true;
    this.#pending = 0;
    this.#head = 0;
    this.#records = [];
  }

  // ---- per frame -------------------------------------------------------------

  /** Writes uniforms and runs this frame's kernels. Call after the EffectSim has stepped. */
  dispatch(renderer: THREE.WebGPURenderer, effect: EffectSim, dt: number): void {
    const u = this.#u;
    const t = effect.transform;
    u.dt.value = dt;
    u.time.value = this.#sim.ctx.time; // emitter time after its start delay, as the CPU modules see it
    // the effect has already stepped, so prevPosition == position; spawns were spread by the CPU-side step
    u.position.value.set(t.position[0], t.position[1], t.position[2]);
    u.prevPosition.value.set(this.#lastPos[0], this.#lastPos[1], this.#lastPos[2]);
    u.rotation.value.set(t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]);
    u.inverseRotation.value.set(-t.rotation[0], -t.rotation[1], -t.rotation[2], t.rotation[3]);
    u.scale.value = t.scale;
    u.velocity.value.set(t.velocity[0], t.velocity[1], t.velocity[2]);
    this.#state.cycleT = this.#sim.ctx.cycleT;
    this.#state.params = this.#sim.ctx.params;

    if (this.#needsClear) {
      renderer.compute(this.#clear);
      this.#needsClear = false;
    }
    const n = this.#pending;
    if (n > 0) {
      u.spawnStart.value = this.#head;
      u.spawnCount.value = n;
      this.#rng = (Math.imul(this.#rng ^ (this.#rng >>> 15), 2246822519) + 0x632be59b) >>> 0;
      u.frameSeed.value = this.#rng;
      renderer.compute(this.#init, n);
      this.#head = (this.#head + n) % this.capacity;
      this.#pending = 0;
      const life = this.#initCtx?.lifetimeMax?.() ?? 1;
      this.#records.push({ t: this.#sim.time, n, life });
      // the budget predictor (Little's law) needs a lifetime estimate; the CPU never sees GPU lifetimes
      this.#sim.lifeEstimate += (life - this.#sim.lifeEstimate) * 0.2;
    }
    if (this.#records.length) renderer.compute(this.#update);
    this.#lastPos[0] = t.position[0];
    this.#lastPos[1] = t.position[1];
    this.#lastPos[2] = t.position[2];
  }

  readonly #lastPos: [number, number, number] = [0, 0, 0];

  /** Call when the effect jumps (spawn / play) so births aren't spread along the jump. */
  teleport(effect: EffectSim): void {
    const p = effect.transform.position;
    this.#lastPos[0] = p[0];
    this.#lastPos[1] = p[1];
    this.#lastPos[2] = p[2];
  }

  dispose(): void {
    for (const g of this.#geometries) g.dispose();
    for (const k of [this.#init, this.#update, this.#clear]) k.dispose?.();
    for (const t of this.#textures) t.dispose();
  }
}
