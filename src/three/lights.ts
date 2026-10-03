// Per-particle lights: a fixed pool of PointLights shared by every effect in
// a ParticleWorld. Light renderers offer candidates each frame (CPU emitters
// from their particles, GPU emitters from a small gather read back from the
// GPU); the pool keeps the most important ones and turns the rest off.
//
// The pool size never changes: in three, adding or removing lights changes
// the lighting hash and recompiles every lit material. Unused lights are kept
// in the scene at intensity 0 instead. (With many lights, consider three's
// DynamicLighting or TiledLighting: lights cost per-fragment work for every lit
// material whether or not they are bright.)

import * as THREE from "three/webgpu";
import type { LightRendererDoc } from "../core/types";
import { LUT_SIZE } from "../core/values";
import type { EmitterTemplate } from "../sim/compile";
import type { SortView } from "./batch";

/** Floats per candidate: x y z, r g b, intensity, range, score. */
const STRIDE = 9;

export class ParticleLights {
  readonly lights: THREE.PointLight[];
  readonly object = new THREE.Group();
  #cand = new Float32Array(64 * STRIDE);
  #n = 0;
  #order: number[] = [];
  #active = 0;
  #view: SortView | null = null;

  constructor(max: number) {
    this.object.name = "particles:lights";
    this.lights = Array.from({ length: max }, (_, i) => {
      const l = new THREE.PointLight(0xffffff, 0, 1, 2);
      l.name = `particles:light:${i}`;
      l.castShadow = false;
      this.object.add(l);
      return l;
    });
  }

  get max(): number {
    return this.lights.length;
  }

  /** Lights lit last frame. */
  get active(): number {
    return this.#active;
  }

  /** Candidates offered last frame (before the pool's cap). */
  get candidates(): number {
    return this.#n;
  }

  begin(view: SortView | null): void {
    this.#n = 0;
    this.#view = view;
  }

  /**
   * Offers a light. Its importance is its intensity, weakened by how far the
   * camera is relative to its range (so a near, modest light can beat a
   * distant bright one); without a camera, intensity alone.
   */
  add(x: number, y: number, z: number, r: number, g: number, b: number, intensity: number, range: number): void {
    if (!(intensity > 0)) return;
    if ((this.#n + 1) * STRIDE > this.#cand.length) {
      const next = new Float32Array(this.#cand.length * 2);
      next.set(this.#cand);
      this.#cand = next;
    }
    let score = intensity;
    const v = this.#view;
    if (v) {
      const dx = x - v.px, dy = y - v.py, dz = z - v.pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      const reach = Math.max(range, 1e-3);
      score = intensity / (1 + d2 / (reach * reach));
    }
    const c = this.#cand;
    const o = this.#n++ * STRIDE;
    c[o] = x;
    c[o + 1] = y;
    c[o + 2] = z;
    c[o + 3] = r;
    c[o + 4] = g;
    c[o + 5] = b;
    c[o + 6] = intensity;
    c[o + 7] = range;
    c[o + 8] = score;
  }

  /** Lights the most important candidates; the rest of the pool goes dark. */
  end(): void {
    const n = this.#n;
    const max = this.lights.length;
    const c = this.#cand;
    const order = this.#order;
    order.length = n;
    for (let i = 0; i < n; i++) order[i] = i;
    if (n > max) order.sort((a, b) => c[b * STRIDE + 8] - c[a * STRIDE + 8]);
    const lit = Math.min(n, max);
    for (let k = 0; k < max; k++) {
      const l = this.lights[k];
      if (k >= lit) {
        l.intensity = 0;
        continue;
      }
      const o = order[k] * STRIDE;
      l.position.set(c[o], c[o + 1], c[o + 2]);
      l.color.setRGB(c[o + 3], c[o + 4], c[o + 5], THREE.LinearSRGBColorSpace);
      l.intensity = c[o + 6];
      l.distance = c[o + 7];
    }
    this.#active = lit;
  }

  dispose(): void {
    this.object.removeFromParent();
    for (const l of this.lights) l.dispose();
  }
}

/** A light renderer resolved against its emitter: fixed colour, LUTs. */
export interface LightSource {
  r: LightRendererDoc;
  /** Linear RGB when not using the particle's colour. */
  fixed: [number, number, number] | null;
  colorLut: Float32Array | null;
  sizeLut: Float32Array | null;
}

export function lightSource(tpl: EmitterTemplate, r: LightRendererDoc): LightSource {
  let fixed: [number, number, number] | null = null;
  if (r.useParticleColor === false) {
    const c = new THREE.Color(r.color ?? "#ffffff");
    fixed = [c.r, c.g, c.b];
  }
  return { r, fixed, colorLut: tpl.colorLut, sizeLut: tpl.sizeLut };
}

const lut1 = (lut: Float32Array, t: number, stride: number, ch: number): number => {
  const x = Math.min(1, Math.max(0, t)) * (LUT_SIZE - 1);
  const i = Math.min(LUT_SIZE - 2, x | 0);
  const f = x - i;
  return lut[i * stride + ch] * (1 - f) + lut[(i + 1) * stride + ch] * f;
};

/**
 * Offers one particle's light: colour × colour over life (or the fixed
 * colour), intensity × alpha (× alpha over life) unless disabled, range ×
 * size (× size over life) when asked.
 */
export function offerParticleLight(
  out: ParticleLights,
  s: LightSource,
  x: number,
  y: number,
  z: number,
  r: number,
  g: number,
  b: number,
  a: number,
  size: number,
  age01: number,
): void {
  const L = s.r;
  let cr = 1, cg = 1, cb = 1, ca = 1;
  const cl = s.colorLut;
  if (cl) {
    cr = lut1(cl, age01, 4, 0);
    cg = lut1(cl, age01, 4, 1);
    cb = lut1(cl, age01, 4, 2);
    ca = lut1(cl, age01, 4, 3);
  }
  if (s.fixed) {
    r = s.fixed[0];
    g = s.fixed[1];
    b = s.fixed[2];
  } else {
    r *= cr;
    g *= cg;
    b *= cb;
  }
  let intensity = L.intensity;
  if (L.alphaAffectsIntensity !== false) intensity *= Math.max(0, a * ca);
  let range = L.range;
  if (L.sizeAffectsRange) range *= Math.max(0, size) * (s.sizeLut ? lut1(s.sizeLut, age01, 1, 0) : 1);
  out.add(x, y, z, r, g, b, intensity, range);
}
