// Evaluation of FloatValue / ColorValue. Values are compiled once per emitter
// template into samplers; curves and gradients are baked into small lookup
// tables so per-particle sampling is a couple of array reads.

import type { ColorValue, Curve, FloatValue, Gradient } from "./types";

export const LUT_SIZE = 64;

export type ParamValues = Record<string, number>;

/** `t` in 0..1 (context dependent), `r` a per-particle random in 0..1. */
export type FloatSampler = (t: number, r: number, params: ParamValues) => number;

export interface CompiledFloat {
  sample: FloatSampler;
  /** True when the value never changes; `value` then holds it. */
  constant: boolean;
  value: number;
}

// ---------------------------------------------------------------------------
// curves
// ---------------------------------------------------------------------------

export function evalCurve(curve: Curve, t: number): number {
  const keys = curve.keys;
  const n = keys.length;
  if (n === 0) return 0;
  if (t <= keys[0].t) return keys[0].v;
  if (t >= keys[n - 1].t) return keys[n - 1].v;
  let i = 1;
  while (i < n && keys[i].t < t) i++;
  const a = keys[i - 1];
  const b = keys[i];
  const span = b.t - a.t;
  let f = span > 0 ? (t - a.t) / span : 0;
  if (curve.interp === "step") f = 0;
  else if (curve.interp === "smooth") f = f * f * (3 - 2 * f);
  return a.v + (b.v - a.v) * f;
}

export function bakeCurve(curve: Curve, size = LUT_SIZE): Float32Array {
  const out = new Float32Array(size);
  for (let i = 0; i < size; i++) out[i] = evalCurve(curve, i / (size - 1));
  return out;
}

/** Linear lookup into a baked table, `t` clamped to 0..1. */
export function sampleLut(lut: Float32Array, t: number): number {
  const last = lut.length - 1;
  const x = (t <= 0 ? 0 : t >= 1 ? 1 : t) * last;
  const i = x | 0;
  if (i >= last) return lut[last];
  const f = x - i;
  return lut[i] + (lut[i + 1] - lut[i]) * f;
}

function sortedCurve(curve: Curve): Curve {
  return { ...curve, keys: [...(curve.keys ?? [])].sort((a, b) => a.t - b.t) };
}

// ---------------------------------------------------------------------------
// floats
// ---------------------------------------------------------------------------

export function constantFloat(v: number): CompiledFloat {
  return { sample: () => v, constant: true, value: v };
}

export function compileFloat(value: FloatValue | undefined, fallback = 0): CompiledFloat {
  if (value === undefined || value === null) return constantFloat(fallback);
  if (typeof value === "number") return constantFloat(value);
  switch (value.kind) {
    case "range": {
      const { min, max } = value;
      if (min === max) return constantFloat(min);
      return { sample: (_t, r) => min + (max - min) * r, constant: false, value: (min + max) / 2 };
    }
    case "curve": {
      const lut = bakeCurve(sortedCurve(value.curve));
      const s = value.scale ?? 1;
      return { sample: (t) => sampleLut(lut, t) * s, constant: false, value: lut[0] * s };
    }
    case "rangeCurve": {
      const lo = bakeCurve(sortedCurve(value.min));
      const hi = bakeCurve(sortedCurve(value.max));
      const s = value.scale ?? 1;
      return {
        sample: (t, r) => {
          const a = sampleLut(lo, t);
          return (a + (sampleLut(hi, t) - a) * r) * s;
        },
        constant: false,
        value: lo[0] * s,
      };
    }
    case "param": {
      const { name } = value;
      const s = value.scale ?? 1;
      const o = value.offset ?? 0;
      return { sample: (_t, _r, p) => (p[name] ?? 0) * s + o, constant: false, value: o };
    }
  }
  return constantFloat(fallback);
}

