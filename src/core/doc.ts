// Creating, normalising and validating effect documents.

import { resolveParams } from "./params";
import { getModuleDef } from "./registry";
import { isSlug, moduleSlug, slugify, uniqueSlug } from "./slug";
import {
  EFFECT_FORMAT,
  EFFECT_VERSION,
  STAGES,
  type EffectDoc,
  type EmitterDoc,
  type Issue,
  RENDERER_TYPES,
  type ModuleInstance,
  type RendererDoc,
  type RendererType,
  type Stage,
} from "./types";

export function uid(prefix = ""): string {
  const r = Math.random().toString(36).slice(2, 10);
  return prefix ? `${prefix}_${r}` : r;
}

export const DEFAULT_TRAIL = { points: 16, minDistance: 0.1, lifetime: 0.5 } as const;

export function defaultRenderer(type: RendererType = "sprite"): RendererDoc {
  switch (type) {
    case "mesh":
      return { type: "mesh", blend: "opaque", mesh: "icosahedron", orientation: "random" };
    case "ribbon":
      return { type: "ribbon", blend: "additive", shape: "softCircle", facing: "camera", uvMode: "stretch" };
    case "light":
      return { type: "light", ratio: 0.1, maxLights: 4, intensity: 2, range: 4, useParticleColor: true, alphaAffectsIntensity: true };
    default:
      return { type: "sprite", blend: "additive", shape: "softCircle", facing: "camera" };
  }
}

/** Slugs already used by an emitter's modules (all stages share one namespace). */
export function moduleIds(e: EmitterDoc): string[] {
  return STAGES.flatMap((stage) => e[stage].map((m) => m.id));
}

/** A renderer of `type` with defaults and overrides; its slug comes from its type, unique among `taken`. */
export function createRenderer(type: RendererType = "sprite", overrides: Partial<RendererDoc> = {}, taken: Iterable<string> = []): RendererDoc {
  return { ...defaultRenderer(type), ...overrides, type, id: overrides.id ?? uniqueSlug(type, taken) } as RendererDoc;
}

/** A module instance with every param at its default (plus overrides); its slug comes from its type, unique among `taken`. */
export function createModule(type: string, params: Record<string, unknown> = {}, taken: Iterable<string> = []): ModuleInstance {
  const def = getModuleDef(type);
  if (!def) throw new Error(`Unknown module type "${type}"`);
  return { id: uniqueSlug(moduleSlug(type), taken), type, params: resolveParams(def.params, params) };
}

/** An emitter whose slug comes from `name`, unique among `taken` (the effect's other emitters). */
export function createEmitter(name = "Emitter", template: "default" | "empty" = "default", taken: Iterable<string> = []): EmitterDoc {
  const base: EmitterDoc = {
    id: uniqueSlug(slugify(name, "emitter"), taken),
    name,
    duration: 2,
    looping: true,
    startDelay: 0,
    maxParticles: 500,
    space: "world",
    spawn: [],
    init: [],
    update: [],
    render: [],
    renderers: [createRenderer()],
  };
  if (template === "empty") return base;
  base.spawn.push(createModule("spawn.rate"));
  base.init.push(createModule("init.lifetime"), createModule("init.shape"), createModule("init.size"), createModule("init.color"));
  base.update.push(createModule("update.drag", { drag: 0.2 }));
  base.render.push(createModule("render.sizeOverLife"), createModule("render.colorOverLife"));
  return base;
}

