// Module registry. A module is a schema (params, docs) plus its CPU
// implementation; render-stage modules bake lookup tables for the GPU instead.
// Hosts and plugins add their own with `registerModule`.

import type { ParticleBuffer } from "../sim/buffer";
import type { SimContext } from "../sim/context";
import type { ParamDef } from "./params";
import type { Stage } from "./types";

export interface ModuleRuntime {
  /** Per-instance float state (accumulators, burst counters), zeroed on reset. */
  stateSize?: number;
  /** spawn stage: number of particles to create this step. */
  spawn?(ctx: SimContext, state: Float64Array): number;
  /** init stage: particles [start, end) were just created. update stage: all live particles. */
  run?(ctx: SimContext, buf: ParticleBuffer, start: number, end: number): void;
}

/** GPU lookup tables contributed by render-stage modules (sampled by normalised age). */
export interface RenderBake {
  /** LUT_SIZE floats, multiplies particle size. */
  size?: Float32Array;
  /** LUT_SIZE * 4 floats (linear RGBA), multiplies particle colour. */
  color?: Float32Array;
}

export interface EmitterInfo {
  space: "world" | "local";
  maxParticles: number;
}

export interface ModuleDef {
  /** "<stage>.<name>", e.g. "init.shape". */
  type: string;
  stage: Stage;
  label: string;
  category: string;
  description: string;
  params: ParamDef[];
  /**
   * init stage only. "local" (default) modules run before particles are moved
   * into simulation space and work in the effect's local frame; "sim" modules
   * run after (e.g. inherit velocity, which is a world quantity).
   */
  phase?: "local" | "sim";
  /** Extra particle channels this module reads or writes. */
  attributes?: string[];
  /** Several instances in one stage are allowed (forces, bursts). Defaults to true. */
  multiple?: boolean;
  compile?(params: Record<string, unknown>, emitter: EmitterInfo): ModuleRuntime;
  bake?(params: Record<string, unknown>): RenderBake;
}

const registry = new Map<string, ModuleDef>();

export function registerModule(def: ModuleDef): void {
  if (!def.type.startsWith(def.stage + ".")) throw new Error(`Module type "${def.type}" must start with "${def.stage}."`);
  if (registry.has(def.type)) throw new Error(`Module "${def.type}" is already registered`);
  registry.set(def.type, def);
}

export function getModuleDef(type: string): ModuleDef | undefined {
  return registry.get(type);
}

export function allModuleDefs(): ModuleDef[] {
  return [...registry.values()];
}

export function moduleDefsForStage(stage: Stage): ModuleDef[] {
  return allModuleDefs().filter((d) => d.stage === stage);
}
