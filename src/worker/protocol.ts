// Messages between WorkerParticleWorld (main thread) and the particle worker.
// Packed instance arrays travel as transferables in both directions
// (ping-pong), so steady state neither copies nor allocates.

import type { EffectDoc } from "../core/types";

export type V3 = [number, number, number];
export type Q4 = [number, number, number, number];

export interface WorkerWorldOptions {
  budget?: { maxParticles: number };
  quality?: number;
  frustumCulling?: boolean;
  maxDelta?: number;
}

export interface SpawnOpts {
  position?: V3;
  rotation?: Q4;
  scale?: number;
  params?: Record<string, number>;
  autoRelease?: boolean;
  paused?: boolean;
  seed?: number;
}

export type HandleOp =
  | { op: "spawn"; id: number; effect: string; opts: SpawnOpts }
  | { op: "transform"; id: number; p: V3; q?: Q4; s?: number }
  | { op: "velocity"; id: number; v: V3 | null }
  | { op: "param"; id: number; name: string; value: number }
  | { op: "autoRelease"; id: number; value: boolean }
  | { op: "play" | "stop" | "clear" | "teleport" | "release"; id: number };

export interface CameraState {
  /** Column-major world matrix and projection matrix. */
  matrixWorld: number[];
  projection: number[];
  coordinateSystem: number;
  reversedDepth: boolean;
}

export type ToWorker =
  | { type: "init"; options: WorkerWorldOptions }
  | { type: "register"; doc: EffectDoc }
  | { type: "unregister"; id: string }
  | { type: "settings"; quality?: number; budget?: number | null }
  | {
      type: "frame";
      frame: number;
      dt: number;
      camera: CameraState | null;
      ops: HandleOp[];
      /** Arrays the main thread replaced last frame, by batch index, for the worker to pack into again. */
      spares: (Float32Array | null)[];
    };

export interface WorkerStats {
  effects: number;
  instances: number;
  particles: number;
  drawnParticles: number;
  drawCalls: number;
  culledInstances: number;
  budgetScale: number;
  rejectedSpawns: number;
  /** Pool lights lit (always 0: per-particle lights aren't available in worker mode). */
  lights: number;
}

export interface FrameResult {
  type: "result";
  frame: number;
  /** Count of layout messages (register/unregister) the worker had processed; batches only apply if it matches. */
  layout: number;
  /** Per batch (ParticleWorld._batchList order): the packed array, or null when empty. */
  batches: { data: Float32Array | null; count: number }[];
  stats: WorkerStats;
  /** Per live handle: id, particle count, flags (1 alive, 2 culled). */
  states: Float64Array;
  finished: number[];
  released: number[];
  rejected: number[];
}

export type FromWorker = FrameResult;
