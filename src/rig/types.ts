// Rigs: the effects that belong to a model. A rig names points on the model
// (sockets: engine nozzles, muzzles, the tail of a projectile), attaches effects
// and lights to them, and binds effect parameters to named signals the game
// feeds every frame (throttle, speed, shield, …).
//
// Everything is keyed by slug. A rig file doesn't name its model: the asset it
// belongs to does (e.g. a ship's definition), so the same rig survives a model
// swap as long as its sockets are re-placed.

import type { Curve, Vec3 } from "../core/types";

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
  /** Timelines played on events (see RigInstance.trigger), by event slug. */
  events: Record<string, RigEventDoc>;
}

export interface RigIssue {
  level: "error" | "warning";
  message: string;
  /** "sockets.engine-left", "attachments.exhaust", "lights.glow". */
  path?: string;
}

// ---------------------------------------------------------------------------
// events: timelines played when something happens (hit, fire, destroyed, …)
// ---------------------------------------------------------------------------

interface TrackBase {
  /** Seconds after the event. */
  at: number;
  /** Default true. */
  enabled?: boolean;
}

/**
 * Spawn an effect: at a socket, or (no socket) at the event's position with
 * its +Z along the event's normal. With `follow`, it moves with the socket
 * until it finishes; otherwise it stays where it started.
 */
export interface EffectTrackDoc extends TrackBase {
  type: "effect";
  effect: string;
  socket?: string;
  scale?: number;
  /** Effect parameter → signal, "strength" (the event's) or a constant. */
  params?: Record<string, ParamBinding>;
  follow?: boolean;
}

/** A point light for `duration` seconds; `curve` (0..1 over the duration) shapes its intensity. Default: fades out. */
export interface LightTrackDoc extends TrackBase {
  type: "light";
  duration: number;
  /** At a socket, or (none) at the event's position. */
  socket?: string;
  color: string;
  intensity: number;
  range: number;
  curve?: Curve;
}

/** Ask the host to shake the camera (a cue: the rig doesn't own the camera). */
export interface ShakeTrackDoc extends TrackBase {
  type: "shake";
  duration: number;
  amplitude: number;
  /** Shakes per second. Default 20. */
  frequency?: number;
}

/** Ask the host to play a sound by slug (a cue). */
export interface SoundTrackDoc extends TrackBase {
  type: "sound";
  sound: string;
  /** 0..1. Default 1. */
  volume?: number;
}

/**
 * A named value over time the host reads with `rig.channel(name)`, e.g. to
 * flash a hull material. `value` × `curve` (0..1 over the duration, default:
 * fades out); overlapping tracks add up.
 */
export interface ChannelTrackDoc extends TrackBase {
  type: "channel";
  duration: number;
  channel: string;
  value?: number;
  curve?: Curve;
}

export type TrackDoc = EffectTrackDoc | LightTrackDoc | ShakeTrackDoc | SoundTrackDoc | ChannelTrackDoc;
export type TrackType = TrackDoc["type"];
export const TRACK_TYPES: TrackType[] = ["effect", "light", "shake", "sound", "channel"];

export interface RigEventDoc {
  tracks: Record<string, TrackDoc>;
}
