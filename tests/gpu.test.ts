import { describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { EffectSim, compileEffect, createEffect, createEmitter, createModule, validateEffect, type EffectDoc, type GpuSpawnTarget } from "../src/index";
import { GpuEmitter, GpuPool, ParticleWorld, gpuSupport } from "../src/three";

function gpuDoc(mut?: (doc: EffectDoc) => void): EffectDoc {
  const doc = createEffect("g", { emitter: false });
  doc.id = "g";
  const e = createEmitter("e", "empty");
  e.sim = "gpu";
  e.maxParticles = 1000;
  e.spawn.push(createModule("spawn.rate", { rate: 600 }));
  e.init.push(createModule("init.lifetime", { lifetime: 1 }), createModule("init.shape", { shape: "cone" }), createModule("init.color", { color: { kind: "range", a: "#ff0000", b: "#0000ff" } }));
  e.update.push(createModule("update.gravity", {}), createModule("update.drag", {}), createModule("update.turbulence", {}));
  doc.emitters.push(e);
  mut?.(doc);
  return doc;
}

type Call = { count: number | "indirect" | null; batch?: number };

type Read = { rb: { buffer: ArrayBuffer | null }; land: (u32: Uint32Array) => Promise<void> };

/**
 * Records compute dispatches instead of running them (arrays are one call with
 * `batch` kernels; 2D dispatches record their [x, y, z]). Readbacks wait in
 * `reads` until a test lands them with the u32 contents it wants.
 */
function fakeRenderer() {
  const calls: (Call | { count: number[] })[] = [];
  const reads: Read[] = [];
  const compute = (node: unknown, count: number | number[] | { isIndirectStorageBufferAttribute?: boolean } | null = null) =>
    void calls.push(
      Array.isArray(count)
        ? { count }
        : { count: typeof count === "object" && count?.isIndirectStorageBufferAttribute ? "indirect" : (count as number | null), ...(Array.isArray(node) ? { batch: node.length } : {}) },
    );
  const getArrayBufferAsync = (_attr: unknown, rb: Read["rb"]) =>
    new Promise<void>((resolve) => {
      reads.push({
        rb,
        land: async (u32) => {
          rb.buffer = u32.buffer as ArrayBuffer;
          resolve();
          await Promise.resolve();
          await Promise.resolve();
        },
      });
    });
  return { calls, reads, compute, getArrayBufferAsync, backend: { isWebGPUBackend: true } } as unknown as THREE.WebGPURenderer & { calls: Call[]; reads: Read[] };
}

/** The u32 counters GpuBounds reads back, for lanes given as [minX, minY, minZ, maxX, maxY, maxZ, maxSpeed, maxSize] (null = empty). */
function boundsWords(lanes: (number[] | null)[]): Uint32Array {
  const enc = (f: number) => {
    const u = new Uint32Array(new Float32Array([f]).buffer)[0];
    return f >= 0 ? (u | 0x80000000) >>> 0 : ~u >>> 0;
  };
  const out = new Uint32Array(lanes.length * 8);
  lanes.forEach((l, i) => {
    if (!l) {
      out.fill(0xffffffff, i * 8, i * 8 + 3);
      return;
    }
    l.forEach((v, k) => (out[i * 8 + k] = enc(k === 6 ? v * v : v)));
  });
  return out;
}

/** A rocket → burst pair on the GPU: bursts spawn from rocket deaths. */
function eventDoc(mut?: (doc: EffectDoc) => void): EffectDoc {
  const doc = gpuDoc((d) => {
    d.emitters[0].id = d.emitters[0].name = "rocket";
    d.emitters[0].spawn = [createModule("spawn.rate", { rate: 60 })];
    d.emitters[0].subEmitters = [{ trigger: "death", emitter: "burst", count: 50 }];
    const b = createEmitter("burst", "empty");
    b.id = "burst";
    b.sim = "gpu";
    b.eventDriven = true;
    b.maxParticles = 5000;
    b.init.push(createModule("init.lifetime", { lifetime: 2 }), createModule("init.shape", { shape: "sphere" }));
    d.emitters.push(b);
  });
  mut?.(doc);
  return doc;
}

describe("GPU support checks", () => {
  it("accepts the built-in init/update modules", () => {
    const doc = gpuDoc();
    expect(gpuSupport(compileEffect(doc).emitters[0], doc)).toEqual([]);
  });

  it("explains what keeps an emitter on the CPU", () => {
    const doc = gpuDoc((d) => {
      d.emitters[0].renderers = [{ type: "ribbon", blend: "additive", shape: "glow", facing: "camera", uvMode: "stretch", sort: "distance" }];
    });
    expect(gpuSupport(compileEffect(doc).emitters[0], doc).join("\n")).toMatch(/sorted ribbons/);
  });

  it("accepts curves over particle age, sorting and sub-emitters", () => {
    const doc = eventDoc((d) => {
      d.emitters[0].update.push(createModule("update.force", { scale: { kind: "rangeCurve", min: { keys: [{ t: 0, v: 0 }] }, max: { keys: [{ t: 1, v: 2 }] } } }));
      d.emitters[0].update.push(createModule("update.limitVelocity", { maxSpeed: { kind: "curve", curve: { keys: [{ t: 0, v: 9 }, { t: 1, v: 1 }] } } }));
      d.emitters[0].renderers[0] = { type: "sprite", blend: "alpha", shape: "softCircle", facing: "camera", sort: "distance" };
    });
    const t = compileEffect(doc);
    expect(gpuSupport(t.emitters[0], doc)).toEqual([]);
    expect(gpuSupport(t.emitters[1], doc)).toEqual([]);
    expect(validateEffect(doc)).toEqual([]);
  });

  it("limits the number of distinct sub-emitter targets", () => {
    const doc = eventDoc((d) => {
      for (const id of ["b2", "b3", "b4"]) {
        const b = createEmitter(id, "empty");
        b.id = id;
        b.sim = "gpu";
        b.eventDriven = true;
        d.emitters.push(b);
        d.emitters[0].subEmitters!.push({ trigger: "birth", emitter: id, count: 1 });
      }
    });
    expect(gpuSupport(compileEffect(doc).emitters[0], doc).join()).toMatch(/more than 3 sub-emitter targets/);
  });

  it("structural limits show up in validation, and the 100k CPU warning doesn't apply", () => {
    const doc = gpuDoc((d) => {
      d.emitters[0].maxParticles = 500_000;
    });
    expect(validateEffect(doc)).toEqual([]);
    const bad = gpuDoc((d) => {
      d.emitters[0].renderers[0] = { type: "ribbon", blend: "additive", shape: "glow", facing: "camera", uvMode: "stretch", sort: "distance" };
    });
    expect(validateEffect(bad).some((i) => i.message.includes("GPU simulation doesn't support sorted ribbons"))).toBe(true);
    const mixed = eventDoc((d) => {
      d.emitters[1].sim = "cpu";
    });
    expect(validateEffect(mixed).filter((i) => i.message.includes("sub-emitters with a CPU partner")).map((i) => i.emitterId)).toEqual(["rocket"]);
  });
});

describe("CPU fallback", () => {
  it("runs gpu emitters on the CPU (with one warning) when there is no renderer", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = new ParticleWorld();
    const h = w.spawn(gpuDoc());
    for (let i = 0; i < 30; i++) w.update(1 / 60);
    expect(h.sim!.emitters[0].gpu).toBeNull();
    expect(h.sim!.emitters[0].buf.count).toBeGreaterThan(200);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/runs on the CPU instead of the GPU: no renderer/));
    w.spawn(gpuDoc());
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("falls back when the renderer is on the WebGL backend", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = fakeRenderer();
    (r as unknown as { backend: { isWebGPUBackend: boolean } }).backend.isWebGPUBackend = false;
    const w = new ParticleWorld({ renderer: r });
    w.spawn(gpuDoc());
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/not using WebGPU/));
    warn.mockRestore();
  });
});

