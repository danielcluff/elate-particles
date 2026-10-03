// Per-lane bounds of a GPU pool, for frustum culling on the CPU. A 2D
// dispatch runs one 64-thread workgroup per chunk of a lane (y = lane), so a
// workgroup never straddles two instances: it reduces its particles' world
// AABB, max speed² and max size in workgroup memory, then does one atomic
// min/max per value into the lane's 8 counters. The counters are read back
// asynchronously (one read in flight per pool), so the CPU culls with bounds a
// few frames old and widens them by how far particles could have moved since.

import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  abs,
  atomicMax,
  atomicMin,
  atomicStore,
  dot,
  float,
  floatBitsToUint,
  instanceIndex,
  localId,
  select,
  storage,
  uint,
  vec3,
  workgroupArray,
  workgroupBarrier,
  workgroupId,
} from "three/tsl";
import type { Node } from "../materials/common";
import { rotateQ, type LaneValues } from "./context";

const WG = 64;
/** Counters per lane: min xyz, max xyz, max speed², max size. */
export const BOUNDS_STRIDE = 8;

/** Float → u32 preserving order (so atomicMin/Max on the bits compare the floats). */
function orderable(f: Node): Node {
  const u: Node = floatBitsToUint(f);
  return select(f.greaterThanEqual(0), u.bitOr(uint(0x80000000)), u.bitNot());
}

function decode(u: number): number {
  const v = new Uint32Array([u & 0x80000000 ? u & 0x7fffffff : ~u >>> 0]);
  return new Float32Array(v.buffer)[0];
}

export interface BoundsSource {
  attrs: readonly THREE.StorageInstancedBufferAttribute[];
  capacity: number;
  laneCap: number;
  lanes: number;
  local: boolean;
  lane: (lane: Node) => LaneValues;
}

/** One lane's bounds as read back: world AABB, max speed and max size, or empty (no live particles). */
export interface LaneBounds {
  empty: boolean;
  box: Float32Array;
  maxSpeed: number;
  maxSize: number;
}

export class GpuBounds {
  readonly #src: BoundsSource;
  readonly #attr: THREE.StorageBufferAttribute;
  readonly #readback: THREE.ReadbackBuffer;
  readonly #reset: Node;
  readonly #reduce: Node;
  #reading = false;
  #disposed = false;

