// GPU particle sorting for alpha-blended GPU emitters: a key per slot
// (view depth or age), a bitonic sort of (key, slot) pairs, then a gather
// into a sorted copy of the four particle buffers that the sorted renderers'
// meshes draw from. Dead slots and the power-of-two padding sort to the end;
// dead particles have size 0, so they still draw nothing.
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

export class GpuSorter {
  readonly mode: Exclude<SortMode, "none">;
  /** Sorted copies of pA..pD, for the sorted renderers' geometry. */
  readonly attrs: THREE.StorageInstancedBufferAttribute[];
  /** Power-of-two sort size. */
  readonly size: number;
  readonly #camPos = uniform(new THREE.Vector3());
  readonly #camDir = uniform(new THREE.Vector3(0, 0, -1));
  readonly #kernels: Node[];

  /** @param worldPos the world position of a particle from its stored position and slot (identity for world space) */
  constructor(mode: Exclude<SortMode, "none">, capacity: number, src: THREE.StorageInstancedBufferAttribute[], worldPos: (pos: Node, slot: Node) => Node) {
    this.mode = mode;
    const n = (this.size = 2 ** Math.ceil(Math.log2(Math.max(2, capacity))));
    this.attrs = [0, 1, 2, 3].map(() => new THREE.StorageInstancedBufferAttribute(capacity, 4));
    const keysAttr = new THREE.StorageBufferAttribute(n, 1);
    const idxAttr = new THREE.StorageBufferAttribute(new Uint32Array(n), 1);
    const [A, , C] = src.map((a) => storage(a, "vec4", capacity));

    const keyKernel = Fn(() => {
      const i = instanceIndex;
      const keys = storage(keysAttr, "float", n);
      storage(idxAttr, "uint", n).element(i).assign(i);
      If(i.greaterThanEqual(uint(capacity)), () => {
        keys.element(i).assign(PAD);
      }).Else(() => {
        const a: Node = A.element(i);
        let key: Node;
        if (mode === "distance") {
          // view depth, farthest first (ascending sort on -depth)
          const p: Node = worldPos(a.xyz, i);
          key = dot(p.sub(this.#camPos), this.#camDir).negate();
        } else {
          // age in seconds; drawn last = on top
          const age: Node = a.w.mul(C.element(i).z);
          key = mode === "oldestOnTop" ? age : age.negate();
        }
        keys.element(i).assign(select(a.w.greaterThanEqual(1), float(DEAD), key));
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

    const S = src.map((a) => storage(a, "vec4", capacity));
    const D = this.attrs.map((a) => storage(a, "vec4", capacity));
    // two halves: 4 sources + 4 copies + the index buffer would be 9 storage buffers, over WebGPU's default 8 per stage
    // (padding indices never land in the first `capacity` entries: they sort after every slot)
    const gather = (c0: number) =>
      Fn(() => {
        const s: Node = storage(idxAttr, "uint", n).element(instanceIndex).toVar();
        for (let c = c0; c < c0 + 2; c++) D[c].element(instanceIndex).assign(S[c].element(s));
      })().compute(capacity);

    this.#kernels = [keyKernel];
    for (let k = 2; k <= n; k *= 2) for (let j = k >> 1; j > 0; j >>= 1) this.#kernels.push(pass(k, j));
    this.#kernels.push(gather(0), gather(2));
  }

  /** Bitonic passes per frame (log2(n)·(log2(n)+1)/2). */
  get passes(): number {
    return this.#kernels.length - 3;
  }

  /** Sorts this frame's particles; without a view, distance sorting keeps the last order. */
  run(renderer: THREE.WebGPURenderer, view: SortView | null): void {
    if (this.mode === "distance") {
      if (!view) return;
      this.#camPos.value.set(view.px, view.py, view.pz);
      this.#camDir.value.set(view.fx, view.fy, view.fz);
    }
    renderer.compute(this.#kernels);
  }

  dispose(): void {
    for (const k of this.#kernels) k.dispose?.();
  }
}