describe("GPU emitters (dispatch bookkeeping)", () => {
  it("EmitterSim forwards spawns to a GPU target instead of creating CPU particles", () => {
    const sim = new EffectSim(compileEffect(gpuDoc())).play();
    let requested = 0;
    const target: GpuSpawnTarget = { spawn: (n) => void (requested += n), count: 0, reset: () => {} };
    sim.emitters[0].gpu = target;
    for (let i = 0; i < 60; i++) sim.step(1 / 60);
    expect(requested).toBeGreaterThanOrEqual(595);
    expect(sim.emitters[0].buf.count).toBe(0);
  });

  it("dispatches clear once, init per spawning frame (sized to the spawn), update over the used lanes", () => {
    const r = fakeRenderer();
    const w = new ParticleWorld({ renderer: r });
    const h = w.spawn(gpuDoc());
    expect(h.sim!.emitters[0].gpu).toBeInstanceOf(GpuEmitter);
    w.update(1 / 60);
    w.update(1 / 60);
    // frame 1: build (clear, prep, init, update compiled with empty dispatches), clear (every lane starts dead),
    // prep (claims ring slots), init (10 = 600/s × 1/60), update (1 lane × 1000 slots); frame 2: prep, init, update
    expect(r.calls).toEqual([{ count: 0, batch: 4 }, { count: null }, { count: null }, { count: 10 }, { count: 1000 }, { count: null }, { count: 10 }, { count: 1000 }]);
    expect(w.stats.drawCalls).toBe(1);
  });

  it("estimates live particles from spawn records and lifetimes", () => {
    const r = fakeRenderer();
    const w = new ParticleWorld({ renderer: r });
    const h = w.spawn(gpuDoc());
    for (let i = 0; i < 30; i++) w.update(1 / 60); // 0.5 s at 600/s
    expect(h.particleCount).toBeGreaterThanOrEqual(295);
    expect(h.particleCount).toBeLessThanOrEqual(305);
    h.stop();
    for (let i = 0; i < 90; i++) w.update(1 / 60); // all lifetimes (≤ 1 s by the estimate's fallback) have passed
    expect(h.particleCount).toBe(0);
    expect(h.alive).toBe(false);
  });

  it("caps at capacity and resets on play", () => {
    const r = fakeRenderer();
    const w = new ParticleWorld({ renderer: r });
    const h = w.spawn(
      gpuDoc((d) => {
        d.emitters[0].maxParticles = 100;
      }),
      { autoRelease: false },
    );
    for (let i = 0; i < 60; i++) w.update(1 / 60);
    expect(h.particleCount).toBe(100);
    r.calls.length = 0;
    h.play();
    w.update(1 / 60);
    expect(r.calls[0].count).toBeNull(); // clear again
  });

  it("disposes GPU emitters with their effect", () => {
    const w = new ParticleWorld({ renderer: fakeRenderer() });
    const h = w.spawn(gpuDoc());
    w.update(1 / 60);
    expect(w.object.children.some((c) => c.name.startsWith("particles:gpu:"))).toBe(true);
    h.release();
    w.unregister("g");
    expect(w.object.children.some((c) => c.name.startsWith("particles:gpu:"))).toBe(false);
  });
});

