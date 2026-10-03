// A sort group with GPU members. CPU members still pack into the group's
// ParticleBatch; once a GPU pool joins, that batch stops drawing itself and
// its packed array is uploaded as a storage buffer instead. Each frame, one
// small kernel per source copies its particles (member index in pC.w, local
// space moved to world) into a combined buffer, which is depth-sorted on the
// GPU and drawn with the group's material: one draw call, one order, CPU and
// GPU particles interleaved.
//
// Sources get a segment of the combined buffer each frame (offsets and counts
// are uniforms), so joining and leaving don't rebuild kernels; only growing
// the combined buffer does (doubling).

import * as THREE from "three/webgpu";
import { Fn, If, Return, float, instanceIndex, storage, uint, uniform, vec4 } from "three/tsl";
import type { SortView } from "../batch";
import { PARTICLE_ATTRIBUTES, PARTICLE_STRIDE, type Node } from "../materials/common";
import { rotateQ } from "./context";
import type { GpuPool } from "./pool";
import { GpuSorter } from "./sort";

const uintUniform = (v: number): Node => (uniform as (v: number, t: string) => Node)(v, "uint");

interface Source {
  pool: GpuPool;
  member: number;
  offset: Node;
  count: Node;
  kernel: Node | null;
  /** The pool buffers the kernel was built over (a resized pool needs a new kernel). */
  built: unknown;
}

export class GpuSortGroup {
  readonly mesh: THREE.Mesh;
  readonly #sources: Source[] = [];
  #cap = 0;
  #U: THREE.StorageInstancedBufferAttribute[] = [];
  #sorter: GpuSorter | null = null;
  #fill: Node | null = null;
  readonly #fillFrom = uintUniform(0);
  readonly #fillTo = uintUniform(0);
  #prevUsed = 0;
  #fullFill = false;
  /** CPU members: the group batch's packed array as a storage buffer. */
  #cpu: { data: Float32Array; attr: THREE.StorageBufferAttribute; kernel: Node | null } | null = null;
  readonly #cpuCount = uintUniform(0);

