// Instanced meshes per particle (debris, shards, rocks). Same per-particle
// data as sprites; the instance transform is built in the vertex shader from
// position, size (× size over life), rotation and an orientation mode.

import * as THREE from "three/webgpu";
import { Fn, cos, cross, dot, hash, max, normalGeometry, normalLocal, normalize, positionGeometry, select, sin, texture, uv, varying, vec3, vec4 } from "three/tsl";
import type { MeshRendererDoc } from "../../core/types";
import type { EmitterTemplate } from "../../sim/compile";
import { applyBlend, overLife, particleAttributes, type MaterialOptions, type Node } from "./common";

/** Rodrigues rotation of `v` around unit axis `k` by `angle`. */
function rotateAxis(v: Node, k: Node, angle: Node): Node {
  const c: Node = cos(angle);
  return v.mul(c).add(cross(k, v).mul(sin(angle))).add(k.mul(dot(k, v).mul(c.oneMinus())));
}

/** Rotates `v` by the rotation taking +Y to unit `d`. */
function alignY(v: Node, d: Node): Node {
  // axis × sin = Y × d = (d.z, 0, -d.x); cos = d.y
  const c: Node = vec3(d.z, 0, d.x.negate());
  const s2: Node = dot(c, c);
  const rotated: Node = v.mul(d.y).add(cross(c, v)).add(c.mul(dot(c, v).mul(d.y.oneMinus()).div(max(s2, 1e-8))));
  // d ≈ ±Y: identity, or a half turn about X
  const flipped: Node = select(d.y.greaterThan(0), v, vec3(v.x, v.y.negate(), v.z.negate()));
  return select(s2.greaterThan(1e-6), rotated, flipped);
}

export function createMeshMaterial(tpl: EmitterTemplate, r: MeshRendererDoc, lut: THREE.DataTexture | null, opts: MaterialOptions): THREE.NodeMaterial {
  let material: THREE.NodeMaterial;
  if (r.lit) {
    const m = new THREE.MeshStandardNodeMaterial();
    m.roughness = r.roughness ?? 0.6;
    m.metalness = r.metalness ?? 0;
    material = m;
  } else {
    material = new THREE.MeshBasicNodeMaterial();
  }
  material.name = `particles:${tpl.doc.name}:${r.type}`;

  const { pA, pB, pC, pD } = particleAttributes();
  const age: Node = pA.w;
  const seed: Node = pB.w;
  const ol = overLife(lut, age);
  // (GPU pools hide distance-culled instances with a negative size)
  const size: Node = max(pC.x, 0).mul(ol.size);
  const rot: Node = pC.y;

  const orient = (v: Node): Node => {
    if (r.orientation === "fixed") return rotateAxis(v, vec3(0, 1, 0), rot);
    if (r.orientation === "velocity") {
      const vel: Node = pB.xyz;
      const speed2: Node = dot(vel, vel);
      const dir: Node = select(speed2.greaterThan(1e-8), normalize(vel), vec3(0, 1, 0));
      return alignY(rotateAxis(v, vec3(0, 1, 0), rot), dir);
    }
    // random: a fixed per-particle tumble axis derived from the seed
    const axis: Node = normalize(vec3(hash(seed.mul(1013.1)), hash(seed.mul(2027.3).add(0.37)), hash(seed.mul(3041.7).add(0.71))).mul(2).sub(1).add(vec3(0, 1e-3, 0)));
    return rotateAxis(v, axis, rot);
  };

  // the batch mesh sits at the world origin, so local space == world space
  material.positionNode = Fn(() => {
    if (r.lit) normalLocal.assign(orient(normalGeometry));
    return pA.xyz.add(orient(positionGeometry.mul(size)));
  })();

  const shape: Node = r.texture ? texture(opts.loadTexture(r.texture), uv()) : vec4(1);
  const color: Node = varying(pD.mul(ol.color));
  applyBlend(material, r.blend, color.xyz.mul(shape.xyz), color.w.mul(shape.w));

  opts.hook?.({
    renderer: "mesh",
    rendererDoc: r,
    material,
    emitter: tpl,
    nodes: { age, seed, life: pC.z, velocity: pB.xyz, color, uv: uv(), shape, time: opts.time },
  });
  return material;
}
