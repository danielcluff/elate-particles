import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { createEffect, createRig, normalizeRig, rigSignals, serializeRig, validateRig, type RigDoc } from "../src";
import { ParticleWorld, RigInstance } from "../src/three";

function thruster() {
  const doc = createEffect("Thruster", { id: "thruster" });
  doc.parameters = [{ name: "throttle", type: "float", default: 0, min: 0, max: 1 }];
  return doc;
}

function rig(): RigDoc {
  return normalizeRig({
    format: "elate-rig",
    version: 1,
    sockets: { "engine-left": { position: [-1, 0, -2], rotation: [0, 180, 0] }, nose: { position: [0, 0, 3] } },
    attachments: { exhaust: { socket: "engine-left", effect: "thruster", params: { throttle: "throttle" }, scale: 2 } },
    lights: { glow: { socket: "engine-left", color: "#ff8844", intensity: 4, range: 6, signal: "throttle" } },
  });
}

describe("rig documents", () => {
  it("normalize drops defaults and junk; serialize is stable", () => {
    const r = normalizeRig({
      sockets: { a: { position: [1, 2, 3], rotation: [0, 0, 0] }, b: { position: "x" }, c: 4 },
      attachments: { fx: { socket: "a", effect: "e", scale: 1, enabled: true, params: { p: "throttle", q: 0.5, bad: {} } } },
      lights: { l: { socket: "a" } },
    });
    expect(r.sockets).toEqual({ a: { position: [1, 2, 3] }, b: { position: [0, 0, 0] } });
    expect(r.attachments.fx).toEqual({ socket: "a", effect: "e", params: { p: "throttle", q: 0.5 } });
    expect(r.lights.l).toEqual({ socket: "a", color: "#ffffff", intensity: 1, range: 5 });
    expect(serializeRig(r)).toEqual(r);
    expect(normalizeRig(undefined)).toEqual(createRig());
    expect(() => normalizeRig({ format: "other" })).toThrow(/Not a elate-rig/);
  });

  it("validates slugs, socket references and known effects", () => {
    const r = rig();
    expect(validateRig(r, { effects: ["thruster"] })).toEqual([]);
    r.sockets["Bad Socket"] = { position: [0, 0, 0] };
    r.attachments.trail = { socket: "tail", effect: "trail" };
    r.lights.glow.color = "orange";
    const messages = validateRig(r, { effects: ["thruster"] }).map((i) => `${i.level}: ${i.message}`);
    expect(messages).toEqual([
      'error: Socket "Bad Socket" is not a slug (lowercase-kebab-case)',
      'error: Attachment "trail" uses unknown socket "tail"',
      'warning: Attachment "trail" uses unknown effect "trail"',
      "error: Light color must be a #rrggbb hex colour",
    ]);
    expect(rigSignals(rig())).toEqual(["throttle"]);
  });
});

describe("RigInstance", () => {
  it("puts effects and lights on sockets, follows the model and feeds signals", () => {
    const world = new ParticleWorld();
    const model = new THREE.Group();
    const r = new RigInstance(world, rig(), { signals: { throttle: 0.25 } });
    model.add(r.object);

    // the effect isn't registered yet: nothing spawns, nothing throws
    r.update(1 / 60);
    expect(r.effect("exhaust")).toBeNull();

    world.register(thruster());
    r.update(1 / 60);
    const h = r.effect("exhaust")!;
    expect(h.sim!.params.throttle).toBe(0.25);
    expect([...h.sim!.transform.position]).toEqual([-1, 0, -2]);
    expect(h.sim!.transform.scale).toBe(2);
    expect(r.light("glow")!.intensity).toBe(1);
    expect(r.light("glow")!.parent).toBe(r.socket("engine-left"));

    model.position.set(10, 0, 0);
    r.setSignal("throttle", 1).update(0.5);
    expect([...h.sim!.transform.position]).toEqual([9, 0, -2]);
    expect(h.sim!.params.throttle).toBe(1);
    expect(r.light("glow")!.intensity).toBe(4);
  });

  it("edits keep running effects unless the effect or socket changes", () => {
    const world = new ParticleWorld();
    world.register(thruster());
    world.register({ ...thruster(), id: "plasma" });
    const r = new RigInstance(world, rig());
    r.update(1 / 60);
    const first = r.effect("exhaust");

    const moved = rig();
    moved.sockets["engine-left"].position = [-2, 0, -2];
    moved.attachments.exhaust.scale = 3;
    r.setDoc(moved);
    r.update(1 / 60);
    expect(r.effect("exhaust")).toBe(first);
    expect(first!.sim!.transform.position[0]).toBe(-2);

    const swapped = structuredClone(moved);
    swapped.attachments.exhaust.effect = "plasma";
    r.setDoc(swapped);
    r.update(1 / 60);
    expect(first!.released).toBe(true);
    expect(r.effect("exhaust")!.effectId).toBe("plasma");

    const gone = structuredClone(swapped);
    delete gone.sockets["engine-left"];
    r.setDoc(gone);
    expect(r.socket("engine-left")).toBeUndefined();
    expect(r.light("glow")).toBeUndefined();
  });

  it("dispose lets particles finish by default", () => {
    const world = new ParticleWorld();
    world.register(thruster());
    const model = new THREE.Group();
    const r = new RigInstance(world, rig());
    model.add(r.object);
    r.update(1 / 60);
    const h = r.effect("exhaust")!;
    r.dispose();
    expect(model.children).toHaveLength(0);
    expect(h.autoRelease).toBe(true);
  });
});