describe("GPU sorting", () => {
  it("sorts after the update in one batched call, and only the sorted renderer draws the sorted copy", () => {
    const r = fakeRenderer();
    const w = new ParticleWorld({ renderer: r });
    const doc = gpuDoc((d) => {
      d.emitters[0].renderers = [
        { type: "sprite", blend: "alpha", shape: "softCircle", facing: "camera", sort: "distance" },
        { type: "sprite", blend: "additive", shape: "glow", facing: "camera" },
      ];
    });
    const h = w.spawn(doc);
    const pool = (h.sim!.emitters[0].gpu as GpuEmitter).pool;
    const cam = new THREE.PerspectiveCamera();
    w.update(1 / 60, cam);
    // the pool sorts every lane together: 4 lanes × 1000 → 4096 keys
    expect(pool.sorter!.size).toBe(4096);
    expect(pool.sorter!.passes).toBe(78); // log2(4096) = 12 → 12·13/2
    // clear, prep, init, update, then key + 78 passes + 2 gather halves in one call (then the culling bounds)
    expect(r.calls.find((c) => "batch" in c && c.batch! > 4)).toEqual({ count: null, batch: 81 });
    const [sorted, plain] = pool.meshes;
    expect(sorted.geometry.getAttribute("pA")).toBe(pool.sorter!.attrs[0]);
    expect(plain.geometry.getAttribute("pA")).toBe(pool.attributes[0]);
    // distance sorting needs a camera: without one the last order stands
    r.calls.length = 0;
    w.update(1 / 60);
    expect(r.calls.some((c) => c.batch)).toBe(false);
  });

  it("age sorting runs without a camera", () => {
    const r = fakeRenderer();
    const w = new ParticleWorld({ renderer: r });
    w.spawn(gpuDoc((d) => void (d.emitters[0].renderers[0] = { type: "sprite", blend: "alpha", shape: "softCircle", facing: "camera", sort: "oldestOnTop" })));
    w.update(1 / 60);
    expect(r.calls.at(-1)?.batch).toBe(81);
  });
});

