import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { EffectSim, compileEffect, createEffect, createEmitter, createModule, validateEffect, type EffectDoc, type SortMode } from "../src/index";
import { KeySorter, ParticleBatch, PARTICLE_STRIDE } from "../src/three";

describe("KeySorter", () => {
  it("orders like a reference sort, ascending and descending", () => {
    const n = 5000;
    const keys = new Float32Array(n);
    for (let i = 0; i < n; i++) keys[i] = Math.random() * 200 - 100;
    const s = new KeySorter();
    for (const desc of [false, true]) {
      const order = Array.from(s.order(keys, n, desc).subarray(0, n));
      expect(new Set(order).size).toBe(n);
      for (let i = 1; i < n; i++) {
        const a = keys[order[i - 1]], b = keys[order[i]];
        // 16-bit quantisation: neighbours may tie within one level (200 / 65535)
        if (desc) expect(a).toBeGreaterThanOrEqual(b - 200 / 65535);
        else expect(a).toBeLessThanOrEqual(b + 200 / 65535);
      }
    }
  });

  it("is stable and handles equal keys and n = 1", () => {
    const s = new KeySorter();
    expect(Array.from(s.order(new Float32Array([3, 3, 3]), 3).subarray(0, 3))).toEqual([0, 1, 2]);
    expect(Array.from(s.order(new Float32Array([1, 0, 1, 0]), 4).subarray(0, 4))).toEqual([1, 3, 0, 2]);
    expect(s.order(new Float32Array([7]), 1)[0]).toBe(0);
  });
});

function smoke(sort: SortMode): EffectDoc {
  const doc = createEffect("smoke", { emitter: false });
  const e = createEmitter("smoke", "empty");
  e.looping = false;
  e.spawn.push(createModule("spawn.burst", { count: 1 }));
  e.init.push(createModule("init.shape", { shape: "point", speed: 0 }), createModule("init.lifetime", { lifetime: 10 }));
  e.renderer = { type: "sprite", blend: "alpha", shape: "softCircle", facing: "camera", sort };
  doc.emitters.push(e);
  return doc;
}

/** One instance per z position, spawned `stagger` steps apart so ages differ. */
function packAt(sort: SortMode, zs: number[], view: { px: number; py: number; pz: number; fx: number; fy: number; fz: number } | null) {
  const tpl = compileEffect(smoke(sort));
  const sims: EffectSim[] = [];
  for (const z of zs) {
    for (const s of sims) s.step(0.1);
    sims.push(new EffectSim(tpl).setPosition(0, 0, z).play());
    sims[sims.length - 1].step(0.1);
  }
  const batch = new ParticleBatch(tpl.emitters[0], new THREE.MeshBasicNodeMaterial());
  batch.begin();
  for (const s of sims) batch.pack(s.emitters[0], null);
  batch.end(view);
  const data = (batch as unknown as { data: Float32Array }).data;
  return Array.from({ length: zs.length }, (_, i) => data[i * PARTICLE_STRIDE + 2]);
}

describe("particle sorting", () => {
  // camera at z = 10 looking down -z: larger z is nearer
  const view = { px: 0, py: 0, pz: 10, fx: 0, fy: 0, fz: -1 };

  it("distance: back to front across all instances in the batch", () => {
    expect(packAt("distance", [5, -20, 0, 8, -3], view)).toEqual([-20, -3, 0, 5, 8]);
  });

  it("distance without a camera leaves pack order", () => {
    expect(packAt("distance", [5, -20, 0], null)).toEqual([5, -20, 0]);
  });

  it("none never reorders", () => {
    expect(packAt("none", [5, -20, 0], view)).toEqual([5, -20, 0]);
  });

  it("oldestOnTop draws the oldest last; newestOnTop the newest last", () => {
    // spawned in order: z=1 is oldest, z=3 newest
    expect(packAt("oldestOnTop", [1, 2, 3], null)).toEqual([3, 2, 1]);
    expect(packAt("newestOnTop", [1, 2, 3], null)).toEqual([1, 2, 3]);
  });

  it("validates sort modes", () => {
    const doc = smoke("distance");
    expect(validateEffect(doc)).toEqual([]);
    (doc.emitters[0].renderer as { sort: string }).sort = "zigzag";
    expect(validateEffect(doc).some((i) => i.message.includes("zigzag"))).toBe(true);
  });
});
