// WorkerParticleWorld: the ParticleWorld API with the CPU simulation in a Web
// Worker. The main thread keeps a render-only ParticleWorld (materials,
// meshes, GPU buffers) built from the same registrations as the worker's, so
// both produce identical batch lists; each frame the worker's packed arrays
// are transferred over and adopted by the matching batches.
//
// Results arrive one frame late (at most one frame is in flight; if the
// worker falls behind, dt accumulates rather than queueing). Effects attached
// to fast-moving objects therefore trail by a frame: keep those in a
// main-thread ParticleWorld (both can run side by side).

import type * as THREE from "three/webgpu";
import type { EffectDoc } from "../core/types";
import type { CameraState, FromWorker, HandleOp, SpawnOpts, ToWorker, WorkerStats } from "../worker/protocol";
import { ParticleWorld, type ParticleWorldOptions, type ParticleWorldStats } from "./world";

interface XYZ {
  x: number;
  y: number;
  z: number;
}
interface XYZW extends XYZ {
  w: number;
}

/** A Worker, MessagePort or test channel. */
export interface ParticlePort {
  postMessage(msg: ToWorker, transfer?: Transferable[]): void;
  addEventListener(type: "message", fn: (e: { data: FromWorker }) => void): void;
  terminate?(): void;
}

export type WorkerParticleWorldOptions = Omit<ParticleWorldOptions, "renderer" | "silent">;

/**
 * Handle to an effect simulated in the worker. Same surface as ParticleEffect;
 * `alive`, `particleCount`, `culled` and `rejected` reflect the latest result
 * (one frame behind), and `sim` is not available.
 */
export class WorkerParticleEffect {
  readonly id: number;
  readonly effectId: string;
  onFinished: (() => void) | null = null;
  #world: WorkerParticleWorld;
  #autoRelease: boolean;
  /** @internal */ _alive = true;
  /** @internal */ _count = 0;
  /** @internal */ _culled = false;
  /** @internal */ _rejected = false;
  /** @internal */ _released = false;

  /** @internal */
  constructor(world: WorkerParticleWorld, id: number, effectId: string, autoRelease: boolean) {
    this.#world = world;
    this.id = id;
    this.effectId = effectId;
    this.#autoRelease = autoRelease;
  }

  get sim(): null {
    return null;
  }
  get alive(): boolean {
    return this._alive && !this._released;
  }
  get released(): boolean {
    return this._released;
  }
  get rejected(): boolean {
    return this._rejected;
  }
  get culled(): boolean {
    return this._culled;
  }
  get particleCount(): number {
    return this._released ? 0 : this._count;
  }
  get autoRelease(): boolean {
    return this.#autoRelease;
  }
  set autoRelease(v: boolean) {
    this.#autoRelease = v;
    this.#op({ op: "autoRelease", id: this.id, value: v });
  }

  #op(op: HandleOp): this {
    if (!this._released) this.#world._enqueue(op);
    return this;
  }

  setTransform(position: XYZ, rotation?: XYZW, scale?: number): this {
    if (!this._released) this.#world._transform(this.id, position, rotation, scale);
    return this;
  }
  setPosition(x: number, y: number, z: number): this {
    return this.setTransform({ x, y, z });
  }
  setVelocity(v: XYZ | null): this {
    return this.#op({ op: "velocity", id: this.id, v: v ? [v.x, v.y, v.z] : null });
  }
  teleport(): this {
    return this.#op({ op: "teleport", id: this.id });
  }
  setParam(name: string, value: number): this {
    return this.#op({ op: "param", id: this.id, name, value });
  }
  play(): this {
    this._alive = true;
    return this.#op({ op: "play", id: this.id });
  }
  stop(): this {
    return this.#op({ op: "stop", id: this.id });
  }
  clear(): this {
    return this.#op({ op: "clear", id: this.id });
  }
  release(): void {
    this.#op({ op: "release", id: this.id });
    this._released = true;
    this.#world._forget(this.id);
  }
}

