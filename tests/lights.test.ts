import { describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { createEffect, createEmitter, createModule, validateEffect, type EffectDoc, type LightRendererDoc } from "../src/index";
import { GpuEmitter, ParticleWorld } from "../src/three";
import { LIGHT_RECORD, lightBucket } from "../src/three/gpu/lights";

const light = (o: Partial<LightRendererDoc> = {}): LightRendererDoc => ({ type: "light", ratio: 1, maxLights: 2, intensity: 4, range: 3, ...o });

/** A burst of `count` motionless particles (lifetime 2) with a light renderer. */
function lit(o: Partial<LightRendererDoc> = {}, mut?: (d: EffectDoc) => void): EffectDoc {
  const doc = createEffect("lit", { emitter: false });
  doc.id = "lit";
  const e = createEmitter("e", "empty");
  e.maxParticles = 100;
  e.looping = false;
  e.spawn.push(createModule("spawn.burst", { count: 10 }));
  e.init.push(createModule("init.lifetime", { lifetime: 2 }), createModule("init.color", { color: { kind: "constant", color: "#ff8000" } }));
  e.renderers = [{ type: "sprite", blend: "additive", shape: "glow", facing: "camera" }, light(o)];
  doc.emitters.push(e);
  mut?.(doc);
  return doc;
}

const poolLights = (w: ParticleWorld) => w.object.getObjectByName("particles:lights")!.children as THREE.PointLight[];

describe("per-particle lights (CPU emitters)", () => {
  it("lights up to maxLights particles per instance, at their positions, tinted by their colour", () => {
    const w = new ParticleWorld({ lights: { max: 8 } });
    const h = w.spawn(lit(), { position: { x: 5, y: 0, z: 0 } });
    w.update(1 / 60);
    expect(w.stats.lights).toBe(2);
    const on = poolLights(w).filter((l) => l.intensity > 0);
    expect(on).toHaveLength(2);
    const b = h.sim!.emitters[0].buf;
    for (const l of on) {
      const i = Array.from({ length: b.count }, (_, k) => k).find((k) => Math.abs(b.px[k] - l.position.x) < 1e-6 && Math.abs(b.pz[k] - l.position.z) < 1e-6);
      expect(i).toBeDefined();
      expect(l.color.r).toBeCloseTo(b.r[i!], 5);
      expect(l.color.g).toBeCloseTo(b.g[i!], 5);
      expect(l.intensity).toBeCloseTo(4 * b.a[i!], 5);
      expect(l.distance).toBe(3);
    }
    // the rest of the pool stays in the scene, dark (changing the light count would recompile materials)
    expect(poolLights(w)).toHaveLength(8);
  });

  it("picks the highest-seed particle per seed bucket: the same particles keep their lights", () => {
    const w = new ParticleWorld({ lights: { max: 8 } });
    const h = w.spawn(lit({ ratio: 0.6, maxLights: 3 }));
    w.update(1 / 60);
    const b = h.sim!.emitters[0].buf;
    const expected = new Map<number, number>();
    for (let i = 0; i < b.count; i++) {
      if (b.seed[i] >= 0.6) continue;
      const k = lightBucket(b.seed[i], 0.6, 3);
      if (!expected.has(k) || b.seed[i] > b.seed[expected.get(k)!]) expected.set(k, i);
    }
    const positions = (w2: ParticleWorld) => poolLights(w2).filter((l) => l.intensity > 0).map((l) => l.position.x).sort();
    expect(positions(w)).toEqual([...expected.values()].map((i) => b.px[i]).sort());
    const before = positions(w);
    w.update(1 / 60);
    expect(positions(w)).toEqual(before);
  });

  it("caps lights world-wide, keeping the most important (closest relative to range, brightest)", () => {
    const w = new ParticleWorld({ lights: { max: 2 } });
    const near = w.spawn(lit({ maxLights: 2 }), { position: { x: 0, y: 0, z: -2 } });
    w.spawn(lit({ maxLights: 2 }), { position: { x: 0, y: 0, z: -200 } });
    w.update(1 / 60, new THREE.PerspectiveCamera());
    expect(w.stats.lights).toBe(2);
    const zs = poolLights(w).filter((l) => l.intensity > 0).map((l) => l.position.z);
    const nb = near.sim!.emitters[0].buf;
    expect(zs.every((z) => Math.abs(z - nb.pz[0]) < 2)).toBe(true);
  });

  it("follows the instance for local-space emitters, scaling range by size when asked", () => {
    const w = new ParticleWorld({ lights: { max: 4 } });
    w.spawn(
      lit({ maxLights: 1, sizeAffectsRange: true }, (d) => {
        d.emitters[0].space = "local";
        d.emitters[0].init.push(createModule("init.size", { size: 2 }));
      }),
      { position: { x: 10, y: 1, z: 0 }, scale: 2 },
    );
    w.update(1 / 60);
    const [l] = poolLights(w).filter((x) => x.intensity > 0);
    expect(l.position.x).toBeCloseTo(10, 5);
    expect(l.position.y).toBeCloseTo(1, 5);
    expect(l.distance).toBeCloseTo(3 * 2 * 2, 5); // range × size × instance scale
  });

  it("uses a fixed colour and ignores alpha when asked", () => {
    const w = new ParticleWorld({ lights: { max: 4 } });
    w.spawn(lit({ maxLights: 1, useParticleColor: false, color: "#0000ff", alphaAffectsIntensity: false }));
    w.update(1 / 60);
    const [l] = poolLights(w).filter((x) => x.intensity > 0);
    expect([l.color.r, l.color.g, l.color.b]).toEqual([0, 0, 1]);
    expect(l.intensity).toBe(4);
  });

  it("skips distance-culled instances and turns lights off when particles are gone", () => {
    const w = new ParticleWorld({ lights: { max: 4 } });
    w.spawn(lit({}, (d) => void (d.scalability = { cullDistance: 50 })), { position: { x: 0, y: 0, z: -500 } });
    w.update(1 / 60, new THREE.PerspectiveCamera());
    expect(w.stats.lights).toBe(0);
    const h = w.spawn(lit({}, (d) => (d.id = "near")));
    w.update(1 / 60);
    expect(w.stats.lights).toBe(2);
    h.release();
    w.update(1 / 60);
    expect(w.stats.lights).toBe(0);
    expect(poolLights(w).every((l) => l.intensity === 0)).toBe(true);
  });

  it("warns once when an effect has lights but the world has no pool, and draws nothing for them", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = new ParticleWorld();
    w.spawn(lit());
    w.spawn(lit({}, (d) => (d.id = "other")));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/no light pool/);
    w.update(1 / 60);
    expect(w.stats.drawCalls).toBe(2); // each effect's sprite; the light renderers draw nothing
    expect(w.object.getObjectByName("particles:lights")).toBeUndefined();
    warn.mockRestore();
  });

  it("validates light renderers", () => {
    expect(validateEffect(lit())).toEqual([]);
    const bad = validateEffect(lit({ ratio: 2, maxLights: 1.5, intensity: -1, range: -1, useParticleColor: false, color: "red" })).map((i) => i.message);
    expect(bad).toEqual(
      expect.arrayContaining([
        "Light ratio must be between 0 and 1",
        "maxLights must be a whole number ≥ 0",
        "Light intensity must be ≥ 0",
        "Light range must be ≥ 0",
        "Light color must be a #rrggbb hex colour",
      ]),
    );
  });
});

