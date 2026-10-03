// Light candidates from a GPU pool. Particles are picked by the light
// renderer's ratio (seed < ratio, the seed being stable for a particle's
// life), then spread over `maxLights` buckets by seed; each bucket keeps its
// highest-seed particle (pass 1: atomicMax of the seed bits; pass 2: the
// winner writes its record). The same particle keeps its light while it
// lives, so lights don't hop between particles from one reading to the next
// (an atomic append would pick an arbitrary subset each time). The CPU picks
// the same way (lightBucket).
//
// Per lane, one atomic u32 buffer holds the bucket keys then the records
// (world position, size, velocity, age, colour; floats as bits). It is read
// back asynchronously like the bounds, and the world extrapolates each light
// along its velocity for the delay.

import * as THREE from "three/webgpu";
import { Fn, If, abs, atomicLoad as tslAtomicLoad, atomicMax, atomicStore, float, floatBitsToUint, floor, fract, instanceIndex, min, storage, uint } from "three/tsl";
import type { Node } from "../materials/common";
import { rotateQ, type LaneValues } from "./context";

const atomicLoad = (p: Node): Node => tslAtomicLoad(p) as unknown as Node;

/** The bucket a picked particle (seed < ratio) competes in; the highest seed in a bucket wins it. */
export function lightBucket(seed: number, ratio: number, max: number): number {
  return Math.min(max - 1, Math.floor((seed / ratio) * max));
}

/** Floats per light record: position xyz, size, velocity xyz, age01, colour rgba. */
export const LIGHT_RECORD = 12;

export interface LightGatherSource {
  attrs: readonly THREE.StorageInstancedBufferAttribute[];
  capacity: number;
  laneCap: number;
  lanes: number;
  local: boolean;
  lane: (lane: Node) => LaneValues;
}

/** One lane's gathered lights: `count` records of LIGHT_RECORD floats (filled buckets, in bucket order). */
export interface LaneLights {
  count: number;
  records: Float32Array;
}

export class GpuLightGather {
  readonly ratio: number;
  readonly max: number;
  readonly #stride: number;
  readonly #attr: THREE.StorageBufferAttribute;
  readonly #readback: THREE.ReadbackBuffer;
  readonly #reset: Node;
  readonly #pick: Node;
  readonly #write: Node;
  #reading = false;
  #disposed = false;

  constructor(src: LightGatherSource, ratio: number, max: number) {
    this.ratio = ratio;
    this.max = max;
    // per lane: `max` bucket keys, then `max` records
    const stride = (this.#stride = max * (1 + LIGHT_RECORD));
    const n = src.lanes * stride;
    const attr = (this.#attr = new THREE.StorageBufferAttribute(new Uint32Array(n), 1));
    this.#readback = new THREE.ReadbackBuffer(n * 4);

    // keys of every lane's buckets (thread = lane × max + bucket)
    this.#reset = Fn(() => {
      const i = instanceIndex;
      atomicStore(storage(attr, "uint", n).toAtomic().element(i.div(uint(max)).mul(stride).add(i.mod(uint(max)))), uint(0));
    })().compute(src.lanes * max);

    const L = src.laneCap;
    const [A, B, C, D] = src.attrs.map((a) => storage(a, "vec4", src.capacity).toReadOnly());
    // a picked particle's bucket, and its key (seed bits + 1: never 0, which marks an empty bucket)
    const pick = (b: Node) => {
      const seed: Node = fract(b.w);
      const bucket: Node = min(floor(seed.div(ratio).mul(max)), float(max - 1)).toUint();
      return { picked: seed.lessThan(ratio), bucket, key: (floatBitsToUint(seed) as unknown as Node).add(1) };
    };
    this.#pick = Fn(() => {
      const i = instanceIndex;
      const a: Node = A.element(i);
      const p = pick(B.element(i));
      If(a.w.lessThan(1).and(p.picked), () => {
        const buf = storage(attr, "uint", n).toAtomic();
        atomicMax(buf.element(i.div(uint(L)).mul(stride).add(p.bucket)), p.key);
      });
    })().compute(src.capacity);
    this.#write = Fn(() => {
      const i = instanceIndex;
      const a: Node = A.element(i).toVar();
      const b: Node = B.element(i).toVar();
      const p = pick(b);
      If(a.w.lessThan(1).and(p.picked), () => {
        const lane: Node = i.div(uint(L)).toVar();
        const buf = storage(attr, "uint", n).toAtomic();
        const base: Node = lane.mul(stride).toVar();
        // only the bucket's winner writes
        If(atomicLoad(buf.element(base.add(p.bucket))).equal(p.key), () => {
          const k: Node = p.bucket;
          let pos: Node = a.xyz;
          let vel: Node = b.xyz;
          let size: Node = abs(C.element(i).x);
          if (src.local) {
            const u = src.lane(lane);
            pos = rotateQ(u.rotation, a.xyz.mul(u.scale)).add(u.position);
            vel = rotateQ(u.rotation, b.xyz.mul(u.scale));
            size = size.mul(u.scale);
          }
          const d: Node = D.element(i);
          const o: Node = base.add(max).add(k.mul(LIGHT_RECORD)).toVar();
          [pos.x, pos.y, pos.z, size, vel.x, vel.y, vel.z, a.w, d.x, d.y, d.z, d.w].forEach((v, j) => atomicStore(buf.element(o.add(j)), floatBitsToUint(v)));
        });
      });
    })().compute(src.capacity);
  }

  get busy(): boolean {
    return this.#reading;
  }

  /** Gathers lanes [0, span) and reads them back; `done` gets each lane's lights when the read lands. */
  run(renderer: THREE.WebGPURenderer, span: number, laneCap: number, done: (lanes: LaneLights[]) => void): void {
    if (this.#reading || span === 0) return;
    renderer.compute(this.#reset, span * this.max);
    renderer.compute([this.#pick, this.#write], span * laneCap);
    this.#reading = true;
    const rb = this.#readback;
    const stride = this.#stride;
    renderer
      .getArrayBufferAsync(this.#attr, rb)
      .then(() => {
        const u = new Uint32Array(rb.buffer as ArrayBuffer, 0, span * stride).slice();
        rb.release();
        this.#reading = false;
        if (this.#disposed) {
          rb.dispose();
          return;
        }
        const f = new Float32Array(u.buffer);
        const out: LaneLights[] = [];
        const max = this.max;
        for (let l = 0; l < span; l++) {
          const o = l * stride;
          const records = new Float32Array(max * LIGHT_RECORD);
          let count = 0;
          for (let k = 0; k < max; k++) {
            if (u[o + k] === 0) continue;
            records.set(f.subarray(o + max + k * LIGHT_RECORD, o + max + (k + 1) * LIGHT_RECORD), count++ * LIGHT_RECORD);
          }
          out.push({ count, records: records.subarray(0, count * LIGHT_RECORD) });
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
    this.#pick.dispose?.();
    this.#write.dispose?.();
    if (!this.#reading) this.#readback.dispose();
  }
}