  constructor(name: string, parent: THREE.Object3D) {
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry());
    this.mesh.name = `particles:group:${name}:gpu`;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    parent.add(this.mesh);
  }

  get active(): boolean {
    return this.#sources.length > 0;
  }

  addSource(pool: GpuPool, member: number): void {
    this.#sources.push({ pool, member, offset: uintUniform(0), count: uintUniform(0), kernel: null, built: null });
  }

  removePool(pool: GpuPool): void {
    for (let i = this.#sources.length - 1; i >= 0; i--) {
      const s = this.#sources[i];
      if (s.pool !== pool) continue;
      s.kernel?.dispose?.();
      this.#sources.splice(i, 1);
    }
  }

  #grow(needed: number): void {
    let cap = Math.max(1024, this.#cap);
    while (cap < needed) cap *= 2;
    if (cap === this.#cap) return;
    this.#cap = cap;
    this.#U = [0, 1, 2, 3].map(() => new THREE.StorageInstancedBufferAttribute(cap, 4));
    for (const s of this.#sources) {
      s.kernel?.dispose?.();
      s.kernel = null;
    }
    if (this.#cpu) {
      this.#cpu.kernel?.dispose?.();
      this.#cpu.kernel = null;
    }
    this.#fill?.dispose?.();
    const U = this.#U.map((a) => storage(a, "vec4", cap));
    this.#fill = Fn(() => {
      const i: Node = instanceIndex.add(this.#fillFrom);
      If(i.greaterThanEqual(this.#fillTo), () => {
        Return();
      });
      U[0].element(i).assign(vec4(0, 0, 0, 2));
      U[2].element(i).assign(vec4(0));
    })().compute(cap);
    this.#fullFill = true;
    const old = this.#sorter;
    this.#sorter = new GpuSorter("distance", cap, this.#U, (p) => p);
    old?.dispose();
    const quad = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry().copy(quad as unknown as THREE.InstancedBufferGeometry);
    quad.dispose();
    Object.values(PARTICLE_ATTRIBUTES).forEach((name, i) => g.setAttribute(name, this.#sorter!.attrs[i]));
    // (the previous geometry's buffers are unused from here on: disposing it frees them)
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
  }

  /** Copies pool `s`'s particles into its segment: member index in pC.w, world space. */
  #poolKernel(s: Source): Node {
    const pool = s.pool;
    const n = pool.capacity;
    const L = pool.laneCap;
    const local = pool.template.space === "local";
    const [A, B, C, D] = pool.attributes.map((a) => storage(a, "vec4", n).toReadOnly());
    const U = this.#U.map((a) => storage(a, "vec4", this.#cap));
    const member = s.member;
    return Fn(() => {
      const i = instanceIndex;
      If(i.greaterThanEqual(s.count), () => {
        Return();
      });
      const o: Node = i.add(s.offset);
      const a: Node = A.element(i).toVar();
      const b: Node = B.element(i).toVar();
      const c: Node = C.element(i).toVar();
      if (local) {
        const u = pool.laneValues(i.div(uint(L)));
        U[0].element(o).assign(vec4(rotateQ(u.rotation, a.xyz.mul(u.scale)).add(u.position), a.w));
        U[1].element(o).assign(vec4(rotateQ(u.rotation, b.xyz.mul(u.scale)), b.w));
        U[2].element(o).assign(vec4(c.x.mul(u.scale), c.y, c.z, float(member)));
      } else {
        U[0].element(o).assign(a);
        U[1].element(o).assign(b);
        U[2].element(o).assign(vec4(c.xyz, float(member)));
      }
      U[3].element(o).assign(D.element(i));
    })().compute(n);
  }

  /** Copies the CPU members' packed particles (stride 16 floats, member already in pC.w) to the front. */
  #cpuKernel(attr: THREE.StorageBufferAttribute, vec4s: number): Node {
    const src = storage(attr, "vec4", vec4s).toReadOnly();
    const U = this.#U.map((a) => storage(a, "vec4", this.#cap));
    return Fn(() => {
      const i = instanceIndex;
      If(i.greaterThanEqual(this.#cpuCount), () => {
        Return();
      });
      for (let c = 0; c < 4; c++) U[c].element(i).assign(src.element(i.mul(PARTICLE_STRIDE / 4).add(c)));
    })().compute(vec4s / 4);
  }

  /**
   * Gathers, sorts and draws. `cpu` is the group batch's packed array and
   * count (it doesn't draw itself while GPU members exist); `material` is the
   * group's current material.
   */
  dispatch(renderer: THREE.WebGPURenderer, view: SortView | null, cpu: { data: Float32Array; count: number }, material: THREE.Material): void {
    const spans = this.#sources.map((s) => s.pool.span * s.pool.laneCap);
    let used = cpu.count;
    for (const n of spans) used += n;
    this.#grow(used);

    const kernels: Node[] = [];
    if (this.#fullFill || used < this.#prevUsed) {
      // stale particles past this frame's end (or a fresh buffer of zeros, which would read as live)
      this.#fillFrom.value = this.#fullFill ? 0 : used;
      this.#fillTo.value = this.#fullFill ? this.#cap : this.#prevUsed;
      this.#fullFill = false;
      kernels.push(this.#fill!);
    }
    this.#prevUsed = used;

    if (cpu.count > 0) {
      if (!this.#cpu || this.#cpu.data !== cpu.data) {
        this.#cpu?.kernel?.dispose?.();
        this.#cpu = { data: cpu.data, attr: new THREE.StorageBufferAttribute(cpu.data, 4), kernel: null };
      }
      const c = this.#cpu;
      c.kernel ??= this.#cpuKernel(c.attr, cpu.data.length / 4);
      c.attr.clearUpdateRanges();
      c.attr.addUpdateRange(0, cpu.count * PARTICLE_STRIDE);
      c.attr.needsUpdate = true;
      this.#cpuCount.value = cpu.count;
      kernels.push(c.kernel);
    }
    let offset = cpu.count;
    this.#sources.forEach((s, k) => {
      if (spans[k] === 0) return;
      const built = s.pool.attributes[0];
      if (!s.kernel || s.built !== built) {
        s.kernel?.dispose?.();
        s.kernel = this.#poolKernel(s);
        s.built = built;
      }
      s.offset.value = offset;
      s.count.value = spans[k];
      offset += spans[k];
      kernels.push(s.kernel);
    });
    // one pass: every copy, then the sort (dispatches in a pass see the previous ones' writes)
    if (kernels.length) renderer.compute(kernels);
    this.#sorter!.run(renderer, view);

    this.mesh.material = material;
    (this.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = used;
    this.mesh.visible = used > 0;
  }

  dispose(): void {
    for (const s of this.#sources) s.kernel?.dispose?.();
    this.#sources.length = 0;
    this.#cpu?.kernel?.dispose?.();
    this.#fill?.dispose?.();
    this.#sorter?.dispose();
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
  }
}
