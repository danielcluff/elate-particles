// EffectDoc → EffectTemplate: modules are resolved, validated and compiled
// once; every instance of the effect shares the template (and, on the GPU
// side, its materials). Invalid modules are skipped and reported as issues so
// a half-edited document still plays in the editor.

import { checkParam, resolveParams } from "../core/params";
import { getModuleDef, type ModuleDef, type ModuleRuntime } from "../core/registry";
import type { EffectDoc, EmitterDoc, Issue, ModuleInstance, RendererDoc, TrailSettings } from "../core/types";
import { DEFAULT_TRAIL } from "../core/doc";
import { hashString, type ParamValues } from "../core/values";

export interface CompiledModule {
  def: ModuleDef;
  instance: ModuleInstance;
  rt: ModuleRuntime;
  /** Offset into the emitter instance's state array. */
  stateOffset: number;
}

export interface ResolvedSubEmitter {
  target: number;
  count: number;
  probability: number;
  inheritVelocity: number;
  inheritColor: boolean;
}

export interface EmitterTemplate {
  doc: EmitterDoc;
  index: number;
  id: string;
  capacity: number;
  space: "world" | "local";
  duration: number;
  looping: boolean;
  startDelay: number;
  prewarm: boolean;
  eventDriven: boolean;
  seed: number;
  spawn: CompiledModule[];
  initLocal: CompiledModule[];
  initSim: CompiledModule[];
  update: CompiledModule[];
  stateSize: number;
  extraChannels: string[];
  /** Over-life LUTs for the renderer; null when no render module provides one. */
  sizeLut: Float32Array | null;
  colorLut: Float32Array | null;
  /** Enabled renderers, in draw-definition order (each becomes its own batch / draw call). */
  renderers: RendererDoc[];
  /**
   * Keep particles in spawn order (oldest first). Ribbons need it; it costs an
   * order-preserving compaction instead of swap-remove when particles die.
   */
  ordered: boolean;
  /** Per-particle trail history settings (ribbon mode "particle"), else null. */
  trail: TrailSettings | null;
  /** LOD (EmitterDoc.lod): spawn scaling applies; distance / quality cut-offs. */
  scaleSpawn: boolean;
  maxDistance: number;
  minQuality: number;
  /**
   * Bounds margins: rendered half-size = size × sizeMargin; trails and
   * velocity-stretched sprites reach back speed × speedMargin.
   */
  sizeMargin: number;
  speedMargin: number;
  birth: ResolvedSubEmitter[];
  death: ResolvedSubEmitter[];
}

export interface EffectTemplate {
  doc: EffectDoc;
  id: string;
  emitters: EmitterTemplate[];
  paramDefaults: ParamValues;
  issues: Issue[];
}

function multiplyInto(target: Float32Array | null, src: Float32Array): Float32Array {
  if (!target) return src.slice();
  for (let i = 0; i < target.length; i++) target[i] *= src[i];
  return target;
}

function compileModules(e: EmitterDoc, list: ModuleInstance[], stage: string, issues: Issue[], offset: { n: number }, extra: Set<string>, onBake?: (def: ModuleDef, params: Record<string, unknown>) => void): CompiledModule[] {
  const out: CompiledModule[] = [];
  for (const m of list ?? []) {
    if (m.enabled === false) continue;
    const def = getModuleDef(m.type);
    const where = { emitterId: e.id, moduleId: m.id };
    if (!def) {
      issues.push({ level: "error", message: `Unknown module type "${m.type}"`, ...where });
      continue;
    }
    if (def.stage !== stage) {
      issues.push({ level: "error", message: `Module "${m.type}" belongs in the ${def.stage} stage, not ${stage}`, ...where });
      continue;
    }
    const params = resolveParams(def.params, m.params);
    const bad = def.params.map((p) => [p.key, checkParam(p, params[p.key])] as const).find(([, err]) => err);
    if (bad) {
      issues.push({ level: "error", message: `${def.label}: "${bad[0]}" ${bad[1]}`, ...where });
      continue;
    }
    if (def.bake) {
      onBake?.(def, params);
      continue;
    }
    if (!def.compile) continue;
    try {
      const rt = def.compile(params, { space: e.space, maxParticles: e.maxParticles });
      out.push({ def, instance: m, rt, stateOffset: offset.n });
      offset.n += rt.stateSize ?? 0;
      for (const a of def.attributes ?? []) extra.add(a);
    } catch (err) {
      issues.push({ level: "error", message: `${def.label}: ${err instanceof Error ? err.message : String(err)}`, ...where });
    }
  }
  return out;
}

