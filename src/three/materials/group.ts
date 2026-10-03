// Sort-group material: one sprite shader for many sprite renderers, so their
// particles can share a draw call and be depth-sorted together. Everything
// that differs per renderer (over-life curves, shape, facing, softness,
// stretch, additive vs alpha, fades, flipbook) lives in a table texture; each
// particle carries its member index in pC.w. Blending is premultiplied
// (One, OneMinusSrcAlpha), which expresses both alpha (rgb·a, a) and additive
// (rgb·a, 0) output in one blend state.

import * as THREE from "three/webgpu";
import {
  abs,
  cameraFar,
  cameraNear,
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
  pow,
  select,
  sin,
  smoothstep,
  texture,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
  viewportLinearDepth,
} from "three/tsl";
import { LUT_SIZE } from "../../core/values";
import { particleAttributes, type MaterialOptions, type Node } from "./common";

/** Table rows per member: colour-over-life, size-over-life, parameters. */
export const GROUP_ROWS_PER_MEMBER = 3;

/** Shape and facing ids stored in the parameter row. */
export const GROUP_SHAPES = ["softCircle", "circle", "glow", "spark", "ring", "square", "texture"] as const;
export const GROUP_FACINGS = ["camera", "velocity", "horizontal"] as const;
export const GROUP_FLIPBOOK_MODES = ["none", "overLife", "fps", "random"] as const;

/**
 * @param table LUT_SIZE × (rows) half-float RGBA table (see SortGroup)
 * @param rows table height in texels
 * @param map shared texture for members with shape "texture", if any
 */
export function createGroupMaterial(name: string, table: THREE.DataTexture, rows: number, map: THREE.Texture | null, opts: MaterialOptions): THREE.MeshBasicNodeMaterial {
  const material = new THREE.MeshBasicNodeMaterial();
  material.name = `particles:group:${name}`;
  material.side = THREE.DoubleSide;
  material.transparent = true;
  material.depthWrite = false;
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneMinusSrcAlphaFactor;

  const rowV = (mi: Node, r: number): Node => mi.mul(GROUP_ROWS_PER_MEMBER).add(r + 0.5).div(rows);
  const texel = (k: number) => (k + 0.5) / LUT_SIZE;
  const param = (mi: Node, k: number): Node => texture(table, vec2(texel(k), rowV(mi, 2)));

  const { pA, pB, pC, pD } = particleAttributes();
  const mi: Node = pC.w;
  const age: Node = pA.w;
  const seed: Node = pB.w;
  const p0: Node = param(mi, 0); // shape, facing, softness, stretch
  const p2: Node = param(mi, 2); // flipbook cols, rows, mode, fps
  const lutU: Node = age.mul((LUT_SIZE - 1) / LUT_SIZE).add(0.5 / LUT_SIZE);
  const sizeOL: Node = texture(table, vec2(lutU, rowV(mi, 1))).x;
  const colorOL: Node = texture(table, vec2(lutU, rowV(mi, 0)));

  // ---- vertex: the three sprite facings, picked per member ------------------
  const corner: Node = positionGeometry.xy;
  // (GPU pools hide distance-culled instances with a negative size)
  const size: Node = max(pC.x, 0).mul(sizeOL);
  const rot: Node = pC.y;
  const c: Node = cos(rot);
  const s: Node = sin(rot);
  const rotated: Node = vec2(corner.x.mul(c).sub(corner.y.mul(s)), corner.x.mul(s).add(corner.y.mul(c))).mul(size);
  const center: Node = modelViewMatrix.mul(vec4(pA.xyz, 1)).xyz;

  const camView: Node = center.add(vec3(rotated, 0));
  const v: Node = modelViewMatrix.mul(vec4(pB.xyz, 0)).xy;
  const speed: Node = length(v);
  const dir: Node = select(speed.greaterThan(1e-4), v.div(max(speed, 1e-4)), vec2(0, 1));
  const perp: Node = vec2(dir.y.negate(), dir.x);
  const len: Node = size.add(speed.mul(p0.w));
  const velView: Node = center.add(vec3(perp.mul(corner.x.mul(size)).add(dir.mul(corner.y.mul(len))), 0));
  const horView: Node = modelViewMatrix.mul(vec4(pA.xyz.add(vec3(rotated.x, 0, rotated.y)), 1)).xyz;
  const facing: Node = p0.y;
  const viewPos: Node = select(facing.lessThan(0.5), camView, select(facing.lessThan(1.5), velView, horView));
  material.vertexNode = cameraProjectionMatrix.mul(vec4(viewPos, 1));

  // flipbook frame per vertex (constant over the quad): (col, row, cols, rows)
  const cols: Node = max(p2.x, 1);
  const fbRows: Node = max(p2.y, 1);
  const frames: Node = cols.mul(fbRows);
  const mode: Node = p2.z;
  const fOver: Node = min(floor(age.mul(frames)), frames.sub(1));
  const fFps: Node = floor(mod(opts.time.mul(p2.w).add(seed.mul(frames)), frames));
  const fRnd: Node = floor(seed.mul(frames));
  const frame: Node = select(mode.lessThan(1.5), fOver, select(mode.lessThan(2.5), fFps, fRnd));
  const fb: Node = varying(vec4(mod(frame, cols), fbRows.sub(1).sub(floor(frame.div(cols))), cols, fbRows));
  const miV: Node = varying(mi);
  const viewZ: Node = varying(viewPos.z);
  const color: Node = varying(pD.mul(colorOL));

  // ---- fragment --------------------------------------------------------------
  const f0: Node = param(miV, 0);
  const f1: Node = param(miV, 1); // additive, depthFade, cameraFade
  const shapeId: Node = f0.x;
  const soft: Node = f0.z;
  const spriteUv: Node = uv().add(fb.xy).div(fb.zw);
  const d: Node = length(uv().sub(0.5)).mul(2);
  const q: Node = abs(uv().sub(0.5)).mul(2);
  const fall: Node = clamp(float(1).sub(d), 0, 1);
  const tex: Node = map ? texture(map, spriteUv) : vec4(1);
  const masks: Node[] = [
    pow(fall, soft.mul(1.5)), // softCircle
    smoothstep(1, 0.85, d), // circle
    pow(fall, soft.mul(3)), // glow
    smoothstep(1, 0, q.x).mul(smoothstep(1, 0.2, q.y)), // spark
    smoothstep(soft.mul(0.2), 0, abs(d.sub(0.7))), // ring
    float(1), // square
    tex.w, // texture
  ];
  let mask: Node = masks[masks.length - 1];
  for (let k = masks.length - 2; k >= 0; k--) mask = select(shapeId.lessThan(k + 0.5), masks[k], mask);
  const shapeRgb: Node = select(shapeId.greaterThan(5.5), tex.xyz, vec3(1));

  // soft particles / camera fade, per member (0 = off)
  const dist: Node = viewZ.negate();
  const sceneDist: Node = cameraNear.add(viewportLinearDepth.mul(cameraFar.sub(cameraNear)));
  const depthFade: Node = select(f1.y.greaterThan(0), clamp(sceneDist.sub(dist).div(max(f1.y, 1e-4)), 0, 1), float(1));
  const camFade: Node = select(f1.z.greaterThan(0), clamp(dist.sub(cameraNear).div(max(f1.z, 1e-4)), 0, 1), float(1));

  const alpha: Node = color.w.mul(mask).mul(depthFade).mul(camFade);
  material.colorNode = color.xyz.mul(shapeRgb).mul(alpha);
  // additive members keep their colour but don't occlude what is behind them
  material.opacityNode = alpha.mul(float(1).sub(f1.x));
  return material;
}
