import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { EffectSim, compileEffect, createEffect, createEmitter, createModule, validateEffect, type EffectDoc, type EmitterDoc } from "../src/index";
import { ParticleWorld } from "../src/three";

function fountain(opts: { rate?: number; looping?: boolean; lifetime?: number; emitter?: Partial<EmitterDoc>; scalability?: EffectDoc["scalability"]; id?: string } = {}): EffectDoc {
  const doc = createEffect("f", { emitter: false });
  doc.id = opts.id ?? "fountain";
  const e = createEmitter("e", "empty");
  e.looping = opts.looping ?? true;
  e.maxParticles = 5000;
  e.spawn.push(createModule("spawn.rate", { rate: opts.rate ?? 100 }));
  e.init.push(createModule("init.shape", { shape: "point", speed: 0 }), createModule("init.lifetime", { lifetime: opts.lifetime ?? 10 }), createModule("init.size", { size: 1 }));
  Object.assign(e, opts.emitter);
  doc.emitters.push(e);
  if (opts.scalability) doc.scalability = opts.scalability;
  return doc;
}

const run = (fn: (dt: number) => void, seconds: number, dt = 1 / 60) => {
  for (let t = 0; t < seconds - 1e-9; t += dt) fn(dt);
};

/** Camera at the origin looking down -z. */
function camera(): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(60, 1, 0.1, 2000);
  c.updateMatrixWorld();
  return c;
}

describe("spawn scaling (sim)", () => {
  it("scales spawn counts and keeps the average rate", () => {
    const sim = new EffectSim(compileEffect(fountain({ rate: 1000 }))).play();
    sim.spawnScale = 0.25;
    run((dt) => sim.step(dt), 2);
    expect(sim.particleCount).toBeGreaterThan(450);
    expect(sim.particleCount).toBeLessThan(550);
  });

  it("emitters with lod.scaleSpawn = false ignore it", () => {
    const sim = new EffectSim(compileEffect(fountain({ rate: 100, emitter: { lod: { scaleSpawn: false } } }))).play();
    sim.spawnScale = 0.1;
    run((dt) => sim.step(dt), 1);
    expect(sim.particleCount).toBeGreaterThanOrEqual(99);
  });

  it("inactive emitters spawn nothing and drop sub-emitter events", () => {
    const doc = fountain({ rate: 100, lifetime: 0.05 });
    const child = createEmitter("child", "empty");
    child.id = "child";
    child.eventDriven = true;
    child.init.push(createModule("init.lifetime", { lifetime: 10 }));
    doc.emitters.push(child);
    doc.emitters[0].subEmitters = [{ trigger: "death", emitter: "child", count: 2 }];
    const sim = new EffectSim(compileEffect(doc)).play();
    sim.emitters[1].lodActive = false;
    run((dt) => sim.step(dt), 0.5);
    expect(sim.emitters[0].buf.count).toBeGreaterThan(0);
    expect(sim.emitters[1].buf.count).toBe(0);
    sim.emitters[0].lodActive = false;
    const before = sim.emitters[0].buf.count;
    run((dt) => sim.step(dt), 0.2);
    expect(sim.emitters[0].buf.count).toBeLessThan(before);
  });
});

