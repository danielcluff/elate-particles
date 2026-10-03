import { describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { EffectSim, compileEffect, createEffect, createEmitter, createModule, validateEffect, type EffectDoc, type GpuSpawnTarget } from "../src/index";
import { GpuEmitter, ParticleWorld, gpuSupport } from "../src/three";

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

/** Records compute dispatches instead of running them. */
function fakeRenderer() {
  const calls: { count: number | null }[] = [];
  return { calls, compute: (_node: unknown, count: number | null = null) => void calls.push({ count }), backend: { isWebGPUBackend: true } } as unknown as THREE.WebGPURenderer & { calls: { count: number | null }[] };
}

describe("GPU support checks", () => {
  it("accepts the built-in init/update modules", () => {
    const doc = gpuDoc();
    expect(gpuSupport(compileEffect(doc).emitters[0], doc)).toEqual([]);
  });

  it("explains what keeps an emitter on the CPU", () => {
    const doc = gpuDoc((d) => {
      d.emitters[0].update.push(createModule("update.drag", { drag: { kind: "curve", curve: { keys: [{ t: 0, v: 1 }] } } }));
      d.emitters[0].renderers = [{ type: "ribbon", blend: "additive", shape: "glow", facing: "camera", uvMode: "stretch" }];
    });
    const why = gpuSupport(compileEffect(doc).emitters[0], doc).join("\n");
    expect(why).toMatch(/ribbon/);
    expect(why).toMatch(/Drag: curves over particle age/);
  });

  it("structural limits show up in validation, and the 100k CPU warning doesn't apply", () => {
    const doc = gpuDoc((d) => {
      d.emitters[0].maxParticles = 500_000;
    });
    expect(validateEffect(doc)).toEqual([]);
    const bad = gpuDoc((d) => {
      d.emitters[0].renderers[0] = { type: "sprite", blend: "alpha", shape: "softCircle", facing: "camera", sort: "distance" };
    });
    expect(validateEffect(bad).some((i) => i.message.includes("GPU simulation doesn't support sorting"))).toBe(true);
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

  it("dispatches clear once, init per spawning frame (sized to the spawn), update every frame", () => {
    const r = fakeRenderer();
    const w = new ParticleWorld({ renderer: r });
    const h = w.spawn(gpuDoc());
    expect(h.sim!.emitters[0].gpu).toBeInstanceOf(GpuEmitter);
    w.update(1 / 60);
    w.update(1 / 60);
    const counts = r.calls.map((c) => c.count);
    // frame 1: clear (null = full size), init (10 = 600/s × 1/60), update; frame 2: init, update
    expect(counts).toEqual([null, 10, null, 10, null]);
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
