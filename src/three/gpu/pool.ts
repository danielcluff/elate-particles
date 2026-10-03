// GPU emitters batched across effect instances. A pool holds one emitter
// template's particles for many instances: each instance owns a lane of
// `maxParticles` slots (slot = lane × laneCap + i) and a row of the pool's lane
// texture with its per-frame values. One set of kernels and one draw call per
// renderer serve every instance, so a hundred GPU effects cost what one does
// on the CPU side and in draw calls.
//
// Pools of an effect that exchange sub-emitter events live in one
// GpuPoolSet and share lane numbers, so an event targets the same lane in the
// target pool. Sets grow by doubling (copying live particles across); WGSL
// doesn't depend on the lane count, so growing rebuilds nodes but reuses
// pipelines.
//
// Per frame and pool: clear (lanes flagged by play/acquire/release) → prep
// (claims each lane's spawn range from its ring head; snapshots incoming
// events) → init (one thread per spawn across all lanes, lane found by binary
// search over the spawn prefix sums) → events (indirect) → update → sort.

import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  Return,
  abs,
  atomicAdd as tslAtomicAdd,
  atomicLoad as tslAtomicLoad,
  atomicStore,
  float,
  floatBitsToUint,
  floor,
  fract,
  instanceIndex,
  min,
  mix,
  select,
  storage,
  uint,
  uintBitsToFloat,
  uniform,
  vec3,
  vec4,
} from "three/tsl";
import type { FloatValue, RendererDoc, RibbonRendererDoc } from "../../core/types";
import { resolveParams } from "../../core/params";
import { compileFloat, type CompiledFloat } from "../../core/values";
import type { CompiledModule, EmitterTemplate, ResolvedSubEmitter } from "../../sim/compile";
import type { EffectSim } from "../../sim/effect";
import type { EmitterSim, GpuSpawnTarget } from "../../sim/emitter";
import type { SortView } from "../batch";
import { PARTICLE_ATTRIBUTES, type Node } from "../materials/common";
import { GpuBuildContext, LANE, LaneLayout, LaneValues, rotateQ, type FrameInfo, type GpuParticle } from "./context";
import { getGpuModule } from "./modules";
import { GpuSorter, type GpuKeySort } from "./sort";
import type { RibbonSource } from "../materials/ribbon";
import { GpuBounds, type LaneBounds } from "./bounds";
import { GpuLightGather, type LaneLights } from "./lights";
import { emitterRibbonSource, recordTrail, ribbonSort, trailRibbonSource, trailStride, type SegmentIndex } from "./ribbon";
import "./modules";

// (@types/three types atomics as AtomicFunctionNode, without the node operators)
const atomicLoad = (p: Node): Node => tslAtomicLoad(p) as unknown as Node;
const atomicAdd = (p: Node, v: Node): Node => tslAtomicAdd(p, v) as unknown as Node;
const uintUniform = (v: number): Node => (uniform as (v: number, t: string) => Node)(v, "uint");

/** Events a target pool holds per frame (all lanes together; fewer for small emitters). */
const MAX_EVENTS = 65536;
const WG = 64;
/**
 * Each pool has one atomic u32 buffer: 4 counters (0 events appended, 1
 * events to spawn this frame), the events (lane, slot base, position, count,
 * velocity, colour; floats stored as bits), then 2 counters per lane (ring
 * head, this frame's spawn start). Lanes come last so growing only appends.
 * One buffer per target keeps a source's kernels within WebGPU's default 8
 * storage buffers per stage.
 */
const CTRL = 4;
const EV_STRIDE = 13;
/** Binary search steps over lanes in the init kernel: up to 2^13 lanes. */
const SEARCH_STEPS = 13;
const MAX_LANES = 1 << SEARCH_STEPS;

/** Distinct sub-emitter targets one GPU emitter can feed (4 particle buffers + own counters + one per target ≤ 8). */
export const MAX_GPU_TARGETS = 3;

/** A renderer of a GPU emitter: shared material and the base geometry to instance. */
export interface GpuDraw {
  renderer: RendererDoc;
  /** Shared by every pool (sprites, meshes); unused for ribbons and sort-group members. */
  material: THREE.Material;
  base: () => THREE.BufferGeometry;
  /** Ribbons: the material reads the pool's own buffers, so each pool builds one from its endpoint source. */
  ribbon?: (source: RibbonSource) => THREE.Material;
  /** Sort-group members draw through their group (GpuSortGroup), not a mesh of the pool. */
  group?: { name: string; member: number };
}

interface PoolLink {
  trigger: "birth" | "death";
  sub: ResolvedSubEmitter;
  target: GpuPool;
}

interface Kernels {
  clear: Node;
  prep: Node;
  init: Node;
  update: Node;
  events: Node | null;
  sorter: GpuSorter | null;
}

// ---------------------------------------------------------------------------
// set
// ---------------------------------------------------------------------------

/** Pools for some of an effect's emitters (a sub-emitter-closed group), sharing lane numbers. */
/**
 * Seconds between bounds measurements per pool (≈ every 4th frame at 60 fps).
 * Readings are used a few frames late and widened for their age anyway; one
 * measurement pass over a 524k-particle pool cost ~0.35 ms of GPU time.
 */
export const GPU_BOUNDS_INTERVAL = 1 / 15;

/** Most draws one pool mesh issues for its shown lane ranges (more runs merge across the smallest hidden gaps). */
export const MAX_RANGE_DRAWS = 8;

/** A growable set halves (or more) once at most a quarter of its lanes have been in use for this long (seconds). */
export const GPU_SHRINK_AFTER = 5;

export class GpuPoolSet {
  readonly pools: GpuPool[];
  readonly growable: boolean;
  lanes: number;
  /** It never shrinks below its starting size. */
  readonly minLanes: number;
  /** Whether draws can skip lane ranges (indirect draws with firstInstance: the "indirect-first-instance" feature). */
  #rangeDraws = false;
  /** Scratch: shown runs as (first lane, lane count) pairs. */
  readonly #runs: number[] = [];
  /** World time since which occupancy has been at most a quarter (null: above). */
  #lowSince: number | null = null;
  readonly #owners: (GpuEmitter[] | null)[] = [];
  readonly #free: number[] = [];

  /**
   * @param indices template indices of the emitters in this set
   * @param draws per template index, the emitter's renderers
   * @param growable false for a single-instance set (local-space emitters: their meshes follow the instance)
   */
  constructor(templates: EmitterTemplate[], indices: number[], draws: (GpuDraw[] | null)[], parent: THREE.Object3D, lanes: number, growable: boolean) {
    this.growable = growable;
    this.lanes = lanes;
    this.minLanes = lanes;
    this.pools = indices.map((i) => new GpuPool(templates[i], draws[i] ?? [], lanes, parent));
    const byIndex: GpuPool[] = [];
    for (const p of this.pools) byIndex[p.template.index] = p;
    for (const p of this.pools) p.link(byIndex);
    for (let l = lanes - 1; l >= 0; l--) this.#free.push(l);
    this.#owners.length = lanes;
  }

  /** Lanes in use. */
  get inUse(): number {
    return this.lanes - this.#free.length;
  }

  /** Gives `sim` a lane in every pool (as GpuEmitters on its EmitterSims), or null when full and fixed-size. */
  acquire(sim: EffectSim): GpuEmitter[] | null {
    if (this.#free.length === 0) {
      if (!this.growable || this.lanes >= MAX_LANES) return null;
      this.#grow();
    }
    const lane = this.#free.pop()!;
    const list = this.pools.map((p) => {
      const em = sim.emitters[p.template.index];
      const g = new GpuEmitter(p, lane, em);
      em.gpu = g;
      p._occupy(lane, g);
      return g;
    });
    for (const g of list) g._link(list);
    this.#owners[lane] = list;
    return list;
  }

