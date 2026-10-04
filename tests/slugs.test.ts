import { describe, expect, it } from "vitest";
import { createEffect, executeCommand, isSlug, normalizeEffect, serializeEffect, slugify, uniqueSlug, validateEffect } from "../src";

describe("slugs", () => {
  it("slugify and uniqueSlug", () => {
    expect(slugify("Engine Left")).toBe("engine-left");
    expect(slugify("sizeOverLife")).toBe("size-over-life");
    expect(slugify("  ***  ", "emitter")).toBe("emitter");
    expect(uniqueSlug("spark", ["spark", "spark-2"])).toBe("spark-3");
    expect(isSlug("engine-left")).toBe(true);
    expect(isSlug("exhaust.spawn.rate")).toBe(false);
  });

  it("new effects, emitters, modules and renderers get slugs scoped to their parent", () => {
    const doc = createEffect("Engine Flare");
    expect(doc.id).toBe("engine-flare");
    const e = doc.emitters[0];
    expect(e.id).toBe("emitter");
    expect(e.spawn.map((m) => m.id)).toEqual(["spawn-rate"]);
    expect(e.render.map((m) => m.id)).toEqual(["render-size-over-life", "render-color-over-life"]);
    expect(e.renderers.map((r) => r.id)).toEqual(["sprite"]);

    expect(executeCommand(doc, { op: "addEmitter", name: "Sparks" })).toEqual({ emitterId: "sparks" });
    expect(executeCommand(doc, { op: "addEmitter", name: "Sparks" })).toEqual({ emitterId: "sparks-2" });
    expect(executeCommand(doc, { op: "addModule", emitterId: "sparks", type: "update.force" })).toMatchObject({ moduleId: "update-force" });
    expect(executeCommand(doc, { op: "addModule", emitterId: "sparks", type: "update.force" })).toMatchObject({ moduleId: "update-force-2" });
    // same module type in another emitter: same slug
    expect(executeCommand(doc, { op: "addModule", emitterId: "emitter", type: "update.force" })).toMatchObject({ moduleId: "update-force" });
    expect(executeCommand(doc, { op: "addRenderer", emitterId: "sparks", renderer: { type: "sprite" } })).toEqual({ rendererId: "sprite-2" });
    expect(validateEffect(doc).filter((i) => i.level === "error")).toEqual([]);
  });

  it("normalize replaces generated ids with slugs and keeps sub-emitter bindings", () => {
    const doc = normalizeEffect(
      {
        name: "Old",
        id: "fx_abc123",
        emitters: [
          {
            id: "e_k2j3",
            name: "Rocket Trail",
            spawn: [{ id: "trail.spawn.rate", type: "spawn.rate", params: {} }],
            renderers: [{ id: "trail.r0", type: "ribbon" }],
            subEmitters: [{ event: "death", emitter: "e_x9", count: 4 }],
          },
          { id: "e_x9", name: "Pop", renderers: [{ type: "sprite" }, { type: "sprite" }] },
          { id: "smoke", name: "Smoke" },
        ],
      },
      { id: "rocket" },
    );
    expect(doc.id).toBe("rocket");
    expect(doc.emitters.map((e) => e.id)).toEqual(["rocket-trail", "pop", "smoke"]);
    expect(doc.emitters[0].spawn[0].id).toBe("spawn-rate");
    expect(doc.emitters[0].renderers[0].id).toBe("ribbon");
    expect(doc.emitters[0].subEmitters).toEqual([{ event: "death", emitter: "pop", count: 4 }]);
    expect(doc.emitters[1].renderers.map((r) => r.id)).toEqual(["sprite", "sprite-2"]);
    expect(normalizeEffect({ name: "Big Bang", emitters: [] }).id).toBe("big-bang");
  });

  it("serializeEffect leaves out the slug and editor metadata", () => {
    const doc = { ...createEffect("Ring"), thumbnail: "data:," };
    const file = serializeEffect(doc) as Record<string, unknown>;
    expect(file).not.toHaveProperty("id");
    expect(file).not.toHaveProperty("createdAt");
    expect(file).not.toHaveProperty("updatedAt");
    expect(file).not.toHaveProperty("thumbnail");
    expect(normalizeEffect(file, { id: "ring" })).toMatchObject({ id: "ring", name: "Ring" });
  });

  it("validation flags ids that aren't slugs", () => {
    const doc = createEffect("x");
    doc.emitters[0].id = "Bad Id";
    doc.emitters[0].spawn[0].id = "m_123";
    doc.emitters[0].renderers[0].id = "x.r0";
    const errors = validateEffect(doc).filter((i) => i.level === "error").map((i) => i.message);
    expect(errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/Emitter id "Bad Id" is not a slug/), expect.stringMatching(/Module id "m_123"/), expect.stringMatching(/Renderer id "x.r0"/)]),
    );
  });
});
