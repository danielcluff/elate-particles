// What a GPU module implementation sees while it emits TSL into the init or
// update kernel. GPU emitters are batched across effect instances: each
// instance owns a "lane" of the pool's particle slots and a row of the pool's
// lane texture, which holds its per-frame values (transform, time, dt, spawn
// count...) and its module values. FloatValues and ColorValues that change
// over the emitter's cycle (curves, parameter bindings) get lane slots: the
// CPU evaluates their bounds per instance at its cycle time (sample(t, r = 0)
// and sample(t, r = 1)) and the kernel mixes between them with a per-particle
// hash.

import * as THREE from "three/webgpu";
import { cross, float, hash, instanceIndex, ivec2, mix, texture, textureLoad, uint, vec2, vec3, vec4 } from "three/tsl";
import type { ColorValue, FloatValue, Vec3 } from "../../core/types";
import { bakeCurve, bakeGradient, compileColor, compileFloat, LUT_SIZE, type ParamValues } from "../../core/values";
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

/** CPU-side values a lane's module slots are evaluated from. */
export interface FrameInfo {
  cycleT: number;
  params: ParamValues;
}

/**
 * Lane row layout (floats). The header is written by the instance each frame;
 * module slots follow, allocated while kernels build.
 *   0 position.xyz, scale     4 prevPosition.xyz, time   8 rotation (quat)
 *   12 velocity.xyz, event scale   16 spawn count, spawn prefix, dt, visible
 *   20 clear flag
 */
export const LANE = { position: 0, scale: 3, prevPosition: 4, time: 7, rotation: 8, velocity: 12, eventScale: 15, spawnCount: 16, spawnPrefix: 17, dt: 18, visible: 19, clear: 20 } as const;
export const LANE_HEADER = 24;

interface LaneSlot {
  offset: number;
  write(st: FrameInfo, out: Float32Array, o: number): void;
}

/** Module value slots of a pool's lane rows (allocated during kernel builds, written by the CPU per lane each frame). */
export class LaneLayout {
  /** Floats per lane row (the lane texture is width/4 texels wide). */
  width: number;
  readonly slots: LaneSlot[] = [];
  readonly #byKey = new Map<string, number>();
  #next = LANE_HEADER;

  constructor(width = 64) {
    this.width = width;
  }

  /** Floats in use; above `width` the pool widens its rows and rebuilds. */
  get used(): number {
    return this.#next;
  }

  /** A slot of `size` floats, shared by every kernel asking with the same key. */
  alloc(key: string, size: number, write: LaneSlot["write"]): number {
    let o = this.#byKey.get(key);
    if (o === undefined) {
      o = this.#next;
      this.#next += size;
      this.#byKey.set(key, o);
      this.slots.push({ offset: o, write });
    }
    return o;
  }
}

/**
 * One lane's per-frame values as TSL, read from the lane texture (row =
 * lane). Built per kernel, around that kernel's lane index. Modules use the
 * same names the per-instance uniforms had: dt, time, position, rotation,
 * inverseRotation, scale, velocity.
 */
export class LaneValues {
  readonly lane: Node;
  readonly frameSeed: Node;
  readonly #tex: THREE.Texture;
  readonly #texels = new Map<number, Node>();
  readonly position: Node;
  readonly prevPosition: Node;
  readonly scale: Node;
  readonly time: Node;
  readonly rotation: Node;
  readonly inverseRotation: Node;
  readonly velocity: Node;
  readonly eventScale: Node;
  readonly spawnCount: Node;
  readonly spawnPrefix: Node;
  readonly dt: Node;
  readonly visible: Node;

  constructor(tex: THREE.Texture, lane: Node, frameSeed: Node) {
    this.#tex = tex;
    this.lane = lane;
    this.frameSeed = frameSeed;
    const t0 = this.texel(0), t1 = this.texel(1), t2 = this.texel(2), t3 = this.texel(3), t4 = this.texel(4);
    this.position = t0.xyz;
    this.scale = t0.w;
    this.prevPosition = t1.xyz;
    this.time = t1.w;
    this.rotation = t2;
    this.inverseRotation = vec4(t2.xyz.negate(), t2.w);
    this.velocity = t3.xyz;
    this.eventScale = t3.w;
    this.spawnCount = t4.x;
    this.spawnPrefix = t4.y;
    this.dt = t4.z;
    this.visible = t4.w;
  }

