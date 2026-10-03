// Pieces shared by the sprite, mesh and ribbon materials.

import * as THREE from "three/webgpu";
import { attribute, cameraFar, cameraNear, clamp, float, pow, smoothstep, texture, vec2, vec3, vec4, viewportLinearDepth } from "three/tsl";
import type { EmitterTemplate } from "../../sim/compile";
import type { BlendMode, RendererDoc, RendererType } from "../../core/types";
import { LUT_SIZE } from "../../core/values";

// TSL node types are loose in @types/three; keep them local.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Node = any;

/**
 * Per-particle instance layout for sprites and meshes: four interleaved vec4s.
 * (Ribbons pack per segment instead, see materials/ribbon.ts.)
 */
export const PARTICLE_STRIDE = 16;
export const PARTICLE_ATTRIBUTES = {
  /** xyz world position, w normalised age */
  a: "pA",
  /** xyz world velocity, w seed */
  b: "pB",
  /** x size, y rotation, z lifetime (s), w unused */
  c: "pC",
  /** linear RGBA base colour */
  d: "pD",
} as const;

/** The nodes a material hook can build on (see ParticleWorldOptions.materialHook). */
export interface ParticleMaterialContext {
  renderer: RendererType;
  /** The renderer being built (an emitter can have several). */
  rendererDoc: RendererDoc;
  material: THREE.NodeMaterial;
  emitter: EmitterTemplate;
  nodes: {
    /** Normalised age 0..1. */
    age: Node;
    /** Per-particle random 0..1. */
    seed: Node;
    /** Lifetime in seconds. */
    life: Node;
    /** World velocity (sprites, meshes; zero for ribbons). */
    velocity: Node;
    /** Base colour × colour over life (vec4, linear). */
    color: Node;
    /** Sprite: UV after flipbook mapping. Mesh: geometry UV. Ribbon: (u along, v across). */
    uv: Node;
    /** Shape / texture sample (vec4; rgb is white for procedural shapes). */
    shape: Node;
    /** Seconds, shared by every particle material in the world. */
    time: Node;
  };
}

export interface MaterialOptions {
  time: Node;
  loadTexture: (url: string) => THREE.Texture;
  hook?: (ctx: ParticleMaterialContext) => void;
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

/** Size and colour multipliers sampled from the over-life LUT at normalised `age`. */
export function overLife(lut: THREE.DataTexture | null, age: Node): { size: Node; color: Node } {
  if (!lut) return { size: float(1), color: vec4(1) };
  // sample texel centres so 0 and 1 hit the first and last key exactly
  const u: Node = age.mul((LUT_SIZE - 1) / LUT_SIZE).add(0.5 / LUT_SIZE);
  return { size: texture(lut, vec2(u, 0.75)).x, color: texture(lut, vec2(u, 0.25)) };
}

/** The four per-particle attributes (sprites and meshes). */
export function particleAttributes(): { pA: Node; pB: Node; pC: Node; pD: Node } {
  return {
    pA: attribute(PARTICLE_ATTRIBUTES.a, "vec4"),
    pB: attribute(PARTICLE_ATTRIBUTES.b, "vec4"),
    pC: attribute(PARTICLE_ATTRIBUTES.c, "vec4"),
    pD: attribute(PARTICLE_ATTRIBUTES.d, "vec4"),
  };
}

/** Radial falloff masks from a normalised distance `d` (0 centre, 1 edge). */
export function radialMask(shape: string, d: Node, softness: number): Node {
  switch (shape) {
    case "circle":
      return smoothstep(1, 0.85, d);
    case "glow":
      return pow(clamp(float(1).sub(d), 0, 1), 3 * softness);
    case "square":
      return float(1);
    default:
      return pow(clamp(float(1).sub(d), 0, 1), 1.5 * softness);
  }
}

export function whiteWithAlpha(a: Node): Node {
  return vec4(vec3(1), a);
}

/**
 * Alpha multiplier for soft particles (`depthFade`) and near-camera fading
 * (`cameraFade`), or null when neither is on. `viewZ` is the fragment's
 * view-space z (negative in front of the camera).
 *
 * Scene depth comes from three's shared `viewportLinearDepth`: one copy of the
 * depth buffer per render, taken when the first transparent material that needs
 * it draws (after opaques, so it holds opaque geometry only).
 */
export function depthFades(r: { depthFade?: number; cameraFade?: number }, viewZ: Node): Node | null {
  const dist: Node = viewZ.negate();
  let f: Node | null = null;
  if (r.depthFade && r.depthFade > 0) {
    // linear depth is 0..1 between near and far (perspective and orthographic alike)
    const sceneDist: Node = cameraNear.add(viewportLinearDepth.mul(cameraFar.sub(cameraNear)));
    f = clamp(sceneDist.sub(dist).div(r.depthFade), 0, 1);
  }
  if (r.cameraFade && r.cameraFade > 0) {
    const c: Node = clamp(dist.sub(cameraNear).div(r.cameraFade), 0, 1);
    f = f ? f.mul(c) : c;
  }
  return f;
}

/** Configures blending and assigns colour/opacity for `blend`. */
export function applyBlend(material: THREE.NodeMaterial, blend: BlendMode, rgb: Node, alpha: Node): void {
  material.transparent = blend !== "opaque";
  material.depthWrite = blend === "opaque";
  switch (blend) {
    case "opaque":
      material.blending = THREE.NormalBlending;
      material.colorNode = rgb;
      break;
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
}
