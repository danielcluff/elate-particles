// ParticleWorld: the three.js runtime. Register effect documents, spawn
// instances (pooled), call update(dt) once per frame and add `world.object`
// to the scene. Each emitter of each registered effect is one draw call no
// matter how many instances are alive.

import * as THREE from "three/webgpu";
import { uniform } from "three/tsl";
import type { EffectDoc, MeshRendererDoc, RendererDoc } from "../core/types";
import { compileEffect, type EffectTemplate } from "../sim/compile";
import { EffectSim } from "../sim/effect";
import type { EmitterTemplate } from "../sim/compile";
import { InstanceBatch, ParticleBatch, RibbonBatch, type SortView } from "./batch";
import { createBuiltinMesh } from "./geometries";
import { SortGroup } from "./sort-group";
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
  /**
   * Soft limit on simulated particles. Spawning of non-essential effects is
   * scaled so the predicted steady population (spawn rate × lifetime) fits the
   * budget; essential effects and emitters with lod.scaleSpawn = false count
   * as fixed load.
   */
  budget?: { maxParticles: number };
  /** 0..1 global detail level (spawn multiplier; emitters with lod.minQuality above it are skipped). Default 1. */
  quality?: number;
  /** Skip drawing instances outside the camera frustum (needs a camera in update). Default true. */
  frustumCulling?: boolean;
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
  /** Particles simulated this frame. */
  particles: number;
  /** Particles actually drawn (after distance and frustum culling). */
  drawnParticles: number;
  drawCalls: number;
  /** Instances not drawn this frame: distance-culled, paused off-screen or outside the frustum. */
  culledInstances: number;
  /** Current budget multiplier on non-essential spawning (1 = unconstrained). */
  budgetScale: number;
  /** Spawns refused this frame by maxInstances or distance culling. */
  rejectedSpawns: number;
}

interface Registered {
  template: EffectTemplate;
  /** Every batch (begin/end/dispose). */
  batches: InstanceBatch[];
  /** Per emitter index: one target per enabled renderer (its own batch, or a sort group's batch + member index). */
  emitterBatches: { batch: InstanceBatch; member: number }[][];
  materials: THREE.Material[];
  luts: THREE.Texture[];
  pool: EffectSim[];
  /** Live handles in spawn order (maxInstances / killOldest). */
  live: ParticleEffect[];
  /** Any emitter loops: culling pauses it instead of letting it finish. */
  looping: boolean;
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
  /** True when spawn() refused this effect (maxInstances, or a one-shot beyond cullDistance). */
  readonly rejected: boolean;
  /** @internal culling state, maintained by the world */
  _culled = false;
  /** @internal */
  _visible = true;

  /** @internal */
  constructor(world: ParticleWorld, effectId: string, sim: EffectSim | null, autoRelease: boolean) {
    this.#world = world;
    this.effectId = effectId;
    this.#sim = sim;
    this.autoRelease = autoRelease;
    this.rejected = !sim;
  }

  /** Not drawn last frame (distance-culled, paused off-screen or outside the frustum). */
  get culled(): boolean {
    return this._culled;
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
    this.#quality = Math.max(0, Math.min(1, opts.quality ?? 1));
    this.#budget = opts.budget?.maxParticles ?? null;
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
      if (reg.template.emitters.some((e) => e.renderers.some((r) => r.type === "mesh" && r.mesh === name))) this.register(reg.template.doc);
  }