  constructor(src: BoundsSource) {
    this.#src = src;
    const n = src.lanes * BOUNDS_STRIDE;
    this.#attr = new THREE.StorageBufferAttribute(new Uint32Array(n), 1);
    this.#readback = new THREE.ReadbackBuffer(n * 4);
    const attr = this.#attr;

    this.#reset = Fn(() => {
      const B = storage(attr, "uint", n).toAtomic();
      const o: Node = instanceIndex.mul(BOUNDS_STRIDE);
      for (let k = 0; k < 3; k++) atomicStore(B.element(o.add(k)), uint(0xffffffff));
      for (let k = 3; k < BOUNDS_STRIDE; k++) atomicStore(B.element(o.add(k)), uint(0));
    })().compute(src.lanes);

    const L = src.laneCap;
    const [A, Bv, C] = src.attrs.map((a) => storage(a, "vec4", src.capacity).toReadOnly());
    // (no count: an early return before the barriers would break workgroup uniformity)
    this.#reduce = Fn(() => {
      const lane: Node = workgroupId.y;
      const li: Node = localId.x;
      const i: Node = workgroupId.x.mul(WG).add(li);
      const slot: Node = lane.mul(L).add(i.min(uint(L - 1))).toVar();
      const a: Node = A.element(slot).toVar();
      const alive: Node = i.lessThan(uint(L)).and(a.w.lessThan(1)).toVar();
      let pos: Node = a.xyz;
      let vel: Node = Bv.element(slot).xyz;
      let size: Node = abs(C.element(slot).x);
      if (src.local) {
        const u = src.lane(lane);
        pos = rotateQ(u.rotation, a.xyz.mul(u.scale)).add(u.position);
        vel = rotateQ(u.rotation, vel.mul(u.scale));
        size = size.mul(u.scale);
      }
      const mn: Node = workgroupArray("vec3", WG);
      const mx: Node = workgroupArray("vec3", WG);
      const sp: Node = workgroupArray("float", WG);
      const sz: Node = workgroupArray("float", WG);
      mn.element(li).assign(select(alive, pos, vec3(1e30)));
      mx.element(li).assign(select(alive, pos, vec3(-1e30)));
      sp.element(li).assign(select(alive, dot(vel, vel), float(0)));
      sz.element(li).assign(select(alive, size, float(0)));
      workgroupBarrier();
      for (let s = WG / 2; s >= 1; s >>= 1) {
        If(li.lessThan(uint(s)), () => {
          const j: Node = li.add(s);
          mn.element(li).assign(mn.element(li).min(mn.element(j)));
          mx.element(li).assign(mx.element(li).max(mx.element(j)));
          sp.element(li).assign(sp.element(li).max(sp.element(j)));
          sz.element(li).assign(sz.element(li).max(sz.element(j)));
        });
        workgroupBarrier();
      }
      If(li.equal(0).and(mx.element(uint(0)).x.greaterThan(-1e29)), () => {
        const B = storage(attr, "uint", n).toAtomic();
        const o: Node = lane.mul(BOUNDS_STRIDE);
        const lo: Node = mn.element(uint(0));
        const hi: Node = mx.element(uint(0));
        atomicMin(B.element(o), orderable(lo.x));
        atomicMin(B.element(o.add(1)), orderable(lo.y));
        atomicMin(B.element(o.add(2)), orderable(lo.z));
        atomicMax(B.element(o.add(3)), orderable(hi.x));
        atomicMax(B.element(o.add(4)), orderable(hi.y));
        atomicMax(B.element(o.add(5)), orderable(hi.z));
        atomicMax(B.element(o.add(6)), orderable(sp.element(uint(0))));
        atomicMax(B.element(o.add(7)), orderable(sz.element(uint(0))));
      });
    })().compute([1, 1, 1] as unknown as number);
  }

  /** True while a readback is in flight (no new measurement is started until it lands). */
  get busy(): boolean {
    return this.#reading;
  }

  /**
   * Measures lanes [0, span) and reads them back. `done` gets each lane's
   * bounds when the read lands (a few frames later).
   */
  run(renderer: THREE.WebGPURenderer, span: number, done: (lanes: LaneBounds[]) => void): void {
    if (this.#reading || span === 0) return;
    renderer.compute(this.#reset);
    renderer.compute(this.#reduce, [Math.ceil(this.#src.laneCap / WG), span, 1]);
    this.#reading = true;
    const rb = this.#readback;
    renderer
      .getArrayBufferAsync(this.#attr, rb)
      .then(() => {
        const u = new Uint32Array(rb.buffer as ArrayBuffer, 0, span * BOUNDS_STRIDE).slice();
        rb.release();
        this.#reading = false;
        if (this.#disposed) {
          rb.dispose();
          return;
        }
        const out: LaneBounds[] = [];
        for (let l = 0; l < span; l++) {
          const o = l * BOUNDS_STRIDE;
          const empty = u[o + 3] === 0;
          const box = new Float32Array(6);
          for (let k = 0; k < 6; k++) box[k] = empty ? 0 : decode(u[o + k]);
          out.push({ empty, box, maxSpeed: empty ? 0 : Math.sqrt(decode(u[o + 6])), maxSize: empty ? 0 : decode(u[o + 7]) });
        }
        done(out);
      })
      .catch(() => {
        this.#reading = false;
      });
  }

  dispose(): void {
    this.#disposed = true;
    this.#reset.dispose?.();
    this.#reduce.dispose?.();
    if (!this.#reading) this.#readback.dispose();
  }
}
