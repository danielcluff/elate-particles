// One draw call per emitter template: every live instance of an emitter packs
// its particles (in world space) into a shared instanced buffer. Draw calls
// therefore scale with the number of distinct emitters, not with the number
// of explosions on screen.

import * as THREE from "three/webgpu";
import type { EmitterSim } from "../sim/emitter";
import type { EmitterTemplate } from "../sim/compile";
import type { RendererDoc, RibbonRendererDoc } from "../core/types";
import { PARTICLE_ATTRIBUTES, PARTICLE_STRIDE } from "./materials/common";
import { RIBBON_ATTRIBUTES, RIBBON_STRIDE } from "./materials/ribbon";
import { KeySorter } from "./sort";

/** Camera position and unit forward vector (world space), for distance sorting. */
export interface SortView {
  px: number;
  py: number;
  pz: number;
  fx: number;
  fy: number;
  fz: number;
}

/** What a batch needs to know about what it draws: an EmitterTemplate, or a sort group. */
export interface BatchSource {
  doc: { name: string };
  capacity: number;
}

/** Shared instanced-buffer management; subclasses decide what an instance is. */
export abstract class InstanceBatch {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.Material>;
  readonly template: BatchSource;
  /** The renderer this batch draws (one batch per renderer per emitter). */
  readonly renderer: RendererDoc;
  protected data: Float32Array;
  /** Instances written this frame. */
  protected count = 0;
  #buffer: THREE.InstancedInterleavedBuffer;
  #capacity: number;
  readonly #stride: number;
  readonly #attributes: readonly string[];
  readonly #base: () => THREE.BufferGeometry;
  /** Float offsets of the position(s) a sort key is taken from (averaged); ribbons use both segment ends. */
  protected sortPositions: readonly number[] = [0];
  #sorter: KeySorter | null = null;
  #keys = new Float32Array(0);
  #scratch = new Float32Array(0);