// ---------------------------------------------------------------------------
// colours (linear RGB; hex input is sRGB)
// ---------------------------------------------------------------------------

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** "#rgb" / "#rrggbb" → linear [r, g, b]. Unparseable input is white. */
export function parseHex(hex: string): [number, number, number] {
  let h = (hex ?? "").trim().replace(/^#/, "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  if (h.length !== 6 || Number.isNaN(n)) return [1, 1, 1];
  return [srgbToLinear(((n >> 16) & 255) / 255), srgbToLinear(((n >> 8) & 255) / 255), srgbToLinear((n & 255) / 255)];
}

/** Bakes a gradient to `size` RGBA texels (linear, intensity applied). */
export function bakeGradient(g: Gradient, size = LUT_SIZE): Float32Array {
  const colors = [...(g.colors?.length ? g.colors : [{ t: 0, color: "#ffffff" }])].sort((a, b) => a.t - b.t);
  const alphas = [...(g.alphas?.length ? g.alphas : [{ t: 0, a: 1 }])].sort((a, b) => a.t - b.t);
  const parsed = colors.map((c) => ({ t: c.t, rgb: parseHex(c.color) }));
  const intensity = g.intensity ?? 1;
  const alphaCurve: Curve = { keys: alphas.map((a) => ({ t: a.t, v: a.a })) };
  const out = new Float32Array(size * 4);
  for (let i = 0; i < size; i++) {
    const t = i / (size - 1);
    for (let ch = 0; ch < 3; ch++) {
      const curve: Curve = { keys: parsed.map((p) => ({ t: p.t, v: p.rgb[ch] })) };
      out[i * 4 + ch] = evalCurve(curve, t) * intensity;
    }
    out[i * 4 + 3] = evalCurve(alphaCurve, t);
  }
  return out;
}

/** Writes linear RGBA into `out` at `o`. */
export type ColorSampler = (t: number, r: number, out: Float32Array | number[], o: number) => void;

export interface CompiledColor {
  sample: ColorSampler;
  constant: boolean;
}

function sampleGradientLut(lut: Float32Array, t: number, out: Float32Array | number[], o: number) {
  const size = lut.length / 4;
  const x = (t <= 0 ? 0 : t >= 1 ? 1 : t) * (size - 1);
  const i = x | 0;
  const j = i >= size - 1 ? i : i + 1;
  const f = x - i;
  for (let ch = 0; ch < 4; ch++) {
    const a = lut[i * 4 + ch];
    out[o + ch] = a + (lut[j * 4 + ch] - a) * f;
  }
}

export function compileColor(value: ColorValue | undefined): CompiledColor {
  if (value === undefined || value === null) value = "#ffffff";
  if (typeof value === "string") value = { kind: "constant", color: value };
  switch (value.kind) {
    case "constant": {
      const [r, g, b] = parseHex(value.color);
      const k = value.intensity ?? 1;
      const a = value.alpha ?? 1;
      return {
        sample: (_t, _r, out, o) => {
          out[o] = r * k;
          out[o + 1] = g * k;
          out[o + 2] = b * k;
          out[o + 3] = a;
        },
        constant: true,
      };
    }
    case "range": {
      const ca = parseHex(value.a);
      const cb = parseHex(value.b);
      const aa = value.alphaA ?? 1;
      const ab = value.alphaB ?? 1;
      const k = value.intensity ?? 1;
      return {
        sample: (_t, r, out, o) => {
          out[o] = (ca[0] + (cb[0] - ca[0]) * r) * k;
          out[o + 1] = (ca[1] + (cb[1] - ca[1]) * r) * k;
          out[o + 2] = (ca[2] + (cb[2] - ca[2]) * r) * k;
          out[o + 3] = aa + (ab - aa) * r;
        },
        constant: false,
      };
    }
    case "gradient": {
      const lut = bakeGradient(value.gradient);
      return { sample: (t, _r, out, o) => sampleGradientLut(lut, t, out, o), constant: false };
    }
    case "randomGradient": {
      const lut = bakeGradient(value.gradient);
      return { sample: (_t, r, out, o) => sampleGradientLut(lut, r, out, o), constant: false };
    }
  }
  return compileColor("#ffffff");
}

// ---------------------------------------------------------------------------
// random
// ---------------------------------------------------------------------------

/** mulberry32: small, fast, deterministic. */
export class Rng {
  #s: number;
  constructor(seed = 1) {
    this.#s = seed >>> 0 || 1;
  }
  seed(seed: number): void {
    this.#s = seed >>> 0 || 1;
  }
  /** Uniform in [0, 1). */
  next(): number {
    let t = (this.#s = (this.#s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