describe("bounds", () => {
  it("contain every particle plus its half size", () => {
    const doc = fountain({ rate: 200 });
    doc.emitters[0].init[0] = createModule("init.shape", { shape: "sphere", radius: 3, speed: 2 });
    const sim = new EffectSim(compileEffect(doc)).setPosition(10, 0, 0).play();
    run((dt) => sim.step(dt), 0.5);
    const bb = new Float32Array(6);
    expect(sim.worldBounds(bb)).toBe(true);
    const b = sim.emitters[0].buf;
    for (let i = 0; i < b.count; i++) {
      expect(b.px[i] - 0.5).toBeGreaterThanOrEqual(bb[0] - 1e-4);
      expect(b.px[i] + 0.5).toBeLessThanOrEqual(bb[3] + 1e-4);
      expect(b.pz[i]).toBeGreaterThanOrEqual(bb[2]);
    }
    expect((bb[0] + bb[3]) / 2).toBeCloseTo(10, 0);
  });

  it("follow the transform for local-space emitters", () => {
    const sim = new EffectSim(compileEffect(fountain({ emitter: { space: "local" } }))).play();
    run((dt) => sim.step(dt), 0.2);
    sim.setPosition(50, 0, 0).step(1 / 60);
    const bb = new Float32Array(6);
    sim.worldBounds(bb);
    expect(bb[0]).toBeGreaterThan(48);
    expect(bb[3]).toBeLessThan(52);
  });

  it("report empty effects", () => {
    expect(new EffectSim(compileEffect(fountain())).worldBounds(new Float32Array(6))).toBe(false);
  });
});

