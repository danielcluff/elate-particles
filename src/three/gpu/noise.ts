// The CPU simulator's Perlin noise (sim/math.ts noise3), ported to TSL with
// the same permutation table, so turbulence samples the same field on both
// backends and an effect looks the same when switched to sim: "gpu".

import * as THREE from "three/webgpu";
import { Fn, floor, int, mix, select, storage, vec3 } from "three/tsl";
import { PERM } from "../../sim/math";
import type { Node } from "../materials/common";

let permNode: Node | null = null;

/** The permutation table as a read-only storage buffer, shared by every kernel. */
function perm(): Node {
  if (!permNode) {
    const attr = new THREE.StorageBufferAttribute(Uint32Array.from(PERM), 1);
    permNode = storage(attr, "uint", 512).toReadOnly();
  }
  return permNode;
}

function grad(h: Node, x: Node, y: Node, z: Node): Node {
  const u: Node = select(h.lessThan(8), x, y);
  const v: Node = select(h.lessThan(4), y, select(h.equal(12).or(h.equal(14)), x, z));
  return select(h.bitAnd(1).equal(0), u, u.negate()).add(select(h.bitAnd(2).equal(0), v, v.negate()));
}

const fade = (t: Node): Node => t.mul(t).mul(t).mul(t.mul(t.mul(6).sub(15)).add(10));

/** Improved Perlin noise, ~[-1, 1]; matches noise3() on the CPU. */
export const noise3 = Fn(([p]: [Node]) => {
  const P: Node = perm();
  const at = (i: Node): Node => int(P.element(i));
  const fl: Node = floor(p);
  const X: Node = int(fl.x).bitAnd(255);
  const Y: Node = int(fl.y).bitAnd(255);
  const Z: Node = int(fl.z).bitAnd(255);
  const f: Node = p.sub(fl);
  const x: Node = f.x, y: Node = f.y, z: Node = f.z;
  const u: Node = fade(x), v: Node = fade(y), w: Node = fade(z);
  const A: Node = at(X).add(Y), AA: Node = at(A).add(Z), AB: Node = at(A.add(1)).add(Z);
  const B: Node = at(X.add(1)).add(Y), BA: Node = at(B).add(Z), BB: Node = at(B.add(1)).add(Z);
  const g = (i: Node, dx: number, dy: number, dz: number): Node => grad(at(i).bitAnd(15), x.sub(dx), y.sub(dy), z.sub(dz));
  // lerp(t, a, b) on the CPU == mix(a, b, t)
  return mix(
    mix(mix(g(AA, 0, 0, 0), g(BA, 1, 0, 0), u), mix(g(AB, 0, 1, 0), g(BB, 1, 1, 0), u), v),
    mix(mix(g(AA.add(1), 0, 0, 1), g(BA.add(1), 1, 0, 1), u), mix(g(AB.add(1), 0, 1, 1), g(BB.add(1), 1, 1, 1), u), v),
    w,
  );
});

/** The turbulence force field: three offset noise lookups, exactly as update.turbulence does on the CPU. */
export function turbulenceField(p: Node, o: Node): Node {
  return vec3(
    noise3(vec3(p.x.add(o), p.y, p.z)),
    noise3(vec3(p.x.add(31.4), p.y.add(o), p.z.add(17.1))),
    noise3(vec3(p.x.sub(47.2), p.y.add(9.7), p.z.add(o))),
  );
}

