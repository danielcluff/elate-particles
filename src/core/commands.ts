// Declarative, serialisable document operations. The effect editor, an MCP
// server and an in-editor AI agent all edit effects through executeCommand,
// so an agent sees exactly what a human would (same validation, same undo
// granularity). Ids may be "$name" references to objects created earlier in
// the same batch (`ref`).

import { compileEffect } from "../sim/compile";
import { createEmitter, createModule, findEmitter, findModule, uid, validateStructure } from "./doc";
import { checkParam } from "./params";
import { allModuleDefs, getModuleDef } from "./registry";
import type { EffectDoc, EffectParameter, EmitterDoc, Issue, RendererDoc, SubEmitterBinding } from "./types";

type EmitterProps = Partial<Omit<EmitterDoc, "id" | "spawn" | "init" | "update" | "render" | "renderer" | "subEmitters">>;

export type Command =
  | { op: "getEffect" }
  | { op: "validate" }
  | { op: "rename"; name: string }
  | { op: "addEmitter"; name?: string; template?: "default" | "empty"; props?: EmitterProps; index?: number; ref?: string }
  | { op: "updateEmitter"; emitterId: string; props: EmitterProps }
  | { op: "removeEmitter"; emitterId: string }
  | { op: "duplicateEmitter"; emitterId: string; name?: string; ref?: string }
  | { op: "moveEmitter"; emitterId: string; index: number }
  | { op: "addModule"; emitterId: string; type: string; params?: Record<string, unknown>; index?: number; label?: string; ref?: string }
  | { op: "updateModule"; emitterId: string; moduleId: string; params?: Record<string, unknown>; enabled?: boolean; label?: string }
  | { op: "removeModule"; emitterId: string; moduleId: string }
  | { op: "moveModule"; emitterId: string; moduleId: string; index: number }
  | { op: "setRenderer"; emitterId: string; renderer: Partial<RendererDoc> }
  | { op: "setSubEmitters"; emitterId: string; subEmitters: SubEmitterBinding[] }
  | { op: "setParameter"; parameter: EffectParameter }
  | { op: "removeParameter"; name: string }
  | { op: "batch"; ops: Command[] };

export const READ_ONLY_OPS = new Set<Command["op"]>(["getEffect", "validate"]);

export function isReadOnly(cmd: Command): boolean {
  if (cmd.op === "batch") return cmd.ops.every(isReadOnly);
  return READ_ONLY_OPS.has(cmd.op);
}

export class CommandError extends Error {}

type Refs = Map<string, string>;

function ref(refs: Refs, id: string): string {
  if (!id?.startsWith("$")) return id;
  const r = refs.get(id.slice(1));
  if (!r) throw new CommandError(`Unknown reference "${id}"`);
  return r;
}

function clampIndex(i: number | undefined, len: number): number {
  if (i === undefined || !Number.isFinite(i)) return len;
  return Math.max(0, Math.min(len, Math.floor(i)));
}

/** Full validation: structure + module params + sub-emitter wiring. */
export function validateEffect(doc: EffectDoc): Issue[] {
  const issues = validateStructure(doc);
  for (const issue of compileEffect(doc).issues) if (!issues.some((i) => i.message === issue.message && i.moduleId === issue.moduleId)) issues.push(issue);
  return issues;
}

function checkModuleParams(type: string, params: Record<string, unknown>): void {
  const def = getModuleDef(type)!;
  for (const [key, value] of Object.entries(params)) {
    const p = def.params.find((d) => d.key === key);
    if (!p) throw new CommandError(`${def.label} has no param "${key}" (params: ${def.params.map((d) => d.key).join(", ")})`);
    const err = checkParam(p, value);
    if (err) throw new CommandError(`${def.label}.${key}: ${err}`);
  }
}