export class WorkerParticleWorld {
  readonly #render: ParticleWorld;
  readonly #port: ParticlePort;
  readonly #handles = new Map<number, WorkerParticleEffect>();
  #ops: HandleOp[] = [];
  readonly #transforms = new Map<number, Extract<HandleOp, { op: "transform" }>>();
  #nextId = 1;
  #frame = 0;
  #inFlight = false;
  #pendingDt = 0;
  #layout = 0;
  #spares: (Float32Array | null)[] = [];
  #stats: WorkerStats = { effects: 0, instances: 0, particles: 0, drawnParticles: 0, drawCalls: 0, culledInstances: 0, budgetScale: 1, rejectedSpawns: 0, lights: 0 };
  #quality: number;
  #budget: number | null;
  #mismatchWarned = false;

  constructor(port: ParticlePort, opts: WorkerParticleWorldOptions = {}) {
    this.#port = port;
    // render-only: never simulates; GPU emitters aren't available in worker mode (they need the renderer here)
    this.#render = new ParticleWorld({ ...opts, silent: false });
    this.#quality = opts.quality ?? 1;
    this.#budget = opts.budget?.maxParticles ?? null;
    port.addEventListener("message", (e) => this.#onResult(e.data));
    port.postMessage({ type: "init", options: { budget: opts.budget, quality: opts.quality, frustumCulling: opts.frustumCulling, maxDelta: opts.maxDelta } });
  }

  /** Add to the scene root. */
  get object(): THREE.Group {
    return this.#render.object;
  }

  /** Seconds, shared by every particle material (advanced by update). */
  get time() {
    return this.#render.time;
  }

  register(doc: EffectDoc): void {
    this.#render.register(doc);
    this.#layout++;
    this.#port.postMessage({ type: "register", doc });
  }

  unregister(id: string): void {
    for (const h of [...this.#handles.values()]) if (h.effectId === id) h.release();
    this.#render.unregister(id);
    this.#layout++;
    this.#port.postMessage({ type: "unregister", id });
  }

  has(id: string): boolean {
    return this.#render.has(id);
  }

  /** Mesh renderers' geometries only matter on the main thread (the worker packs per-particle data). */
  registerGeometry(name: string, geometry: THREE.BufferGeometry): void {
    this.#render.registerGeometry(name, geometry);
  }

  get quality(): number {
    return this.#quality;
  }
  set quality(q: number) {
    this.#quality = Math.max(0, Math.min(1, q));
    this.#port.postMessage({ type: "settings", quality: this.#quality });
  }

  get budget(): number | null {
    return this.#budget;
  }
  set budget(n: number | null) {
    this.#budget = n && n > 0 ? n : null;
    this.#port.postMessage({ type: "settings", budget: this.#budget });
  }

  spawn(effect: string | EffectDoc, opts: { position?: XYZ; rotation?: XYZW; scale?: number; params?: Record<string, number>; autoRelease?: boolean; paused?: boolean; seed?: number } = {}): WorkerParticleEffect {
    const id = typeof effect === "string" ? effect : effect.id;
    if (typeof effect !== "string" && !this.has(id)) this.register(effect);
    if (!this.has(id)) throw new Error(`Particle effect "${id}" is not registered`);
    const hid = this.#nextId++;
    const h = new WorkerParticleEffect(this, hid, id, opts.autoRelease ?? true);
    const o: SpawnOpts = {
      position: opts.position ? [opts.position.x, opts.position.y, opts.position.z] : undefined,
      rotation: opts.rotation ? [opts.rotation.x, opts.rotation.y, opts.rotation.z, opts.rotation.w] : undefined,
      scale: opts.scale,
      params: opts.params,
      autoRelease: opts.autoRelease,
      paused: opts.paused,
      seed: opts.seed,
    };
    this.#ops.push({ op: "spawn", id: hid, effect: id, opts: o });
    this.#handles.set(hid, h);
    return h;
  }

  /** @internal */ _enqueue(op: HandleOp): void {
    // keep transform/op order: a pending transform must apply before later ops on the same handle
    const t = this.#transforms.get(op.id);
    if (t) {
      this.#ops.push(t);
      this.#transforms.delete(op.id);
    }
    this.#ops.push(op);
  }

  /** @internal coalesced: only the last transform per frame is sent */
  _transform(id: number, p: XYZ, q?: XYZW, s?: number): void {
    this.#transforms.set(id, { op: "transform", id, p: [p.x, p.y, p.z], q: q ? [q.x, q.y, q.z, q.w] : undefined, s });
  }

  /** @internal */ _forget(id: number): void {
    this.#handles.delete(id);
    this.#transforms.delete(id);
  }

  /**
   * Sends this frame to the worker (unless the previous one is still in
   * flight, in which case dt accumulates). Pass the camera for sorting, sort
   * groups, frustum culling and distance LOD.
   */
  update(dt: number, camera?: THREE.Camera): void {
    this.#render.time.value += dt;
    this.#pendingDt += dt;
    if (this.#inFlight) return;
    let cam: CameraState | null = null;
    if (camera) {
      camera.updateMatrixWorld();
      cam = {
        matrixWorld: camera.matrixWorld.toArray(),
        projection: camera.projectionMatrix.toArray(),
        coordinateSystem: camera.coordinateSystem,
        reversedDepth: (camera as unknown as { reversedDepth?: boolean }).reversedDepth ?? false,
      };
    }
    const ops = this.#ops;
    for (const t of this.#transforms.values()) ops.push(t);
    this.#transforms.clear();
    this.#ops = [];
    const spares = this.#spares;
    this.#spares = [];
    const transfer: Transferable[] = [];
    for (const s of spares) if (s) transfer.push(s.buffer);
    this.#port.postMessage({ type: "frame", frame: ++this.#frame, dt: this.#pendingDt, camera: cam, ops, spares }, transfer);
    this.#pendingDt = 0;
    this.#inFlight = true;
  }

  #applyMs = 0;

  /** Main-thread milliseconds spent applying the last worker result (adopting arrays, handle states). */
  get lastApplyMs(): number {
    return this.#applyMs;
  }

  #onResult(r: FromWorker): void {
    const t0 = performance.now();
    this.#inFlight = false;
    if (r.layout === this.#layout) {
      const batches = this.#render._batchList();
      if (batches.length !== r.batches.length && !this.#mismatchWarned) {
        this.#mismatchWarned = true;
        console.warn(`tsl-particles: worker batch list (${r.batches.length}) doesn't match the main thread's (${batches.length}); were the same effects registered in the same order?`);
      }
      const spares: (Float32Array | null)[] = [];
      for (let i = 0; i < batches.length; i++) {
        const b = batches[i];
        const res = r.batches[i];
        if (res?.data) spares[i] = b.adopt(res.data, res.count);
        else {
          b.begin();
          b.end();
          spares[i] = null;
        }
      }
      this.#spares = spares;
    }
    // (a stale layout: batches changed since this frame was computed; skip its arrays, keep its events)

    const st = r.states;
    for (let i = 0; i < st.length; i += 3) {
      const h = this.#handles.get(st[i]);
      if (!h) continue;
      h._count = st[i + 1];
      h._alive = (st[i + 2] & 1) !== 0;
      h._culled = (st[i + 2] & 2) !== 0;
    }
    for (const id of r.finished) {
      const h = this.#handles.get(id);
      if (h) {
        h._alive = false;
        h.onFinished?.();
      }
    }
    for (const id of r.released) {
      const h = this.#handles.get(id);
      if (h) {
        h._released = true;
        h._alive = false;
        this.#handles.delete(id);
      }
    }
    for (const id of r.rejected) {
      const h = this.#handles.get(id);
      if (h) {
        h._rejected = true;
        h._released = true;
        h._alive = false;
        this.#handles.delete(id);
      }
    }
    this.#stats = r.stats;
    this.#applyMs = performance.now() - t0;
  }

  get stats(): ParticleWorldStats {
    return { ...this.#stats };
  }

  /** True while a frame is being simulated in the worker. */
  get busy(): boolean {
    return this.#inFlight;
  }

  dispose(): void {
    this.#port.terminate?.();
    this.#render.dispose();
    this.#handles.clear();
  }
}
