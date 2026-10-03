// GPU ribbons: the ribbon material's segment endpoints read straight from a
// pool's buffers in the vertex shader (storage, read-only), so nothing is
// packed per segment. One instance per possible segment; invalid ones get zero
// width at the origin and draw nothing.
//
// - mode "particle": each slot has a trail ring (see trailStride); the update
//   kernel records points and how many are still live, the vertex shader
//   walks oldest → newest, then the particle itself.
// - mode "emitter": one strip per lane through its particles in spawn order,
//   which on the GPU is ring order (slot i → i + 1) up to the newest slot.

import { If, Loop, float, instanceIndex, length, max, min, normalize, select, storage, uint, vec3, vec4 } from "three/tsl";
import type * as THREE from "three/webgpu";
import type { RibbonRendererDoc } from "../../core/types";
import type { Node } from "../materials/common";
import type { RibbonEndpoint, RibbonSource } from "../materials/ribbon";
import type { LaneValues } from "./context";

/** vec4s per slot in a trail buffer: meta (head, count, live, skip newest) then the ring of points (xyz, time). */
export const trailStride = (points: number): number => points + 1;

export interface GpuRibbonBuffers {
  attrs: readonly THREE.StorageInstancedBufferAttribute[];
  capacity: number;
  laneCap: number;
  /** Lane values for a lane index node (local-space pools scale widths by the instance's scale). */
  lane: (lane: Node) => LaneValues;
  local: boolean;
}

function particleBuffers(b: GpuRibbonBuffers): Node[] {
  return b.attrs.map((a) => storage(a, "vec4", b.capacity).toReadOnly());
}

/** Unit tangent from `prev` to `next`, falling back to +Y for coincident points. */
function tangent(prev: Node, next: Node): Node {
  const d: Node = next.sub(prev);
  return select(length(d).greaterThan(1e-6), normalize(d), vec3(0, 1, 0));
}

/** Per-particle trails (ribbon mode "particle"): instance = slot × points + segment. */
export function trailRibbonSource(b: GpuRibbonBuffers, trail: THREE.StorageBufferAttribute, points: number, r: RibbonRendererDoc): RibbonSource {
  return (end): RibbonEndpoint => {
    const [A, B, C, D] = particleBuffers(b);
    const stride = trailStride(points);
    const T = storage(trail, "vec4", b.capacity * stride).toReadOnly();
    const P = uint(points);
    const slot: Node = instanceIndex.div(P).toVar();
    const s: Node = instanceIndex.mod(P);
    const a: Node = A.element(slot).toVar();
    const c: Node = C.element(slot).toVar();
    const base: Node = slot.mul(stride).toVar();
    const meta: Node = T.element(base).toVar();
    const head: Node = meta.x.toUint();
    const live: Node = meta.z;
    // history points that make up the strip (the newest is skipped when it sits on the particle), then the particle
    const m: Node = live.sub(meta.w).toVar();
    const valid: Node = a.w.lessThan(1).and(c.x.greaterThan(0)).and(float(s).lessThan(m));
    const j: Node = float(s).add(select(end, float(1), float(0))).toVar();
    const point = (k: Node): Node => {
      // k-th live point, oldest first: ring index head − (live − 1) + k
      const idx: Node = head.add(P.mul(2)).add(k.toUint()).sub(max(live, 1).toUint().sub(1)).mod(P);
      return select(k.greaterThanEqual(m), a.xyz, T.element(base.add(1).add(idx)).xyz);
    };
    const pos: Node = point(j).toVar();
    const tan: Node = tangent(point(max(j.sub(1), 0)), point(min(j.add(1), m)));
    const un: Node = m.sub(j).div(max(m, 1));
    let u: Node = un;
    if (r.uvMode === "tile") {
      // world distance from the head (the particle) back to this point
      const tile = r.uvTile && r.uvTile > 0 ? r.uvTile : 1;
      const dist: Node = float(0).toVar();
      Loop(points, ({ i }: { i: Node }) => {
        const k: Node = float(i);
        If(k.greaterThanEqual(j).and(k.lessThan(m)), () => {
          dist.addAssign(length(point(k.add(1)).sub(point(k))));
        });
      });
      u = dist.div(tile);
    }
    let width: Node = c.x;
    if (b.local) width = width.mul(b.lane(slot.div(uint(b.laneCap))).scale);
    return {
      A: vec4(select(valid, pos, vec3(0)), a.w),
      B: vec4(tan, u),
      C: vec4(select(valid, width, float(0)), B.element(slot).w, c.z, un),
      D: D.element(slot),
    };
  };
}

