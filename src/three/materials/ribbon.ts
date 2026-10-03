// Ribbons: one instanced quad per segment between consecutive particles.
// The CPU writes both endpoints of every segment (position, smoothed tangent,
// texture u, width, colour), so adjacent segments compute identical edge
// vertices and the strip has no seams. Segments are only written within a
// ribbon, so every instance's ribbon shares one draw call.

import * as THREE from "three/webgpu";
import { abs, attribute, cameraProjectionMatrix, cross, length, modelViewMatrix, normalize, positionGeometry, select, texture, uv, varying, vec2, vec3, vec4 } from "three/tsl";
import type { RibbonRendererDoc } from "../../core/types";
import type { EmitterTemplate } from "../../sim/compile";
import { applyBlend, overLife, radialMask, whiteWithAlpha, type MaterialOptions, type Node } from "./common";

/**
 * Per-segment instance layout: two endpoints × four vec4s.
 *   A: xyz world position, w normalised age
 *   B: xyz world tangent (unit), w texture u
 *   C: x width (particle size), y seed, z lifetime, w strip coordinate (0 head → 1 tail)
 *   D: linear RGBA base colour
 */
export const RIBBON_STRIDE = 32;
export const RIBBON_ATTRIBUTES = ["rA0", "rB0", "rC0", "rD0", "rA1", "rB1", "rC1", "rD1"] as const;

export function createRibbonMaterial(tpl: EmitterTemplate, lut: THREE.DataTexture | null, opts: MaterialOptions): THREE.MeshBasicNodeMaterial {
  const r = tpl.renderer as RibbonRendererDoc;
  const material = new THREE.MeshBasicNodeMaterial();
  material.name = `particles:${tpl.doc.name}`;
  material.side = THREE.DoubleSide;

  // which end of the segment this vertex belongs to (quad y is ±0.5)
  const end: Node = positionGeometry.y.greaterThan(0);
  const pick = (i: number): Node => select(end, attribute(RIBBON_ATTRIBUTES[i + 4], "vec4"), attribute(RIBBON_ATTRIBUTES[i], "vec4"));
  const A: Node = pick(0);
  const B: Node = pick(1);
  const C: Node = pick(2);
  const D: Node = pick(3);

  const age: Node = A.w;
  const ol = overLife(lut, age);
  const tail: Node = C.w;
  const taper = r.taper ?? 0;
  const fade = r.fade ?? 0;
  const halfWidth: Node = C.x
    .mul(ol.size)
    .mul(taper > 0 ? tail.mul(-taper).add(1) : 1)
    .mul(positionGeometry.x); // x is ±0.5

  let viewPos: Node;
  if (r.facing === "horizontal") {
    const side: Node = cross(B.xyz, vec3(0, 1, 0));
    const s: Node = select(length(side).greaterThan(1e-5), normalize(side), vec3(1, 0, 0));
    viewPos = modelViewMatrix.mul(vec4(A.xyz.add(s.mul(halfWidth)), 1)).xyz;
  } else {
    const center: Node = modelViewMatrix.mul(vec4(A.xyz, 1)).xyz;
    const tangent: Node = modelViewMatrix.mul(vec4(B.xyz, 0)).xyz;
    // perpendicular to both the ribbon and the view ray: always faces the camera
    const side: Node = tangent.cross(center.normalize());
    const s: Node = select(length(side).greaterThan(1e-5), normalize(side), vec3(1, 0, 0));
    viewPos = center.add(s.mul(halfWidth));
  }
  material.vertexNode = cameraProjectionMatrix.mul(vec4(viewPos, 1));

  const u: Node = varying(B.w);
  const v: Node = uv().x;
  const ribbonUv: Node = vec2(u, v);
  const shape: Node =
    r.shape === "texture"
      ? r.texture
        ? texture(opts.loadTexture(r.texture), ribbonUv)
        : vec4(1)
      : whiteWithAlpha(radialMask(r.shape, abs(v.sub(0.5)).mul(2), r.softness ?? 1));

  let color: Node = D.mul(ol.color);
  if (fade > 0) color = color.mul(vec4(1, 1, 1, tail.mul(-fade).add(1)));
  color = varying(color);
  applyBlend(material, r.blend, color.xyz.mul(shape.xyz), color.w.mul(shape.w));

  opts.hook?.({
    renderer: "ribbon",
    material,
    emitter: tpl,
    nodes: { age, seed: C.y, life: C.z, velocity: vec3(0), color, uv: ribbonUv, shape, time: opts.time },
  });
  return material;
}