describe("per-particle lights (GPU emitters)", () => {
  type Read = { rb: { buffer: ArrayBuffer | null }; land: (u32: Uint32Array) => Promise<void> };
  function fakeRenderer() {
    const calls: { count: unknown; batch?: number }[] = [];
    const reads: Read[] = [];
    return {
      calls,
      reads,
      backend: { isWebGPUBackend: true },
      compute: (node: unknown, count: unknown = null) => void calls.push({ count, ...(Array.isArray(node) ? { batch: node.length } : {}) }),
      getArrayBufferAsync: (_a: unknown, rb: Read["rb"]) =>
        new Promise<void>((resolve) =>
          reads.push({
            rb,
            land: async (u32) => {
              rb.buffer = u32.buffer as ArrayBuffer;
              resolve();
              await Promise.resolve();
              await Promise.resolve();
            },
          }),
        ),
    } as unknown as THREE.WebGPURenderer & { calls: { count: unknown; batch?: number }[]; reads: Read[] };
  }
  const gpuLit = () =>
    lit({ maxLights: 2 }, (d) => {
      d.emitters[0].sim = "gpu";
      d.emitters[0].looping = true;
      d.emitters[0].spawn = [createModule("spawn.rate", { rate: 600 })];
    });

  it("gathers on the GPU (reset, then pick + write in one call) with one read in flight", () => {
    const r = fakeRenderer();
    const w = new ParticleWorld({ renderer: r, lights: { max: 4 } });
    w.spawn(gpuLit());
    w.update(1 / 60);
    expect(r.calls.at(-1)).toEqual({ count: 100, batch: 2 }); // the used span: 1 lane × 100 slots
    expect(r.reads).toHaveLength(1);
    w.update(1 / 60);
    expect(r.reads).toHaveLength(1);
  });

  it("lights the gathered particles, moved along their velocity for the reading's age", async () => {
    const r = fakeRenderer();
    const w = new ParticleWorld({ renderer: r, lights: { max: 4 } });
    const h = w.spawn(gpuLit());
    w.update(1 / 60);
    // lane 0: bucket keys (2), then 2 records: pos xyz, size, vel xyz, age01, rgba
    const max = 2;
    const u = new Uint32Array(max * (1 + LIGHT_RECORD));
    const f = new Float32Array(u.buffer);
    u[0] = 1; // bucket 0 filled
    u[1] = 0; // bucket 1 empty
    f.set([1, 2, 3, 0.5, 6, 0, 0, 0.25, 1, 0.5, 0, 1], max);
    await r.reads[0].land(u);
    expect((h.sim!.emitters[0].gpu as GpuEmitter).lightReading(0)!.ll.count).toBe(1);
    w.update(0.1); // world time moves on: the light is extrapolated along its velocity
    const [l] = poolLights(w).filter((x) => x.intensity > 0);
    expect(l.position.x).toBeCloseTo(1 + 6 * 0.1, 4);
    expect([l.position.y, l.position.z]).toEqual([2, 3]);
    expect([l.color.r, l.color.g, l.color.b]).toEqual([1, 0.5, 0]);
    expect(w.stats.lights).toBe(1);
  });
});