/** One strip per lane through its particles in spawn (ring) order (ribbon mode "emitter"): instance = slot. */
export function emitterRibbonSource(b: GpuRibbonBuffers, ctrl: () => THREE.StorageBufferAttribute, ctrlLen: number, lanesAt: number, r: RibbonRendererDoc): RibbonSource {
  return (end): RibbonEndpoint => {
    const [A, B, C, D] = particleBuffers(b);
    const L = uint(b.laneCap);
    const lane: Node = instanceIndex.div(L).toVar();
    const laneBase: Node = lane.mul(L).toVar();
    const i: Node = instanceIndex.mod(L).toVar();
    const head: Node = storage(ctrl(), "uint", ctrlLen).toReadOnly().element(lane.mul(2).add(lanesAt));
    // the newest slot: one before the ring head (which may run past laneCap until the next prep)
    const newest: Node = head.add(L).sub(1).mod(L).toVar();
    const alive = (k: Node): Node => A.element(laneBase.add(k)).w.lessThan(1).and(C.element(laneBase.add(k)).x.greaterThan(0));
    const next = (k: Node): Node => k.add(1).mod(L);
    const prev = (k: Node): Node => k.add(L).sub(1).mod(L);
    const succ: Node = next(i).toVar();
    const valid: Node = alive(i).and(alive(succ)).and(i.notEqual(newest));
    // (arithmetic, not select(end, succ, i): TSL would declare those vars inside the if/else it generates,
    // leaving them unset in the other branch)
    const e: Node = i.add(select(end, uint(1), uint(0))).mod(L).toVar();
    const pe: Node = prev(e).toVar();
    const ne: Node = next(e).toVar();
    const P = (k: Node): Node => A.element(laneBase.add(k)).xyz;
    const hasPrev: Node = alive(pe).and(pe.notEqual(newest));
    const hasNext: Node = alive(ne).and(e.notEqual(newest));
    const a: Node = A.element(laneBase.add(e)).toVar();
    const c: Node = C.element(laneBase.add(e)).toVar();
    const tan: Node = tangent(select(hasPrev, P(pe), a.xyz), select(hasNext, P(ne), a.xyz));
    // strip coordinate 0 head → 1 tail: the particle's age (exact for equal lifetimes; the CPU uses strip position)
    const un: Node = a.w;
    // tile mode: by age in seconds (the GPU has no running distance along the strip)
    const u: Node = r.uvMode === "tile" ? a.w.mul(c.z).div(r.uvTile && r.uvTile > 0 ? r.uvTile : 1) : un;
    let width: Node = c.x;
    if (b.local) width = width.mul(b.lane(lane).scale);
    return {
      A: vec4(select(valid, a.xyz, vec3(0)), a.w),
      B: vec4(tan, u),
      C: vec4(select(valid, width, float(0)), B.element(laneBase.add(e)).w, c.z, un),
      D: D.element(laneBase.add(e)),
    };
  };
}

/** TSL for the update kernel: records the particle's position into its trail and refreshes the live count. */
export function recordTrail(
  T: Node,
  slot: Node,
  points: number,
  settings: { minDistance: number; lifetime: number },
  pos: Node,
  wasNew: Node,
  now: Node,
): void {
  const stride = trailStride(points);
  const P = uint(points);
  const base: Node = slot.mul(stride).toVar();
  const meta: Node = T.element(base).toVar();
  // a particle born this frame (age 0 when the kernel started) starts a fresh trail at its birth position
  If(wasNew, () => {
    // (the point sits on the particle: skipped while drawing until it moves on)
    meta.assign(vec4(0, 1, 1, 1));
    T.element(base.add(1)).assign(vec4(pos, now));
  }).Else(() => {
    const h: Node = meta.x.toUint().toVar();
    const newest: Node = T.element(base.add(1).add(h));
    const d: Node = pos.sub(newest.xyz);
    If(d.dot(d).greaterThanEqual(settings.minDistance * settings.minDistance), () => {
      const nh: Node = h.add(1).mod(P);
      T.element(base.add(1).add(nh)).assign(vec4(pos, now));
      meta.x.assign(float(nh));
      meta.y.assign(min(meta.y.add(1), float(points)));
      meta.w.assign(1);
    }).Else(() => {
      meta.w.assign(0);
    });
  });
  // live points: newest → oldest while younger than the trail lifetime
  const live: Node = float(0).toVar();
  const open: Node = float(1).toVar();
  const idx: Node = meta.x.toUint().toVar();
  const oldest: Node = now.sub(settings.lifetime);
  Loop(points, ({ i }: { i: Node }) => {
    If(open.greaterThan(0).and(float(i).lessThan(meta.y)).and(T.element(base.add(1).add(idx)).w.greaterThanEqual(oldest)), () => {
      live.addAssign(1);
    }).Else(() => {
      open.assign(0);
    });
    idx.assign(idx.add(P).sub(1).mod(P));
  });
  meta.z.assign(live);
  T.element(base).assign(meta);
}
