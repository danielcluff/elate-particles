// Rigs: the effects that belong to a model. A rig names points on the model
// (sockets: engine nozzles, muzzles, the tail of a projectile), attaches effects
// and lights to them, and binds effect parameters to named signals the game
// feeds every frame (throttle, speed, shield, …).
//
// Everything is keyed by slug. A rig file doesn't name its model: the asset it
// belongs to does (e.g. a ship's definition), so the same rig survives a model
// swap as long as its sockets are re-placed.

import type { Vec3 } from "../core/types";

export const RIG_FORMAT = "elate-rig";
export const RIG_VERSION = 1;

/** A named transform in model space (metres; Redshift ships face +Z). */
export interface SocketDoc {
  position: Vec3;
  /** Euler angles in degrees, XYZ order. Effects emit along the socket's axes. Default [0, 0, 0]. */
  rotation?: Vec3;
}

/**
 * An effect parameter's source: a signal name (its value is passed through;
 * the effect's own `{ kind: "param", scale, offset }` maps it) or a constant.
 */
export type ParamBinding = string | number;

export interface AttachmentDoc {
  /** Socket slug. */
  socket: string;
  /** Effect slug (what ParticleWorld.spawn takes). */
  effect: string;
  /** Uniform scale. Default 1. */
  scale?: number;
  /** Effect parameter name → signal or constant. */
  params?: Record<string, ParamBinding>;
  /** Default true. */
  enabled?: boolean;
}

export interface RigLightDoc {
  /** Socket slug. */
  socket: string;
  /** #rrggbb. */
  color: string;
  intensity: number;
  /** Distance where the light reaches zero (metres). */
  range: number;
  /** Multiply the intensity by this signal's value (e.g. "throttle" for an engine glow). */
  signal?: string;
  /** Default true. */
  enabled?: boolean;
}

export interface RigDoc {
  format: typeof RIG_FORMAT;
  version: typeof RIG_VERSION;
  sockets: Record<string, SocketDoc>;
  attachments: Record<string, AttachmentDoc>;
  lights: Record<string, RigLightDoc>;
}

export interface RigIssue {
  level: "error" | "warning";
  message: string;
  /** "sockets.engine-left", "attachments.exhaust", "lights.glow". */
  path?: string;
}
