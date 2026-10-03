import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { EffectSim, compileEffect, createEffect, createEmitter, createModule, executeCommand, normalizeEffect, validateEffect, type EffectDoc, type RendererDoc, type RibbonRendererDoc } from "../src/index";
import { ParticleBatch, RibbonBatch, RIBBON_STRIDE } from "../src/three";

function trail(renderer: Partial<RendererDoc> = {}): EffectDoc {
  const doc = createEffect("trail", { emitter: false });
  const e = createEmitter("trail", "empty");
  e.spawn.push(createModule("spawn.distance", { perUnit: 1 }));
  e.init.push(createModule("init.shape", { shape: "point", speed: 0 }), createModule("init.lifetime", { lifetime: 10 }), createModule("init.size", { size: 0.5 }));
  e.renderers = [{ type: "ribbon", blend: "additive", shape: "softCircle", facing: "camera", uvMode: "stretch", ...renderer } as RendererDoc];
  doc.emitters.push(e);
  return doc;
}

describe("ordered emitters (ribbons)", () => {
  it("keep particles in spawn order when older ones die", () => {
    const doc = trail();
    doc.emitters[0].init[1].params.lifetime = { kind: "range", min: 0.05, max: 1 };
    const sim = new EffectSim(compileEffect(doc)).play();
    for (let i = 1; i <= 60; i++) sim.setPosition(i, 0, 0).step(1 / 60);
    const b = sim.emitters[0].buf;
    expect(b.count).toBeGreaterThan(5);
    expect(b.count).toBeLessThan(60);
    // spawned along +x over time: order is preserved iff x increases monotonically
    for (let i = 1; i < b.count; i++) expect(b.px[i]).toBeGreaterThan(b.px[i - 1]);
  });

  it("only ribbon emitters pay for ordering", () => {
    expect(compileEffect(trail()).emitters[0].ordered).toBe(true);
    expect(compileEffect(createEffect("x")).emitters[0].ordered).toBe(false);
  });
});

describe("ribbon packing", () => {
  const material = new THREE.MeshBasicNodeMaterial();

  function packed(doc: EffectDoc, steps: number, instances = 1) {
    const tpl = compileEffect(doc);
    const batch = new RibbonBatch(tpl.emitters[0], tpl.emitters[0].renderers[0] as RibbonRendererDoc, material);
    const sims = Array.from({ length: instances }, (_, k) => new EffectSim(tpl).setPosition(0, 0, k * 10).play());
    for (let i = 1; i <= steps; i++) for (const [k, s] of sims.entries()) s.setPosition(i, 0, k * 10).step(1 / 60);
    batch.begin();
    for (const s of sims) batch.pack(s.emitters[0], null);
    batch.end();
    return { batch, data: (batch as unknown as { data: Float32Array }).data, sims };
  }

  it("writes n-1 segments with shared endpoints and unit tangents", () => {
    const { batch, data, sims } = packed(trail(), 5);
    const n = sims[0].particleCount;
    expect(n).toBe(5);
    expect(batch.instances).toBe(4);
    expect(batch.particles).toBe(5);
    for (let s = 0; s < 3; s++) {
      // end of segment s == start of segment s+1 (seamless joints)
      const endA = data.subarray(s * RIBBON_STRIDE + 16, s * RIBBON_STRIDE + 32);
      const startB = data.subarray((s + 1) * RIBBON_STRIDE, (s + 1) * RIBBON_STRIDE + 16);
      expect(Array.from(endA)).toEqual(Array.from(startB));
    }
    // straight line along +x
    expect(data[4]).toBeCloseTo(1);
    expect(data[5]).toBeCloseTo(0);
    // width
    expect(data[8]).toBeCloseTo(0.5);
  });

  it("stretch u runs 1 (oldest) → 0 (newest)", () => {
    const { data } = packed(trail(), 5);
    expect(data[7]).toBeCloseTo(1); // first segment start = oldest
    expect(data[3 * RIBBON_STRIDE + 16 + 7]).toBeCloseTo(0); // last segment end = newest
  });

  it("tile u follows world distance", () => {
    const { data } = packed(trail({ uvMode: "tile", uvTile: 2 } as Partial<RendererDoc>), 5);
    // 5 points 1 unit apart: oldest is 4 units from the head → u = 2
    expect(data[7]).toBeCloseTo(2);
  });

  it("never bridges two instances' ribbons", () => {
    const { batch } = packed(trail(), 5, 3);
    expect(batch.instances).toBe(3 * 4);
    expect(batch.particles).toBe(15);
  });

  it("skips ribbons with fewer than two points", () => {
    const { batch } = packed(trail(), 1);
    expect(batch.instances).toBe(0);
  });
});

