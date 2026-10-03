import { describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { createEffect, createEmitter, createModule, validateEffect, type EffectDoc, type SpriteRendererDoc } from "../src/index";
import { ParticleWorld, PARTICLE_STRIDE } from "../src/three";

function sprite(group: string | undefined, over: Partial<SpriteRendererDoc> = {}): SpriteRendererDoc {
  return { type: "sprite", blend: "alpha", shape: "softCircle", facing: "camera", ...(group ? { sortGroup: group } : {}), ...over };
}

/** One emitter per entry; each spawns one particle at z, so depth order is easy to read back. */
function effect(id: string, emitters: { z: number; renderer: SpriteRendererDoc }[]): EffectDoc {
  const doc = createEffect(id, { emitter: false });
  doc.id = id;
  for (const [k, { z, renderer }] of emitters.entries()) {
    const e = createEmitter(`e${k}`, "empty");
    e.looping = false;
    e.spawn.push(createModule("spawn.burst", { count: 1 }));
    e.init.push(createModule("init.shape", { shape: "point", speed: 0, offset: [0, 0, z] }), createModule("init.lifetime", { lifetime: 100 }));
    e.renderers = [renderer];
    doc.emitters.push(e);
  }
  return doc;
}

const cam = () => {
  const c = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  c.position.set(0, 0, 50);
  c.updateMatrixWorld();
  return c;
};

/** The group batch's packed (z, member) pairs, in draw order. */
function groupOrder(w: ParticleWorld, name: string): [number, number][] {
  const mesh = w.object.children.find((c) => c.name === `particles:group:${name}`) as THREE.Mesh<THREE.InstancedBufferGeometry>;
  const data = (mesh.geometry.getAttribute("pA") as THREE.InterleavedBufferAttribute).data.array as Float32Array;
  return Array.from({ length: mesh.geometry.instanceCount }, (_, i) => [data[i * PARTICLE_STRIDE + 2], data[i * PARTICLE_STRIDE + 11]]);
}

describe("sort groups", () => {
  it("draws alpha and additive renderers of different emitters in one depth-sorted call", () => {
    const w = new ParticleWorld();
    w.spawn(
      effect("campfire", [
        { z: 0, renderer: sprite("fx") }, // smoke (alpha), member 0
        { z: 10, renderer: sprite("fx", { blend: "additive", shape: "glow" }) }, // fire, member 1
        { z: -10, renderer: sprite("fx") }, // more smoke, member 2
      ]),
    );
    w.update(1 / 60, cam());
    expect(w.stats.drawCalls).toBe(1);
    expect(w.sortGroups).toEqual([{ name: "fx", members: 3 }]);
    // back to front, interleaving the emitters
    expect(groupOrder(w, "fx")).toEqual([
      [-10, 2],
      [0, 0],
      [10, 1],
    ]);
  });

  it("merges renderers from different effects", () => {
    const w = new ParticleWorld();
    w.spawn(effect("a", [{ z: -5, renderer: sprite("smoke") }]));
    w.spawn(effect("b", [{ z: 5, renderer: sprite("smoke") }]));
    w.spawn("a", { position: new THREE.Vector3(0, 0, 5) }); // second instance of "a": its particle lands at z = 0
    w.update(1 / 60, cam());
    expect(w.stats.drawCalls).toBe(1);
    expect(groupOrder(w, "smoke").map(([z]) => z)).toEqual([-5, 0, 5]);
  });

  it("frees and reuses member slots when an effect is re-registered or unregistered", () => {
    const w = new ParticleWorld();
    const doc = effect("a", [{ z: 0, renderer: sprite("g") }, { z: 1, renderer: sprite("g") }]);
    w.register(doc);
    w.register(doc);
    w.register(doc);
    expect(w.sortGroups[0].members).toBe(2);
    w.unregister("a");
    expect(w.sortGroups[0].members).toBe(0);
  });

  it("grows its table past the initial capacity", () => {
    const w = new ParticleWorld();
    const doc = effect("many", Array.from({ length: 20 }, (_, i) => ({ z: i - 10, renderer: sprite("big") })));
    w.spawn(doc);
    w.update(1 / 60, cam());
    expect(w.sortGroups[0].members).toBe(20);
    expect(w.stats.drawCalls).toBe(1);
    const order = groupOrder(w, "big");
    expect(order).toHaveLength(20);
    expect(order.map(([z]) => z)).toEqual([...order.map(([z]) => z)].sort((a, b) => a - b));
  });

  it("falls back to separate batches for a different texture or opaque blend", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = new ParticleWorld({ loadTexture: () => new THREE.Texture() });
    w.spawn(
      effect("mixed", [
        { z: 0, renderer: sprite("g", { shape: "texture", texture: "smoke.png" }) },
        { z: 1, renderer: sprite("g", { shape: "texture", texture: "dust.png" }) }, // different texture
        { z: 2, renderer: sprite("g", { blend: "opaque" }) },
      ]),
    );
    w.update(1 / 60, cam());
    expect(w.sortGroups[0].members).toBe(1);
    expect(w.stats.drawCalls).toBe(3);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("validates sortGroup", () => {
    const ok = effect("v", [{ z: 0, renderer: sprite("g") }]);
    expect(validateEffect(ok)).toEqual([]);
    const opaque = effect("v", [{ z: 0, renderer: sprite("g", { blend: "opaque" }) }]);
    expect(validateEffect(opaque).some((i) => i.message.includes("sort group"))).toBe(true);
    const empty = effect("v", [{ z: 0, renderer: sprite("", {}) }]);
    (empty.emitters[0].renderers[0] as SpriteRendererDoc).sortGroup = "";
    expect(validateEffect(empty).some((i) => i.message.includes("non-empty"))).toBe(true);
  });
});
