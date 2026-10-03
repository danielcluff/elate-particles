// Module parameter schema. The same definitions drive validation, default
// filling, the editor's inspector widgets and the descriptions agents see.

export type ParamType =
  | "float"
  | "int"
  | "bool"
  | "vec3"
  | "enum"
  | "string"
  /** FloatValue: constant, range, curve, random-between-curves or parameter binding. */
  | "floatValue"
  /** ColorValue: hex, constant, range, gradient. */
  | "colorValue"
  | "curve"
  | "gradient";

export interface ParamDef {
  key: string;
  label: string;
  type: ParamType;
  default: unknown;
  description?: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: { label: string; value: string }[];
  /** Only relevant when another param has one of these values (the editor hides it otherwise). */
  showIf?: { key: string; values: unknown[] };
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function checkCurve(v: unknown): string | null {
  if (!isObj(v) || !Array.isArray(v.keys)) return "expected a curve { keys: [{ t, v }] }";
  for (const k of v.keys) if (!isObj(k) || !isNum(k.t) || !isNum(k.v)) return "curve keys need numeric t and v";
  if (v.interp !== undefined && !["linear", "smooth", "step"].includes(v.interp as string))
    return 'curve interp must be "linear", "smooth" or "step"';
  return null;
}

function checkGradient(v: unknown): string | null {
  if (!isObj(v) || !Array.isArray(v.colors) || !Array.isArray(v.alphas))
    return "expected a gradient { colors: [{ t, color }], alphas: [{ t, a }] }";
  for (const c of v.colors) if (!isObj(c) || !isNum(c.t) || typeof c.color !== "string" || !HEX.test(c.color)) return "gradient colours need t and a #hex color";
  for (const a of v.alphas) if (!isObj(a) || !isNum(a.t) || !isNum(a.a)) return "gradient alphas need numeric t and a";
  return null;
}

export function checkFloatValue(v: unknown): string | null {
  if (isNum(v)) return null;
  if (!isObj(v)) return "expected a number or { kind: range | curve | rangeCurve | param }";
  switch (v.kind) {
    case "range":
      return isNum(v.min) && isNum(v.max) ? null : "range needs numeric min and max";
    case "curve":
      return checkCurve(v.curve);
    case "rangeCurve":
      return checkCurve(v.min) ?? checkCurve(v.max);
    case "param":
      return typeof v.name === "string" && v.name ? null : "param binding needs a name";
  }
  return `unknown float value kind "${String(v.kind)}"`;
}

export function checkColorValue(v: unknown): string | null {
  if (typeof v === "string") return HEX.test(v) ? null : `"${v}" is not a #hex colour`;
  if (!isObj(v)) return "expected a #hex string or { kind: constant | range | gradient | randomGradient }";
  switch (v.kind) {
    case "constant":
      return typeof v.color === "string" && HEX.test(v.color) ? null : "constant colour needs a #hex color";
    case "range":
      return typeof v.a === "string" && HEX.test(v.a) && typeof v.b === "string" && HEX.test(v.b) ? null : "colour range needs #hex a and b";
    case "gradient":
    case "randomGradient":
      return checkGradient(v.gradient);
  }
  return `unknown colour value kind "${String(v.kind)}"`;
}

/** Returns an error message, or null when `value` is valid for `def`. */
export function checkParam(def: ParamDef, value: unknown): string | null {
  switch (def.type) {
    case "float":
    case "int":
      if (!isNum(value)) return "expected a number";
      if (def.type === "int" && !Number.isInteger(value)) return "expected an integer";
      if (def.min !== undefined && value < def.min) return `must be ≥ ${def.min}`;
      if (def.max !== undefined && value > def.max) return `must be ≤ ${def.max}`;
      return null;
    case "bool":
      return typeof value === "boolean" ? null : "expected true or false";
    case "vec3":
      return Array.isArray(value) && value.length === 3 && value.every(isNum) ? null : "expected [x, y, z]";
    case "enum":
      return def.options?.some((o) => o.value === value) ? null : `expected one of ${def.options?.map((o) => o.value).join(", ")}`;
    case "string":
      return typeof value === "string" ? null : "expected a string";
    case "floatValue":
      return checkFloatValue(value);
    case "colorValue":
      return checkColorValue(value);
    case "curve":
      return checkCurve(value);
    case "gradient":
      return checkGradient(value);
  }
}

/** Defaults merged with the given values (defaults are deep-copied). */
export function resolveParams(defs: ParamDef[], values: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const d of defs) out[d.key] = values && values[d.key] !== undefined ? values[d.key] : structuredClone(d.default);
  return out;
}