describe("mesh renderer", () => {
  it("packs one instance per particle into any geometry", () => {
    const doc = createEffect("debris");
    executeCommand(doc, { op: "setRenderer", emitterId: doc.emitters[0].id, renderer: { type: "mesh" } });
    const tpl = compileEffect(doc);
    const batch = new ParticleBatch(tpl.emitters[0], tpl.emitters[0].renderers[0], new THREE.MeshBasicNodeMaterial(), () => new THREE.IcosahedronGeometry(0.5, 0));
    const sim = new EffectSim(tpl).play();
    for (let i = 0; i < 30; i++) sim.step(1 / 60);
    batch.begin();
    batch.pack(sim.emitters[0], null);
    batch.end();
    expect(batch.instances).toBe(sim.particleCount);
    expect(batch.mesh.geometry.getAttribute("normal")).toBeTruthy();
    expect(batch.mesh.geometry.instanceCount).toBe(sim.particleCount);
  });
});

describe("renderer documents", () => {
  it("switching renderer type starts from that type's defaults", () => {
    const doc = createEffect("x");
    const id = doc.emitters[0].id;
    executeCommand(doc, { op: "setRenderer", emitterId: id, renderer: { facing: "velocity", stretch: 0.3 } });
    executeCommand(doc, { op: "setRenderer", emitterId: id, renderer: { type: "ribbon", uvMode: "tile" } });
    expect(doc.emitters[0].renderers[0]).toEqual({ id: doc.emitters[0].renderers[0].id, ...{ type: "ribbon", blend: "additive", shape: "softCircle", facing: "camera", uvMode: "tile" } });
    executeCommand(doc, { op: "setRenderer", emitterId: id, renderer: { type: "mesh", mesh: "box", lit: true } });
    expect(doc.emitters[0].renderers[0]).toEqual({ id: doc.emitters[0].renderers[0].id, ...{ type: "mesh", blend: "opaque", mesh: "box", orientation: "random", lit: true } });
    expect(validateEffect(doc)).toEqual([]);
  });

  it("normalises partial renderers with their type's defaults", () => {
    const doc = normalizeEffect({ emitters: [{ name: "a", renderer: { type: "mesh", mesh: "rock" } }] });
    expect(doc.emitters[0].renderers[0]).toEqual({ id: doc.emitters[0].renderers[0].id, ...{ type: "mesh", blend: "opaque", mesh: "rock", orientation: "random" } });
  });

  it("flags unknown renderer types", () => {
    const doc = createEffect("x");
    (doc.emitters[0].renderers[0] as { type: string }).type = "decal";
    expect(validateEffect(doc).some((i) => i.message.includes("decal"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// per-particle trails (ribbon mode "particle")

import { TrailStore } from "../src/sim/trails";

describe("TrailStore", () => {
  it("records points at least minDistance apart, oldest first", () => {
    const t = new TrailStore(4, 8, 1, 10);
    const s = t.start(0, 0, 0, 0);
    t.record(s, 0.5, 0, 0, 0.1); // too close
    t.record(s, 1, 0, 0, 0.2);
    t.record(s, 2.5, 0, 0, 0.3);
    const out = new Float32Array(30);
    expect(t.read(s, 0.3, out)).toBe(3);
    expect([out[0], out[3], out[6]]).toEqual([0, 1, 2.5]);
  });

  it("wraps the ring and keeps the newest points", () => {
    const t = new TrailStore(1, 4, 0, 100);
    const s = t.start(0, 0, 0, 0);
    for (let i = 1; i <= 9; i++) t.record(s, i, 0, 0, i);
    const out = new Float32Array(12);
    expect(t.read(s, 9, out)).toBe(4);
    expect([out[0], out[3], out[6], out[9]]).toEqual([6, 7, 8, 9]);
  });

  it("drops points older than the lifetime", () => {
    const t = new TrailStore(1, 8, 0, 0.5);
    const s = t.start(0, 0, 0, 0);
    t.record(s, 1, 0, 0, 0.4);
    t.record(s, 2, 0, 0, 0.8);
    const out = new Float32Array(24);
    expect(t.read(s, 0.8, out)).toBe(2); // t=0 is older than 0.8 - 0.5
    expect(out[0]).toBe(1);
    expect(t.read(s, 1, out)).toBe(1); // now t=0.4 has expired too
  });

  it("recycles slots", () => {
    const t = new TrailStore(2, 4, 0, 1);
    const a = t.start(0, 0, 0, 0);
    const b = t.start(0, 0, 0, 0);
    expect(t.start(0, 0, 0, 0)).toBe(-1);
    t.release(a);
    expect(t.start(0, 0, 0, 0)).toBe(a);
    expect(t.slotsInUse).toBe(2);
    t.release(b);
    expect(t.slotsInUse).toBe(1);
  });
});

function sparks(trail = { points: 8, minDistance: 0.05, lifetime: 1 }): EffectDoc {
  const doc = createEffect("sparks", { emitter: false });
  const e = createEmitter("sparks", "empty");
  e.looping = false;
  e.spawn.push(createModule("spawn.burst", { count: 3 }));
  e.init.push(
    createModule("init.shape", { shape: "point", speed: 0 }),
    createModule("init.velocity", { velocity: [0, 10, 0] }),
    createModule("init.lifetime", { lifetime: { kind: "range", min: 0.3, max: 2 } }),
    createModule("init.size", { size: 0.2 }),
  );
  e.renderers = [{ type: "ribbon", mode: "particle", trail, taper: 1, fade: 1, blend: "additive", shape: "softCircle", facing: "camera", uvMode: "stretch" }];
  doc.emitters.push(e);
  return doc;
}

describe("per-particle trails", () => {
  it("compiles trail settings (with defaults) and skips ordering", () => {
    const e = compileEffect(sparks()).emitters[0];
    expect(e.trail).toEqual({ points: 8, minDistance: 0.05, lifetime: 1 });
    expect(e.ordered).toBe(false);
    expect(e.extraChannels).toContain("trailSlot");
    const d = sparks();
    delete (d.emitters[0].renderers[0] as { trail?: unknown }).trail;
    expect(compileEffect(d).emitters[0].trail).toEqual({ points: 16, minDistance: 0.1, lifetime: 0.5 });
    expect(validateEffect(sparks())).toEqual([]);
  });

  it("follows each particle and frees slots when particles die", () => {
    const sim = new EffectSim(compileEffect(sparks())).play();
    for (let i = 0; i < 30; i++) sim.step(1 / 60);
    const em = sim.emitters[0];
    expect(em.trails!.slotsInUse).toBe(em.buf.count);
    for (let i = 0; i < 120; i++) sim.step(1 / 60);
    expect(em.buf.count).toBe(0);
    expect(em.trails!.slotsInUse).toBe(0);
  });

  it("packs one strip per particle ending at the live position, with tail coordinate 1 → 0", () => {
    // 32 points: 12 steps at ~0.17 units/step don't wrap the ring, so the birth point is still there
    const tpl = compileEffect(sparks({ points: 32, minDistance: 0.05, lifetime: 1 }));
    const sim = new EffectSim(tpl).play();
    for (let i = 0; i < 12; i++) sim.step(1 / 60);
    const batch = new RibbonBatch(tpl.emitters[0], tpl.emitters[0].renderers[0] as RibbonRendererDoc, new THREE.MeshBasicNodeMaterial());
    batch.begin();
    batch.pack(sim.emitters[0], null);
    batch.end();
    const data = (batch as unknown as { data: Float32Array }).data;
    const b = sim.emitters[0].buf;
    expect(batch.particles).toBe(3);
    // all three particles move identically: same segment count each, strips never bridge
    const perStrip = batch.instances / 3;
    expect(Number.isInteger(perStrip)).toBe(true);
    expect(perStrip).toBeGreaterThanOrEqual(2);
    // first strip: starts at the birth point (tail), ends at particle 0's live position (head)
    const last = (perStrip - 1) * RIBBON_STRIDE + 16;
    expect(data[1]).toBeCloseTo(0);
    expect(data[last + 1]).toBeCloseTo(b.py[0]);
    expect(data[11]).toBeCloseTo(1); // tail
    expect(data[last + 11]).toBeCloseTo(0); // head
  });
});

// ---------------------------------------------------------------------------
// soft particles / camera fade

import { createSpriteMaterial, createRibbonMaterial } from "../src/three";
import { depthFades } from "../src/three/materials/common";
import { float } from "three/tsl";

describe("depth fades", () => {
  it("are only built when enabled", () => {
    expect(depthFades({}, float(-5))).toBeNull();
    expect(depthFades({ depthFade: 0, cameraFade: 0 }, float(-5))).toBeNull();
    expect(depthFades({ depthFade: 1 }, float(-5))).not.toBeNull();
    expect(depthFades({ cameraFade: 2 }, float(-5))).not.toBeNull();
  });

  it("sprite and ribbon materials build with soft particles on", () => {
    const opts = { time: float(0), loadTexture: () => new THREE.Texture() };
    const doc = createEffect("soft");
    executeCommand(doc, { op: "setRenderer", emitterId: doc.emitters[0].id, renderer: { blend: "alpha", depthFade: 0.5, cameraFade: 1 } });
    expect(validateEffect(doc)).toEqual([]);
    expect(createSpriteMaterial(compileEffect(doc).emitters[0], compileEffect(doc).emitters[0].renderers[0] as never, null, opts).opacityNode).toBeTruthy();
    expect(createRibbonMaterial(compileEffect(trail({ depthFade: 0.5 } as Partial<RendererDoc>)).emitters[0], compileEffect(trail({ depthFade: 0.5 } as Partial<RendererDoc>)).emitters[0].renderers[0] as RibbonRendererDoc, null, opts).opacityNode).toBeTruthy();
  });

  it("rejects negative fade distances", () => {
    const doc = createEffect("soft");
    executeCommand(doc, { op: "setRenderer", emitterId: doc.emitters[0].id, renderer: { depthFade: -1 } });
    expect(validateEffect(doc).some((i) => i.message.includes("depthFade"))).toBe(true);
  });
});