  #meshGeometry(e: EmitterTemplate, r: MeshRendererDoc): () => THREE.BufferGeometry {
    const name = r.mesh;
    const registered = this.#geometries.get(name);
    if (registered) return () => registered.clone();
    if (createBuiltinMesh(name)) return () => createBuiltinMesh(name)!;
    console.warn(`tsl-particles: mesh "${name}" is not registered (emitter "${e.doc.name}"); drawing boxes until it is`);
    return () => createBuiltinMesh("box")!;
  }

  #createBatch(e: EmitterTemplate, r: RendererDoc, lut: THREE.DataTexture | null): { batch: InstanceBatch; material: THREE.Material } {
    const opts: MaterialOptions = { time: this.time, loadTexture: this.#loadTexture, hook: this.#opts.materialHook };
    switch (r.type) {
      case "mesh": {
        const material = createMeshMaterial(e, r, lut, opts);
        return { material, batch: new ParticleBatch(e, r, material, this.#meshGeometry(e, r)) };
      }
      case "ribbon": {
        const material = createRibbonMaterial(e, r, lut, opts);
        return { material, batch: new RibbonBatch(e, r, material) };
      }
      default: {
        const material = createSpriteMaterial(e, r, lut, opts);
        return { material, batch: new ParticleBatch(e, r, material) };
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
    for (const g of this.#groups.values()) g.removeEffect(doc.id);

    const reg: Registered = {
      template,
      batches: [],
      emitterBatches: [],
      materials: [],
      luts: [],
      pool: [],
      live: old?.live ?? [],
      looping: template.emitters.some((e) => e.looping),
    };
    for (const e of template.emitters) {
      // one LUT per emitter, shared by its renderers
      const lut = createLutTexture(e);
      if (lut) reg.luts.push(lut);
      const list: { batch: InstanceBatch; member: number }[] = [];
      for (const r of e.renderers) {
        if (r.type === "sprite" && r.sortGroup && r.blend !== "opaque") {
          const group = this.#group(r.sortGroup);
          const member = group.add(doc.id, e, r);
          if (member !== null) {
            list.push({ batch: group.batch, member });
            continue;
          }
          console.warn(
            `tsl-particles: "${doc.name}" / ${e.doc.name} can't join sort group "${r.sortGroup}" (its texture differs from the group's); drawn on its own`,
          );
        }
        const { batch, material } = this.#createBatch(e, r, lut);
        reg.materials.push(material);
        reg.batches.push(batch);
        list.push({ batch, member: 0 });
        this.object.add(batch.mesh);
      }
      reg.emitterBatches.push(list);
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
    for (const g of this.#groups.values()) g.removeEffect(id);
    this.#effects.delete(id);
  }

  /**
   * Spawns an effect by id (or document, registered on first use). May return
   * a `rejected` (inert) handle when scalability refuses the spawn: the effect
   * is at maxInstances with overflow "rejectNew", or it is a one-shot beyond its
   * cullDistance from the last camera.
   */
  spawn(effect: string | EffectDoc, opts: SpawnOptions = {}): ParticleEffect {
    const id = typeof effect === "string" ? effect : effect.id;
    if (typeof effect !== "string" && !this.#effects.has(id)) this.register(effect);
    const reg = this.#effects.get(id);
    if (!reg) throw new Error(`Particle effect "${id}" is not registered`);
    const sc = reg.template.doc.scalability;

    if (sc) {
      // one-shots that start out of range would never be seen
      if (sc.cullDistance && !reg.looping && this.#hasView && opts.position) {
        const v = this.#view;
        const p = opts.position;
        if ((p.x - v.px) ** 2 + (p.y - v.py) ** 2 + (p.z - v.pz) ** 2 > sc.cullDistance ** 2) return this.#reject(id);
      }
      if (sc.maxInstances && reg.live.length >= sc.maxInstances) {
        if ((sc.overflow ?? "rejectNew") === "rejectNew") return this.#reject(id);
        reg.live[0].release();
      }
    }

    const sim = reg.pool.pop() ?? new EffectSim(reg.template);
    sim.setVelocity(null);
    sim.spawnScale = 1;
    sim.transform.scale = opts.scale ?? 1;
    Object.assign(sim.params, reg.template.paramDefaults, opts.params);
    if (opts.position) sim.setPosition(opts.position.x, opts.position.y, opts.position.z);
    else sim.setPosition(0, 0, 0);
    if (opts.rotation) sim.setRotation(opts.rotation.x, opts.rotation.y, opts.rotation.z, opts.rotation.w);
    else sim.setRotation(0, 0, 0, 1);
    for (const e of sim.emitters) e.lodActive = true;
    const seed = opts.seed ?? this.#seed++;
    if (opts.paused) sim.clear();
    else sim.play(seed);

    const handle = new ParticleEffect(this, id, sim, opts.autoRelease ?? true);
    this.#active.push(handle);
    reg.live.push(handle);
    return handle;
  }

  #reject(id: string): ParticleEffect {
    this.#rejected++;
    return new ParticleEffect(this, id, null, true);
  }

  /** @internal called by ParticleEffect.release */
  _release(handle: ParticleEffect, sim: EffectSim): void {
    const i = this.#active.indexOf(handle);
    if (i >= 0) {
      this.#active[i] = this.#active[this.#active.length - 1];
      this.#active.pop();
    }
    sim.clear();
    const reg = this.#effects.get(handle.effectId);
    if (reg) {
      const j = reg.live.indexOf(handle);
      if (j >= 0) reg.live.splice(j, 1);
      // only recycle sims built from the current template (not ones orphaned by a re-register)
      if (sim.template === reg.template) reg.pool.push(sim);
    }
  }

  /** Global detail level 0..1 (see ParticleWorldOptions.quality). */
  get quality(): number {
    return this.#quality;
  }
  set quality(q: number) {
    this.#quality = Math.max(0, Math.min(1, q));
  }

  /** Soft particle budget (see ParticleWorldOptions.budget); null = unlimited. */
  get budget(): number | null {
    return this.#budget;
  }
  set budget(n: number | null) {
    this.#budget = n && n > 0 ? n : null;
    if (!this.#budget) this.#budgetScale = 1;
  }

  readonly #view: SortView = { px: 0, py: 0, pz: 0, fx: 0, fy: 0, fz: -1 };
  #hasView = false;
  #warnedNoCamera = false;
  readonly #frustum = new THREE.Frustum();
  readonly #projView = new THREE.Matrix4();
  readonly #box = new THREE.Box3();
  readonly #bounds = new Float32Array(6);
  #quality = 1;
  #budget: number | null = null;
  #budgetScale = 1;
  #rejected = 0;
  #frameStats = { particles: 0, drawn: 0, culled: 0, rejected: 0 };

  /**
   * Steps every live effect and fills the GPU buffers. Pass the camera that
   * will render the frame when any emitter uses `sort: "distance"`.
   */
  update(dt: number, camera?: THREE.Camera): void {
    dt = Math.min(dt, this.#opts.maxDelta ?? 0.1);
    if (dt <= 0) return;
    this.time.value += dt;

    // camera: view for sorting / distance LOD, frustum for culling
    let view: SortView | null = null;
    let frustum: THREE.Frustum | null = null;
    if (camera) {
      camera.updateMatrixWorld();
      const e = camera.matrixWorld.elements;
      const v = this.#view;
      const l = Math.sqrt(e[8] * e[8] + e[9] * e[9] + e[10] * e[10]) || 1;
      v.px = e[12];
      v.py = e[13];
      v.pz = e[14];
      v.fx = -e[8] / l;
      v.fy = -e[9] / l;
      v.fz = -e[10] / l;
      view = v;
      this.#hasView = true;
      if (this.#opts.frustumCulling !== false) {
        this.#projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        frustum = this.#frustum.setFromProjectionMatrix(this.#projView, camera.coordinateSystem, camera.reversedDepth);
      }
    } else if (!this.#warnedNoCamera) {
      for (const reg of this.#effects.values())
        if (reg.template.emitters.some((em) => em.renderers.some((r) => r.sort === "distance" || (r.type === "sprite" && r.sortGroup)))) {
          console.warn('tsl-particles: an emitter uses sort: "distance" or a sortGroup but ParticleWorld.update() was called without a camera; it is drawn unsorted');
          this.#warnedNoCamera = true;
          break;
        }
    }

    const quality = this.#quality;
    const active = this.#active;
    let simulated = 0;
    let fixedLoad = 0;
    let scalableLoad = 0;
    for (let i = active.length - 1; i >= 0; i--) {
      const h = active[i];
      const sim = h.sim!;
      const reg = this.#effects.get(h.effectId)!;
      const sc = reg.template.doc.scalability;

      // distance LOD
      let dist = 0;
      if (view) {
        const p = sim.transform.position;
        dist = Math.sqrt((p[0] - view.px) ** 2 + (p[1] - view.py) ** 2 + (p[2] - view.pz) ** 2);
      }
      const farCulled = !!(view && sc?.cullDistance && dist > sc.cullDistance);
      h._culled = farCulled;
      // looping effects pause while out of range, or off-screen when asked to
      if (farCulled && reg.looping) continue;
      // paused, not culled: its frozen bounds are still frustum-tested below, so it resumes once in view
      if (sc?.pauseOffscreen && reg.looping && frustum && !h._visible && sim.particleCount > 0) {
        simulated += sim.particleCount;
        continue;
      }

      let lodScale = quality;
      if (farCulled) lodScale = 0;
      else if (view && sc?.lodDistance && dist > sc.lodDistance) {
        const far = sc.farSpawnScale ?? 0.25;
        const end = sc.cullDistance ?? sc.lodDistance * 2;
        const f = Math.min(1, (dist - sc.lodDistance) / Math.max(1e-6, end - sc.lodDistance));
        lodScale *= 1 + (far - 1) * f;
      }
      sim.spawnScale = lodScale * (sc?.essential ? 1 : this.#budgetScale);
      for (const em of sim.emitters) {
        const t = em.template;
        em.lodActive = quality >= t.minQuality && !(view && dist > t.maxDistance);
      }

      const wasAlive = sim.alive;
      sim.step(dt);
      simulated += sim.particleCount;
      // budget load: what this instance would hold at budget scale 1, or its actual count if exempt
      for (const em of sim.emitters) {
        if (sc?.essential || !em.template.scaleSpawn) fixedLoad += em.buf.count;
        else if (em.lodActive) scalableLoad += em.demand * em.lifeEstimate * lodScale;
      }
      if (wasAlive && !sim.alive) {
        h.onFinished?.();
        if (h.autoRelease && h.sim) h.release();
      }
    }

    // pack what is visible
    let culled = 0;
    let drawn = 0;
    const box = this.#box;
    const bb = this.#bounds;
    for (const reg of this.#effects.values()) for (const b of reg.batches) b.begin();
    for (const g of this.#groups.values()) g.batch.begin();
    for (const h of active) {
      const sim = h.sim!;
      if (sim.state === "stopped" && sim.particleCount === 0) continue;
      if (h._culled) {
        culled++;
        continue;
      }
      if (frustum) {
        h._visible = sim.worldBounds(bb) && frustum.intersectsBox(box.set(box.min.set(bb[0], bb[1], bb[2]), box.max.set(bb[3], bb[4], bb[5])));
        if (!h._visible) {
          culled++;
          continue;
        }
      } else h._visible = true;
      const perEmitter = this.#effects.get(h.effectId)!.emitterBatches;
      for (const e of sim.emitters) {
        const list = perEmitter[e.template.index];
        if (list.length === 0) continue;
        drawn += e.buf.count; // once per emitter, however many renderers draw it
        const m = e.template.space === "local" ? sim.matrix : null;
        for (let k = 0; k < list.length; k++) list[k].batch.pack(e, m, list[k].member);
      }
    }
    for (const reg of this.#effects.values()) for (const b of reg.batches) b.end(view);
    for (const g of this.#groups.values()) g.batch.end(view);

    // budget, feedforward: particle counts lag spawn decisions by a lifetime, so
    // reacting to the live count oscillates. Instead predict the steady population
    // (Little's law, demand × lifetime per emitter) and pick the scale that fits it.
    const budget = this.#budget;
    if (budget) {
      let target = scalableLoad > 0 ? Math.max(0, budget - fixedLoad) / scalableLoad : 1;
      // prediction error correction: if the live count is well over, lean in proportionally
      if (simulated > budget * 1.25) target *= (budget * 1.25) / simulated;
      target = Math.max(0.01, Math.min(1, target));
      this.#budgetScale += (target - this.#budgetScale) * Math.min(1, dt * 3);
    }

    this.#frameStats.particles = simulated;
    this.#frameStats.drawn = drawn;
    this.#frameStats.culled = culled;
    this.#frameStats.rejected = this.#rejected;
    this.#rejected = 0;
  }

  get stats(): ParticleWorldStats {
    let drawCalls = 0;
    for (const reg of this.#effects.values()) for (const b of reg.batches) if (b.instances > 0) drawCalls++;
    for (const g of this.#groups.values()) if (g.batch.instances > 0) drawCalls++;
    const f = this.#frameStats;
    return {
      effects: this.#effects.size,
      instances: this.#active.length,
      particles: f.particles,
      drawnParticles: f.drawn,
      drawCalls,
      culledInstances: f.culled,
      budgetScale: this.#budgetScale,
      rejectedSpawns: f.rejected,
    };
  }

  readonly #groups = new Map<string, SortGroup>();

  #group(name: string): SortGroup {
    let g = this.#groups.get(name);
    if (!g) {
      g = new SortGroup(name, { time: this.time, loadTexture: this.#loadTexture, hook: this.#opts.materialHook });
      this.#groups.set(name, g);
      this.object.add(g.batch.mesh);
    }
    return g;
  }

  /** Sort groups and how many renderers each holds (diagnostics). */
  get sortGroups(): { name: string; members: number }[] {
    return [...this.#groups.values()].map((g) => ({ name: g.name, members: g.memberCount }));
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
    for (const g of this.#groups.values()) g.dispose();
    this.#groups.clear();
    for (const t of this.#textures.values()) t.dispose();
    this.#textures.clear();
    this.object.removeFromParent();
  }
}
