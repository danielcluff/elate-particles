import { describe, expect, it } from "vitest";
import { positionLocal } from "three/tsl";
import { HitBuffer } from "../src/three";

describe("HitBuffer", () => {
  it("keeps the newest hits, stamped with the clock, until they expire", () => {
    const hits = new HitBuffer({ max: 3, lifetime: 1 });
    hits.setTime(10);
    hits.add({ x: 1, y: 0, z: 0 }, 0.5);
    hits.setTime(10.4);
    hits.add({ x: 0, y: 2, z: 0 });
    expect(hits.active().map((h) => [h.position.toArray(), Number(h.age.toFixed(2)), h.strength])).toEqual([
      [[0, 2, 0], 0, 1],
      [[1, 0, 0], 0.4, 0.5],
    ]);
    // a ring buffer: the oldest slot is reused
    hits.add({ x: 3, y: 0, z: 0 });
    hits.add({ x: 4, y: 0, z: 0 });
    expect(hits.active().map((h) => h.position.x)).toEqual(expect.arrayContaining([3, 4, 0]));
    expect(hits.active()).toHaveLength(3);
    // expiry
    hits.setTime(11.2);
    expect(hits.active().map((h) => h.position.x).sort()).toEqual([0, 3, 4]);
    hits.setTime(12);
    expect(hits.active()).toEqual([]);
    hits.setTime(12);
    hits.add({ x: 5, y: 0, z: 0 });
    hits.clear();
    expect(hits.active()).toEqual([]);
  });

  it("builds a TSL lookup of the nearest hit", () => {
    const hits = new HitBuffer();
    const near = hits.nearest(positionLocal);
    for (const n of [near.distance, near.age, near.strength]) expect(n?.isNode).toBe(true);
    expect(hits.max).toBe(8);
    expect(hits.lifetime).toBe(1.5);
    // its own clock: update() advances it (the page's clock by default)
    hits.update(42);
    expect(hits.time).toBe(42);
    expect(hits.now.value).toBe(42);
    hits.update();
    expect(hits.time).toBeGreaterThan(0);
  });
});