describe("GPU sub-emitters", () => {
  it("keeps both ends on the GPU, linked, with the target dispatched indirectly once events can exist", () => {
    const r = fakeRenderer();
    const w = new ParticleWorld({ renderer: r });
    const h = w.spawn(eventDoc());
    const [rocket, burst] = h.sim!.emitters;
    expect(rocket.gpu).toBeInstanceOf(GpuEmitter);
    expect(burst.gpu).toBeInstanceOf(GpuEmitter);
    w.update(1 / 60);
    // rocket: build, clear, prep, init, update; burst: build (with the event kernel), clear, prep, events (indirect), update
    expect(r.calls).toEqual([
      { count: 0, batch: 4 },
      { count: null },
      { count: null },
      { count: 1 },
      { count: 1000 },
      { count: 0, batch: 5 },
      { count: null },
      { count: null },
      { count: "indirect" },
      { count: 5000 },
    ]);
    expect((rocket.gpu as GpuEmitter).lane).toBe((burst.gpu as GpuEmitter).lane);
  });

  it("falls back to the CPU together when one end can't run on the GPU", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = new ParticleWorld({ renderer: fakeRenderer() });
    const h = w.spawn(
      eventDoc((d) => {
        d.emitters[1].renderers = [{ type: "ribbon", blend: "additive", shape: "glow", facing: "camera", uvMode: "stretch", sort: "distance" }];
      }),
    );
    expect(h.sim!.emitters.map((e) => e.gpu)).toEqual([null, null]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/rocket runs on the CPU instead of the GPU: its sub-emitter partner burst runs on the CPU/));
    // and the CPU simulation still drives the bursts
    for (let i = 0; i < 90; i++) w.update(1 / 60);
    expect(h.sim!.emitters[1].buf.count).toBeGreaterThan(0);
    warn.mockRestore();
  });

  it("estimates the target's live count from the source's spawns, so the effect finishes after both", () => {
    const w = new ParticleWorld({ renderer: fakeRenderer() });
    const h = w.spawn(
      eventDoc((d) => {
        d.emitters[0].looping = false;
        d.emitters[0].duration = 0.5;
      }),
    );
    for (let i = 0; i < 30; i++) w.update(1 / 60); // 0.5 s: 30 rockets (lifetime 1)
    const burst = h.sim!.emitters[1];
    // upper bound: every rocket may die into 50 particles
    expect(burst.particleCount).toBeGreaterThanOrEqual(30 * 50 - 50);
    expect(h.alive).toBe(true);
    for (let i = 0; i < 60 * 2.6; i++) w.update(1 / 60); // rocket lifetime (1) + burst lifetime (2) after the last spawn
    expect(h.alive).toBe(true);
    for (let i = 0; i < 30; i++) w.update(1 / 60);
    expect(burst.particleCount).toBe(0);
    expect(h.alive).toBe(false);
  });
});