function apply(doc: EffectDoc, cmd: Command, refs: Refs): unknown {
  switch (cmd.op) {
    case "getEffect":
      return doc;
    case "validate":
      return validateEffect(doc);
    case "rename":
      doc.name = cmd.name;
      return { name: doc.name };
    case "addEmitter": {
      const e = createEmitter(cmd.name ?? `Emitter ${doc.emitters.length + 1}`, cmd.template ?? "default");
      if (cmd.props) Object.assign(e, cmd.props);
      doc.emitters.splice(clampIndex(cmd.index, doc.emitters.length), 0, e);
      if (cmd.ref) refs.set(cmd.ref, e.id);
      return { emitterId: e.id };
    }
    case "updateEmitter": {
      const e = findEmitter(doc, ref(refs, cmd.emitterId));
      const { id: _id, spawn: _s, init: _i, update: _u, render: _r, renderer: _rd, subEmitters: _se, ...props } = cmd.props as EmitterDoc;
      Object.assign(e, props);
      return { emitterId: e.id };
    }
    case "removeEmitter": {
      const e = findEmitter(doc, ref(refs, cmd.emitterId));
      doc.emitters = doc.emitters.filter((x) => x !== e);
      // drop sub-emitter bindings that pointed at it
      for (const o of doc.emitters) if (o.subEmitters) o.subEmitters = o.subEmitters.filter((s) => s.emitter !== e.id);
      return { removed: e.id };
    }
    case "duplicateEmitter": {
      const src = findEmitter(doc, ref(refs, cmd.emitterId));
      const copy: EmitterDoc = structuredClone(src);
      copy.id = uid("e");
      copy.name = cmd.name ?? `${src.name} copy`;
      for (const stage of ["spawn", "init", "update", "render"] as const) for (const m of copy[stage]) m.id = uid("m");
      doc.emitters.splice(doc.emitters.indexOf(src) + 1, 0, copy);
      if (cmd.ref) refs.set(cmd.ref, copy.id);
      return { emitterId: copy.id };
    }
    case "moveEmitter": {
      const e = findEmitter(doc, ref(refs, cmd.emitterId));
      doc.emitters = doc.emitters.filter((x) => x !== e);
      doc.emitters.splice(clampIndex(cmd.index, doc.emitters.length), 0, e);
      return { emitterId: e.id, index: doc.emitters.indexOf(e) };
    }
    case "addModule": {
      const e = findEmitter(doc, ref(refs, cmd.emitterId));
      const def = getModuleDef(cmd.type);
      if (!def) throw new CommandError(`Unknown module type "${cmd.type}". Use listModuleTypes to see what exists.`);
      if (cmd.params) checkModuleParams(cmd.type, cmd.params);
      if (def.multiple === false && e[def.stage].some((m) => m.type === cmd.type))
        throw new CommandError(`${def.label} is already in this emitter; update it instead`);
      const m = createModule(cmd.type, cmd.params);
      if (cmd.label) m.label = cmd.label;
      const list = e[def.stage];
      list.splice(clampIndex(cmd.index, list.length), 0, m);
      if (cmd.ref) refs.set(cmd.ref, m.id);
      return { moduleId: m.id, stage: def.stage };
    }
    case "updateModule": {
      const e = findEmitter(doc, ref(refs, cmd.emitterId));
      const { module: m } = findModule(e, ref(refs, cmd.moduleId));
      if (cmd.params) {
        if (getModuleDef(m.type)) checkModuleParams(m.type, cmd.params);
        Object.assign(m.params, cmd.params);
      }
      if (cmd.enabled !== undefined) m.enabled = cmd.enabled;
      if (cmd.label !== undefined) m.label = cmd.label || undefined;
      return { moduleId: m.id };
    }
    case "removeModule": {
      const e = findEmitter(doc, ref(refs, cmd.emitterId));
      const { stage, index } = findModule(e, ref(refs, cmd.moduleId));
      e[stage].splice(index, 1);
      return { removed: cmd.moduleId };
    }
    case "moveModule": {
      const e = findEmitter(doc, ref(refs, cmd.emitterId));
      const { stage, index, module } = findModule(e, ref(refs, cmd.moduleId));
      e[stage].splice(index, 1);
      e[stage].splice(clampIndex(cmd.index, e[stage].length), 0, module);
      return { moduleId: module.id, index: e[stage].indexOf(module) };
    }
    case "setRenderer": {
      const e = findEmitter(doc, ref(refs, cmd.emitterId));
      e.renderer = { ...e.renderer, ...cmd.renderer } as RendererDoc;
      return { renderer: e.renderer };
    }
    case "setSubEmitters": {
      const e = findEmitter(doc, ref(refs, cmd.emitterId));
      e.subEmitters = cmd.subEmitters.map((s) => ({ ...s, emitter: findEmitter(doc, ref(refs, s.emitter)).id }));
      return { subEmitters: e.subEmitters };
    }
    case "setParameter": {
      const p = cmd.parameter;
      if (!p?.name) throw new CommandError("Parameter needs a name");
      const i = doc.parameters.findIndex((x) => x.name === p.name);
      const next: EffectParameter = { ...p, type: "float" };
      if (i >= 0) doc.parameters[i] = next;
      else doc.parameters.push(next);
      return { parameter: next };
    }
    case "removeParameter":
      doc.parameters = doc.parameters.filter((p) => p.name !== cmd.name);
      return { removed: cmd.name };
    case "batch":
      return cmd.ops.map((op) => apply(doc, op, refs));
  }
  throw new CommandError(`Unknown op "${(cmd as { op: string }).op}"`);
}

/**
 * Applies `cmd` to `doc` in place. Batches are atomic: if any step fails the
 * document is left untouched.
 */
export function executeCommand(doc: EffectDoc, cmd: Command): unknown {
  if (cmd.op !== "batch") {
    const result = apply(doc, cmd, new Map());
    if (!isReadOnly(cmd)) doc.updatedAt = Date.now();
    return result;
  }
  const draft = structuredClone(doc);
  const result = apply(draft, cmd, new Map());
  Object.assign(doc, draft);
  if (!isReadOnly(cmd)) doc.updatedAt = Date.now();
  return result;
}

/** Compact catalogue for agents and the module picker. */
export function listModuleTypes() {
  return allModuleDefs().map((d) => ({ type: d.type, stage: d.stage, label: d.label, category: d.category, description: d.description }));
}

export function describeModuleType(type: string) {
  const d = getModuleDef(type);
  if (!d) throw new CommandError(`Unknown module type "${type}"`);
  return {
    type: d.type,
    stage: d.stage,
    label: d.label,
    description: d.description,
    multiple: d.multiple !== false,
    params: d.params.map((p) => ({ key: p.key, type: p.type, default: p.default, description: p.description, min: p.min, max: p.max, unit: p.unit, options: p.options?.map((o) => o.value), showIf: p.showIf })),
  };
}
