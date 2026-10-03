// Per-particle trail history for ribbon mode "particle". Each trailed particle
// owns a slot (stored in its "trailSlot" channel) holding a ring of timestamped
// points in simulation space. Keeping history out of the particle channels
// means swap-remove moves one float per particle, not points × 4.

export class TrailStore {
  readonly points: number;
  readonly lifetime: number;
  readonly #minDist2: number;
  /** slot × points × (x, y, z, t) */
  readonly #data: Float32Array;
  /** Ring index of the newest point, per slot. */
  readonly #head: Int32Array;
  /** Points recorded (≤ points), per slot. */
  readonly #count: Int32Array;
  readonly #free: Int32Array;
  #freeTop = 0;

  constructor(capacity: number, points: number, minDistance: number, lifetime: number) {
    this.points = Math.max(2, Math.floor(points));
    this.lifetime = lifetime;
    this.#minDist2 = minDistance * minDistance;
    this.#data = new Float32Array(capacity * this.points * 4);
    this.#head = new Int32Array(capacity);
    this.#count = new Int32Array(capacity);
    this.#free = new Int32Array(capacity);
    this.reset();
  }

  /** Frees every slot. */
  reset(): void {
    const n = this.#free.length;
    // pop order 0, 1, 2… (cosmetic: keeps slot ids small and predictable in tests)
    for (let i = 0; i < n; i++) this.#free[i] = n - 1 - i;
    this.#freeTop = n;
    this.#count.fill(0);
  }

  get slotsInUse(): number {
    return this.#free.length - this.#freeTop;
  }

  /** Claims a slot and records the first point; -1 if none are left. */
  start(x: number, y: number, z: number, t: number): number {
    if (this.#freeTop === 0) return -1;
    const slot = this.#free[--this.#freeTop];
    this.#head[slot] = 0;
    this.#count[slot] = 1;
    const o = slot * this.points * 4;
    this.#data[o] = x;
    this.#data[o + 1] = y;
    this.#data[o + 2] = z;
    this.#data[o + 3] = t;
    return slot;
  }

  release(slot: number): void {
    if (slot < 0) return;
    this.#count[slot] = 0;
    this.#free[this.#freeTop++] = slot;
  }

  /** Records a point if the particle moved at least minDistance since the newest one. */
  record(slot: number, x: number, y: number, z: number, t: number): void {
    if (slot < 0) return;
    const P = this.points;
    const base = slot * P * 4;
    const d = this.#data;
    const h = this.#head[slot];
    const o = base + h * 4;
    const dx = x - d[o], dy = y - d[o + 1], dz = z - d[o + 2];
    if (dx * dx + dy * dy + dz * dz < this.#minDist2) return;
    const nh = h + 1 === P ? 0 : h + 1;
    const q = base + nh * 4;
    d[q] = x;
    d[q + 1] = y;
    d[q + 2] = z;
    d[q + 3] = t;
    this.#head[slot] = nh;
    if (this.#count[slot] < P) this.#count[slot]++;
  }

  /**
   * Writes the slot's live points (age ≤ lifetime at time `now`) into `out`
   * as xyz triples, **oldest first**. Returns how many were written.
   */
  read(slot: number, now: number, out: Float32Array, offset = 0): number {
    if (slot < 0) return 0;
    const P = this.points;
    const base = slot * P * 4;
    const d = this.#data;
    const count = this.#count[slot];
    const h = this.#head[slot];
    const oldest = now - this.lifetime;
    // walk newest → oldest to find how many are alive, then emit oldest → newest
    let live = 0;
    for (let idx = h; live < count; live++) {
      if (d[base + idx * 4 + 3] < oldest) break;
      idx = idx === 0 ? P - 1 : idx - 1;
    }
    let idx = h - (live - 1);
    if (idx < 0) idx += P;
    for (let k = 0, w = offset; k < live; k++, w += 3) {
      const o = base + idx * 4;
      out[w] = d[o];
      out[w + 1] = d[o + 1];
      out[w + 2] = d[o + 2];
      idx = idx === P - 1 ? 0 : idx + 1;
    }
    return live;
  }
}
