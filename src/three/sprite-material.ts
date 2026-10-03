// TSL sprite material. Billboarding, size/colour over life, flipbooks and
// procedural shapes all run on the GPU; the CPU uploads 16 floats per particle.

import * as THREE from "three/webgpu";
import {
  abs,
  attribute,
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
  pow,
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
import type { EmitterTemplate } from "../sim/compile";
import { LUT_SIZE } from "../core/values";

/** Per-particle vertex layout: four vec4s, interleaved. */
export const SPRITE_STRIDE = 16;
export const SPRITE_ATTRIBUTES = {
  /** xyz world position, w normalised age */
  a: "pA",
  /** xyz world velocity, w seed */
  b: "pB",
  /** x size, y rotation, z lifetime (s), w unused */
  c: "pC",
  /** linear RGBA base colour */
  d: "pD",
} as const;

// TSL node types are loose in @types/three; keep them local.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

/** The nodes a material hook can build on (see ParticleWorldOptions.materialHook). */
export interface SpriteMaterialContext {
  material: THREE.MeshBasicNodeMaterial;
  emitter: EmitterTemplate;
  nodes: {
    /** Normalised age 0..1. */
    age: Node;
    /** Per-particle random 0..1. */
    seed: Node;
    /** Lifetime in seconds. */
    life: Node;
    /** World velocity. */
    velocity: Node;
    /** Base colour × colour over life (vec4, linear). */
    color: Node;
    /** Sprite UV after flipbook mapping. */
    uv: Node;
    /** Shape / texture sample (vec4; rgb is white for procedural shapes). */
    shape: Node;
    /** Seconds, shared by every particle material in the world. */
    time: Node;
  };
}

export interface SpriteMaterialOptions {
  time: Node;
  loadTexture: (url: string) => THREE.Texture;
  hook?: (ctx: SpriteMaterialContext) => void;
}

/** 64×2 half-float LUT: row 0 colour over life (RGBA), row 1 size over life (R). */
export function createLutTexture(tpl: EmitterTemplate): THREE.DataTexture | null {
  if (!tpl.sizeLut && !tpl.colorLut) return null;
  const data = new Uint16Array(LUT_SIZE * 2 * 4);
  const h = THREE.DataUtils.toHalfFloat;
  for (let i = 0; i < LUT_SIZE; i++) {
    for (let c = 0; c < 4; c++) data[i * 4 + c] = h(tpl.colorLut ? tpl.colorLut[i * 4 + c] : 1);
    const s = tpl.sizeLut ? tpl.sizeLut[i] : 1;
    const o = (LUT_SIZE + i) * 4;
    data[o] = h(s);
    data[o + 1] = data[o + 2] = data[o + 3] = h(1);
  }
  const tex = new THREE.DataTexture(data, LUT_SIZE, 2, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export function createSpriteMaterial(tpl: EmitterTemplate, lut: THREE.DataTexture | null, opts: SpriteMaterialOptions): THREE.MeshBasicNodeMaterial {
  const r = tpl.renderer;
  const material = new THREE.MeshBasicNodeMaterial();
  material.name = `particles:${tpl.doc.name}`;
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;

  const pA: Node = attribute(SPRITE_ATTRIBUTES.a, "vec4");
  const pB: Node = attribute(SPRITE_ATTRIBUTES.b, "vec4");
  const pC: Node = attribute(SPRITE_ATTRIBUTES.c, "vec4");
  const pD: Node = attribute(SPRITE_ATTRIBUTES.d, "vec4");

  const age: Node = pA.w;
  const seed: Node = pB.w;
  // sample texel centres so 0 and 1 hit the first and last key exactly
  const lutU: Node = age.mul((LUT_SIZE - 1) / LUT_SIZE).add(0.5 / LUT_SIZE);
  const sizeOverLife: Node = lut ? texture(lut, vec2(lutU, 0.75)).x : float(1);
  const colorOverLife: Node = lut ? texture(lut, vec2(lutU, 0.25)) : vec4(1);

  // ---- vertex: billboard in view space --------------------------------------
  const corner: Node = positionGeometry.xy;
  const size: Node = pC.x.mul(sizeOverLife);
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
    case "circle":
      shape = vec4(vec3(1), smoothstep(1, 0.85, d));
      break;
    case "glow":
      shape = vec4(vec3(1), pow(clamp(float(1).sub(d), 0, 1), 3 * softness));
      break;
    case "spark": {
      const q: Node = abs(uv().sub(0.5)).mul(2);
      shape = vec4(vec3(1), smoothstep(1, 0, q.x).mul(smoothstep(1, 0.2, q.y)));
      break;
    }
    case "ring":
      shape = vec4(vec3(1), smoothstep(0.2 * softness, 0, abs(d.sub(0.7))));
      break;
    case "square":
      shape = vec4(1);
      break;
    default:
      shape = vec4(vec3(1), pow(clamp(float(1).sub(d), 0, 1), 1.5 * softness));
  }

  // colour work per vertex (constant over a quad), shape per fragment
  const color: Node = varying(pD.mul(colorOverLife));
  const rgb: Node = color.xyz.mul(shape.xyz);
  const alpha: Node = color.w.mul(shape.w);

  switch (r.blend) {
    case "alpha":
      material.blending = THREE.NormalBlending;
      material.colorNode = rgb;
      material.opacityNode = alpha;
      break;
    case "premultiplied":
      material.blending = THREE.CustomBlending;
      material.blendEquation = THREE.AddEquation;
      material.blendSrc = THREE.OneFactor;
      material.blendDst = THREE.OneMinusSrcAlphaFactor;
      material.colorNode = rgb.mul(alpha);
      material.opacityNode = alpha;
      break;
    default:
      material.blending = THREE.AdditiveBlending;
      material.colorNode = rgb;
      material.opacityNode = alpha;
  }

  opts.hook?.({
    material,
    emitter: tpl,
    nodes: { age, seed, life: pC.z, velocity: pB.xyz, color, uv: spriteUv, shape, time: opts.time },
  });
  return material;
}
