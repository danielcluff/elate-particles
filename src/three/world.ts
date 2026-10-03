// ParticleWorld: the three.js runtime. Register effect documents, spawn
// instances (pooled), call update(dt) once per frame and add `world.object`
// to the scene. Each emitter of each registered effect is one draw call no
// matter how many instances are alive.

import * as THREE from "three/webgpu";
import { uniform } from "three/tsl";
import type { EffectDoc } from "../core/types";
import { compileEffect, type EffectTemplate } from "../sim/compile";
import { EffectSim } from "../sim/effect";
import type { EmitterTemplate } from "../sim/compile";
import { InstanceBatch, ParticleBatch, RibbonBatch } from "./batch";
import { createBuiltinMesh } from "./geometries";
import { createLutTexture, type MaterialOptions, type ParticleMaterialContext } from "./materials/common";
import { createMeshMaterial } from "./materials/mesh";
import { createRibbonMaterial } from "./materials/ribbon";
import { createSpriteMaterial } from "./materials/sprite";

interface XYZ {
  x: number;
  y: number;
  z: number;
}
interface XYZW extends XYZ {
  w: number;
}

export interface ParticleWorldOptions {
  /** Resolves renderer texture references (URLs or host asset ids). Defaults to a cached TextureLoader. */
  loadTexture?: (url: string) => THREE.Texture;
  /** Customise sprite materials (e.g. plug in a tsl-graph shader). Called once per emitter material. */
  materialHook?: (ctx: ParticleMaterialContext) => void;
  /** Named geometries for mesh renderers (also see registerGeometry). Built-in primitives need no registration. */
  geometries?: Record<string, THREE.BufferGeometry>;
  /** Larger frame deltas are clamped to this (seconds). Default 0.1. */
  maxDelta?: number;
}

export interface SpawnOptions {
  position?: XYZ;
  rotation?: XYZW;
  scale?: number;
  params?: Record<string, number>;
  /** Return the instance to the pool as soon as it finishes. Default true (fire-and-forget). */
  autoRelease?: boolean;
  /** Don't start playing yet. */
  paused?: boolean;
  seed?: number;
}

export interface ParticleWorldStats {
  effects: number;
  instances: number;
  particles: number;
  drawCalls: number;
}

interface Registered {
  template: EffectTemplate;
  batches: InstanceBatch[];
  materials: THREE.Material[];
  luts: THREE.Texture[];
  pool: EffectSim[];
}

/**
 * Handle to a spawned effect. Handles are never reused: after release() (or
 * auto-release when finished) every method is a no-op and `alive` is false,
 * so holding on to a stale handle is harmless.
 */
export class ParticleEffect {
  readonly effectId: string;
  autoRelease: boolean;
  /** Called once when the effect finishes (all particles dead after stop or a one-shot ends). */
  onFinished: (() => void) | null = null;
  #sim: EffectSim | null;
  #world: ParticleWorld;

  /** @internal */
  constructor(world: ParticleWorld, effectId: string, sim: EffectSim, autoRelease: boolean) {
    this.#world = world;
    this.effectId = effectId;
    this.#sim = sim;
    this.autoRelease = autoRelease;
  }

  /** The underlying simulation (null once released). */
  get sim(): EffectSim | null {
    return this.#sim;
  }

  get alive(): boolean {
    return !!this.#sim?.alive;
  }

  get released(): boolean {
    return !this.#sim;
  }

  get particleCount(): number {
    return this.#sim?.particleCount ?? 0;
  }

  setTransform(position: XYZ, rotation?: XYZW, scale?: number): this {
    this.#sim?.setTransform(position, rotation, scale);
    return this;
  }

  setPosition(x: number, y: number, z: number): this {
    this.#sim?.setPosition(x, y, z);
    return this;
  }

  setVelocity(v: XYZ | null): this {
    this.#sim?.setVelocity(v);
    return this;
  }

  teleport(): this {
    this.#sim?.teleport();
    return this;
  }

  setParam(name: string, value: number): this {
    this.#sim?.setParam(name, value);
    return this;
  }

  play(): this {
    this.#sim?.play();
    return this;
  }

  /** Stop spawning and let live particles finish. */
  stop(): this {
    this.#sim?.stop();
    return this;
  }

  /** Remove every particle now. */
  clear(): this {
    this.#sim?.clear();
    return this;
  }

