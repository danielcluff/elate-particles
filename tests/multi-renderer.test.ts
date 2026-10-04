import { describe, expect, it } from "vitest";
import { compileEffect, createEffect, createEmitter, createModule, executeCommand, normalizeEffect, validateEffect } from "../src/index";
import { ParticleWorld } from "../src/three";

describe("renderer lists in documents", () => {
  it("migrates a legacy single `renderer` and assigns ids", () => {
    const doc = normalizeEffect({ emitters: [{ name: "a", renderer: { type: "mesh", mesh: "rock" } }] });
    expect(doc.emitters[0].renderers).toHaveLength(1);
    expect(doc.emitters[0].renderers[0]).toMatchObject({ type: "mesh", mesh: "rock", orientation: "random" });
    expect(doc.emitters[0].renderers[0].id).toBeTruthy();
    expect("renderer" in doc.emitters[0]).toBe(false);
  });

  it("de-duplicates renderer ids", () => {
    const doc = normalizeEffect({ emitters: [{ renderers: [{ id: "x", type: "sprite" }, { id: "x", type: "ribbon" }] }] });
    const [a, b] = doc.emitters[0].renderers;
    expect(a.id).toBe("x");
    expect(b.id).not.toBe("x");
    // (the minimal emitter has no spawn modules, which is only a warning)
    expect(validateEffect(doc).filter((i) => i.level === "error")).toEqual([]);
  });

  it("adds, updates, moves and removes renderers by id (with batch refs)", () => {
    const doc = createEffect("fx");
    const emitterId = doc.emitters[0].id;
    const first = doc.emitters[0].renderers[0].id!;
    const res = executeCommand(doc, {
      op: "batch",
      ops: [
        { op: "addRenderer", emitterId, renderer: { type: "ribbon", mode: "particle", fade: 1 }, ref: "trail" },
        { op: "setRenderer", emitterId, rendererId: "$trail", renderer: { taper: 1 } },
        { op: "setRenderer", emitterId, renderer: { sortOrder: 2 } }, // no id: the first renderer
      ],
    }) as { rendererId: string }[];
    const trailId = res[0].rendererId;
    const rs = doc.emitters[0].renderers;
    expect(rs.map((r) => r.type)).toEqual(["sprite", "ribbon"]);
    expect(rs[1]).toMatchObject({ id: trailId, mode: "particle", fade: 1, taper: 1 });
    expect(rs[0]).toMatchObject({ id: first, sortOrder: 2 });

    executeCommand(doc, { op: "moveRenderer", emitterId, rendererId: trailId, index: 0 });
    expect(doc.emitters[0].renderers.map((r) => r.id)).toEqual([trailId, first]);
    executeCommand(doc, { op: "removeRenderer", emitterId, rendererId: first });
    expect(doc.emitters[0].renderers.map((r) => r.id)).toEqual([trailId]);
    expect(() => executeCommand(doc, { op: "removeRenderer", emitterId, rendererId: "nope" })).toThrow(/not found/);
  });

  it("changing a renderer's type keeps its id", () => {
    const doc = createEffect("fx");
    const e = doc.emitters[0];
    const id = e.renderers[0].id;
    executeCommand(doc, { op: "setRenderer", emitterId: e.id, rendererId: id, renderer: { type: "mesh" } });
    expect(e.renderers[0]).toEqual({ id, type: "mesh", blend: "opaque", mesh: "icosahedron", orientation: "random" });
  });

  it("duplicating an emitter keeps its renderer slugs (they are scoped to the emitter)", () => {
    const doc = createEffect("fx");
    const { emitterId } = executeCommand(doc, { op: "duplicateEmitter", emitterId: doc.emitters[0].id }) as { emitterId: string };
    const copy = doc.emitters.find((e) => e.id === emitterId)!;
    expect(emitterId).toBe("emitter-2");
    expect(copy.renderers[0].id).toBe(doc.emitters[0].renderers[0].id);
  });
});

describe("compiling renderer lists", () => {
  it("skips disabled renderers and derives sim settings across the list", () => {
    const doc = createEffect("fx");
    const e = doc.emitters[0];
    executeCommand(doc, { op: "addRenderer", emitterId: e.id, renderer: { type: "ribbon", mode: "particle", trail: { points: 8, minDistance: 0.1, lifetime: 0.7 } } });
    executeCommand(doc, { op: "addRenderer", emitterId: e.id, renderer: { type: "ribbon", enabled: false } });
    const t = compileEffect(doc).emitters[0];
    expect(t.renderers.map((r) => r.type)).toEqual(["sprite", "ribbon"]);
    expect(t.trail).toEqual({ points: 8, minDistance: 0.1, lifetime: 0.7 });
    expect(t.ordered).toBe(false); // the emitter-mode ribbon is disabled
    expect(t.speedMargin).toBeCloseTo(0.7);
  });

  it("warns when particle-mode ribbons disagree on trail settings", () => {
    const doc = createEffect("fx");
    const e = doc.emitters[0];
    executeCommand(doc, { op: "addRenderer", emitterId: e.id, renderer: { type: "ribbon", mode: "particle", trail: { points: 8, minDistance: 0.1, lifetime: 0.5 } } });
    executeCommand(doc, { op: "addRenderer", emitterId: e.id, renderer: { type: "ribbon", mode: "particle", trail: { points: 32, minDistance: 0.1, lifetime: 2 } } });
    expect(validateEffect(doc).some((i) => i.message.includes("share a trail history"))).toBe(true);
  });
});

describe("drawing one emitter several ways", () => {
  function sparks() {
    const doc = createEffect("sparks", { emitter: false });
    const e = createEmitter("sparks", "empty");
    e.spawn.push(createModule("spawn.rate", { rate: 100 }));
    e.init.push(createModule("init.shape", { shape: "sphere", speed: 5 }), createModule("init.lifetime", { lifetime: 1 }));
    e.renderers = [
      { id: "head", type: "sprite", blend: "additive", shape: "glow", facing: "camera" },
      { id: "trail", type: "ribbon", mode: "particle", blend: "additive", shape: "glow", facing: "camera", uvMode: "stretch" },
    ];
    doc.emitters.push(e);
    return doc;
  }

  it("one batch and draw call per renderer; particles counted once", () => {
    const w = new ParticleWorld();
    const h = w.spawn(sparks());
    for (let i = 0; i < 30; i++) w.update(1 / 60);
    const s = w.stats;
    expect(s.drawCalls).toBe(2);
    expect(s.drawnParticles).toBe(h.particleCount);
    expect(s.particles).toBe(h.particleCount);
    const names = w.object.children.map((c) => c.name);
    expect(names).toEqual(["particles:sparks:sprite", "particles:sparks:ribbon"]);
  });

  it("an emitter with no renderers simulates but draws nothing", () => {
    const doc = sparks();
    doc.emitters[0].renderers = [];
    const w = new ParticleWorld();
    const h = w.spawn(doc);
    for (let i = 0; i < 30; i++) w.update(1 / 60);
    expect(h.particleCount).toBeGreaterThan(0);
    expect(w.stats.drawCalls).toBe(0);
    expect(w.stats.drawnParticles).toBe(0);
    expect(validateEffect(doc)).toEqual([]);
  });
});