  /** Frees the lanes (their particles are cleared on the next dispatch). */
  release(list: GpuEmitter[]): void {
    const lane = list[0]?.lane;
    if (lane === undefined || this.#owners[lane] !== list) return;
    for (const g of list) {
      g.pool._vacate(lane);
      if (g.emitter.gpu === g) g.emitter.gpu = null;
    }
    this.#owners[lane] = null;
    this.#free.push(lane);
    // lowest lanes first: keeps the used span (what gets drawn and updated) short after a peak
    this.#free.sort((a, b) => b - a);
  }

  #grow(): void {
    const old = this.lanes;
    this.lanes = Math.min(MAX_LANES, old * 2);
    for (const p of this.pools) p._resize(this.lanes);
    for (let l = this.lanes - 1; l >= old; l--) this.#free.push(l);
    this.#owners.length = this.lanes;
  }

  /**
   * Shrinks after a quiet spell: at most a quarter of the lanes in use for
   * GPU_SHRINK_AFTER seconds. Live lanes above the new size are moved into
   * free lanes below it first (in every pool: lane numbers are shared). The
   * new size keeps room to double the current use before growing again, so
   * growth (when full) and shrinking (at a quarter) can't chase each other.
   */
  #maybeShrink(renderer: THREE.WebGPURenderer, now: number): void {
    if (!this.growable || this.lanes <= this.minLanes) return;
    const used = this.inUse;
    if (used * 4 > this.lanes) {
      this.#lowSince = null;
      return;
    }
    this.#lowSince ??= now;
    if (now - this.#lowSince < GPU_SHRINK_AFTER) return;
    this.#lowSince = null;
    let target = this.minLanes;
    while (target < used * 2) target *= 2;
    if (target >= this.lanes) return;
    // compaction: every live lane at or above the target into a free lane below it
    const free = this.#free.filter((l) => l < target).sort((a, b) => a - b);
    const moves: [number, number][] = [];
    for (let l = target; l < this.lanes; l++) if (this.#owners[l]) moves.push([l, free.shift()!]);
    if (moves.length) for (const p of this.pools) p._moveLanes(renderer, moves);
    for (const [a, b] of moves) {
      const list = this.#owners[a]!;
      for (const g of list) g.lane = b;
      this.#owners[b] = list;
      this.#owners[a] = null;
    }
    this.lanes = target;
    for (const p of this.pools) p._resize(target);
    this.#owners.length = target;
    this.#free.length = 0;
    for (let l = target - 1; l >= 0; l--) if (!this.#owners[l]) this.#free.push(l);
  }

  /**
   * Runs this frame's kernels for every pool (emitter order). With `cull`,
   * pools also measure their lanes' bounds for frustum culling (read back a
   * few frames later); `now` is the world time the measurement is stamped with.
   */
  dispatch(renderer: THREE.WebGPURenderer, view: SortView | null, cull = false, now = 0, lights = false): void {
    this.#rangeDraws = (renderer as { hasFeature?: (f: string) => boolean }).hasFeature?.("indirect-first-instance") ?? false;
    this.#maybeShrink(renderer, now);
    for (const p of this.pools) p._dispatch(renderer, view, cull, now, lights);
  }

  /** Shows the meshes while any lane is in use, drawing only up to the highest one; `matrix` places a single-instance (local-space) set. */
  updateMeshes(matrix: ArrayLike<number> | null): void {
    let span = 0;
    for (let l = this.lanes - 1; l >= 0; l--)
      if (this.#owners[l]) {
        span = l + 1;
        break;
      }
    for (const p of this.pools) {
      p.span = span;
      // runs of shown lanes (in use, not culled); lanes are shared, so the first pool's rows decide for all
      const runs = this.#runs;
      runs.length = 0;
      let hidden = false;
      for (let l = 0; l < span; l++) {
        const shown = !!this.#owners[l] && p.laneData[l * p.layout.width + LANE.visible] > 0;
        if (!shown) {
          hidden = true;
          continue;
        }
        const last = runs.length - 2;
        if (last >= 0 && runs[last] + runs[last + 1] === l) runs[last + 1]++;
        else runs.push(l, 1);
      }
      // a fragmented pool would issue many small draws: merge across the smallest hidden gaps
      // (lanes in a merged gap still draw nothing, they just cost vertex work again)
      while (runs.length > MAX_RANGE_DRAWS * 2) {
        let best = 0;
        let gap = Infinity;
        for (let r = 0; r + 2 < runs.length; r += 2) {
          const g = runs[r + 2] - (runs[r] + runs[r + 1]);
          if (g < gap) {
            gap = g;
            best = r;
          }
        }
        runs[best + 1] = runs[best + 2] + runs[best + 3] - runs[best];
        runs.splice(best + 2, 2);
      }
      // every used lane hidden (frustum- or distance-culled): skip the draw
      const shown = runs.length > 0;
      p.meshes.forEach((m, k) => {
        m.visible = shown;
        // sorted copies hold every live particle first, so the same count covers them
        (m.geometry as THREE.InstancedBufferGeometry).instanceCount = span * p.laneCap * p.instancesPerSlot(k);
        // culled lanes inside the span: draw only the shown runs (indirect, one record per run), so hidden
        // lanes cost no vertex work. Sorted draws stay whole: their instances are in depth order, not lane order.
        p._drawRanges(k, shown && hidden && this.#rangeDraws && !p.meshSorted(k) ? runs : null);
        if (matrix && p.template.space === "local") m.matrix.fromArray(matrix);
      });
    }
  }

  /** GPU draws issued: one per visible mesh, or one per shown run for meshes drawn in ranges. */
  get drawCalls(): number {
    let n = 0;
    for (const p of this.pools) p.meshes.forEach((m, k) => m.visible && (n += p.drawCount(k)));
    return n;
  }

  dispose(): void {
    for (const p of this.pools) p.dispose();
  }
}

// ---------------------------------------------------------------------------
// pool
// ---------------------------------------------------------------------------

/** One emitter template's GPU particles for all lanes of a set. */
export class GpuPool {
  readonly template: EmitterTemplate;
  /** Slots per lane (the emitter's maxParticles). */
  readonly laneCap: number;
  lanes: number;
  /** Lanes up to the highest one in use: what is drawn and updated. */
  span = 0;
  /** One per renderer: drawing every lane at once. */
  readonly meshes: THREE.Mesh[] = [];
  readonly layout = new LaneLayout();
  /** Lane rows (layout.width floats each), uploaded every dispatch. */
  laneData: Float32Array;
  readonly #draws: GpuDraw[];
  /** Sprite renderers drawn through sort groups (see GpuSortGroup). */
  readonly groupMembers: { name: string; member: number }[];
  /** Per mesh: the draw it renders. */
  readonly #meshDraws: GpuDraw[] = [];
  readonly #sortedDraw: boolean[];
  /** Per-particle trail rings (ribbon mode "particle"), else null. */
  #trail: THREE.StorageBufferAttribute | null = null;
  /** The lane-move kernel (compaction), built on first use for the current buffers. */
  #move: { kernel: Node; from: Node; to: Node } | null = null;
  /** Per light renderer (in the template's order of light renderers): its gather, built on first use. */
  #lightGathers: (GpuLightGather | undefined)[] = [];
  /** World time of the last bounds measurement (see GPU_BOUNDS_INTERVAL). */
  #measuredAt = -Infinity;
  /** Bounds measurement for frustum culling, created when the world first culls. */
  #bounds: GpuBounds | null = null;
  readonly #trailPoints: number;
  /** Per mesh: indirect records for drawing lane ranges (see _drawRanges). */
  readonly #indirect: ({
    attr: THREE.IndirectStorageBufferAttribute;
    lanes: number;
    geometry: THREE.BufferGeometry;
    runs: number[];
    offsets: number[];
  } | null)[] = [];
  /** Per mesh: the segment sort of a sorted ribbon, else null (rebuilt with the ribbon materials). */
  readonly #ribbonSorts: (GpuKeySort | null)[] = [];
  /** Ribbon meshes' materials are built per pool from its buffers; null = rebuild on the next dispatch. */
  #ribbonsStale = true;
  #attrs: THREE.StorageInstancedBufferAttribute[];
  #ctrl: THREE.StorageBufferAttribute | null = null;
  #laneTex: THREE.DataTexture;
  #k: Kernels | null = null;
  /** Buffers to copy live particles from after a resize (on the next dispatch). */
  #old: { attrs: THREE.StorageInstancedBufferAttribute[]; ctrl: THREE.StorageBufferAttribute | null; trail?: THREE.StorageBufferAttribute; count: number; ctrlLen: number } | null = null;
  /**
   * Replaced geometries and the particle buffers they draw. Disposing a
   * geometry destroys every buffer it uses, shared ones included, so they wait
   * until those buffers are retired too.
   */
  readonly #retired = new Map<THREE.BufferGeometry, readonly THREE.BufferAttribute[]>();
  readonly #textures: THREE.Texture[] = [];
  readonly #owners: (GpuEmitter | null)[] = [];
  #clearPending = false;
  #links: PoolLink[] = [];
  #events: { max: number; perEvent: number; args: THREE.IndirectStorageBufferAttribute } | null = null;
  readonly #seedU = uintUniform(0);
  /** This frame's spawns over all lanes (the init dispatch rounds up to whole workgroups: threads past it return). */
  readonly #totalU = uniform(0);
  #rng = 0x9e3779b9;
  /** Upper bound on lifetimes, from the template's init.lifetime (the CPU never sees GPU lifetimes). */
  readonly lifetime: CompiledFloat | null;
  readonly #emit = (list: CompiledModule[], p: GpuParticle, ctx: GpuBuildContext) => {
    for (const m of list) getGpuModule(m.def.type)!.emit(p, ctx, resolveParams(m.def.params, m.instance.params));
  };

