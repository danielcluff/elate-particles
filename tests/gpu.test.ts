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

/** Records compute dispatches instead of running them (arrays are one call with `batch` kernels). */
function fakeRenderer() {
  const calls: Call[] = [];
  const compute = (node: unknown, count: number | { isIndirectStorageBufferAttribute?: boolean } | null = null) =>
    void calls.push({ count: typeof count === "object" && count?.isIndirectStorageBufferAttribute ? "indirect" : (count as number | null), ...(Array.isArray(node) ? { batch: node.length } : {}) });
  return { calls, compute, backend: { isWebGPUBackend: true } } as unknown as THREE.WebGPURenderer & { calls: Call[] };
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
      d.emitters[0].renderers = [{ type: "ribbon", blend: "additive", shape: "glow", facing: "camera", uvMode: "stretch" }];
    });
    expect(gpuSupport(compileEffect(doc).emitters[0], doc).join("\n")).toMatch(/ribbon/);
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
      d.emitters[0].renderers[0] = { type: "ribbon", blend: "additive", shape: "glow", facing: "camera", uvMode: "stretch" };
    });
    expect(validateEffect(bad).some((i) => i.message.includes("GPU simulation doesn't support ribbon renderers"))).toBe(true);
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
    // clear, prep, init, update, then key + 78 passes + 2 gather halves in one call
    expect(r.calls.at(-1)).toEqual({ count: null, batch: 81 });
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
        d.emitters[1].renderers = [{ type: "ribbon", blend: "additive", shape: "glow", facing: "camera", uvMode: "stretch" }];
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