  /** Detach from the world immediately and recycle the simulation. */
  release(): void {
    if (!this.#sim) return;
    const sim = this.#sim;
    this.#sim = null;
    this.#world._release(this, sim);
  }

  /** @internal swap in a recompiled simulation (hot reload). */
  _swap(sim: EffectSim): void {
    this.#sim = sim;
  }
}

export class ParticleWorld {
  /** Add to the scene root (it must keep an identity transform). */
  readonly object = new THREE.Group();
  /** Seconds, shared by every particle material (flipbook fps, custom hooks). */
  readonly time = uniform(0);

  readonly #effects = new Map<string, Registered>();
  readonly #active: ParticleEffect[] = [];
  readonly #opts: ParticleWorldOptions;
  readonly #textures = new Map<string, THREE.Texture>();
  readonly #geometries = new Map<string, THREE.BufferGeometry>();
  #seed = 1;

  constructor(opts: ParticleWorldOptions = {}) {
    this.#opts = opts;
    this.object.name = "ParticleWorld";
    this.object.matrixAutoUpdate = false;
    for (const [name, g] of Object.entries(opts.geometries ?? {})) this.#geometries.set(name, g);
  }

  /**
   * Makes a geometry available to mesh renderers by name (e.g. debris from a
   * GLB). Effects already using the name are rebuilt. The world keeps a
   * reference but never disposes it: the caller owns the geometry.
   */
  registerGeometry(name: string, geometry: THREE.BufferGeometry): void {
    this.#geometries.set(name, geometry);
    for (const reg of [...this.#effects.values()])
      if (reg.template.emitters.some((e) => e.renderer.type === "mesh" && e.renderer.mesh === name)) this.register(reg.template.doc);
  }

  #meshGeometry(e: EmitterTemplate): () => THREE.BufferGeometry {
    const name = e.renderer.type === "mesh" ? e.renderer.mesh : "box";
    const registered = this.#geometries.get(name);
    if (registered) return () => registered.clone();
    if (createBuiltinMesh(name)) return () => createBuiltinMesh(name)!;
    console.warn(`tsl-particles: mesh "${name}" is not registered (emitter "${e.doc.name}"); drawing boxes until it is`);
    return () => createBuiltinMesh("box")!;
  }

  #createBatch(e: EmitterTemplate, lut: THREE.DataTexture | null): { batch: InstanceBatch; material: THREE.Material } {
    const opts: MaterialOptions = { time: this.time, loadTexture: this.#loadTexture, hook: this.#opts.materialHook };
    switch (e.renderer.type) {
      case "mesh": {
        const material = createMeshMaterial(e, lut, opts);
        return { material, batch: new ParticleBatch(e, material, this.#meshGeometry(e)) };
      }
      case "ribbon": {
        const material = createRibbonMaterial(e, lut, opts);
        return { material, batch: new RibbonBatch(e, material) };
      }
      default: {
        const material = createSpriteMaterial(e, lut, opts);
        return { material, batch: new ParticleBatch(e, material) };
      }
    }
  }

  #loadTexture = (url: string): THREE.Texture => {
    if (this.#opts.loadTexture) return this.#opts.loadTexture(url);
    let t = this.#textures.get(url);
    if (!t) {
      t = new THREE.TextureLoader().load(url);
      t.colorSpace = THREE.SRGBColorSpace;
      this.#textures.set(url, t);
    }
    return t;
  };

  /**
   * Compiles and registers an effect (or replaces it: live instances restart
   * with the new definition, which is what an editor wants on every change).
   */
  register(doc: EffectDoc): EffectTemplate {
    const template = compileEffect(doc);
    const old = this.#effects.get(doc.id);
    if (old) this.#disposeRegistered(old);

    const reg: Registered = { template, batches: [], materials: [], luts: [], pool: [] };
    for (const e of template.emitters) {
      const lut = createLutTexture(e);
      if (lut) reg.luts.push(lut);
      const { batch, material } = this.#createBatch(e, lut);
      reg.materials.push(material);
      reg.batches.push(batch);
      this.object.add(batch.mesh);
    }
    this.#effects.set(doc.id, reg);

    if (old) {
      for (const h of this.#active) {
        if (h.effectId !== doc.id || !h.sim) continue;
        const prev = h.sim;
        const sim = new EffectSim(template, this.#seed++);
        const t = prev.transform;
        sim.setPosition(t.position[0], t.position[1], t.position[2]);
        sim.setRotation(t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]);
        sim.transform.scale = t.scale;
        Object.assign(sim.params, prev.params);
        if (prev.state !== "stopped") sim.play();
        h._swap(sim);
      }
    }
    return template;
  }

  has(id: string): boolean {
    return this.#effects.has(id);
  }

  template(id: string): EffectTemplate | undefined {
    return this.#effects.get(id)?.template;
  }

  /** Releases live instances of the effect and frees its GPU resources. */
  unregister(id: string): void {
    const reg = this.#effects.get(id);
    if (!reg) return;
    for (const h of [...this.#active]) if (h.effectId === id) h.release();
    this.#disposeRegistered(reg);
    this.#effects.delete(id);
  }

  /** Spawns an effect by id (or document, registered on first use). */
  spawn(effect: string | EffectDoc, opts: SpawnOptions = {}): ParticleEffect {
    const id = typeof effect === "string" ? effect : effect.id;
    if (typeof effect !== "string" && !this.#effects.has(id)) this.register(effect);
    const reg = this.#effects.get(id);
    if (!reg) throw new Error(`Particle effect "${id}" is not registered`);

    const sim = reg.pool.pop() ?? new EffectSim(reg.template);
    sim.setVelocity(null);
    sim.transform.scale = opts.scale ?? 1;
    Object.assign(sim.params, reg.template.paramDefaults, opts.params);
    if (opts.position) sim.setPosition(opts.position.x, opts.position.y, opts.position.z);
    else sim.setPosition(0, 0, 0);
    if (opts.rotation) sim.setRotation(opts.rotation.x, opts.rotation.y, opts.rotation.z, opts.rotation.w);
    else sim.setRotation(0, 0, 0, 1);
    const seed = opts.seed ?? this.#seed++;
    if (opts.paused) sim.clear();
    else sim.play(seed);

    const handle = new ParticleEffect(this, id, sim, opts.autoRelease ?? true);
    this.#active.push(handle);
    return handle;
  }

  /** @internal called by ParticleEffect.release */
  _release(handle: ParticleEffect, sim: EffectSim): void {
    const i = this.#active.indexOf(handle);
    if (i >= 0) {
      this.#active[i] = this.#active[this.#active.length - 1];
      this.#active.pop();
    }
    sim.clear();
    // only recycle sims built from the current template (not ones orphaned by a re-register)
    const reg = this.#effects.get(handle.effectId);
    if (reg && sim.template === reg.template) reg.pool.push(sim);
  }

  update(dt: number): void {
    dt = Math.min(dt, this.#opts.maxDelta ?? 0.1);
    if (dt <= 0) return;
    this.time.value += dt;

    const active = this.#active;
    for (let i = active.length - 1; i >= 0; i--) {
      const h = active[i];
      const sim = h.sim!;
      const wasAlive = sim.alive;
      sim.step(dt);
      if (wasAlive && !sim.alive) {
        h.onFinished?.();
        if (h.autoRelease && h.sim) h.release();
      }
    }

    for (const reg of this.#effects.values()) for (const b of reg.batches) b.begin();
    for (const h of active) {
      const sim = h.sim!;
      if (sim.state === "stopped") continue;
      const batches = this.#effects.get(h.effectId)!.batches;
      for (const e of sim.emitters) batches[e.template.index].pack(e, e.template.space === "local" ? sim.matrix : null);
    }
    for (const reg of this.#effects.values()) for (const b of reg.batches) b.end();
  }

  get stats(): ParticleWorldStats {
    let particles = 0;
    let drawCalls = 0;
    for (const reg of this.#effects.values())
      for (const b of reg.batches) {
        particles += b.particles;
        if (b.instances > 0) drawCalls++;
      }
    return { effects: this.#effects.size, instances: this.#active.length, particles, drawCalls };
  }

  #disposeRegistered(reg: Registered): void {
    for (const b of reg.batches) b.dispose();
    for (const m of reg.materials) m.dispose();
    for (const t of reg.luts) t.dispose();
    reg.pool.length = 0;
  }

  dispose(): void {
    for (const h of [...this.#active]) h.release();
    for (const reg of this.#effects.values()) this.#disposeRegistered(reg);
    this.#effects.clear();
    for (const t of this.#textures.values()) t.dispose();
    this.#textures.clear();
    this.object.removeFromParent();
  }
}