describe("GPU batching across instances", () => {
  const meshes = (w: ParticleWorld) => w.object.children.filter((c) => c.name.startsWith("particles:gpu:")) as THREE.Mesh[];

  it("instances share one pool, one set of kernels and one draw call per renderer", () => {
    const r = fakeRenderer();
    const w = new ParticleWorld({ renderer: r });
    const hs = [0, 1, 2].map((i) => w.spawn(gpuDoc(), { position: { x: i * 10, y: 0, z: 0 } }));
    const lanes = hs.map((h) => h.sim!.emitters[0].gpu as GpuEmitter);
    expect(new Set(lanes.map((g) => g.pool)).size).toBe(1);
    expect(lanes.map((g) => g.lane)).toEqual([0, 1, 2]);
    w.update(1 / 60);
    expect(meshes(w)).toHaveLength(1);
    expect(w.stats.drawCalls).toBe(1);
    // one init for all three instances' spawns (3 × 10), one update over the 3 used lanes
    expect(r.calls.filter((c) => c.count === 30)).toHaveLength(1);
    expect(r.calls.at(-1)).toEqual({ count: 3000 });
    expect((meshes(w)[0].geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(3000);
  });

  it("writes each instance's row: transform, dt, spawn count, prefix sums", () => {
    const w = new ParticleWorld({ renderer: fakeRenderer() });
    const a = w.spawn(gpuDoc(), { position: { x: 1, y: 2, z: 3 } });
    const b = w.spawn(gpuDoc(), { position: { x: -4, y: 0, z: 0 }, scale: 2 });
    w.update(1 / 60);
    const pool = (a.sim!.emitters[0].gpu as GpuEmitter).pool;
    const W = pool.layout.width;
    const row = (g: GpuEmitter) => [...pool.laneData.subarray(g.lane * W, g.lane * W + 20)].map((v) => +v.toFixed(4));
    const ra = row(a.sim!.emitters[0].gpu as GpuEmitter);
    const rb = row(b.sim!.emitters[0].gpu as GpuEmitter);
    expect(ra.slice(0, 4)).toEqual([1, 2, 3, 1]);
    expect(rb.slice(0, 4)).toEqual([-4, 0, 0, 2]);
    // spawn count, prefix, dt, visible
    expect(ra.slice(16, 20)).toEqual([10, 0, +(1 / 60).toFixed(4), 1]);
    expect(rb.slice(16, 20)).toEqual([10, 10, +(1 / 60).toFixed(4), 1]);
  });

  it("grows by doubling, keeping lanes, and frees the lowest lane first", () => {
    const r = fakeRenderer();
    const w = new ParticleWorld({ renderer: r });
    const hs = [0, 1, 2, 3, 4].map(() => w.spawn(gpuDoc(), { autoRelease: false }));
    const pool = (hs[0].sim!.emitters[0].gpu as GpuEmitter).pool;
    expect(pool.lanes).toBe(8);
    expect(pool.capacity).toBe(8000);
    expect(hs.map((h) => (h.sim!.emitters[0].gpu as GpuEmitter).lane)).toEqual([0, 1, 2, 3, 4]);
    w.update(1 / 60);
    hs[1].release();
    hs[3].release();
    const again = w.spawn(gpuDoc(), { autoRelease: false });
    expect((again.sim!.emitters[0].gpu as GpuEmitter).lane).toBe(1);
    w.update(1 / 60);
    // span = highest used lane + 1
    expect(pool.span).toBe(5);
    for (const h of [hs[0], hs[2], hs[4], again]) h.release();
    w.update(1 / 60);
    expect(meshes(w)[0].visible).toBe(false);
    expect(w.stats.drawCalls).toBe(0);
  });

  it("sizes the pool for scalability.maxInstances", () => {
    const w = new ParticleWorld({ renderer: fakeRenderer() });
    const h = w.spawn(gpuDoc((d) => void (d.scalability = { maxInstances: 12 })));
    expect((h.sim!.emitters[0].gpu as GpuEmitter).pool.lanes).toBe(12);
  });

  it("released instances free their lanes (pooled sims don't hold GPU memory)", () => {
    const w = new ParticleWorld({ renderer: fakeRenderer() });
    const h = w.spawn(gpuDoc(), { autoRelease: false });
    const em = h.sim!.emitters[0];
    h.release();
    expect(em.gpu).toBeNull();
    const h2 = w.spawn(gpuDoc(), { autoRelease: false });
    expect((h2.sim!.emitters[0].gpu as GpuEmitter).lane).toBe(0);
  });

  it("hides distance-culled instances through their row, without a draw call of their own", () => {
    const w = new ParticleWorld({ renderer: fakeRenderer() });
    const doc = gpuDoc((d) => void (d.scalability = { cullDistance: 50 }));
    const near = w.spawn(doc, { position: { x: 0, y: 0, z: 0 } });
    const far = w.spawn(doc, { position: { x: 500, y: 0, z: 0 } });
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(0, 0, 10);
    w.update(1 / 60, cam);
    const pool = (near.sim!.emitters[0].gpu as GpuEmitter).pool;
    const visible = (h: typeof near) => pool.laneData[(h.sim!.emitters[0].gpu as GpuEmitter).lane * pool.layout.width + 19];
    expect(visible(near)).toBe(1);
    expect(visible(far)).toBe(0);
    expect(w.stats.culledInstances).toBe(1);
    expect(w.stats.drawCalls).toBe(1);
  });

  it("local-space emitters get a single-lane pool per instance that follows it", () => {
    const w = new ParticleWorld({ renderer: fakeRenderer() });
    const doc = gpuDoc((d) => void (d.emitters[0].space = "local"));
    const a = w.spawn(doc, { position: { x: 5, y: 0, z: 0 } });
    const b = w.spawn(doc, { position: { x: -5, y: 0, z: 0 } });
    const pa = (a.sim!.emitters[0].gpu as GpuEmitter).pool;
    const pb = (b.sim!.emitters[0].gpu as GpuEmitter).pool;
    expect(pa).not.toBe(pb);
    expect(pa).toBeInstanceOf(GpuPool);
    expect(pa.lanes).toBe(1);
    w.update(1 / 60);
    expect(pa.meshes[0].matrix.elements[12]).toBe(5);
    expect(pb.meshes[0].matrix.elements[12]).toBe(-5);
    expect(w.stats.drawCalls).toBe(2);
    a.release();
    expect(pa.meshes[0].parent).toBeNull();
  });
});

describe("GPU ribbons", () => {
  const ribbon = (mode: "particle" | "emitter") => ({ type: "ribbon" as const, mode, trail: { points: 8, minDistance: 0.1, lifetime: 0.5 }, blend: "additive" as const, shape: "glow" as const, facing: "camera" as const, uvMode: "stretch" as const });

  it("accepts both ribbon modes", () => {
    for (const mode of ["particle", "emitter"] as const) {
      const doc = gpuDoc((d) => void (d.emitters[0].renderers = [ribbon(mode)]));
      expect(gpuSupport(compileEffect(doc).emitters[0], doc)).toEqual([]);
    }
  });

  it("particle trails draw one instance per history point per slot, from a pool-built material", () => {
    const w = new ParticleWorld({ renderer: fakeRenderer() });
    const h = w.spawn(gpuDoc((d) => void (d.emitters[0].renderers = [ribbon("particle"), { type: "sprite", blend: "additive", shape: "glow", facing: "camera" }])));
    const pool = (h.sim!.emitters[0].gpu as GpuEmitter).pool;
    const [trail, sprite] = pool.meshes;
    const placeholder = trail.material;
    w.update(1 / 60);
    expect(trail.material).not.toBe(placeholder); // built over the pool's buffers on the first dispatch
    expect((trail.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(1000 * 8);
    expect((sprite.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(1000);
    // a resize rebuilds it over the new buffers
    const built = trail.material;
    for (let i = 0; i < 4; i++) w.spawn(gpuDoc((d) => void (d.emitters[0].renderers = [ribbon("particle"), { type: "sprite", blend: "additive", shape: "glow", facing: "camera" }])));
    w.update(1 / 60);
    expect(pool.lanes).toBe(8);
    expect(trail.material).not.toBe(built);
  });

  it("emitter-mode ribbons draw one segment per slot", () => {
    const w = new ParticleWorld({ renderer: fakeRenderer() });
    const h = w.spawn(gpuDoc((d) => void (d.emitters[0].renderers = [ribbon("emitter")])));
    w.update(1 / 60);
    const [m] = (h.sim!.emitters[0].gpu as GpuEmitter).pool.meshes;
    expect((m.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(1000);
    expect(w.stats.drawCalls).toBe(1);
  });
});

describe("GPU sort groups", () => {
  const grouped = (id: string, sim: "gpu" | "cpu") =>
    gpuDoc((d) => {
      d.id = id;
      d.emitters[0].sim = sim;
      d.emitters[0].renderers = [{ type: "sprite", blend: "alpha", shape: "softCircle", facing: "camera", sortGroup: "fx" }];
    });
  const named = (w: ParticleWorld, name: string) => w.object.children.find((c) => c.name === name) as THREE.Mesh | undefined;

  it("GPU members draw through the group: CPU and GPU particles gathered, sorted on the GPU, one draw call", () => {
    const r = fakeRenderer();
    const w = new ParticleWorld({ renderer: r });
    const g = w.spawn(grouped("gpuFx", "gpu"));
    w.spawn(grouped("cpuFx", "cpu"));
    const pool = (g.sim!.emitters[0].gpu as GpuEmitter).pool;
    expect(pool.meshes).toHaveLength(0); // its sprite renderer is a group member
    expect(pool.groupMembers).toEqual([{ name: "fx", member: 0 }]);
    w.update(1 / 60, new THREE.PerspectiveCamera());
    expect(named(w, "particles:group:fx")!.visible).toBe(false);
    const gpuMesh = named(w, "particles:group:fx:gpu")!;
    expect(gpuMesh.visible).toBe(true);
    // CPU members (10 particles) + the GPU pool's used lanes (1 × 1000)
    expect((gpuMesh.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(10 + 1000);
    expect(w.stats.drawCalls).toBe(1);
    // gather (fill + CPU copy + pool copy) in one call, then key + passes + gather halves in another
    expect(r.calls.at(-2)).toEqual({ count: null, batch: 3 });
    expect((r.calls.at(-1) as Call).batch).toBeGreaterThan(3);
  });

  it("falls back to CPU sorting when the last GPU member leaves", () => {
    const w = new ParticleWorld({ renderer: fakeRenderer() });
    const g = w.spawn(grouped("gpuFx", "gpu"), { autoRelease: false });
    w.spawn(grouped("cpuFx", "cpu"));
    w.update(1 / 60);
    g.release();
    w.unregister("gpuFx");
    w.update(1 / 60);
    expect(named(w, "particles:group:fx")!.visible).toBe(true);
    expect(named(w, "particles:group:fx:gpu")!.visible).toBe(false);
    expect(w.stats.drawCalls).toBe(1);
  });
});

describe("GPU frustum culling", () => {
  // the default camera sits at the origin looking down -z: z = -10 is in view, z = +10 behind it
  const setup = (mut?: (d: EffectDoc) => void) => {
    const r = fakeRenderer();
    const w = new ParticleWorld({ renderer: r });
    const cam = new THREE.PerspectiveCamera();
    const h = w.spawn(gpuDoc(mut), { autoRelease: false, position: { x: 0, y: 0, z: 10 } });
    const lane = h.sim!.emitters[0].gpu as GpuEmitter;
    const visibleFlag = () => lane.pool.laneData[lane.lane * lane.pool.layout.width + 19];
    return { r, w, cam, h, lane, visibleFlag };
  };
  const behind = [-1, -1, 9, 1, 1, 11, 0, 0.1];
  const ahead = [-1, -1, -11, 1, 1, -9, 0, 0.1];

  it("measures bounds with one 2D dispatch per pool, one read in flight", () => {
    const { r, w, cam } = setup();
    w.update(1 / 60, cam);
    expect(r.calls.at(-1)).toEqual({ count: [Math.ceil(1000 / 64), 1, 1] });
    expect(r.reads).toHaveLength(1);
    w.update(1 / 60, cam);
    w.update(1 / 60, cam);
    expect(r.reads).toHaveLength(1); // still waiting: no new measurement
  });

  it("keeps instances visible until bounds arrive, then culls them, hides their lanes and skips the draw", async () => {
    const { r, w, cam, h, visibleFlag } = setup();
    w.update(1 / 60, cam);
    expect(h.culled).toBe(false);
    expect(w.stats.culledInstances).toBe(0);
    await r.reads[0].land(boundsWords([behind]));
    w.update(1 / 60, cam);
    expect(w.stats.culledInstances).toBe(1);
    w.update(1 / 60, cam); // the lane flag follows a frame later
    expect(visibleFlag()).toBe(0);
    expect(w.stats.drawCalls).toBe(0);
  });

  it("culls with the measured box, not the effect's position", async () => {
    const { r, w, cam, visibleFlag } = setup();
    w.update(1 / 60, cam);
    // the effect sits behind the camera, but its particles were measured ahead of it
    await r.reads[0].land(boundsWords([ahead]));
    w.update(1 / 60, cam);
    w.update(1 / 60, cam);
    expect(w.stats.culledInstances).toBe(0);
    expect(visibleFlag()).toBe(1);
    expect(w.stats.drawCalls).toBe(1);
  });

  it("widens old bounds by the instance's movement since they were measured", async () => {
    const { r, w, cam, h } = setup();
    w.update(1 / 60, cam);
    await r.reads[0].land(boundsWords([behind]));
    w.update(1 / 60, cam);
    expect(w.stats.culledInstances).toBe(1);
    // the instance jumps in front of the camera; the box (still the old reading) moves with it
    h.setPosition(0, 0, -10);
    w.update(1 / 60, cam);
    expect(w.stats.culledInstances).toBe(0);
  });

  it("an empty reading is a point at the instance", async () => {
    const { r, w, cam } = setup();
    w.update(1 / 60, cam);
    await r.reads[0].land(boundsWords([null]));
    w.update(1 / 60, cam);
    expect(w.stats.culledInstances).toBe(1);
  });

  it("pauseOffscreen stops stepping culled looping GPU instances", async () => {
    const { r, w, cam, h } = setup((d) => void (d.scalability = { pauseOffscreen: true }));
    w.update(1 / 60, cam);
    await r.reads[0].land(boundsWords([behind]));
    w.update(1 / 60, cam);
    const t = h.sim!.emitters[0].time;
    w.update(1 / 60, cam);
    w.update(1 / 60, cam);
    expect(h.sim!.emitters[0].time).toBe(t);
  });

  it("drops a reading whose lane changed hands before it landed", async () => {
    const { r, w, cam, h } = setup();
    w.update(1 / 60, cam);
    h.release();
    const h2 = w.spawn(gpuDoc(), { autoRelease: false, position: { x: 0, y: 0, z: 10 } });
    expect((h2.sim!.emitters[0].gpu as GpuEmitter).lane).toBe(0);
    await r.reads[0].land(boundsWords([behind]));
    w.update(1 / 60, cam);
    expect(w.stats.culledInstances).toBe(0); // the new instance hasn't been measured yet
  });

  it("does nothing without a camera or with frustumCulling off", () => {
    const r = fakeRenderer();
    const w = new ParticleWorld({ renderer: r, frustumCulling: false });
    w.spawn(gpuDoc());
    w.update(1 / 60, new THREE.PerspectiveCamera());
    expect(r.reads).toHaveLength(0);
  });
});
