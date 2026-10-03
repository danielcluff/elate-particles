// GPU sorting for alpha-blended GPU emitters. GpuKeySort: a key per item, a
// bitonic sort of (key, index) pairs into an order buffer (keys ascending;
// dead items and the power-of-two padding sort to the end). GpuSorter uses it
// for particles, then gathers a sorted copy of the four particle buffers that
// the sorted renderers' meshes draw from; sorted ribbons draw their segments
// through the order buffer instead (gpu/ribbon.ts).
//
// Every bitonic pass is its own compute node with constant (k, j) uniforms;
// they share one shader (and pipeline) and are all encoded in a single
// renderer.compute([...]) call: one compute pass, one submit per frame.

import * as THREE from "three/webgpu";
import { Fn, If, dot, float, instanceIndex, select, storage, uint, uniform } from "three/tsl";
import type { SortMode } from "../../core/types";
import type { SortView } from "../batch";
import type { Node } from "../materials/common";

const DEAD = 1e30;
const PAD = 2e30;

const uintUniform = (v: number): Node => (uniform as (v: number, t: string) => Node)(v, "uint");

/** The camera, for keys that sort by view depth. */
export interface SortCamera {
  position: Node;
  forward: Node;
}

/** Key for dead / invalid items: after every live one. */
export const SORT_DEAD = DEAD;

/** Sorts `count` items by a key into `order` (indices, ascending keys), all on the GPU. */
export class GpuKeySort {
  /** Power-of-two sort size. */
  readonly size: number;
  /** Item indices in key order (the first `count` entries are real items). */
  readonly order: THREE.StorageBufferAttribute;
  /** The keys, in the same (sorted) order. */
  readonly keys: THREE.StorageBufferAttribute;
  readonly kernels: Node[];
  readonly #camPos = uniform(new THREE.Vector3());
  readonly #camDir = uniform(new THREE.Vector3(0, 0, -1));

  /** @param key the key of item `i` (< count), built inside the key kernel; SORT_DEAD for items that draw nothing */
  constructor(count: number, key: (i: Node, camera: SortCamera) => Node) {
    const n = (this.size = 2 ** Math.ceil(Math.log2(Math.max(2, count))));
    const keysAttr = (this.keys = new THREE.StorageBufferAttribute(n, 1));
    const idxAttr = (this.order = new THREE.StorageBufferAttribute(new Uint32Array(n), 1));
    const camera = { position: this.#camPos, forward: this.#camDir };

    const keyKernel = Fn(() => {
      const i = instanceIndex;
      const keys = storage(keysAttr, "float", n);
      storage(idxAttr, "uint", n).element(i).assign(i);
      If(i.greaterThanEqual(uint(count)), () => {
        keys.element(i).assign(PAD);
      }).Else(() => {
        keys.element(i).assign(key(i, camera));
      });
    })().compute(n);

    const pass = (k: number, j: number): Node =>
      Fn(() => {
        const kU = uintUniform(k);
        const jU = uintUniform(j);
        const i = instanceIndex;
        const l: Node = i.bitXor(jU);
        If(l.greaterThan(i), () => {
          const keys = storage(keysAttr, "float", n);
          const idx = storage(idxAttr, "uint", n);
          const ki: Node = keys.element(i).toVar();
          const kl: Node = keys.element(l).toVar();
          const up: Node = i.bitAnd(kU).equal(uint(0));
          If(select(up, ki.greaterThan(kl), ki.lessThan(kl)), () => {
            keys.element(i).assign(kl);
            keys.element(l).assign(ki);
            const t: Node = idx.element(i).toVar();
            idx.element(i).assign(idx.element(l));
            idx.element(l).assign(t);
          });
        });
      })().compute(n);

    this.kernels = [keyKernel];
    for (let k = 2; k <= n; k *= 2) for (let j = k >> 1; j > 0; j >>= 1) this.kernels.push(pass(k, j));
  }

  /** Bitonic passes per frame (log2(n)·(log2(n)+1)/2). */
  get passes(): number {
    return this.kernels.length - 1;
  }

  /** Points the camera uniforms at `view`. */
  setView(view: SortView): void {
    this.#camPos.value.set(view.px, view.py, view.pz);
    this.#camDir.value.set(view.fx, view.fy, view.fz);
  }

  dispose(): void {
    for (const k of this.kernels) k.dispose?.();
  }
}

/** The key for a sort mode: negative view depth of `pos` (farthest first), or age in seconds (drawn last = on top). */
export function sortKey(mode: Exclude<SortMode, "none">, camera: SortCamera, pos: Node, ageSeconds: Node): Node {
  if (mode === "distance") return dot(pos.sub(camera.position), camera.forward).negate();
  return mode === "oldestOnTop" ? ageSeconds : ageSeconds.negate();
}

export class GpuSorter {
  readonly mode: Exclude<SortMode, "none">;
  /** Sorted copies of pA..pD, for the sorted renderers' geometry. */
  readonly attrs: THREE.StorageInstancedBufferAttribute[];
  readonly #keys: GpuKeySort;
  readonly #kernels: Node[];

  /** @param worldPos the world position of a particle from its stored position and slot (identity for world space) */
  constructor(mode: Exclude<SortMode, "none">, capacity: number, src: THREE.StorageInstancedBufferAttribute[], worldPos: (pos: Node, slot: Node) => Node) {
    this.mode = mode;
    this.attrs = [0, 1, 2, 3].map(() => new THREE.StorageInstancedBufferAttribute(capacity, 4));
    const [A, , C] = src.map((a) => storage(a, "vec4", capacity));
    this.#keys = new GpuKeySort(capacity, (i, camera) => {
      const a: Node = A.element(i);
      const key = sortKey(mode, camera, mode === "distance" ? worldPos(a.xyz, i) : a.xyz, a.w.mul(C.element(i).z));
      return select(a.w.greaterThanEqual(1), float(DEAD), key);
    });
    const n = this.#keys.size;
    const order = this.#keys.order;
    const S = src.map((a) => storage(a, "vec4", capacity));
    const D = this.attrs.map((a) => storage(a, "vec4", capacity));
    // two halves: 4 sources + 4 copies + the index buffer would be 9 storage buffers, over WebGPU's default 8 per stage
    // (padding indices never land in the first `capacity` entries: they sort after every slot)
    const gather = (c0: number) =>
      Fn(() => {
        const s: Node = storage(order, "uint", n).element(instanceIndex).toVar();
        for (let c = c0; c < c0 + 2; c++) D[c].element(instanceIndex).assign(S[c].element(s));
      })().compute(capacity);
    this.#kernels = [...this.#keys.kernels, gather(0), gather(2)];
  }

  /** Power-of-two sort size. */
  get size(): number {
    return this.#keys.size;
  }

  /** Bitonic passes per frame (log2(n)·(log2(n)+1)/2). */
  get passes(): number {
    return this.#keys.passes;
  }

  /** Sorts this frame's particles; without a view, distance sorting keeps the last order. */
  run(renderer: THREE.WebGPURenderer, view: SortView | null): void {
    if (this.mode === "distance") {
      if (!view) return;
      this.#keys.setView(view);
    }
    renderer.compute(this.#kernels);
  }

  dispose(): void {
    this.#keys.dispose();
  }
}
