// What a GPU module implementation sees while it emits TSL into the init or
// update kernel. FloatValues and ColorValues collapse to per-frame uniforms:
// the CPU evaluates their bounds at the emitter's cycle time (curves, ranges,
// parameter bindings alike: sample(t, r = 0) and sample(t, r = 1)), and the
// kernel mixes between them with a per-particle hash.

import * as THREE from "three/webgpu";
import { cross, float, hash, instanceIndex, mix, texture, uint, uniform, vec2, vec3, vec4 } from "three/tsl";
import type { ColorValue, FloatValue, Vec3 } from "../../core/types";
import { bakeGradient, compileColor, compileFloat, LUT_SIZE, type ParamValues } from "../../core/values";
import type { Node } from "../materials/common";

/** Per-particle working values inside a kernel (TSL vars). */
export interface GpuParticle {
  pos: Node;
  vel: Node;
  /** Normalised age 0..1; setting it to 1 kills the particle. */
  age01: Node;
  /** Lifetime in seconds. */
  life: Node;
  size: Node;
  rot: Node;
  spin: Node;
  /** Per-particle random 0..1, fixed for its life. */
  seed: Node;
  /** Linear RGBA. */
  color: Node;
}

/** CPU-side values the per-frame uniform updaters read. */
export interface FrameInfo {
  cycleT: number;
  params: ParamValues;
}

/** Uniforms shared by an emitter's kernels, written once per frame. */
export class GpuUniforms {
  readonly dt = uniform(0);
  readonly time = uniform(0);
  readonly position = uniform(new THREE.Vector3());
  readonly prevPosition = uniform(new THREE.Vector3());
  readonly rotation = uniform(new THREE.Vector4(0, 0, 0, 1));
  readonly inverseRotation = uniform(new THREE.Vector4(0, 0, 0, 1));
  readonly scale = uniform(1);
  readonly velocity = uniform(new THREE.Vector3());
  /** Ring-buffer spawn range and a fresh random salt per frame. */
  // (uint uniforms aren't in @types/three's overloads)
  readonly spawnStart: Node = (uniform as (v: number, t: string) => Node)(0, "uint");
  readonly spawnCount: Node = (uniform as (v: number, t: string) => Node)(0, "uint");
  readonly frameSeed: Node = (uniform as (v: number, t: string) => Node)(0, "uint");
}

/** v rotated by unit quaternion q (vec4, xyz + w). */
export function rotateQ(q: Node, v: Node): Node {
  const t: Node = cross(q.xyz, v).mul(2);
  return v.add(t.mul(q.w)).add(cross(q.xyz, t));
}

const salted = (salt: number) => uint((Math.imul(salt + 1, 2654435761) >>> 0) as number);

export class GpuBuildContext {
  readonly stage: "init" | "update";
  readonly space: "world" | "local";
  readonly u: GpuUniforms;
  /**
   * Current CPU frame values, owned by the emitter and rewritten before each
   * dispatch. Module uniforms read it through onRenderUpdate, which runs inside
   * renderer.compute() after the kernel is built (TSL Fn bodies only execute at
   * build time, inside the first compute call).
   */
  readonly state: FrameInfo;
  /** Textures created for modules (random gradients), disposed with the emitter. */
  readonly textures: THREE.Texture[];
  #seed: Node | null = null;
  /** Upper bound on lifetimes (seconds), for the CPU's live-count estimate; set by init.lifetime. */
  lifetimeMax: (() => number) | null = null;

  constructor(stage: "init" | "update", space: "world" | "local", u: GpuUniforms, state: FrameInfo, textures: THREE.Texture[]) {
    this.stage = stage;
    this.space = space;
    this.u = u;
    this.state = state;
    this.textures = textures;
  }

  /** @internal the particle's stored seed (update stage randomness derives from it) */
  bindSeed(seed: Node): void {
    this.#seed = seed;
  }

  /** Uniform random 0..1, distinct per `salt`: per spawned particle (init) or fixed per particle (update). */
  rand(salt: number): Node {
    if (this.stage === "init") return hash(instanceIndex.add(this.u.frameSeed).add(salted(salt)));
    return hash(this.#seed!.mul(16777216).toUint().add(salted(salt)));
  }

  /** A FloatValue as TSL: mix(lo, hi, rand) with lo/hi re-evaluated by the CPU each frame. */
  float(value: FloatValue | undefined, fallback: number, salt: number): Node {
    const c = compileFloat(value, fallback);
    if (c.constant) return float(c.value);
    if (typeof value === "object" && value?.kind === "range") return mix(float(value.min), float(value.max), this.rand(salt));
    const st = this.state;
    const lo = uniform(0).onRenderUpdate(() => c.sample(st.cycleT, 0, st.params));
    const hi = uniform(0).onRenderUpdate(() => c.sample(st.cycleT, 1, st.params));
    return mix(lo, hi, this.rand(salt));
  }

  /** A ColorValue as TSL (linear RGBA). Random gradients sample a baked LUT texture. */
  color(value: ColorValue | undefined, salt: number): Node {
    if (value && typeof value === "object" && value.kind === "randomGradient") {
      const lut = bakeGradient(value.gradient);
      const h = THREE.DataUtils.toHalfFloat;
      const tex = new THREE.DataTexture(Uint16Array.from(lut, (v) => h(v)), LUT_SIZE, 1, THREE.RGBAFormat, THREE.HalfFloatType);
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
      this.textures.push(tex);
      const u: Node = this.rand(salt).mul((LUT_SIZE - 1) / LUT_SIZE).add(0.5 / LUT_SIZE);
      return texture(tex, vec2(u, 0.5));
    }
    const c = compileColor(value);
    const st = this.state;
    const tmp = [0, 0, 0, 0];
    const va = new THREE.Vector4();
    const vb = new THREE.Vector4();
    const a = uniform(va).onRenderUpdate(() => {
      c.sample(st.cycleT, 0, tmp, 0);
      return va.set(tmp[0], tmp[1], tmp[2], tmp[3]);
    });
    const b = uniform(vb).onRenderUpdate(() => {
      c.sample(st.cycleT, 1, tmp, 0);
      return vb.set(tmp[0], tmp[1], tmp[2], tmp[3]);
    });
    if (c.constant) return vec4(a);
    return mix(a, b, this.rand(salt));
  }

  /** A point given in effect-local space, in simulation space. */
  localPointToSim(v: Vec3): Node {
    const p: Node = vec3(...v);
    if (this.space === "local") return p;
    return rotateQ(this.u.rotation, p.mul(this.u.scale)).add(this.u.position);
  }

  /** A direction given in world space, in simulation space. */
  worldDirToSim(v: Vec3 | Node): Node {
    const d: Node = Array.isArray(v) ? vec3(...v) : v;
    return this.space === "world" ? d : rotateQ(this.u.inverseRotation, d);
  }

  /** A direction given in effect-local space, in simulation space. */
  localDirToSim(v: Vec3 | Node): Node {
    const d: Node = Array.isArray(v) ? vec3(...v) : v;
    return this.space === "local" ? d : rotateQ(this.u.rotation, d);
  }
}
