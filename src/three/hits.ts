// Recent hits on a surface (a shield, a hull), for shaders that react where
// they were struck: ripples, hot spots, scorch marks.
//
//   const hits = new HitBuffer({ max: 8, lifetime: 1.5 });
//   // TSL, inside a Fn: every live hit's ripple, added up
//   const opacity = float(0).toVar();
//   hits.each(positionLocal, (hit) => opacity.addAssign(rippleFrom(hit.distance, hit.age).mul(hit.strength)));
//   // or only the nearest hit (cheaper, but ripples from different hits cut each other off)
//   const near = hits.nearest(positionLocal);
//   // every frame:
//   hits.update();
//   // on impact, in the same space as the position node (e.g. the model's):
//   hits.add(model.worldToLocal(hitPoint.clone()), damage / maxDamage);
//
// The buffer keeps its own clock: call update() once per frame (with your
// game time, or nothing for the page's clock). Hits are stamped with it, kept
// in a ring buffer of `max`, and expire after `lifetime`.
import * as THREE from "three/webgpu";
import { Fn, If, Loop, float, uniform, uniformArray, vec3 } from "three/tsl";

interface XYZ {
  x: number;
  y: number;
  z: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

export interface HitBufferOptions {
  /** Hits kept at once; the oldest is replaced. Default 8. */
  max?: number;
  /** Seconds a hit stays visible to `nearest`. Default 1.5. */
  lifetime?: number;
}

export interface NearestHit {
  /** Distance to the nearest live hit (very large when there is none). */
  distance: Node;
  /** Seconds since that hit (very large when there is none). */
  age: Node;
  /** That hit's strength (0 when there is none). */
  strength: Node;
}

/** One live hit, as `each` hands it to its body (TSL nodes). */
export interface LiveHit {
  /** Distance from the position to the hit. */
  distance: Node;
  /** Seconds since the hit. */
  age: Node;
  /** The hit's strength. */
  strength: Node;
}

const NONE = 1e6;
const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000;

export class HitBuffer {
  readonly max: number;
  readonly lifetime: number;
  /** xyz: where, w: when (renderer seconds); w < 0 marks an empty slot. */
  readonly hits: Node;
  readonly strengths: Node;
  /** The buffer's clock in seconds (see update), as a uniform shaders read. */
  readonly now: Node;
  #points: THREE.Vector4[];
  #strength: number[];
  #next = 0;
  #time = 0;

  constructor(opts: HitBufferOptions = {}) {
    this.max = Math.max(1, Math.floor(opts.max ?? 8));
    this.lifetime = opts.lifetime ?? 1.5;
    this.#points = Array.from({ length: this.max }, () => new THREE.Vector4(0, 0, 0, -1));
    this.#strength = new Array(this.max).fill(0);
    this.hits = uniformArray(this.#points, "vec4");
    this.strengths = uniformArray(this.#strength, "float");
    // a plain uniform the owner advances: three's per-frame uniform callbacks
    // don't reliably run for a uniform used inside the lookup's Fn/Loop
    this.now = uniform(0);
    this.setTime(clock());
  }

  /** The clock in seconds (hits added now are stamped with it). */
  get time(): number {
    return this.#time;
  }

  /** Advance the clock: call once per frame, with your game time in seconds or nothing for the page's clock. */
  update(seconds = clock()): void {
    this.setTime(seconds);
  }

  setTime(seconds: number): void {
    this.#time = seconds;
    this.now.value = seconds;
  }

  /** Record a hit at `position` (in the space of the position node given to `nearest`). */
  add(position: XYZ, strength = 1): void {
    this.#points[this.#next].set(position.x, position.y, position.z, this.#time);
    this.#strength[this.#next] = strength;
    this.#next = (this.#next + 1) % this.max;
  }

  clear(): void {
    for (const p of this.#points) p.w = -1;
    this.#strength.fill(0);
    this.#next = 0;
  }

  /** Hits still within their lifetime, newest first. */
  active(): { position: THREE.Vector3; age: number; strength: number }[] {
    return this.#points
      .map((p, i) => ({ position: new THREE.Vector3(p.x, p.y, p.z), age: this.#time - p.w, strength: this.#strength[i], empty: p.w < 0 }))
      .filter((h) => !h.empty && h.age >= 0 && h.age < this.lifetime)
      .sort((a, b) => a.age - b.age)
      .map(({ empty: _empty, ...h }) => h);
  }

  /**
   * TSL, inside a Fn: run `body` once for every live hit (`position` is a vec3
   * node in the same space as the hits). The body is emitted once, inside a
   * shader loop over the slots, and skipped for empty or expired ones; it
   * typically adds to variables declared before the call. Unlike `nearest`,
   * every hit's effect shows where they overlap.
   */
  each(position: Node, body: (hit: LiveHit) => void): void {
    const now = this.now;
    Loop(this.max, ({ i }: { i: Node }) => {
      const hit = this.hits.element(i);
      If(hit.w.greaterThanEqual(0).and(now.sub(hit.w).lessThan(this.lifetime)), () => {
        body({ distance: position.distance(hit.xyz), age: now.sub(hit.w), strength: this.strengths.element(i) });
      });
    });
  }

  /**
   * TSL: the live hit nearest to `position` (a vec3 node in the same space as
   * the hits). Effects driven by it show one hit per point, so the regions of
   * two hits meet at a seam; use `each` to let them overlap.
   */
  nearest(position: Node): NearestHit {
    const now = this.now;
    const result = Fn(() => {
      const best = float(NONE).toVar();
      const bestTime = float(-NONE).toVar();
      const bestStrength = float(0).toVar();
      Loop(this.max, ({ i }: { i: Node }) => {
        const hit = this.hits.element(i);
        const d = position.distance(hit.xyz);
        If(hit.w.greaterThanEqual(0).and(now.sub(hit.w).lessThan(this.lifetime)).and(d.lessThan(best)), () => {
          best.assign(d);
          bestTime.assign(hit.w);
          bestStrength.assign(this.strengths.element(i));
        });
      });
      return vec3(best, bestTime, bestStrength);
    })();
    return { distance: result.x, age: now.sub(result.y), strength: result.z };
  }
}
