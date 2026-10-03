// Creating, normalising and validating effect documents.

import { resolveParams } from "./params";
import { getModuleDef } from "./registry";
import {
  EFFECT_FORMAT,
  EFFECT_VERSION,
  STAGES,
  type EffectDoc,
  type EmitterDoc,
  type Issue,
  type ModuleInstance,
  type SpriteRendererDoc,
  type Stage,
} from "./types";

export function uid(prefix = ""): string {
  const r = Math.random().toString(36).slice(2, 10);
  return prefix ? `${prefix}_${r}` : r;
}

export function defaultRenderer(): SpriteRendererDoc {
  return { type: "sprite", blend: "additive", shape: "softCircle", facing: "camera" };
}

/** A module instance with every param at its default (plus overrides). */
export function createModule(type: string, params: Record<string, unknown> = {}): ModuleInstance {
  const def = getModuleDef(type);
  if (!def) throw new Error(`Unknown module type "${type}"`);
  return { id: uid("m"), type, params: resolveParams(def.params, params) };
}

export function createEmitter(name = "Emitter", template: "default" | "empty" = "default"): EmitterDoc {
  const base: EmitterDoc = {
    id: uid("e"),
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
    renderer: defaultRenderer(),
  };
  if (template === "empty") return base;
  base.spawn.push(createModule("spawn.rate"));
  base.init.push(createModule("init.lifetime"), createModule("init.shape"), createModule("init.size"), createModule("init.color"));
  base.update.push(createModule("update.drag", { drag: 0.2 }));
  base.render.push(createModule("render.sizeOverLife"), createModule("render.colorOverLife"));
  return base;
}

export function createEffect(name = "New Effect", opts: { emitter?: boolean } = {}): EffectDoc {
  const now = Date.now();
  return {
    format: EFFECT_FORMAT,
    version: EFFECT_VERSION,
    id: uid("fx"),
    name,
    emitters: opts.emitter === false ? [] : [createEmitter("Emitter")],
    parameters: [],
    createdAt: now,
    updatedAt: now,
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function normalizeModules(list: unknown): ModuleInstance[] {
  if (!Array.isArray(list)) return [];
  return list.filter(isObj).map((m) => ({
    ...(m as unknown as ModuleInstance),
    id: typeof m.id === "string" && m.id ? m.id : uid("m"),
    type: String(m.type ?? ""),
    params: isObj(m.params) ? (m.params as Record<string, unknown>) : {},
  }));
}

/**
 * Parses untrusted JSON into an EffectDoc, filling structural defaults.
 * Throws when the input is not an effect at all; content problems are left
 * for validateEffect so nothing the user made is silently dropped.
 */
export function normalizeEffect(json: unknown): EffectDoc {
  if (!isObj(json)) throw new Error("Effect must be a JSON object");
  if (json.format !== undefined && json.format !== EFFECT_FORMAT) throw new Error(`Not a ${EFFECT_FORMAT} document (format "${String(json.format)}")`);
  if (!Array.isArray(json.emitters)) throw new Error("Effect has no emitters array");
  const emitters = json.emitters.filter(isObj).map((raw): EmitterDoc => {
    const def = createEmitter(String(raw.name ?? "Emitter"), "empty");
    return {
      ...def,
      ...(raw as Partial<EmitterDoc>),
      id: typeof raw.id === "string" && raw.id ? raw.id : def.id,
      spawn: normalizeModules(raw.spawn),
      init: normalizeModules(raw.init),
      update: normalizeModules(raw.update),
      render: normalizeModules(raw.render),
      renderer: { ...defaultRenderer(), ...(isObj(raw.renderer) ? (raw.renderer as Partial<SpriteRendererDoc>) : {}) },
    };
  });
  return {
    format: EFFECT_FORMAT,
    version: EFFECT_VERSION,
    id: typeof json.id === "string" && json.id ? json.id : uid("fx"),
    name: typeof json.name === "string" ? json.name : "Effect",
    emitters,
    parameters: Array.isArray(json.parameters) ? (json.parameters as EffectDoc["parameters"]) : [],
    ...(typeof json.createdAt === "number" ? { createdAt: json.createdAt } : {}),
    ...(typeof json.updatedAt === "number" ? { updatedAt: json.updatedAt } : {}),
    ...(typeof json.thumbnail === "string" ? { thumbnail: json.thumbnail } : {}),
    ...(isObj(json.preview) ? { preview: json.preview as EffectDoc["preview"] } : {}),
  };
}

/** Structural checks that do not need the simulator (module params are checked by compileEffect). */
export function validateStructure(doc: EffectDoc): Issue[] {
  const issues: Issue[] = [];
  const ids = new Set<string>();
  for (const e of doc.emitters) {
    if (ids.has(e.id)) issues.push({ level: "error", message: `Duplicate emitter id "${e.id}"`, emitterId: e.id });
    ids.add(e.id);
    if (!(e.duration > 0)) issues.push({ level: "error", message: "duration must be > 0", emitterId: e.id });
    if (!(e.maxParticles >= 1)) issues.push({ level: "error", message: "maxParticles must be ≥ 1", emitterId: e.id });
    if (e.maxParticles > 100_000) issues.push({ level: "warning", message: "maxParticles above 100k is expensive on the CPU simulator", emitterId: e.id });
    if (e.renderer?.type !== "sprite") issues.push({ level: "error", message: `Unknown renderer type "${String(e.renderer?.type)}"`, emitterId: e.id });
    if (e.renderer?.shape === "texture" && !e.renderer.texture) issues.push({ level: "warning", message: "Texture shape without a texture", emitterId: e.id });
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

export function findModule(e: EmitterDoc, id: string): { stage: Stage; index: number; module: ModuleInstance } {
  for (const stage of STAGES) {
    const index = e[stage].findIndex((m) => m.id === id);
    if (index >= 0) return { stage, index, module: e[stage][index] };
  }
  throw new Error(`Module "${id}" not found in emitter "${e.name}"`);
}
