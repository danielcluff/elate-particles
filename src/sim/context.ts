import type { ParamValues, Rng } from "../core/values";
import { rotate } from "./math";

/** World transform of an effect instance, shared by its emitters. */
export class EffectTransform {
  readonly position: [number, number, number] = [0, 0, 0];
  readonly rotation: [number, number, number, number] = [0, 0, 0, 1];
  scale = 1;
  /** Position at the previous step (for spawn interpolation and distance spawning). */
  readonly prevPosition: [number, number, number] = [0, 0, 0];
  /** World velocity: derived from movement unless set explicitly. */
  readonly velocity: [number, number, number] = [0, 0, 0];
  /** Inverse rotation, kept in sync by the effect. */
  readonly inverseRotation: [number, number, number, number] = [0, 0, 0, 1];
}

/**
 * What a module sees while it runs. One context per emitter instance; its
 * fields are rewritten every step, never reallocated.
 */
export class SimContext {
  dt = 0;
  /** Seconds since the emitter started (after its start delay). */
  time = 0;
  /** Position within the current cycle, 0..1 (the `t` spawn/init curves are sampled at). */
  cycleT = 0;
  /** Seconds into the current cycle. */
  cycleTime = 0;
  /** Index of the current cycle (looping emitters). */
  cycle = 0;
  /** Distance the effect moved this step (world units). */
  distance = 0;
  readonly rng: Rng;
  params: ParamValues;
  readonly transform: EffectTransform;
  readonly space: "world" | "local";

  constructor(rng: Rng, params: ParamValues, transform: EffectTransform, space: "world" | "local") {
    this.rng = rng;
    this.params = params;
    this.transform = transform;
    this.space = space;
  }

  /** A point given in effect-local space, in simulation space. */
  localPointToSim(x: number, y: number, z: number, out: number[]): void {
    if (this.space === "local") {
      out[0] = x;
      out[1] = y;
      out[2] = z;
      return;
    }
    const t = this.transform;
    rotate(t.rotation, x * t.scale, y * t.scale, z * t.scale, out);
    out[0] += t.position[0];
    out[1] += t.position[1];
    out[2] += t.position[2];
  }

  /** A direction given in world space, in simulation space. */
  worldDirToSim(x: number, y: number, z: number, out: number[]): void {
    if (this.space === "world") {
      out[0] = x;
      out[1] = y;
      out[2] = z;
      return;
    }
    rotate(this.transform.inverseRotation, x, y, z, out);
  }

  /** A direction given in effect-local space, in simulation space. */
  localDirToSim(x: number, y: number, z: number, out: number[]): void {
    if (this.space === "local") {
      out[0] = x;
      out[1] = y;
      out[2] = z;
      return;
    }
    rotate(this.transform.rotation, x, y, z, out);
  }
}