describe("ParticleWorld scalability", () => {
  it("maxInstances rejectNew returns inert handles", () => {
    const w = new ParticleWorld();
    const doc = fountain({ scalability: { maxInstances: 2 } });
    const a = w.spawn(doc);
    w.spawn(doc);
    const c = w.spawn(doc);
    expect(c.rejected).toBe(true);
    expect(c.alive).toBe(false);
    c.setPosition(1, 2, 3).stop(); // harmless
    expect(w.stats.instances).toBe(2);
    a.release();
    expect(w.spawn(doc).rejected).toBe(false);
  });

  it("maxInstances killOldest releases the oldest", () => {
    const w = new ParticleWorld();
    const doc = fountain({ scalability: { maxInstances: 2, overflow: "killOldest" } });
    const a = w.spawn(doc);
    const b = w.spawn(doc);
    const c = w.spawn(doc);
    expect(a.released).toBe(true);
    expect(b.alive && c.alive).toBe(true);
  });

  it("does not spawn one-shots beyond cullDistance of the last camera", () => {
    const w = new ParticleWorld();
    const doc = fountain({ looping: false, scalability: { cullDistance: 100 } });
    w.update(1 / 60, camera());
    expect(w.spawn(doc, { position: new THREE.Vector3(0, 0, -500) }).rejected).toBe(true);
    expect(w.spawn(doc, { position: new THREE.Vector3(0, 0, -50) }).rejected).toBe(false);
    expect(w.stats.rejectedSpawns).toBe(0); // counted per frame, reported after update
    w.update(1 / 60, camera());
    expect(w.stats.rejectedSpawns).toBe(1);
  });

  it("pauses looping effects beyond cullDistance and resumes them in range", () => {
    const w = new ParticleWorld();
    const h = w.spawn(fountain({ scalability: { cullDistance: 100 } }), { position: new THREE.Vector3(0, 0, -500) });
    const cam = camera();
    run((dt) => w.update(dt, cam), 0.5);
    expect(h.particleCount).toBe(0);
    expect(h.culled).toBe(true);
    expect(w.stats.culledInstances).toBe(1);
    cam.position.set(0, 0, -450);
    run((dt) => w.update(dt, cam), 0.5);
    expect(h.culled).toBe(false);
    expect(h.particleCount).toBeGreaterThan(30);
  });

  it("ramps spawning down between lodDistance and cullDistance", () => {
    const w = new ParticleWorld();
    const doc = fountain({ rate: 400, scalability: { lodDistance: 50, cullDistance: 250, farSpawnScale: 0 } });
    const near = w.spawn(doc, { position: new THREE.Vector3(0, 0, -20) });
    const far = w.spawn(doc, { position: new THREE.Vector3(0, 0, -200) });
    const cam = camera();
    run((dt) => w.update(dt, cam), 1);
    // far is 3/4 of the way to cullDistance: ~25% rate
    expect(near.particleCount).toBeGreaterThan(380);
    expect(far.particleCount).toBeGreaterThan(60);
    expect(far.particleCount).toBeLessThan(140);
  });

  it("drops emitters by lod.maxDistance and lod.minQuality", () => {
    const doc = fountain({ id: "two" });
    const detail = createEmitter("detail", "empty");
    detail.spawn.push(createModule("spawn.rate", { rate: 100 }));
    detail.init.push(createModule("init.lifetime", { lifetime: 10 }));
    detail.lod = { maxDistance: 30, minQuality: 0.5 };
    doc.emitters.push(detail);
    expect(validateEffect(doc)).toEqual([]);

    const w = new ParticleWorld();
    const cam = camera();
    const near = w.spawn(doc, { position: new THREE.Vector3(0, 0, -10) });
    const far = w.spawn(doc, { position: new THREE.Vector3(0, 0, -100) });
    run((dt) => w.update(dt, cam), 0.5);
    expect(near.sim!.emitters[1].buf.count).toBeGreaterThan(0);
    expect(far.sim!.emitters[1].buf.count).toBe(0);
    expect(far.sim!.emitters[0].buf.count).toBeGreaterThan(0);

    w.quality = 0.3;
    const lowQ = w.spawn(doc, { position: new THREE.Vector3(0, 0, -10) });
    run((dt) => w.update(dt, cam), 0.5);
    expect(lowQ.sim!.emitters[1].buf.count).toBe(0);
  });

  it("frustum-culls drawing but keeps simulating", () => {
    const w = new ParticleWorld();
    const behind = w.spawn(fountain(), { position: new THREE.Vector3(0, 0, 50) });
    const cam = camera();
    run((dt) => w.update(dt, cam), 0.5);
    expect(behind.particleCount).toBeGreaterThan(30);
    expect(w.stats.drawnParticles).toBe(0);
    expect(w.stats.culledInstances).toBe(1);
    cam.lookAt(0, 0, 50);
    w.update(1 / 60, cam);
    expect(w.stats.drawnParticles).toBe(behind.particleCount);
  });

  it("pauseOffscreen freezes looping effects until they are in view", () => {
    const w = new ParticleWorld();
    const h = w.spawn(fountain({ scalability: { pauseOffscreen: true } }), { position: new THREE.Vector3(0, 0, 50) });
    const cam = camera();
    run((dt) => w.update(dt, cam), 0.3);
    const frozen = h.particleCount;
    run((dt) => w.update(dt, cam), 0.5);
    expect(h.particleCount).toBe(frozen);
    cam.lookAt(0, 0, 50);
    run((dt) => w.update(dt, cam), 0.5);
    expect(h.particleCount).toBeGreaterThan(frozen + 30);
  });

  it("budget settles total particles near the limit; essential effects are exempt", () => {
    const w = new ParticleWorld({ budget: { maxParticles: 1000 } });
    const doc = fountain({ rate: 200, lifetime: 2 });
    for (let i = 0; i < 20; i++) w.spawn(doc); // unconstrained: 20 × 200 × 2 = 8000
    const player = w.spawn(fountain({ id: "player", rate: 100, lifetime: 2, scalability: { essential: true } }));
    run((dt) => w.update(dt), 8);
    expect(w.stats.particles).toBeGreaterThan(700);
    expect(w.stats.particles).toBeLessThan(1500);
    expect(w.stats.budgetScale).toBeLessThan(0.2);
    expect(player.particleCount).toBeGreaterThanOrEqual(195);
  });

  it("quality scales spawning globally", () => {
    const w = new ParticleWorld({ quality: 0.5 });
    const h = w.spawn(fountain({ rate: 400 }));
    run((dt) => w.update(dt), 1);
    expect(h.particleCount).toBeGreaterThan(160);
    expect(h.particleCount).toBeLessThan(240);
  });

  it("validates scalability settings", () => {
    const doc = fountain({ scalability: { cullDistance: -5, farSpawnScale: 2, overflow: "explode" as never } });
    const msgs = validateEffect(doc).map((i) => i.message).join("\n");
    expect(msgs).toMatch(/cullDistance/);
    expect(msgs).toMatch(/farSpawnScale/);
    expect(msgs).toMatch(/explode/);
  });
});
