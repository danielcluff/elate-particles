// Structure-of-arrays particle storage. Fixed capacity, no allocation after
// construction; dead particles are removed by swapping the last one into
// their slot, so live particles are always 0..count-1.

export const CORE_CHANNELS = [
  "px", "py", "pz",
  "vx", "vy", "vz",
  "age", "life", "seed",
  "size", "rot", "spin",
  "r", "g", "b", "a",
] as const;

export type CoreChannel = (typeof CORE_CHANNELS)[number];

export class ParticleBuffer {
  readonly capacity: number;
  count = 0;

  /** Position (simulation space). */
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  /** Velocity (simulation space, units/s). */
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  /** Seconds alive. */
  readonly age: Float32Array;
  /** Lifetime in seconds; the particle dies when age ≥ life. */
  readonly life: Float32Array;
  /** Per-particle random in [0, 1), fixed for the particle's life. */
  readonly seed: Float32Array;
  /** Base size (world units); the renderer multiplies it by size-over-life. */
  readonly size: Float32Array;
  /** Sprite rotation (radians) and angular velocity (radians/s). */
  readonly rot: Float32Array;
  readonly spin: Float32Array;
  /** Base colour, linear RGBA (HDR allowed). */
  readonly r: Float32Array;
  readonly g: Float32Array;
  readonly b: Float32Array;
  readonly a: Float32Array;

  readonly #channels: Float32Array[];
  readonly #byName = new Map<string, Float32Array>();

  constructor(capacity: number, extraChannels: readonly string[] = []) {
    this.capacity = Math.max(1, Math.floor(capacity));
    const make = (name: string) => {
      const arr = new Float32Array(this.capacity);
      this.#byName.set(name, arr);
      return arr;
    };
    this.px = make("px");
    this.py = make("py");
    this.pz = make("pz");
    this.vx = make("vx");
    this.vy = make("vy");
    this.vz = make("vz");
    this.age = make("age");
    this.life = make("life");
    this.seed = make("seed");
    this.size = make("size");
    this.rot = make("rot");
    this.spin = make("spin");
    this.r = make("r");
    this.g = make("g");
    this.b = make("b");
    this.a = make("a");
    for (const name of extraChannels) if (!this.#byName.has(name)) make(name);
    this.#channels = [...this.#byName.values()];
  }

  /** A channel by name (core or module-declared). */
  channel(name: string): Float32Array {
    const c = this.#byName.get(name);
    if (!c) throw new Error(`Particle channel "${name}" was not declared`);
    return c;
  }

  hasChannel(name: string): boolean {
    return this.#byName.has(name);
  }

  /** Removes particle `i` by moving the last particle into its slot. */
  remove(i: number): void {
    const last = --this.count;
    if (i === last) return;
    const ch = this.#channels;
    for (let c = 0; c < ch.length; c++) ch[c][i] = ch[c][last];
  }

  /** Copies particle `from` into slot `to` (all channels). */
  copy(from: number, to: number): void {
    const ch = this.#channels;
    for (let c = 0; c < ch.length; c++) ch[c][to] = ch[c][from];
  }

  clear(): void {
    this.count = 0;
  }
}
