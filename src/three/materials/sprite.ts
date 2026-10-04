// Camera-facing / velocity-stretched / horizontal sprites. Billboarding,
// size/colour over life, flipbooks and procedural shapes all run on the GPU.

import * as THREE from "three/webgpu";
import {
  abs,
  cameraProjectionMatrix,
  clamp,
  cos,
  float,
  floor,
  length,
  max,
  min,
  mod,
  modelViewMatrix,
  positionGeometry,
  select,
  sin,
  smoothstep,
  texture,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import type { SpriteRendererDoc } from "../../core/types";
import type { EmitterTemplate } from "../../sim/compile";
import { applyBlend, depthFades, overLife, particleAttributes, radialMask, whiteWithAlpha, type MaterialOptions, type Node } from "./common";

export function createSpriteMaterial(tpl: EmitterTemplate, r: SpriteRendererDoc, lut: THREE.DataTexture | null, opts: MaterialOptions): THREE.MeshBasicNodeMaterial {
  const material = new THREE.MeshBasicNodeMaterial();
  material.name = `particles:${tpl.doc.name}:${r.type}`;
  material.side = THREE.DoubleSide;

  const { pA, pB, pC, pD } = particleAttributes();
  const age: Node = pA.w;
  const seed: Node = pB.w;
  const ol = overLife(lut, age);

  // ---- vertex: billboard in view space --------------------------------------
  const corner: Node = positionGeometry.xy;
  // (GPU pools hide distance-culled instances with a negative size)
  const size: Node = max(pC.x, 0).mul(ol.size);
  const rot: Node = pC.y;
  const c: Node = cos(rot);
  const s: Node = sin(rot);
  const rotated: Node = vec2(corner.x.mul(c).sub(corner.y.mul(s)), corner.x.mul(s).add(corner.y.mul(c))).mul(size);

  let viewPos: Node;
  if (r.facing === "horizontal") {
    viewPos = modelViewMatrix.mul(vec4(pA.xyz.add(vec3(rotated.x, 0, rotated.y)), 1)).xyz;
  } else if (r.facing === "velocity") {
    const center: Node = modelViewMatrix.mul(vec4(pA.xyz, 1)).xyz;
    const v: Node = modelViewMatrix.mul(vec4(pB.xyz, 0)).xy;
    const speed: Node = length(v);
    const dir: Node = select(speed.greaterThan(1e-4), v.div(max(speed, 1e-4)), vec2(0, 1));
    const perp: Node = vec2(dir.y.negate(), dir.x);
    const len: Node = size.add(speed.mul(uniform(r.stretch ?? 0.1)));
    viewPos = center.add(vec3(perp.mul(corner.x.mul(size)).add(dir.mul(corner.y.mul(len))), 0));
  } else {
    const center: Node = modelViewMatrix.mul(vec4(pA.xyz, 1)).xyz;
    viewPos = center.add(vec3(rotated, 0));
  }
  material.vertexNode = cameraProjectionMatrix.mul(vec4(viewPos, 1));

  // ---- fragment --------------------------------------------------------------
  let spriteUv: Node = uv();
  const fb = r.flipbook;
  if (fb && fb.cols * fb.rows > 1) {
    const frames = fb.cols * fb.rows;
    let frame: Node;
    if (fb.mode === "fps") frame = floor(mod(opts.time.mul(fb.fps ?? 15).add(seed.mul(frames)), frames));
    else if (fb.mode === "random") frame = floor(seed.mul(frames));
    else frame = min(floor(age.mul(frames)), frames - 1);
    // computed per vertex; frame is constant across the quad
    frame = varying(frame);
    const col: Node = mod(frame, fb.cols);
    const row: Node = float(fb.rows - 1).sub(floor(frame.div(fb.cols)));
    spriteUv = spriteUv.add(vec2(col, row)).div(vec2(fb.cols, fb.rows));
  }

  const d: Node = length(uv().sub(0.5)).mul(2);
  const softness = r.softness ?? 1;
  let shape: Node;
  switch (r.shape) {
    case "texture":
      shape = r.texture ? texture(opts.loadTexture(r.texture), spriteUv) : vec4(1);
      break;
    case "spark": {
      const q: Node = abs(uv().sub(0.5)).mul(2);
      shape = whiteWithAlpha(smoothstep(1, 0, q.x).mul(smoothstep(1, 0.2, q.y)));
      break;
    }
    case "ring":
      shape = whiteWithAlpha(smoothstep(0.2 * softness, 0, abs(d.sub(0.7))));
      break;
    default:
      shape = whiteWithAlpha(radialMask(r.shape, d, softness));
  }

  // colour work per vertex (constant over a quad), shape per fragment
  const color: Node = varying(pD.mul(ol.color));
  const nodes = { age, seed, life: pC.z, velocity: pB.xyz, color, uv: spriteUv, shape, time: opts.time };
  let rgb: Node = color.xyz.mul(shape.xyz);
  let alpha: Node = color.w.mul(shape.w);
  // a shader graph replaces colour and/or opacity (soft-particle fades still apply on top)
  const shader = r.material?.kind === "graph" ? opts.shader?.(r.material.shaderId) : undefined;
  if (shader) {
    const out = shader(nodes);
    if (out.color) rgb = out.color;
    if (out.opacity) alpha = clamp(out.opacity, 0, 1);
  }
  const fade = depthFades(r, varying(viewPos.z));
  if (fade) alpha = alpha.mul(fade);
  applyBlend(material, r.blend, rgb, alpha);

  opts.hook?.({
    renderer: "sprite",
    rendererDoc: r,
    material,
    emitter: tpl,
    nodes,
  });
  return material;
}