  /** Texel `i` of this lane's row (read once per kernel). */
  texel(i: number): Node {
    let t = this.#texels.get(i);
    if (!t) {
      t = textureLoad(this.#tex, ivec2(i, this.lane.toInt())).toVar();
      this.#texels.set(i, t);
    }
    return t;
  }

  /** Float `k` of this lane's row. */
  read(k: number): Node {
    return this.texel(k >> 2).element(k & 3);
  }
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
  /** This particle's lane values (its instance's transform, time, dt...). */
  readonly u: LaneValues;
  /** Lane slots for values the CPU evaluates per instance each frame. */
  readonly layout: LaneLayout;
  /** Textures created for modules (random gradients), disposed with the pool. */
  readonly textures: THREE.Texture[];
  #seed: Node | null = null;
  #age: Node | null = null;
  /** Per-thread index the init-stage randomness hashes (distinct per kernel that spawns). */
  readonly #randIndex: Node;

  constructor(stage: "init" | "update", space: "world" | "local", u: LaneValues, layout: LaneLayout, textures: THREE.Texture[], randSalt = 0) {
    this.stage = stage;
    this.#randIndex = instanceIndex.add(u.frameSeed).add(salted(randSalt + 0x10000));
    this.space = space;
    this.u = u;
    this.layout = layout;
    this.textures = textures;
  }

  /** @internal the particle's stored seed (update stage randomness derives from it) */
  bindSeed(seed: Node): void {
    this.#seed = seed;
  }

  /** @internal the particle's normalised age (update-stage curves are sampled over it) */
  bindAge(age01: Node): void {
    this.#age = age01;
  }

  /** Uniform random 0..1, distinct per `salt`: per spawned particle (init) or fixed per particle (update). */
  rand(salt: number): Node {
    if (this.stage === "init") return hash(this.#randIndex.add(salted(salt)));
    return hash(this.#seed!.mul(16777216).toUint().add(salted(salt)));
  }

  /** A FloatValue as TSL: mix(lo, hi, rand) with lo/hi re-evaluated by the CPU per instance each frame. */
  float(value: FloatValue | undefined, fallback: number, salt: number): Node {
    const c = compileFloat(value, fallback);
    if (c.constant) return float(c.value);
    if (typeof value === "object" && value?.kind === "range") return mix(float(value.min), float(value.max), this.rand(salt));
    if (this.stage === "update" && typeof value === "object" && (value.kind === "curve" || value.kind === "rangeCurve")) return this.#ageCurve(value, salt);
    const o = this.layout.alloc(`f:${JSON.stringify(value)}:${fallback}`, 2, (st, out, k) => {
      out[k] = c.sample(st.cycleT, 0, st.params);
      out[k + 1] = c.sample(st.cycleT, 1, st.params);
    });
    return mix(this.u.read(o), this.u.read(o + 1), this.rand(salt));
  }

  /**
   * A curve over the particle's age (the update stage's meaning of a curve):
   * baked like the CPU's tables into a half-float texture, lower curve in R
   * and upper in G, sampled by age01 and mixed by a per-particle random.
   */
  #ageCurve(value: Extract<FloatValue, { kind: "curve" | "rangeCurve" }>, salt: number): Node {
    const sorted = (c: Parameters<typeof bakeCurve>[0]) => ({ ...c, keys: [...(c.keys ?? [])].sort((a, b) => a.t - b.t) });
    const lo = bakeCurve(sorted(value.kind === "curve" ? value.curve : value.min));
    const hi = value.kind === "curve" ? lo : bakeCurve(sorted(value.max));
    const h = THREE.DataUtils.toHalfFloat;
    const data = new Uint16Array(LUT_SIZE * 4);
    for (let i = 0; i < LUT_SIZE; i++) {
      data[i * 4] = h(lo[i]);
      data[i * 4 + 1] = h(hi[i]);
    }
    const tex = new THREE.DataTexture(data, LUT_SIZE, 1, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    this.textures.push(tex);
    const t: Node = this.#age!.clamp(0, 1).mul((LUT_SIZE - 1) / LUT_SIZE).add(0.5 / LUT_SIZE);
    const s: Node = texture(tex, vec2(t, 0.5));
    const v: Node = value.kind === "curve" ? s.x : mix(s.x, s.y, this.rand(salt));
    return v.mul(value.scale ?? 1);
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
    if (c.constant) {
      const k = [0, 0, 0, 0];
      c.sample(0, 0, k, 0);
      return vec4(k[0], k[1], k[2], k[3]);
    }
    // two texels: the colour at r = 0 and r = 1 (texel-aligned, so each is one read)
    const o = this.layout.alloc(`c:${JSON.stringify(value)}`, 8 + ((4 - (this.layout.used % 4)) % 4), (st, out, k) => {
      const a = (k + 3) & ~3;
      c.sample(st.cycleT, 0, out, a);
      c.sample(st.cycleT, 1, out, a + 4);
    });
    const a = (o + 3) & ~3;
    return mix(this.u.texel(a >> 2), this.u.texel((a >> 2) + 1), this.rand(salt));
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