  constructor(tpl: EmitterTemplate, draws: GpuDraw[], lanes: number, parent: THREE.Object3D) {
    this.template = tpl;
    this.laneCap = tpl.capacity;
    this.lanes = lanes;
    this.#draws = draws.filter((d) => !d.group);
    this.groupMembers = draws.flatMap((d) => (d.group ? [d.group] : []));
    this.#sortedDraw = this.#draws.map((d) => d.renderer.type !== "ribbon" && !!d.renderer.sort && d.renderer.sort !== "none");
    this.#trailPoints = tpl.trail ? Math.max(2, Math.floor(tpl.trail.points)) : 0;
    if (tpl.trail) this.#trail = this.#newTrail();
    const lt = [...tpl.initLocal, ...tpl.initSim].find((m) => m.def.type === "init.lifetime");
    this.lifetime = lt ? compileFloat(resolveParams(lt.def.params, lt.instance.params).lifetime as FloatValue, 1) : null;
    this.#attrs = this.#newAttrs();
    this.laneData = new Float32Array(this.layout.width * lanes);
    this.#laneTex = this.#newLaneTex();
    for (const d of this.#draws) {
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), d.ribbon ? new THREE.MeshBasicNodeMaterial() : d.material);
      mesh.name = `particles:gpu:${tpl.doc.name}:${d.renderer.type}`;
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = d.renderer.sortOrder ?? 0;
      mesh.visible = false;
      parent.add(mesh);
      this.meshes.push(mesh);
      this.#meshDraws.push(d);
    }
    this.#setGeometries();
    // fresh buffers are zeros, which read as live particles of age 0: start every lane dead
    for (let l = 0; l < lanes; l++) this.clearLane(l);
  }

  get capacity(): number {
    return this.lanes * this.laneCap;
  }

  /** Whether mesh `k` draws in depth/age order (a sorted copy or a sorted ribbon) rather than lane order. */
  meshSorted(k: number): boolean {
    return (this.#sortedDraw[k] && !!this.#k?.sorter) || !!this.#ribbonSorts[k];
  }

  /** GPU draws mesh `k` issues: its shown runs when drawn in ranges, else one. */
  drawCount(k: number): number {
    const g = this.meshes[k].geometry;
    return g.indirect ? (g.indirectOffset as number[]).length : 1;
  }

  /**
   * @internal Draws mesh `k` as the given runs of lanes ((first, count)
   * pairs) with one indexed/non-indexed indirect record each, or whole
   * (null). Records are rewritten only when the runs change.
   */
  _drawRanges(k: number, runs: readonly number[] | null): void {
    const g = this.meshes[k].geometry as THREE.InstancedBufferGeometry;
    if (!runs) {
      if (g.indirect) g.setIndirect(null as unknown as THREE.IndirectStorageBufferAttribute, 0);
      return;
    }
    const per = this.laneCap * this.instancesPerSlot(k);
    const indexed = !!g.index;
    const stride = indexed ? 5 : 4;
    const count = indexed ? g.index!.count : g.getAttribute("position").count;
    let d = this.#indirect[k];
    if (!d || d.lanes !== this.lanes || d.geometry !== g) {
      // one record per possible run (at most every other lane)
      const attr = new THREE.IndirectStorageBufferAttribute(new Uint32Array(Math.ceil(this.lanes / 2) * stride), 1);
      d = this.#indirect[k] = { attr, lanes: this.lanes, geometry: g, runs: [], offsets: [] };
    }
    const same = d.runs.length === runs.length && d.runs.every((v, i) => v === runs[i]);
    if (!same) {
      const a = d.attr.array as Uint32Array;
      d.offsets = [];
      for (let r = 0; r < runs.length; r += 2) {
        const o = (r / 2) * stride;
        a[o] = count; // index (or vertex) count
        a[o + 1] = runs[r + 1] * per; // instances
        a[o + 2] = 0; // first index (or vertex)
        if (indexed) {
          a[o + 3] = 0; // base vertex
          a[o + 4] = runs[r] * per; // first instance
        } else a[o + 3] = runs[r] * per;
        d.offsets.push(o * 4);
      }
      d.runs = runs.slice();
      d.attr.needsUpdate = true;
    }
    if (g.indirect !== d.attr || g.indirectOffset !== d.offsets) g.setIndirect(d.attr, d.offsets);
  }

  /** Mesh `k`'s segment sort when it is a sorted ribbon (built on the first dispatch). */
  ribbonSort(k: number): GpuKeySort | null {
    return this.#ribbonSorts[k] ?? null;
  }

  /** The sorter, once kernels are built (null when no renderer sorts). */
  get sorter(): GpuSorter | null {
    return this.#k?.sorter ?? null;
  }

  /** The particle buffers (pA..pD) this pool's unsorted renderers draw. */
  get attributes(): readonly THREE.StorageInstancedBufferAttribute[] {
    return this.#attrs;
  }

  #newTrail(): THREE.StorageBufferAttribute {
    return new THREE.StorageBufferAttribute(this.capacity * trailStride(this.#trailPoints), 4);
  }

  /** Instances drawn per particle slot by mesh `k`: a trail ribbon has one per history point. */
  instancesPerSlot(k: number): number {
    const r = this.#meshDraws[k].renderer;
    return r.type === "ribbon" && r.mode === "particle" ? this.#trailPoints : 1;
  }

  /** The world space of this pool's lane-local values (for sort groups gathering local-space pools). */
  laneValues(lane: Node): LaneValues {
    return new LaneValues(this.#laneTex, lane, this.#seedU);
  }

  #newAttrs(): THREE.StorageInstancedBufferAttribute[] {
    return [0, 1, 2, 3].map(() => new THREE.StorageInstancedBufferAttribute(this.capacity, 4));
  }

  #newLaneTex(): THREE.DataTexture {
    const t = new THREE.DataTexture(this.laneData, this.layout.width / 4, this.lanes, THREE.RGBAFormat, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.needsUpdate = true;
    return t;
  }

  /** Instanced geometry per renderer over the current buffers (sorted renderers get theirs when the sorter exists). */
  #setGeometries(): void {
    this.#ribbonsStale = true;
    this.meshes.forEach((mesh, k) => {
      if (this.#meshDraws[k].ribbon) {
        // ribbons instance a plain quad and read particles from storage: the geometry never changes
        if (!mesh.geometry.getAttribute("position")) {
          const g = new THREE.InstancedBufferGeometry().copy(this.#meshDraws[k].base() as THREE.InstancedBufferGeometry);
          mesh.geometry.dispose();
          mesh.geometry = g;
        }
        return;
      }
      const attrs = this.#sortedDraw[k] && this.#k?.sorter ? this.#k.sorter.attrs : this.#attrs;
      const prev = mesh.geometry;
      if (prev.getAttribute(PARTICLE_ATTRIBUTES.a) === attrs[0]) return;
      const base = this.#meshDraws[k].base();
      const g = new THREE.InstancedBufferGeometry().copy(base as THREE.InstancedBufferGeometry);
      base.dispose();
      Object.values(PARTICLE_ATTRIBUTES).forEach((name, i) => g.setAttribute(name, attrs[i]));
      g.instanceCount = this.capacity;
      mesh.geometry = g;
      const used = prev.getAttribute(PARTICLE_ATTRIBUTES.a);
      if (used) this.#retired.set(prev, [used as THREE.BufferAttribute]);
      else prev.dispose();
    });
    this.#purge();
  }

  /** Disposes replaced geometries whose particle buffers no current geometry or pending copy uses. */
  #purge(): void {
    const live = new Set<unknown>([this.#attrs[0], this.#k?.sorter?.attrs[0], this.#old?.attrs[0]]);
    for (const [g, attrs] of this.#retired)
      if (!attrs.some((a) => live.has(a))) {
        g.dispose();
        this.#retired.delete(g);
      }
  }

  // ---- lanes -------------------------------------------------------------------

  /** @internal */ _occupy(lane: number, g: GpuEmitter): void {
    this.#owners[lane] = g;
    this.clearLane(lane);
  }

  /** @internal */ _vacate(lane: number): void {
    this.#owners[lane] = null;
    this.clearLane(lane);
    const o = lane * this.layout.width;
    this.laneData[o + LANE.dt] = 0;
    this.laneData[o + LANE.spawnCount] = 0;
  }

  /** Kills every particle of `lane` (and resets its ring) on the next dispatch. */
  clearLane(lane: number): void {
    this.laneData[lane * this.layout.width + LANE.clear] = 1;
    this.#clearPending = true;
  }

  /** @internal set-wide growth: new buffers sized for `lanes`, live particles copied on the next dispatch */
  _resize(lanes: number): void {
    const oldCount = this.capacity;
    const oldCtrlLen = this.#ctrlLen();
    // a second resize before a dispatch: the first copy source is still the one with live particles
    if (!this.#old) this.#old = { attrs: this.#attrs, ctrl: this.#ctrl, count: oldCount, ctrlLen: oldCtrlLen };
    this.lanes = lanes;
    this.#attrs = this.#newAttrs();
    this.#ctrl = null;
    if (this.#trail) {
      this.#old.trail ??= this.#trail;
      this.#trail = this.#newTrail();
    }
    const data = new Float32Array(this.layout.width * lanes);
    data.set(this.laneData.subarray(0, data.length));
    this.laneData = data;
    this.#owners.length = Math.min(this.#owners.length, lanes);
    this.#laneTex.dispose();
    this.#laneTex = this.#newLaneTex();
    this.#disposeKernels();
    this.#bounds?.dispose();
    this.#bounds = null;
    for (const g of this.#lightGathers) g?.dispose();
    this.#lightGathers = [];
    this.#setGeometries();
    for (let l = oldCount / this.laneCap; l < lanes; l++) this.clearLane(l);
  }

  /**
   * @internal Compaction before a shrink: moves lanes' particles, ring
   * counters and trails (GPU) and rows and owners (CPU) from each `from` to
   * its `to` (a free lane). Runs on the current buffers, before _resize.
   */
  _moveLanes(renderer: THREE.WebGPURenderer, moves: [number, number][]): void {
    const L = this.laneCap;
    const W = this.layout.width;
    const cap = this.capacity;
    const lanesAt = this.#lanesAt();
    this.#move ??= (() => {
      const from = uintUniform(0);
      const to = uintUniform(0);
      const bufs = this.#attrs.map((a) => storage(a, "vec4", cap));
      const stride = trailStride(this.#trailPoints);
      const T = this.#trail ? storage(this.#trail, "vec4", cap * stride) : null;
      const kernel = Fn(() => {
        const j = instanceIndex;
        const src: Node = from.mul(L).add(j).toVar();
        const dst: Node = to.mul(L).add(j).toVar();
        for (const B of bufs) B.element(dst).assign(B.element(src));
        if (T) for (let k = 0; k < stride; k++) T.element(dst.mul(stride).add(k)).assign(T.element(src.mul(stride).add(k)));
        If(j.equal(0), () => {
          const ctrl = this.#ctrlNode();
          for (let k = 0; k < 2; k++) atomicStore(ctrl.element(to.mul(2).add(lanesAt + k)), atomicLoad(ctrl.element(from.mul(2).add(lanesAt + k))));
        });
      })().compute(L);
      return { kernel, from, to };
    })();
    const m = this.#move;
    for (const [a, b] of moves) {
      // one dispatch per move: the uniforms change between them (each compute() call is its own submit)
      m.from.value = a;
      m.to.value = b;
      renderer.compute(m.kernel);
      this.laneData.copyWithin(b * W, a * W, a * W + W);
      this.laneData[a * W + LANE.clear] = 0;
      this.#owners[b] = this.#owners[a];
      this.#owners[a] = null;
    }
  }

  // ---- sub-emitters ------------------------------------------------------------

  /** @internal resolves this pool's sub-emitter bindings to the set's other pools */
  link(byIndex: (GpuPool | undefined)[]): void {
    for (const trigger of ["birth", "death"] as const) {
      for (const sub of this.template[trigger]) {
        const target = byIndex[sub.target];
        if (!target) continue;
        this.#links.push({ trigger, sub, target });
        target.#acceptEvents(Math.max(1, sub.count));
      }
    }
  }

  #acceptEvents(perEvent: number): void {
    this.#events ??= {
      max: Math.min(MAX_EVENTS, Math.max(1024, this.laneCap)),
      args: new THREE.IndirectStorageBufferAttribute(new Uint32Array([0, 1, 1]), 1),
      perEvent: 1,
    };
    this.#events.perEvent = Math.max(this.#events.perEvent, perEvent);
  }

  #lanesAt(): number {
    return CTRL + (this.#events ? this.#events.max * EV_STRIDE : 0);
  }

  #ctrlLen(): number {
    return this.#lanesAt() + this.lanes * 2;
  }

  /** An atomic view of the counters and events (one node per kernel that uses it). */
  #ctrlNode(): Node {
    return storage(this.#ctrlBuffer(), "uint", this.#ctrlLen()).toAtomic();
  }

  /** TSL: send `trigger` events for particle `p` of `lane` to every linked target (same lane there). */
  #emitEvents(trigger: "birth" | "death", p: GpuParticle, ctx: GpuBuildContext, lane: Node): void {
    const links = this.#links.filter((l) => l.trigger === trigger);
    if (!links.length) return;
    const u = ctx.u;
    // events travel in world space
    let pos: Node = p.pos;
    let vel: Node = p.vel;
    if (this.template.space === "local") {
      pos = rotateQ(u.rotation, p.pos.mul(u.scale)).add(u.position);
      vel = rotateQ(u.rotation, p.vel.mul(u.scale));
    }
    links.forEach((l, k) => {
      const t = l.target;
      const ev = t.#events!;
      const ctrl = t.#ctrlNode();
      const tv = new LaneValues(t.#laneTex, lane, t.#seedU);
      // count × the target lane's LOD/budget scale, stochastically rounded, capped at the target's per-event width
      const want: Node = float(l.sub.count).mul(tv.eventScale);
      const extra: Node = select(ctx.rand(9001 + k * 2).lessThan(fract(want)), float(1), float(0));
      const cnt: Node = min(floor(want).add(extra), float(ev.perEvent)).toVar();
      let go: Node = cnt.greaterThan(0);
      if (l.sub.probability < 1) go = go.and(ctx.rand(9002 + k * 2).lessThan(l.sub.probability));
      If(go, () => {
        const e: Node = atomicAdd(ctrl.element(0), uint(1)).toVar();
        If(e.lessThan(uint(ev.max)), () => {
          const o: Node = e.mul(EV_STRIDE).add(CTRL).toVar();
          const put = (i: number, v: Node) => atomicStore(ctrl.element(o.add(i)), floatBitsToUint(v));
          const headIdx: Node = lane.mul(2).add(t.#lanesAt());
          atomicStore(ctrl.element(o), lane);
          atomicStore(ctrl.element(o.add(1)), atomicAdd(ctrl.element(headIdx), cnt.toUint()));
          const v: Node = vel.mul(l.sub.inheritVelocity).toVar();
          [pos.x, pos.y, pos.z, cnt, v.x, v.y, v.z].forEach((x, i) => put(i + 2, x));
          if (l.sub.inheritColor) [p.color.x, p.color.y, p.color.z, p.color.w].forEach((x, i) => put(i + 9, x));
          else for (let i = 9; i < 13; i++) put(i, float(1));
        });
      });
    });
  }

  // ---- kernels -------------------------------------------------------------------

  #newParticle(ctx: GpuBuildContext): GpuParticle {
    return {
      pos: vec3(0).toVar(),
      vel: vec3(0).toVar(),
      age01: float(0).toVar(),
      life: float(1).toVar(),
      size: float(1).toVar(),
      rot: float(0).toVar(),
      spin: float(0).toVar(),
      seed: ctx.rand(0).toVar(),
      color: vec4(1).toVar(),
    };
  }

  /** Stores `p` at `slot` through the kernel's buffer nodes (a second node per buffer would bind it twice: aliasing). */
  #write(bufs: Node[], slot: Node, p: GpuParticle, sizeSign: Node | null = null): void {
    const [A, B, C, D] = bufs;
    A.element(slot).assign(vec4(p.pos, p.age01));
    B.element(slot).assign(vec4(p.vel, p.seed));
    C.element(slot).assign(vec4(sizeSign ? p.size.mul(sizeSign) : p.size, p.rot, p.life, p.spin));
    D.element(slot).assign(p.color);
  }

  #build(): Kernels {
    const tpl = this.template;
    const L = this.laneCap;
    const cap = this.capacity;
    const layout = this.layout;
    const lanesAt = this.#lanesAt();
    const lv = (lane: Node) => new LaneValues(this.#laneTex, lane, this.#seedU);
    const bufs = this.#attrs.map((a) => storage(a, "vec4", cap));
    const [A, B, C, D] = bufs;
    const laneCount = uintUniform(this.lanes);

    const clear = Fn(() => {
      const i = instanceIndex;
      const lane: Node = i.div(uint(L)).toVar();
      If(lv(lane).read(LANE.clear).greaterThan(0.5), () => {
        A.element(i).assign(vec4(0, 0, 0, 2));
        C.element(i).assign(vec4(0));
        If(i.mod(uint(L)).equal(0), () => {
          const ctrl = this.#ctrlNode();
          atomicStore(ctrl.element(lane.mul(2).add(lanesAt)), uint(0));
          atomicStore(ctrl.element(lane.mul(2).add(lanesAt + 1)), uint(0));
        });
      });
    })().compute(cap);

    const prep = Fn(() => {
      const lane = instanceIndex;
      const ctrl = this.#ctrlNode();
      // claim this frame's CPU-driven spawns from the lane's ring head (kept below laneCap so it never wraps)
      const h: Node = ctrl.element(lane.mul(2).add(lanesAt));
      const head: Node = atomicLoad(h).mod(uint(L)).toVar();
      atomicStore(ctrl.element(lane.mul(2).add(lanesAt + 1)), head);
      atomicStore(h, head.add(lv(lane).spawnCount.toUint()));
      const ev = this.#events;
      if (ev)
        If(lane.equal(0), () => {
          const n: Node = atomicLoad(ctrl.element(0)).min(uint(ev.max)).toVar();
          atomicStore(ctrl.element(1), n);
          atomicStore(ctrl.element(0), uint(0));
          storage(ev.args, "uint", 3).element(0).assign(n.mul(ev.perEvent).add(WG - 1).div(WG));
        });
    })().compute(this.lanes);

    const init = Fn(() => {
      const i = instanceIndex;
      const fi: Node = float(i);
      If(fi.greaterThanEqual(this.#totalU), () => {
        Return();
      });
      // the lane whose spawn range holds i: the last lane with prefix ≤ i (free and idle lanes have empty ranges)
      const lo: Node = uint(0).toVar();
      const hi: Node = laneCount.sub(1).toVar();
      for (let s = 0; s < SEARCH_STEPS; s++) {
        If(lo.lessThan(hi), () => {
          const mid: Node = lo.add(hi).add(1).div(2).toVar();
          If(lv(mid).spawnPrefix.lessThanEqual(fi), () => {
            lo.assign(mid);
          }).Else(() => {
            hi.assign(mid.sub(1));
          });
        });
      }
      const lane: Node = lo;
      const u = lv(lane);
      const ctx = new GpuBuildContext("init", tpl.space, u, layout, this.#textures);
      const k: Node = fi.sub(u.spawnPrefix).toVar();
      const start: Node = atomicLoad(this.#ctrlNode().element(lane.mul(2).add(lanesAt + 1)));
      const slot: Node = lane.mul(L).add(start.add(k.toUint()).mod(uint(L)));
      const p = this.#newParticle(ctx);
      this.#emit(tpl.initLocal, p, ctx);
      if (tpl.space === "world") {
        // local → world, spreading births along the path travelled this frame
        const origin: Node = mix(u.prevPosition, u.position, k.add(1).div(u.spawnCount));
        p.pos.assign(rotateQ(u.rotation, p.pos.mul(u.scale)).add(origin));
        p.vel.assign(rotateQ(u.rotation, p.vel.mul(u.scale)));
        p.size.mulAssign(u.scale);
      }
      this.#emit(tpl.initSim, p, ctx);
      this.#write(bufs, slot, p);
      this.#emitEvents("birth", p, ctx, lane);
    })().compute(cap);

    let events: Node | null = null;
    const ev = this.#events;
    if (ev) {
      events = Fn(() => {
        const per = uint(ev.perEvent);
        const e: Node = instanceIndex.div(per);
        const j: Node = instanceIndex.mod(per);
        const ctrl = this.#ctrlNode();
        If(e.greaterThanEqual(atomicLoad(ctrl.element(1))), () => {
          Return();
        });
        const o: Node = e.mul(EV_STRIDE).add(CTRL).toVar();
        const get = (k: number): Node => uintBitsToFloat(atomicLoad(ctrl.element(o.add(k))));
        If(j.toFloat().greaterThanEqual(get(5)), () => {
          Return();
        });
        const lane: Node = atomicLoad(ctrl.element(o)).toVar();
        // events for a lane compaction moved away (from beyond the shrunk pool): dropped
        If(lane.greaterThanEqual(laneCount), () => {
          Return();
        });
        const slot: Node = lane.mul(L).add(atomicLoad(ctrl.element(o.add(1))).add(j).mod(uint(L)));
        const e0: Node = vec3(get(2), get(3), get(4)).toVar();
        const e1: Node = vec3(get(6), get(7), get(8)).toVar();
        const e2: Node = vec4(get(9), get(10), get(11), get(12)).toVar();
        const u = lv(lane);
        const ctx = new GpuBuildContext("init", tpl.space, u, layout, this.#textures, 1);
        const p = this.#newParticle(ctx);
        this.#emit(tpl.initLocal, p, ctx);
        // event position/velocity arrive in world space (as on the CPU)
        if (tpl.space === "world") {
          p.pos.assign(rotateQ(u.rotation, p.pos.mul(u.scale)).add(e0));
          p.vel.assign(rotateQ(u.rotation, p.vel.mul(u.scale)).add(e1));
          p.size.mulAssign(u.scale);
        } else {
          p.pos.addAssign(rotateQ(u.inverseRotation, e0.sub(u.position)).div(u.scale));
          p.vel.addAssign(rotateQ(u.inverseRotation, e1).div(u.scale));
        }
        p.color.mulAssign(e2);
        this.#emit(tpl.initSim, p, ctx);
        this.#write(bufs, slot, p);
        this.#emitEvents("birth", p, ctx, lane);
      })().compute(ev.max * ev.perEvent);
    }

    const update = Fn(() => {
      const i = instanceIndex;
      const a: Node = A.element(i).toVar();
      If(a.w.greaterThanEqual(1), () => {
        Return();
      });
      const lane: Node = i.div(uint(L)).toVar();
      const u = lv(lane);
      const c: Node = C.element(i).toVar();
      const wasNew: Node = a.w.equal(0);
      // hidden lanes (distance-culled instances) store a negative size, which materials draw as nothing
      const sign: Node = select(u.visible.greaterThan(0.5), float(1), float(-1));
      If(u.dt.equal(0), () => {
        C.element(i).assign(vec4(abs(c.x).mul(sign), c.yzw));
        Return();
      });
      const b: Node = B.element(i);
      const ctx = new GpuBuildContext("update", tpl.space, u, layout, this.#textures);
      const p: GpuParticle = {
        pos: a.xyz.toVar(),
        vel: b.xyz.toVar(),
        age01: a.w.toVar(),
        life: c.z,
        size: abs(c.x).toVar(),
        rot: c.y.toVar(),
        spin: c.w,
        seed: b.w,
        color: D.element(i).toVar(),
      };
      ctx.bindSeed(p.seed);
      ctx.bindAge(p.age01);
      this.#emit(tpl.update, p, ctx);
      p.pos.addAssign(p.vel.mul(u.dt));
      p.rot.addAssign(p.spin.mul(u.dt));
      p.age01.addAssign(u.dt.div(p.life));
      // dead (this frame; dead slots returned above): send death events, collapse the instance so it draws nothing
      If(p.age01.greaterThanEqual(1), () => {
        this.#emitEvents("death", p, ctx, lane);
        p.size.assign(0);
      });
      const trail = this.#trail;
      if (trail && tpl.trail) {
        const T = storage(trail, "vec4", cap * trailStride(this.#trailPoints));
        If(p.age01.lessThan(1), () => recordTrail(T, i, this.#trailPoints, tpl.trail!, p.pos, wasNew, u.time));
      }
      this.#write(bufs, i, p, sign);
    })().compute(cap);

    // (sort-group members sort in their group; ribbons don't sort on the GPU)
    const sortMode = this.#draws.find((d) => d.renderer.type !== "ribbon" && d.renderer.sort && d.renderer.sort !== "none")?.renderer.sort;
    const local = tpl.space === "local";
    const sorter =
      sortMode && sortMode !== "none"
        ? new GpuSorter(sortMode, cap, this.#attrs, (pos, slot) => {
            if (!local) return pos;
            const u = lv(slot.div(uint(L)));
            return rotateQ(u.rotation, pos.mul(u.scale)).add(u.position);
          })
        : null;
    return { clear, prep, init, update, events, sorter };
  }

  /** Builds (or rebuilds) the kernels, compiling them with empty dispatches so module lane slots exist before data is written. */
  #ensureKernels(renderer: THREE.WebGPURenderer): Kernels {
    for (;;) {
      if (!this.#k) {
        this.#k = this.#build();
        if (this.#k.sorter) this.#setGeometries();
        const k = this.#k;
        renderer.compute([k.clear, k.prep, k.init, k.update, ...(k.events ? [k.events] : [])], 0);
      }
      if (this.layout.used <= this.layout.width) return this.#k;
      // module values need wider lane rows: re-lay the rows and rebuild
      const w = this.layout.width;
      let nw = w;
      while (nw < this.layout.used) nw *= 2;
      const data = new Float32Array(nw * this.lanes);
      for (let l = 0; l < this.lanes; l++) data.set(this.laneData.subarray(l * w, l * w + w), l * nw);
      this.layout.width = nw;
      this.laneData = data;
      this.#laneTex.dispose();
      this.#laneTex = this.#newLaneTex();
      this.#disposeKernels();
    }
  }

  #copyOld(renderer: THREE.WebGPURenderer): void {
    const old = this.#old!;
    this.#old = null;
    // growing copies everything; shrinking only the lanes that remain (compaction moved live ones down first)
    const n = Math.min(old.count, this.capacity);
    const copy = Fn(() => {
      const i = instanceIndex;
      for (let c = 0; c < 4; c++) storage(this.#attrs[c], "vec4", this.capacity).element(i).assign(storage(old.attrs[c], "vec4", old.count).element(i));
    })().compute(n);
    const kernels = [copy];
    if (old.ctrl) {
      const srcLen = old.ctrlLen;
      const len = Math.min(srcLen, this.#ctrlLen());
      const src = old.ctrl;
      kernels.push(
        Fn(() => {
          const i = instanceIndex;
          storage(this.#ctrlBuffer(), "uint", this.#ctrlLen()).element(i).assign(storage(src, "uint", srcLen).element(i));
        })().compute(len),
      );
    }
    if (old.trail && this.#trail) {
      const srcLen = old.count * trailStride(this.#trailPoints);
      const len = n * trailStride(this.#trailPoints);
      const src = old.trail;
      const dst = this.#trail;
      const cap = this.capacity * trailStride(this.#trailPoints);
      kernels.push(
        Fn(() => {
          storage(dst, "vec4", cap).element(instanceIndex).assign(storage(src, "vec4", srcLen).element(instanceIndex));
        })().compute(len),
      );
    }
    renderer.compute(kernels);
    for (const k of kernels) k.dispose?.();
    this.#purge();
  }

  #ctrlBuffer(): THREE.StorageBufferAttribute {
    this.#ctrl ??= new THREE.StorageBufferAttribute(new Uint32Array(this.#ctrlLen()), 1);
    return this.#ctrl;
  }

  /** @internal Writes lane rows and runs this frame's kernels. */
  _dispatch(renderer: THREE.WebGPURenderer, view: SortView | null, cull = false, now = 0, lights = false): void {
    const owners = this.#owners;
    let any = this.#clearPending;
    for (let l = 0; l < this.lanes && !any; l++) any = owners[l] !== null && owners[l] !== undefined;
    if (!any) return;
    const k = this.#ensureKernels(renderer);
    if (this.#old) this.#copyOld(renderer);
    if (this.#ribbonsStale) this.#buildRibbons();

    // module values per lane, spawn prefix sums
    const W = this.layout.width;
    const data = this.laneData;
    const slots = this.layout.slots;
    let total = 0;
    for (let l = 0; l < this.lanes; l++) {
      const o = l * W;
      const g = owners[l];
      if (g) {
        const st = g.frameInfo;
        for (let s = 0; s < slots.length; s++) slots[s].write(st, data, o + slots[s].offset);
      }
      data[o + LANE.spawnPrefix] = total;
      total += data[o + LANE.spawnCount];
    }
    this.#laneTex.needsUpdate = true;
    this.#rng = (Math.imul(this.#rng ^ (this.#rng >>> 15), 2246822519) + 0x632be59b) >>> 0;
    this.#seedU.value = this.#rng;

    if (this.#clearPending) renderer.compute(k.clear);
    renderer.compute(k.prep);
    this.#totalU.value = total;
    if (total > 0) renderer.compute(k.init, total);
    if (k.events && this.#events) renderer.compute(k.events, this.#events.args);
    // lanes above the span hold nothing live (released lanes were cleared above)
    let span = 0;
    for (let l = this.lanes - 1; l >= 0; l--)
      if (owners[l]) {
        span = l + 1;
        break;
      }
    if (span > 0) renderer.compute(k.update, span * this.laneCap);
    k.sorter?.run(renderer, view);
    if (span > 0) this.#sortRibbons(renderer, view);
    if (cull && span > 0) this.#measure(renderer, span, now);
    if (lights && span > 0) this.#gatherLights(renderer, span, now);

    if (this.#clearPending) {
      for (let l = 0; l < this.lanes; l++) data[l * W + LANE.clear] = 0;
      this.#clearPending = false;
    }
  }

  /**
   * Light candidates for each light renderer (see GpuLightGather), read back
   * asynchronously to the lanes' current owners. Each gather starts again as
   * soon as its last reading lands: lights want fresh positions.
   */
  #gatherLights(renderer: THREE.WebGPURenderer, span: number, now: number): void {
    const docs = this.template.renderers.filter((r) => r.type === "light");
    docs.forEach((r, idx) => {
      if (r.type !== "light" || !(r.ratio > 0) || !(r.maxLights > 0)) return;
      const g = (this.#lightGathers[idx] ??= new GpuLightGather(
        { attrs: this.#attrs, capacity: this.capacity, laneCap: this.laneCap, lanes: this.lanes, local: this.template.space === "local", lane: (l) => this.laneValues(l) },
        Math.min(1, r.ratio),
        Math.floor(r.maxLights),
      ));
      if (g.busy) return;
      const owners = this.#owners.slice(0, span);
      g.run(renderer, span, this.laneCap, (lanes: LaneLights[]) => {
        if (this.#lightGathers[idx] !== g) return;
        lanes.forEach((ll, l) => {
          const o = owners[l];
          if (o && this.#owners[l] === o) o._setLights(idx, ll, now);
        });
      });
    });
  }

  /** Starts a bounds measurement unless one is still being read back; results go to the lanes' current owners. */
  #measure(renderer: THREE.WebGPURenderer, span: number, now: number): void {
    this.#bounds ??= new GpuBounds({
      attrs: this.#attrs,
      capacity: this.capacity,
      laneCap: this.laneCap,
      lanes: this.lanes,
      local: this.template.space === "local",
      lane: (l) => this.laneValues(l),
    });
    const b = this.#bounds;
    if (b.busy || now - this.#measuredAt < GPU_BOUNDS_INTERVAL) return;
    this.#measuredAt = now;
    // who owned each lane, and where its instance was, when measured (lanes can change hands before the read lands)
    const W = this.layout.width;
    const owners = this.#owners.slice(0, span);
    const at = owners.map((_, l) => [this.laneData[l * W + LANE.position], this.laneData[l * W + LANE.position + 1], this.laneData[l * W + LANE.position + 2]]);
    b.run(renderer, span, (lanes: LaneBounds[]) => {
      if (this.#bounds !== b) return;
      lanes.forEach((lb, l) => {
        const g = owners[l];
        if (g && this.#owners[l] === g) g._setBounds(lb, now, at[l]);
      });
    });
  }

  /** (Re)builds ribbon materials over the current buffers. */
  #buildRibbons(): void {
    this.#ribbonsStale = false;
    const buffers = { attrs: this.#attrs, capacity: this.capacity, laneCap: this.laneCap, lane: (l: Node) => this.laneValues(l), local: this.template.space === "local" };
    this.meshes.forEach((mesh, k) => {
      const d = this.#meshDraws[k];
      if (!d.ribbon) return;
      const r = d.renderer as RibbonRendererDoc;
      const trail = r.mode === "particle" ? this.#trail : null;
      const sourceFor = (seg?: SegmentIndex) =>
        trail
          ? trailRibbonSource(buffers, trail, this.#trailPoints, r, seg)
          : emitterRibbonSource(buffers, () => this.#ctrlBuffer(), this.#ctrlLen(), this.#lanesAt(), r, seg);
      this.#ribbonSorts[k]?.dispose();
      this.#ribbonSorts[k] = null;
      let source = sourceFor();
      if (r.sort && r.sort !== "none") {
        // segments drawn through a GPU-sorted order buffer
        const sorted = ribbonSort(sourceFor, this.capacity * (trail ? this.#trailPoints : 1), r, buffers);
        this.#ribbonSorts[k] = sorted.sort;
        source = sorted.source;
      }
      const old = mesh.material as THREE.Material;
      mesh.material = d.ribbon(source);
      old.dispose();
    });
  }

  /** Sorts the sorted ribbons' segments (distance needs the camera; without it the last order stands). */
  #sortRibbons(renderer: THREE.WebGPURenderer, view: SortView | null): void {
    this.#ribbonSorts.forEach((sort, k) => {
      if (!sort) return;
      const r = this.#meshDraws[k].renderer;
      if (r.sort === "distance") {
        if (!view) return;
        sort.setView(view);
      }
      renderer.compute(sort.kernels);
    });
  }

  #disposeKernels(): void {
    this.#move?.kernel.dispose?.();
    this.#move = null;
    const k = this.#k;
    if (!k) return;
    for (const n of [k.clear, k.prep, k.init, k.update, k.events]) n?.dispose?.();
    k.sorter?.dispose();
    this.#k = null;
  }

  dispose(): void {
    this.#disposeKernels();
    for (const s of this.#ribbonSorts) s?.dispose();
    for (const g of this.#lightGathers) g?.dispose();
    this.#bounds?.dispose();
    this.#bounds = null;
    this.meshes.forEach((m, k) => {
      m.removeFromParent();
      m.geometry.dispose();
      if (this.#meshDraws[k].ribbon) (m.material as THREE.Material).dispose();
    });
    for (const g of this.#retired.keys()) g.dispose();
    this.#retired.clear();
    this.#laneTex.dispose();
    for (const t of this.#textures) t.dispose();
  }
}

// ---------------------------------------------------------------------------
// lane
// ---------------------------------------------------------------------------

interface SpawnRecord {
  /** Effect time of the spawn (or of the source spawn, for event records). */
  t: number;
  n: number;
  /** Upper bound on the wait before these particles are born (source lifetimes along a death chain). */
  delay: number;
}

/**
 * One emitter of one effect instance on the GPU: its lane in a pool. The
 * EmitterSim forwards spawn counts here; the lane writes its row each frame
 * and keeps the CPU's upper-bound live count (it never sees GPU particles).
 */
export class GpuEmitter implements GpuSpawnTarget {
  readonly pool: GpuPool;
  /** This instance's lane (changes only when a shrinking pool set compacts). */
  lane: number;
  readonly emitter: EmitterSim;
  #links: { trigger: "birth" | "death"; count: number; target: GpuEmitter }[] = [];
  #pending = 0;
  #records: SpawnRecord[] = [];
  #maxLife = 0;
  readonly #lastPos: [number, number, number] = [0, 0, 0];
  readonly #frame: FrameInfo = { cycleT: 0, params: {} };
  /** Per light renderer: the latest light candidates read back for this lane, and when (world time). */
  #lights: ({ ll: LaneLights; t: number } | null)[] = [];
  /** The latest bounds read back for this lane: when (world time) and where the instance was then. */
  #bounds: { lb: LaneBounds; t: number; at: number[] } | null = null;

  constructor(pool: GpuPool, lane: number, emitter: EmitterSim) {
    this.pool = pool;
    this.lane = lane;
    this.emitter = emitter;
  }

  get template(): EmitterTemplate {
    return this.pool.template;
  }

  /** Slots of this lane (the emitter's maxParticles). */
  get capacity(): number {
    return this.pool.laneCap;
  }

  /** @internal this instance's lanes in the set's other pools, for record propagation */
  _link(list: GpuEmitter[]): void {
    for (const trigger of ["birth", "death"] as const)
      for (const sub of this.template[trigger]) {
        const target = list.find((g) => g.template.index === sub.target);
        if (target) this.#links.push({ trigger, count: Math.max(1, sub.count), target });
      }
  }

  get frameInfo(): FrameInfo {
    this.#frame.cycleT = this.emitter.ctx.cycleT;
    this.#frame.params = this.emitter.ctx.params;
    return this.#frame;
  }

  // ---- GpuSpawnTarget --------------------------------------------------------

  spawn(n: number): void {
    this.#pending = Math.min(this.capacity, this.#pending + n);
  }

  get count(): number {
    const now = this.emitter.time;
    const life = this.#maxLife;
    const r = this.#records;
    let n = 0;
    let w = 0;
    for (let i = 0; i < r.length; i++) {
      if (r[i].t + r[i].delay + life < now) continue;
      n += r[i].n;
      r[w++] = r[i];
    }
    r.length = w;
    return Math.min(this.capacity, n);
  }

  reset(): void {
    this.pool.clearLane(this.lane);
    this.#pending = 0;
    this.#records = [];
    this.#bounds = null;
    this.#lights = [];
  }

  /** @internal a light gather landed */
  _setLights(idx: number, ll: LaneLights, t: number): void {
    this.#lights[idx] = { ll, t };
  }

  /** The latest light candidates of light renderer `idx` (records of LIGHT_RECORD floats) and their age, or null. */
  lightReading(idx: number): { ll: LaneLights; t: number } | null {
    return this.#lights[idx] ?? null;
  }

  /** @internal a bounds read landed */
  _setBounds(lb: LaneBounds, t: number, at: number[]): void {
    this.#bounds = { lb, t, at };
  }

  /**
   * A conservative world box for this lane now, from the latest read-back
   * bounds: widened by the largest particle (× the template's size margin),
   * by how far the fastest particle can have moved since the measurement (plus
   * trail/stretch reach), and joined with itself moved by the instance's
   * displacement since (particles that follow or spawn around the instance).
   * False when nothing has been measured yet (callers treat that as visible);
   * an empty measurement is a point at the instance.
   */
  cullBox(out: Float32Array | number[], now: number, position: ArrayLike<number>): boolean {
    const b = this.#bounds;
    if (!b) return false;
    const tpl = this.template;
    const { lb, at } = b;
    const dx = position[0] - at[0], dy = position[1] - at[1], dz = position[2] - at[2];
    if (lb.empty) {
      const m = lb.maxSize * tpl.sizeMargin + 0.5;
      for (let k = 0; k < 3; k++) {
        out[k] = position[k] - m;
        out[k + 3] = position[k] + m;
      }
      return true;
    }
    const m = lb.maxSize * tpl.sizeMargin + lb.maxSpeed * (tpl.speedMargin + Math.max(0, now - b.t) + 1 / 30);
    const d = [dx, dy, dz];
    for (let k = 0; k < 3; k++) {
      out[k] = Math.min(lb.box[k], lb.box[k] + d[k]) - m;
      out[k + 3] = Math.max(lb.box[k + 3], lb.box[k + 3] + d[k]) + m;
    }
    return true;
  }

  // ---- per frame -------------------------------------------------------------

  #row(): number {
    return this.lane * this.pool.layout.width;
  }

  /** Start of the world's frame: not stepped (dt 0, no spawns) until stage() says otherwise. */
  begin(visible: boolean): void {
    const d = this.pool.laneData;
    const o = this.#row();
    d[o + LANE.dt] = 0;
    d[o + LANE.spawnCount] = 0;
    d[o + LANE.visible] = visible ? 1 : 0;
  }

  /** Writes this lane's row after the EffectSim stepped by `dt`. */
  stage(effect: EffectSim, dt: number): void {
    const d = this.pool.laneData;
    const o = this.#row();
    const t = effect.transform;
    const em = this.emitter;
    d[o + LANE.position] = t.position[0];
    d[o + LANE.position + 1] = t.position[1];
    d[o + LANE.position + 2] = t.position[2];
    d[o + LANE.scale] = t.scale;
    // the effect has already stepped, so its prevPosition == position; spawns spread from where it was last frame
    d[o + LANE.prevPosition] = this.#lastPos[0];
    d[o + LANE.prevPosition + 1] = this.#lastPos[1];
    d[o + LANE.prevPosition + 2] = this.#lastPos[2];
    d[o + LANE.time] = em.ctx.time; // emitter time after its start delay, as the CPU modules see it
    for (let k = 0; k < 4; k++) d[o + LANE.rotation + k] = t.rotation[k];
    d[o + LANE.velocity] = t.velocity[0];
    d[o + LANE.velocity + 1] = t.velocity[1];
    d[o + LANE.velocity + 2] = t.velocity[2];
    d[o + LANE.eventScale] = em.lodActive ? (this.template.scaleSpawn ? effect.spawnScale : 1) : 0;
    d[o + LANE.dt] = dt;
    this.#lastPos[0] = t.position[0];
    this.#lastPos[1] = t.position[1];
    this.#lastPos[2] = t.position[2];

    const life = this.#lifeNow();
    const n = this.#pending;
    this.#pending = 0;
    d[o + LANE.spawnCount] = n;
    if (n > 0) {
      this.#record(em.time, n, 0);
      // the budget predictor (Little's law) needs a lifetime estimate; the CPU never sees GPU lifetimes
      em.lifeEstimate += (life - em.lifeEstimate) * 0.2;
    }
  }

  /** Call when the effect jumps (spawn / play) so births aren't spread along the jump. */
  teleport(effect: EffectSim): void {
    const p = effect.transform.position;
    this.#lastPos[0] = p[0];
    this.#lastPos[1] = p[1];
    this.#lastPos[2] = p[2];
  }

  /** Largest lifetime this emitter's particles can have at the current cycle time. */
  #lifeNow(): number {
    const c = this.pool.lifetime;
    if (c) {
      const st = this.frameInfo;
      this.#maxLife = Math.max(this.#maxLife, c.sample(st.cycleT, 0, st.params), c.sample(st.cycleT, 1, st.params));
    } else this.#maxLife = Math.max(this.#maxLife, 1);
    return this.#maxLife;
  }

  /**
   * Upper-bound bookkeeping for the CPU's live count: `n` particles spawned at
   * effect time `t`, then (through the links) the most their events can spawn
   * in each target, born up to one source lifetime later for death events.
   */
  #record(t: number, n: number, delay: number, depth = 0): void {
    this.#records.push({ t, n, delay });
    if (depth > 8) return; // event cycles: stop propagating
    for (const l of this.#links) l.target.#record(t, n * l.count, l.trigger === "death" ? delay + this.#maxLife : delay, depth + 1);
  }
}