export function compileEffect(doc: EffectDoc): EffectTemplate {
  const issues: Issue[] = [];
  const enabled = (doc.emitters ?? []).filter((e) => e.enabled !== false);
  const indexOf = new Map(enabled.map((e, i) => [e.id, i]));

  const emitters = enabled.map((e, index): EmitterTemplate => {
    const offset = { n: 0 };
    const extra = new Set<string>();
    let sizeLut: Float32Array | null = null;
    let colorLut: Float32Array | null = null;

    const spawn = compileModules(e, e.spawn, "spawn", issues, offset, extra);
    const init = compileModules(e, e.init, "init", issues, offset, extra);
    const update = compileModules(e, e.update, "update", issues, offset, extra);
    compileModules(e, e.render, "render", issues, offset, extra, (def, params) => {
      const bake = def.bake!(params);
      if (bake.size) sizeLut = multiplyInto(sizeLut, bake.size);
      if (bake.color) colorLut = multiplyInto(colorLut, bake.color);
    });

    if (!e.eventDriven && spawn.length === 0 && !(doc.emitters ?? []).some((o) => o.subEmitters?.some((s) => s.emitter === e.id)))
      issues.push({ level: "warning", message: `Emitter "${e.name}" has no spawn modules and nothing triggers it`, emitterId: e.id });

    const resolveSubs = (trigger: "birth" | "death"): ResolvedSubEmitter[] =>
      (e.subEmitters ?? [])
        .filter((s) => s.trigger === trigger)
        .flatMap((s) => {
          const target = indexOf.get(s.emitter);
          if (target === undefined) {
            issues.push({ level: "warning", message: `Sub-emitter target "${s.emitter}" is missing or disabled`, emitterId: e.id });
            return [];
          }
          if (target === index) {
            issues.push({ level: "error", message: "An emitter cannot be its own sub-emitter", emitterId: e.id });
            return [];
          }
          return [{ target, count: Math.max(0, Math.round(s.count)), probability: s.probability ?? 1, inheritVelocity: s.inheritVelocity ?? 0, inheritColor: s.inheritColor ?? false }];
        });

    const renderers = (e.renderers ?? []).filter((r) => r && r.enabled !== false);
    // one trail history per emitter, from the first particle-mode ribbon (validateStructure warns on disagreement)
    const trailRibbon = renderers.find((r) => r.type === "ribbon" && r.mode === "particle");
    const trail: TrailSettings | null = trailRibbon?.type === "ribbon" ? { ...DEFAULT_TRAIL, ...trailRibbon.trail } : null;
    const speedMargin = Math.max(
      0,
      ...renderers.map((r) => (r.type === "ribbon" && r.mode === "particle" ? trail!.lifetime : r.type === "sprite" && r.facing === "velocity" ? (r.stretch ?? 0.1) : 0)),
    );

    return {
      doc: e,
      index,
      id: e.id,
      capacity: Math.max(1, Math.floor(e.maxParticles)),
      space: e.space === "local" ? "local" : "world",
      duration: Math.max(1e-3, e.duration),
      looping: !!e.looping,
      startDelay: Math.max(0, e.startDelay ?? 0),
      prewarm: !!e.prewarm,
      eventDriven: !!e.eventDriven,
      seed: e.seed ?? hashString(e.id),
      spawn,
      initLocal: init.filter((m) => m.def.phase !== "sim"),
      initSim: init.filter((m) => m.def.phase === "sim"),
      update,
      stateSize: offset.n,
      extraChannels: trail ? [...extra, "trailSlot"] : [...extra],
      sizeLut,
      colorLut,
      renderers,
      ordered: renderers.some((r) => r.type === "ribbon" && r.mode !== "particle"),
      trail,
      scaleSpawn: e.lod?.scaleSpawn !== false,
      maxDistance: e.lod?.maxDistance ?? Infinity,
      minQuality: e.lod?.minQuality ?? 0,
      // half the quad × the largest size-over-life value (mesh primitives are ~1 unit across too)
      sizeMargin: 0.5 * (sizeLut ? Math.max(1e-3, ...(sizeLut as Float32Array)) : 1),
      speedMargin,
      birth: resolveSubs("birth"),
      death: resolveSubs("death"),
    };
  });

  const paramDefaults: ParamValues = {};
  for (const p of doc.parameters ?? []) paramDefaults[p.name] = p.default;

  return { doc, id: doc.id, emitters, paramDefaults, issues };
}
