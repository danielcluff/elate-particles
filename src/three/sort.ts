// Stable O(n) ordering for particle sorting. Float keys are quantised to 16
// bits within their [min, max] range, then sorted with a two-pass LSD radix
// sort (low byte, high byte). 65 536 levels across a batch's depth range is
// far finer than blending order can show; there is no comparator, and no
// allocation once the scratch arrays have grown.

export class KeySorter {
  #q = new Uint16Array(0);
  #a = new Uint32Array(0);
  #b = new Uint32Array(0);
  readonly #hist = new Uint32Array(256);

  #grow(n: number): void {
    if (this.#a.length >= n) return;
    const cap = Math.max(n, this.#a.length * 2, 256);
    this.#q = new Uint16Array(cap);
    this.#a = new Uint32Array(cap);
    this.#b = new Uint32Array(cap);
  }

  /**
   * Indices 0..n-1 ordered by `keys` (ascending, or descending), stable for
   * equal quantised keys. The returned array is reused by the next call; only
   * its first `n` entries are meaningful.
   */
  order(keys: Float32Array, n: number, descending = false): Uint32Array {
    this.#grow(n);
    const q = this.#q, a = this.#a, b = this.#b, hist = this.#hist;
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < n; i++) {
      const k = keys[i];
      if (k < min) min = k;
      if (k > max) max = k;
    }
    const scale = max > min ? 65535 / (max - min) : 0;
    for (let i = 0; i < n; i++) {
      const k = ((keys[i] - min) * scale) | 0;
      q[i] = descending ? 65535 - k : k;
    }

    // pass 1: low byte, identity → b
    hist.fill(0);
    for (let i = 0; i < n; i++) hist[q[i] & 255]++;
    for (let i = 0, sum = 0; i < 256; i++) {
      const c = hist[i];
      hist[i] = sum;
      sum += c;
    }
    for (let i = 0; i < n; i++) b[hist[q[i] & 255]++] = i;

    // pass 2: high byte, b → a
    hist.fill(0);
    for (let i = 0; i < n; i++) hist[q[i] >> 8]++;
    for (let i = 0, sum = 0; i < 256; i++) {
      const c = hist[i];
      hist[i] = sum;
      sum += c;
    }
    for (let i = 0; i < n; i++) {
      const idx = b[i];
      a[hist[q[idx] >> 8]++] = idx;
    }
    return a;
  }
}