/** A new effect. Its slug comes from `name` unless given (hosts usually use the file name). */
export function createEffect(name = "New Effect", opts: { emitter?: boolean; id?: string } = {}): EffectDoc {
  const now = Date.now();
  return {
    format: EFFECT_FORMAT,
    version: EFFECT_VERSION,
    id: opts.id ?? slugify(name, "effect"),
    name,
    emitters: opts.emitter === false ? [] : [createEmitter("Emitter")],
    parameters: [],
    createdAt: now,
    updatedAt: now,
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Keeps an id that is a free slug; otherwise derives one (older files used generated ids). */
function claim(id: unknown, derive: () => string, taken: Set<string>): string {
  const slug = isSlug(id) && !taken.has(id) ? id : uniqueSlug(derive(), taken);
  taken.add(slug);
  return slug;
}

/** Modules of one stage; `taken` is shared by every stage of the emitter. */
function normalizeModules(list: unknown, taken: Set<string>): ModuleInstance[] {
  if (!Array.isArray(list)) return [];
  return list.filter(isObj).map((m) => {
    const type = String(m.type ?? "");
    return {
      ...(m as unknown as ModuleInstance),
      id: claim(m.id, () => moduleSlug(type), taken),
      type,
      params: isObj(m.params) ? (m.params as Record<string, unknown>) : {},
    };
  });
}

/** `renderers` (or a legacy single `renderer`), each filled with its type's defaults and given a slug. */
function normalizeRenderers(raw: Record<string, unknown>): RendererDoc[] {
  const list: unknown[] = Array.isArray(raw.renderers) ? raw.renderers : isObj(raw.renderer) ? [raw.renderer] : [defaultRenderer()];
  const taken = new Set<string>();
  return list.filter(isObj).map((r) => {
    const type = (RENDERER_TYPES.includes(r.type as RendererType) ? r.type : "sprite") as RendererType;
    return { ...defaultRenderer(r.type as RendererType), ...r, id: claim(r.id, () => type, taken) } as RendererDoc;
  });
}

/**
 * Parses untrusted JSON into an EffectDoc, filling structural defaults.
 * Throws when the input is not an effect at all; content problems are left
 * for validateEffect so nothing the user made is silently dropped.
 *
 * Effect files don't store their own slug (the file name is the slug): pass it
 * as `opts.id`. Ids that aren't slugs (older files) are replaced by slugs, and
 * sub-emitter bindings follow renamed emitters.
 */
export function normalizeEffect(json: unknown, opts: { id?: string } = {}): EffectDoc {
  if (!isObj(json)) throw new Error("Effect must be a JSON object");
  if (json.format !== undefined && json.format !== EFFECT_FORMAT) throw new Error(`Not a ${EFFECT_FORMAT} document (format "${String(json.format)}")`);
  if (!Array.isArray(json.emitters)) throw new Error("Effect has no emitters array");
  const emitterIds = new Set<string>();
  const renamed = new Map<string, string>();
  const emitters = json.emitters.filter(isObj).map((raw): EmitterDoc => {
    const name = String(raw.name ?? "Emitter");
    const def = createEmitter(name, "empty");
    const { renderer: _legacy, ...fields } = raw;
    const id = claim(raw.id, () => slugify(name, "emitter"), emitterIds);
    if (typeof raw.id === "string" && raw.id !== id) renamed.set(raw.id, id);
    const modules = new Set<string>();
    return {
      ...def,
      ...(fields as Partial<EmitterDoc>),
      id,
      spawn: normalizeModules(raw.spawn, modules),
      init: normalizeModules(raw.init, modules),
      update: normalizeModules(raw.update, modules),
      render: normalizeModules(raw.render, modules),
      renderers: normalizeRenderers(raw),
    };
  });
  if (renamed.size)
    for (const e of emitters)
      if (Array.isArray(e.subEmitters)) e.subEmitters = e.subEmitters.map((s) => (renamed.has(s.emitter) ? { ...s, emitter: renamed.get(s.emitter)! } : s));
  const name = typeof json.name === "string" ? json.name : "Effect";
  return {
    format: EFFECT_FORMAT,
    version: EFFECT_VERSION,
    id: opts.id ?? (isSlug(json.id) ? json.id : slugify(name, "effect")),
    name,
    emitters,
    parameters: Array.isArray(json.parameters) ? (json.parameters as EffectDoc["parameters"]) : [],
    ...(typeof json.createdAt === "number" ? { createdAt: json.createdAt } : {}),
    ...(typeof json.updatedAt === "number" ? { updatedAt: json.updatedAt } : {}),
    ...(typeof json.thumbnail === "string" ? { thumbnail: json.thumbnail } : {}),
    ...(isObj(json.preview) ? { preview: json.preview as EffectDoc["preview"] } : {}),
    ...(isObj(json.scalability) ? { scalability: json.scalability as EffectDoc["scalability"] } : {}),
  };
}

/**
 * The effect as it is written to a file: without its own slug (the file name
 * is the slug) or editor metadata (timestamps, thumbnail).
 */
export function serializeEffect(doc: EffectDoc): Omit<EffectDoc, "id" | "createdAt" | "updatedAt" | "thumbnail"> {
  const { id: _id, createdAt: _c, updatedAt: _u, thumbnail: _t, ...file } = doc;
  return file;
}

/** Structural checks that do not need the simulator (module params are checked by compileEffect). */
export function validateStructure(doc: EffectDoc): Issue[] {
  const issues: Issue[] = [];
  const ids = new Set<string>();
  for (const e of doc.emitters) {
    if (!isSlug(e.id)) issues.push({ level: "error", message: `Emitter id "${e.id}" is not a slug (lowercase-kebab-case)`, emitterId: e.id });
    if (ids.has(e.id)) issues.push({ level: "error", message: `Duplicate emitter id "${e.id}"`, emitterId: e.id });
    ids.add(e.id);
    const mids = new Set<string>();
    for (const stage of STAGES)
      for (const m of e[stage] ?? []) {
        const where = { emitterId: e.id, moduleId: m.id };
        if (!isSlug(m.id)) issues.push({ level: "error", message: `Module id "${m.id}" is not a slug (lowercase-kebab-case)`, ...where });
        else if (mids.has(m.id)) issues.push({ level: "error", message: `Duplicate module id "${m.id}"`, ...where });
        mids.add(m.id);
      }
    if (!(e.duration > 0)) issues.push({ level: "error", message: "duration must be > 0", emitterId: e.id });
    if (!(e.maxParticles >= 1)) issues.push({ level: "error", message: "maxParticles must be ≥ 1", emitterId: e.id });
    if (e.maxParticles > 100_000 && e.sim !== "gpu")
      issues.push({ level: "warning", message: 'maxParticles above 100k is expensive on the CPU simulator (consider sim: "gpu")', emitterId: e.id });
    if (e.maxParticles > 4_000_000) issues.push({ level: "warning", message: "maxParticles above 4M is a lot of GPU memory (64 bytes each)", emitterId: e.id });
    if (!Array.isArray(e.renderers)) issues.push({ level: "error", message: "Emitter has no renderers array", emitterId: e.id });
    const rids = new Set<string>();
    for (const r of e.renderers ?? []) {
      const where = { emitterId: e.id, rendererId: r?.id };
      if (r?.id) {
        if (!isSlug(r.id)) issues.push({ level: "error", message: `Renderer id "${r.id}" is not a slug (lowercase-kebab-case)`, ...where });
        else if (rids.has(r.id)) issues.push({ level: "error", message: `Duplicate renderer id "${r.id}"`, ...where });
        rids.add(r.id);
      }
      if (!RENDERER_TYPES.includes(r?.type)) {
        issues.push({ level: "error", message: `Unknown renderer type "${String(r?.type)}"`, ...where });
        continue;
      }
      if (r.type === "light") {
        if (!(r.ratio >= 0 && r.ratio <= 1)) issues.push({ level: "error", message: "Light ratio must be between 0 and 1", ...where });
        if (!(r.maxLights >= 0) || !Number.isInteger(r.maxLights)) issues.push({ level: "error", message: "maxLights must be a whole number ≥ 0", ...where });
        if (!(r.intensity >= 0)) issues.push({ level: "error", message: "Light intensity must be ≥ 0", ...where });
        if (!(r.range >= 0)) issues.push({ level: "error", message: "Light range must be ≥ 0", ...where });
        if (r.useParticleColor === false && r.color !== undefined && !/^#[0-9a-f]{6}$/i.test(r.color)) issues.push({ level: "error", message: "Light color must be a #rrggbb hex colour", ...where });
        continue;
      }
      if (r.type !== "mesh" && r.shape === "texture" && !r.texture) issues.push({ level: "warning", message: "Texture shape without a texture", ...where });
      if (r.type === "mesh" && !r.mesh) issues.push({ level: "error", message: "Mesh renderer needs a mesh", ...where });
      for (const key of ["depthFade", "cameraFade"] as const) {
        const v = r.type !== "mesh" ? r[key] : undefined;
        if (v !== undefined && !(v >= 0)) issues.push({ level: "error", message: `${key} must be ≥ 0`, ...where });
      }
      if (r.type === "sprite" && r.material !== undefined) {
        const m = r.material as { kind?: unknown; shaderId?: unknown };
        if (m?.kind !== "graph" || typeof m.shaderId !== "string" || !m.shaderId)
          issues.push({ level: "error", message: 'material must be { kind: "graph", shaderId }', ...where });
        else if (r.sortGroup) issues.push({ level: "warning", message: "Sprites with a shader graph can't join a sort group; drawn on their own", ...where });
      }
      if (r.type === "sprite" && r.sortGroup !== undefined) {
        if (typeof r.sortGroup !== "string" || !r.sortGroup) issues.push({ level: "error", message: "sortGroup must be a non-empty string", ...where });
        else if (r.blend === "opaque") issues.push({ level: "warning", message: "Opaque sprites can't join a sort group; drawn on their own", ...where });
      }
      if (r.sort !== undefined && !["none", "distance", "oldestOnTop", "newestOnTop"].includes(r.sort))
        issues.push({ level: "error", message: `Unknown sort mode "${String(r.sort)}"`, ...where });
      if (r.type === "ribbon" && r.mode !== "particle" && e.maxParticles > 2000)
        issues.push({ level: "warning", message: "Ribbons rarely need more than a few hundred points", ...where });
      if (r.type === "ribbon" && r.mode === "particle" && r.trail) {
        if (!(r.trail.points >= 2 && r.trail.points <= 256)) issues.push({ level: "error", message: "trail.points must be between 2 and 256", ...where });
        if (!(r.trail.lifetime > 0)) issues.push({ level: "error", message: "trail.lifetime must be > 0", ...where });
        if (!(r.trail.minDistance >= 0)) issues.push({ level: "error", message: "trail.minDistance must be ≥ 0", ...where });
      }
    }
    if (e.sim !== undefined && e.sim !== "cpu" && e.sim !== "gpu") issues.push({ level: "error", message: `Unknown sim "${String(e.sim)}"`, emitterId: e.id });
    if (e.sim === "gpu") {
      // structural features the GPU simulator can't do; module-level support is checked by the runtime
      const why: string[] = [];
      // sub-emitter events only flow GPU → GPU: both ends must ask for the GPU
      const partners = [...(e.subEmitters ?? []).map((s) => s.emitter), ...doc.emitters.filter((o) => o.subEmitters?.some((s) => s.emitter === e.id)).map((o) => o.id)];
      if (partners.some((id) => doc.emitters.find((o) => o.id === id)?.sim !== "gpu")) why.push("sub-emitters with a CPU partner");
      if (why.length) issues.push({ level: "warning", message: `GPU simulation doesn't support ${[...new Set(why)].join(", ")}; this emitter will run on the CPU`, emitterId: e.id });
    }
    // one trail history per emitter: particle-mode ribbons must agree on it
    const trails = (e.renderers ?? []).filter((r) => r?.type === "ribbon" && r.mode === "particle" && r.enabled !== false);
    if (trails.length > 1 && new Set(trails.map((r) => JSON.stringify((r as { trail?: unknown }).trail ?? null))).size > 1)
      issues.push({ level: "warning", message: "Particle-mode ribbons in one emitter share a trail history; the first one's trail settings are used", emitterId: e.id });
    const seen = new Set<string>();
    for (const stage of STAGES) {
      for (const m of e[stage]) {
        const def = getModuleDef(m.type);
        if (def && def.multiple === false) {
          if (seen.has(m.type)) issues.push({ level: "warning", message: `${def.label} appears more than once; later instances override earlier ones`, emitterId: e.id, moduleId: m.id });
          seen.add(m.type);
        }
      }
    }
  }
  const sc = doc.scalability;
  if (sc) {
    for (const key of ["cullDistance", "lodDistance", "maxInstances"] as const)
      if (sc[key] !== undefined && !(sc[key]! > 0)) issues.push({ level: "error", message: `scalability.${key} must be > 0` });
    if (sc.farSpawnScale !== undefined && !(sc.farSpawnScale >= 0 && sc.farSpawnScale <= 1)) issues.push({ level: "error", message: "scalability.farSpawnScale must be 0..1" });
    if (sc.lodDistance !== undefined && sc.cullDistance !== undefined && sc.lodDistance >= sc.cullDistance)
      issues.push({ level: "warning", message: "scalability.lodDistance should be less than cullDistance" });
    if (sc.overflow !== undefined && sc.overflow !== "rejectNew" && sc.overflow !== "killOldest") issues.push({ level: "error", message: `Unknown overflow "${String(sc.overflow)}"` });
  }
  for (const e of doc.emitters) {
    const l = e.lod;
    if (!l) continue;
    if (l.maxDistance !== undefined && !(l.maxDistance > 0)) issues.push({ level: "error", message: "lod.maxDistance must be > 0", emitterId: e.id });
    if (l.minQuality !== undefined && !(l.minQuality >= 0 && l.minQuality <= 1)) issues.push({ level: "error", message: "lod.minQuality must be 0..1", emitterId: e.id });
  }
  const names = new Set<string>();
  for (const p of doc.parameters) {
    if (names.has(p.name)) issues.push({ level: "error", message: `Duplicate parameter "${p.name}"` });
    names.add(p.name);
  }
  return issues;
}

export function findEmitter(doc: EffectDoc, id: string): EmitterDoc {
  const e = doc.emitters.find((x) => x.id === id) ?? doc.emitters.find((x) => x.name === id);
  if (!e) throw new Error(`Emitter "${id}" not found`);
  return e;
}

export function findRenderer(e: EmitterDoc, id?: string): { index: number; renderer: RendererDoc } {
  const index = id === undefined ? 0 : e.renderers.findIndex((r) => r.id === id);
  if (index < 0 || !e.renderers[index]) throw new Error(id === undefined ? `Emitter "${e.name}" has no renderers` : `Renderer "${id}" not found in emitter "${e.name}"`);
  return { index, renderer: e.renderers[index] };
}

export function findModule(e: EmitterDoc, id: string): { stage: Stage; index: number; module: ModuleInstance } {
  for (const stage of STAGES) {
    const index = e[stage].findIndex((m) => m.id === id);
    if (index >= 0) return { stage, index, module: e[stage][index] };
  }
  throw new Error(`Module "${id}" not found in emitter "${e.name}"`);
}
