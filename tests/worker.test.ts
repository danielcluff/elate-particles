import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { createEffect, createEmitter, createModule, type EffectDoc } from "../src/index";
import { WorkerParticleWorld, type ParticlePort } from "../src/three";
import { createParticleWorkerHost } from "../src/worker";
import type { FromWorker, ToWorker } from "../src/worker/protocol";

/** A main ⇄ worker pair over an async channel that really transfers (detaches) buffers, like postMessage. */
function channel() {
  const toMain: ((e: { data: FromWorker }) => void)[] = [];
  let sent = 0;
  const host = createParticleWorkerHost((msg, transfer) => {
    const copy = structuredClone(msg, { transfer: transfer as Transferable[] });
    setTimeout(() => toMain.forEach((fn) => fn({ data: copy })), 0);
  });
  const port: ParticlePort = {
    postMessage(msg: ToWorker, transfer: Transferable[] = []) {
      if (msg.type === "frame") sent++;
      const copy = structuredClone(msg, { transfer });
      setTimeout(() => host(copy), 0);
    },
    addEventListener: (_t, fn) => void toMain.push(fn),
  };
  return { port, framesSent: () => sent };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

/** Steps the main world and waits for each result, like frames arriving over time. */
async function frames(w: WorkerParticleWorld, n: number, camera?: THREE.Camera) {
  for (let i = 0; i < n; i++) {
    w.update(1 / 60, camera);
    await settle();
  }
}

function fountain(id = "f", mut?: (doc: EffectDoc) => void): EffectDoc {
  const doc = createEffect(id, { emitter: false });
  doc.id = id;
  const e = createEmitter("e", "empty");
  e.maxParticles = 10_000;
  e.spawn.push(createModule("spawn.rate", { rate: 600 }));
  e.init.push(createModule("init.shape", { shape: "point", speed: 0 }), createModule("init.lifetime", { lifetime: 10 }));
  doc.emitters.push(e);
  mut?.(doc);
  return doc;
}

const batchOf = (w: WorkerParticleWorld) => w.object.children[0] as THREE.Mesh<THREE.InstancedBufferGeometry>;

describe("WorkerParticleWorld", () => {
  it("simulates in the worker and draws the transferred arrays on the main thread", async () => {
    const { port } = channel();
    const w = new WorkerParticleWorld(port);
    const h = w.spawn(fountain(), { position: new THREE.Vector3(5, 0, 0) });
    await frames(w, 30);
    expect(h.particleCount).toBeGreaterThan(250);
    const mesh = batchOf(w);
    expect(mesh.visible).toBe(true);
    expect(mesh.geometry.instanceCount).toBeGreaterThan(250);
    const data = (mesh.geometry.getAttribute("pA") as THREE.InterleavedBufferAttribute).data.array as Float32Array;
    expect(data[0]).toBeCloseTo(5); // particles where the effect was spawned
    expect(w.stats.particles).toBe(h.particleCount);
  });

  it("keeps working over many frames of ping-pong transfers (no detached-buffer errors)", async () => {
    const { port } = channel();
    const w = new WorkerParticleWorld(port);
    w.spawn(fountain());
    await frames(w, 120);
    const mesh = batchOf(w);
    const data = (mesh.geometry.getAttribute("pA") as THREE.InterleavedBufferAttribute).data.array as Float32Array;
    expect(data.byteLength).toBeGreaterThan(0);
    expect(mesh.geometry.instanceCount).toBeGreaterThan(1000);
  });

  it("applies handle commands: transforms (coalesced), params, stop", async () => {
    const { port } = channel();
    const w = new WorkerParticleWorld(port);
    const doc = fountain("p", (d) => {
      d.parameters.push({ name: "rate", type: "float", default: 1 });
      d.emitters[0].spawn[0].params.rate = { kind: "param", name: "rate", scale: 600 };
    });
    const h = w.spawn(doc, { autoRelease: false });
    h.setPosition(1, 0, 0);
    h.setPosition(2, 0, 0); // only the last one is sent…
    h.teleport(); // …and it must reach the worker before the teleport, or births would spread along 0 → 2
    await frames(w, 10);
    const data = (batchOf(w).geometry.getAttribute("pA") as THREE.InterleavedBufferAttribute).data.array as Float32Array;
    expect(data[0]).toBeCloseTo(2);
    h.setParam("rate", 0);
    await frames(w, 2);
    const before = h.particleCount;
    await frames(w, 10);
    expect(h.particleCount).toBe(before);
    h.stop();
    await frames(w, 2);
    expect(h.alive).toBe(true); // stopping, particles still alive (lifetime 10)
  });

  it("reports finished, released and rejected handles", async () => {
    const { port } = channel();
    const w = new WorkerParticleWorld(port);
    const oneShot = fountain("o", (d) => {
      d.emitters[0].looping = false;
      d.emitters[0].duration = 0.05;
      d.emitters[0].init[1].params.lifetime = 0.1;
      d.scalability = { maxInstances: 1 };
    });
    let finished = 0;
    const a = w.spawn(oneShot);
    a.onFinished = () => finished++;
    const b = w.spawn(oneShot); // over maxInstances
    await frames(w, 30);
    expect(finished).toBe(1);
    expect(a.alive).toBe(false);
    expect(a.released).toBe(true); // auto-released
    expect(b.rejected).toBe(true);
  });

  it("has at most one frame in flight and accumulates dt meanwhile", async () => {
    const { port, framesSent } = channel();
    const w = new WorkerParticleWorld(port);
    const h = w.spawn(fountain());
    for (let i = 0; i < 5; i++) w.update(1 / 60); // no waiting: only the first is sent
    expect(framesSent()).toBe(1);
    expect(w.busy).toBe(true);
    await settle();
    w.update(1 / 60); // sends the accumulated 5/60 s
    await settle();
    expect(framesSent()).toBe(2);
    expect(h.particleCount).toBeGreaterThanOrEqual(55); // 600/s × 6/60 s
  });

  it("drops one stale frame when effects are registered mid-flight, then carries on", async () => {
    const { port } = channel();
    const w = new WorkerParticleWorld(port);
    w.spawn(fountain("a"));
    w.update(1 / 60);
    w.register(fountain("b")); // layout changes while the frame is in flight
    w.spawn("b");
    await settle();
    await frames(w, 10);
    const meshes = w.object.children as THREE.Mesh<THREE.InstancedBufferGeometry>[];
    expect(meshes).toHaveLength(2);
    expect(meshes.every((m) => m.geometry.instanceCount > 50)).toBe(true);
  });

  it("sorts and culls with the main thread's camera", async () => {
    const { port } = channel();
    const w = new WorkerParticleWorld(port, { frustumCulling: true });
    const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    w.spawn(fountain(), { position: new THREE.Vector3(0, 0, 50) }); // behind the camera
    await frames(w, 10, cam);
    expect(w.stats.culledInstances).toBe(1);
    expect(batchOf(w).visible).toBe(false);
  });
});