  /**
   * @param base returns a fresh copy of the per-instance geometry (each batch geometry owns its attributes,
   *   because disposing a geometry frees its attributes' GPU buffers)
   * @param attributes vec4 attribute names, laid out consecutively in each instance's `stride` floats
   */
  constructor(template: BatchSource, renderer: RendererDoc, material: THREE.Material, base: () => THREE.BufferGeometry, stride: number, attributes: readonly string[], capacity: number) {
    this.template = template;
    this.renderer = renderer;
    this.#stride = stride;
    this.#attributes = attributes;
    this.#base = base;
    this.#capacity = Math.max(16, capacity);
    this.data = new Float32Array(this.#capacity * stride);
    this.#buffer = this.#makeBuffer();
    this.mesh = new THREE.Mesh(this.#makeGeometry(), material);
    this.mesh.name = `particles:${template.doc.name}:${renderer.type}`;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = renderer.sortOrder ?? 0;
    this.mesh.visible = false;
  }

  /** Instances drawn this frame (particles for sprites/meshes, segments for ribbons). */
  get instances(): number {
    return this.count;
  }

  get capacity(): number {
    return this.#capacity;
  }

  /** Particles represented this frame (for stats). */
  abstract get particles(): number;

  /** Appends an emitter's live particles. `matrix` is set for local-space emitters. */
  abstract pack(sim: EmitterSim, matrix: Float32Array | null, member?: number): void;

  #makeBuffer(): THREE.InstancedInterleavedBuffer {
    const b = new THREE.InstancedInterleavedBuffer(this.data, this.#stride, 1);
    b.setUsage(THREE.DynamicDrawUsage);
    return b;
  }

  #makeGeometry(): THREE.InstancedBufferGeometry {
    const g = new THREE.InstancedBufferGeometry().copy(this.#base() as THREE.InstancedBufferGeometry);
    this.#attributes.forEach((name, i) => g.setAttribute(name, new THREE.InterleavedBufferAttribute(this.#buffer, 4, i * 4)));
    g.instanceCount = 0;
    return g;
  }

  /** Grows the GPU buffer (doubling) so `needed` instances fit. Rare: allocates. */
  protected ensure(needed: number): void {
    if (needed <= this.#capacity) return;
    let cap = this.#capacity;
    while (cap < needed) cap *= 2;
    const data = new Float32Array(cap * this.#stride);
    data.set(this.data.subarray(0, this.count * this.#stride));
    this.data = data;
    this.#capacity = cap;
    this.#buffer = this.#makeBuffer();
    const old = this.mesh.geometry;
    this.mesh.geometry = this.#makeGeometry();
    old.dispose();
  }

  begin(): void {
    this.count = 0;
  }

  /** Finishes the frame: sorts (if the renderer asks for it) and schedules the upload. */
  end(view: SortView | null = null): void {
    const n = this.count;
    this.mesh.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n === 0) return;
    if (n > 1) this.#sort(n, view);
    this.#buffer.clearUpdateRanges();
    this.#buffer.addUpdateRange(0, n * this.#stride);
    this.#buffer.needsUpdate = true;
  }

  /** Reorders this frame's instances by the renderer's sort mode. Both layouts keep age at +3 and lifetime at +10. */
  #sort(n: number, view: SortView | null): void {
    const mode = this.renderer.sort ?? "none";
    if (mode === "none" || (mode === "distance" && !view)) return;
    const stride = this.#stride;
    const data = this.data;
    if (this.#keys.length < n) {
      this.#keys = new Float32Array(Math.max(n, this.#keys.length * 2));
      this.#scratch = new Float32Array(this.#keys.length * stride);
    }
    const keys = this.#keys;
    let descending: boolean;
    if (mode === "distance") {
      // view-space depth: farthest first
      const { px, py, pz, fx, fy, fz } = view!;
      const offs = this.sortPositions;
      const inv = 1 / offs.length;
      for (let i = 0, o = 0; i < n; i++, o += stride) {
        let x = 0, y = 0, z = 0;
        for (let k = 0; k < offs.length; k++) {
          x += data[o + offs[k]];
          y += data[o + offs[k] + 1];
          z += data[o + offs[k] + 2];
        }
        keys[i] = (x * inv - px) * fx + (y * inv - py) * fy + (z * inv - pz) * fz;
      }
      descending = true;
    } else {
      // age in seconds; drawn last = on top
      for (let i = 0, o = 0; i < n; i++, o += stride) keys[i] = data[o + 3] * data[o + 10];
      descending = mode === "newestOnTop";
    }
    const order = (this.#sorter ??= new KeySorter()).order(keys, n, descending);
    const scratch = this.#scratch;
    scratch.set(data.subarray(0, n * stride));
    for (let i = 0, dst = 0; i < n; i++, dst += stride) {
      const src = order[i] * stride;
      for (let c = 0; c < stride; c++) data[dst + c] = scratch[src + c];
    }
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
  }
}

// ---------------------------------------------------------------------------

/** One instance per particle: sprites (quad) and meshes (any geometry). */
export class ParticleBatch extends InstanceBatch {
  constructor(
    template: BatchSource,
    renderer: RendererDoc,
    material: THREE.Material,
    base: () => THREE.BufferGeometry = () => new THREE.PlaneGeometry(1, 1),
    capacity = template.capacity,
  ) {
    super(template, renderer, material, base, PARTICLE_STRIDE, Object.values(PARTICLE_ATTRIBUTES), capacity);
  }

  get particles(): number {
    return this.count;
  }

  /** @param member written to the spare `pC.w` slot (sort groups use it to look up per-renderer data) */
  pack(sim: EmitterSim, matrix: Float32Array | null, member = 0): void {
    const b = sim.buf;
    const n = b.count;
    if (n === 0) return;
    this.ensure(this.count + n);
    const out = this.data;
    const { px, py, pz, vx, vy, vz, age, life, seed, size, rot, r, g, b: bl, a } = b;
    let o = this.count * PARTICLE_STRIDE;
    if (!matrix) {
      for (let i = 0; i < n; i++, o += PARTICLE_STRIDE) {
        out[o] = px[i];
        out[o + 1] = py[i];
        out[o + 2] = pz[i];
        out[o + 3] = age[i] / life[i];
        out[o + 4] = vx[i];
        out[o + 5] = vy[i];
        out[o + 6] = vz[i];
        out[o + 7] = seed[i];
        out[o + 8] = size[i];
        out[o + 9] = rot[i];
        out[o + 10] = life[i];
        out[o + 11] = member;
        out[o + 12] = r[i];
        out[o + 13] = g[i];
        out[o + 14] = bl[i];
        out[o + 15] = a[i];
      }
    } else {
      const m = matrix;
      // uniform scale = length of the first basis column
      const sc = Math.hypot(m[0], m[1], m[2]);
      for (let i = 0; i < n; i++, o += PARTICLE_STRIDE) {
        const x = px[i], y = py[i], z = pz[i];
        out[o] = m[0] * x + m[4] * y + m[8] * z + m[12];
        out[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
        out[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        out[o + 3] = age[i] / life[i];
        const ux = vx[i], uy = vy[i], uz = vz[i];
        out[o + 4] = m[0] * ux + m[4] * uy + m[8] * uz;
        out[o + 5] = m[1] * ux + m[5] * uy + m[9] * uz;
        out[o + 6] = m[2] * ux + m[6] * uy + m[10] * uz;
        out[o + 7] = seed[i];
        out[o + 8] = size[i] * sc;
        out[o + 9] = rot[i];
        out[o + 10] = life[i];
        out[o + 11] = member;
        out[o + 12] = r[i];
        out[o + 13] = g[i];
        out[o + 14] = bl[i];
        out[o + 15] = a[i];
      }
    }
    this.count += n;
  }
}

/** @deprecated renamed to ParticleBatch */
export const SpriteBatch = ParticleBatch;

// ---------------------------------------------------------------------------

/**
 * One instance per ribbon segment.
 *  - mode "emitter": an emitter instance's particles (kept in spawn order by
 *    the simulator) form one strip, oldest → newest.
 *  - mode "particle": every particle draws its own strip, from the oldest
 *    point of its trail history to its live position.
 * Segments are only written within a strip, so strips never join up.
 */
export class RibbonBatch extends InstanceBatch {
  #particles = 0;
  // per-strip scratch: points in simulation space, the particle each point
  // takes its attributes from, then world positions / tangents / u
  #pts = new Float32Array(0);
  #pi = new Int32Array(0);
  #wp = new Float32Array(0);
  #tan = new Float32Array(0);
  #u = new Float32Array(0);
  #un = new Float32Array(0);

  constructor(template: EmitterTemplate, renderer: RibbonRendererDoc, material: THREE.Material, capacity = template.capacity) {
    super(template, renderer, material, () => new THREE.PlaneGeometry(1, 1), RIBBON_STRIDE, RIBBON_ATTRIBUTES, capacity);
    this.sortPositions = [0, 16];
  }

  get particles(): number {
    return this.#particles;
  }

  override begin(): void {
    super.begin();
    this.#particles = 0;
  }

  #scratch(n: number): void {
    if (this.#u.length >= n) return;
    const cap = Math.max(n, this.#u.length * 2, 64);
    this.#pts = new Float32Array(cap * 3);
    this.#pi = new Int32Array(cap);
    this.#wp = new Float32Array(cap * 3);
    this.#tan = new Float32Array(cap * 3);
    this.#u = new Float32Array(cap);
    this.#un = new Float32Array(cap);
  }

  pack(sim: EmitterSim, matrix: Float32Array | null): void {
    const b = sim.buf;
    const n = b.count;
    this.#particles += n;
    const trails = sim.trails;
    if (!trails) {
      if (n < 2) return;
      this.#scratch(n);
      const pts = this.#pts, pi = this.#pi;
      for (let i = 0; i < n; i++) {
        pts[i * 3] = b.px[i];
        pts[i * 3 + 1] = b.py[i];
        pts[i * 3 + 2] = b.pz[i];
        pi[i] = i;
      }
      this.#writeStrip(sim, n, matrix);
      return;
    }

    // one strip per particle: history (oldest first), then the live position
    this.#scratch(trails.points + 1);
    const slots = b.channel("trailSlot");
    const pts = this.#pts;
    for (let i = 0; i < n; i++) {
      let m = trails.read(slots[i], sim.time, pts, 0);
      // skip the newest history point if it sits on the particle (recorded this step)
      if (m > 0) {
        const o = (m - 1) * 3;
        const dx = pts[o] - b.px[i], dy = pts[o + 1] - b.py[i], dz = pts[o + 2] - b.pz[i];
        if (dx * dx + dy * dy + dz * dz < 1e-12) m--;
      }
      pts[m * 3] = b.px[i];
      pts[m * 3 + 1] = b.py[i];
      pts[m * 3 + 2] = b.pz[i];
      m++;
      if (m < 2) continue;
      this.#writeStrip(sim, m, matrix, i);
    }
  }

  /**
   * Writes a strip through the first `n` scratch points (simulation space).
   * Attributes come from particle `particle`, or per point from #pi when -1.
   */
  #writeStrip(sim: EmitterSim, n: number, matrix: Float32Array | null, particle = -1): void {
    this.ensure(this.count + n - 1);
    const r = this.renderer as RibbonRendererDoc;
    const pts = this.#pts, pi = this.#pi, wp = this.#wp, tan = this.#tan, uu = this.#u, un = this.#un;

    // world positions
    let sc = 1;
    if (matrix) {
      const m = matrix;
      sc = Math.hypot(m[0], m[1], m[2]);
      for (let i = 0; i < n; i++) {
        const x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2];
        wp[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
        wp[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
        wp[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
      }
    } else {
      for (let i = 0; i < n * 3; i++) wp[i] = pts[i];
    }

    // tangents from neighbours (central differences, one-sided at the ends);
    // a degenerate tangent (coincident points) reuses the previous one
    let lx = 0, ly = 1, lz = 0;
    for (let i = 0; i < n; i++) {
      const a = i > 0 ? i - 1 : i;
      const c = i < n - 1 ? i + 1 : i;
      let tx = wp[c * 3] - wp[a * 3], ty = wp[c * 3 + 1] - wp[a * 3 + 1], tz = wp[c * 3 + 2] - wp[a * 3 + 2];
      // sqrt, not Math.hypot: hypot is several times slower in V8 and this runs per point
      const l = Math.sqrt(tx * tx + ty * ty + tz * tz);
      if (l > 1e-6) {
        tx /= l;
        ty /= l;
        tz /= l;
        lx = tx;
        ly = ty;
        lz = tz;
      } else {
        tx = lx;
        ty = ly;
        tz = lz;
      }
      tan[i * 3] = tx;
      tan[i * 3 + 1] = ty;
      tan[i * 3 + 2] = tz;
    }

    // normalised strip coordinate (0 head → 1 tail) drives taper/fade;
    // texture u is the same for "stretch", world distance / uvTile for "tile"
    for (let i = 0; i < n; i++) un[i] = (n - 1 - i) / (n - 1);
    if (r.uvMode === "tile") {
      const tile = r.uvTile && r.uvTile > 0 ? r.uvTile : 1;
      let d = 0;
      uu[n - 1] = 0;
      for (let i = n - 2; i >= 0; i--) {
        const dx = wp[i * 3 + 3] - wp[i * 3], dy = wp[i * 3 + 4] - wp[i * 3 + 1], dz = wp[i * 3 + 5] - wp[i * 3 + 2];
        d += Math.sqrt(dx * dx + dy * dy + dz * dz);
        uu[i] = d / tile;
      }
    } else {
      for (let i = 0; i < n; i++) uu[i] = un[i];
    }

    const out = this.data;
    const { age, life, seed, size, r: cr, g, b: cb, a } = sim.buf;
    let o = this.count * RIBBON_STRIDE;
    if (particle >= 0) {
      // trail of one particle: everything but position/tangent/u is constant along the strip
      const i = particle;
      const ag = age[i] / life[i], w = size[i] * sc, sd = seed[i], lf = life[i];
      const r0 = cr[i], g0 = g[i], b0 = cb[i], a0 = a[i];
      for (let s = 0; s < n - 1; s++, o += RIBBON_STRIDE) {
        for (let e = 0; e < 2; e++) {
          const k = s + e;
          const q = o + e * 16;
          const k3 = k * 3;
          out[q] = wp[k3];
          out[q + 1] = wp[k3 + 1];
          out[q + 2] = wp[k3 + 2];
          out[q + 3] = ag;
          out[q + 4] = tan[k3];
          out[q + 5] = tan[k3 + 1];
          out[q + 6] = tan[k3 + 2];
          out[q + 7] = uu[k];
          out[q + 8] = w;
          out[q + 9] = sd;
          out[q + 10] = lf;
          out[q + 11] = un[k];
          out[q + 12] = r0;
          out[q + 13] = g0;
          out[q + 14] = b0;
          out[q + 15] = a0;
        }
      }
      this.count += n - 1;
      return;
    }
    for (let s = 0; s < n - 1; s++, o += RIBBON_STRIDE) {
      for (let e = 0; e < 2; e++) {
        const k = s + e;
        const i = pi[k];
        const q = o + e * 16;
        out[q] = wp[k * 3];
        out[q + 1] = wp[k * 3 + 1];
        out[q + 2] = wp[k * 3 + 2];
        out[q + 3] = age[i] / life[i];
        out[q + 4] = tan[k * 3];
        out[q + 5] = tan[k * 3 + 1];
        out[q + 6] = tan[k * 3 + 2];
        out[q + 7] = uu[k];
        out[q + 8] = size[i] * sc;
        out[q + 9] = seed[i];
        out[q + 10] = life[i];
        out[q + 11] = un[k];
        out[q + 12] = cr[i];
        out[q + 13] = g[i];
        out[q + 14] = cb[i];
        out[q + 15] = a[i];
      }
    }
    this.count += n - 1;
  }
}
