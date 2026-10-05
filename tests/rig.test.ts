import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { createEffect, createRig, eventDuration, normalizeRig, rigSignals, serializeRig, validateRig, type RigDoc } from "../src";
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

describe("rig events", () => {
  function eventRig(): RigDoc {
    return normalizeRig({
      sockets: { "engine-left": { position: [-1, 0, -2] }, nose: { position: [0, 0, 3] } },
      events: {
        "shield-hit": {
          tracks: {
            sparks: { type: "effect", at: 0, effect: "thruster", params: { throttle: "strength" } },
            flash: { type: "light", at: 0, duration: 0.5, color: "#88ccff", intensity: 10, range: 8 },
            glow: { type: "channel", at: 0.1, duration: 0.4, channel: "shield-flash", value: 2 },
            thump: { type: "sound", at: 0, sound: "shield-thump", volume: 0.8 },
            shake: { type: "shake", at: 0.2, duration: 0.3, amplitude: 0.5 },
          },
        },
        destroyed: { tracks: { boom: { type: "effect", at: 0.5, effect: "thruster", socket: "nose", follow: true } } },
      },
    });
  }

  it("normalizes tracks with defaults left out and reports bad ones", () => {
    const r = eventRig();
    expect(r.events["shield-hit"].tracks.thump).toEqual({ type: "sound", at: 0, sound: "shield-thump", volume: 0.8 });
    expect(r.events.destroyed.tracks.boom).toEqual({ type: "effect", at: 0.5, effect: "thruster", socket: "nose", follow: true });
    expect(eventDuration(r.events["shield-hit"])).toBeCloseTo(0.5);
    expect(validateRig(r, { effects: ["thruster"] })).toEqual([]);

    const bad = normalizeRig({ events: { boom: { tracks: { a: { type: "laser", at: 0 }, b: { type: "light", at: 0, duration: 0, socket: "tail", color: "red" } } } } });
    expect(validateRig(bad).map((i) => i.message)).toEqual([
      'Track "boom/a" has unknown type "laser" (types: effect, light, shake, sound, channel)',
      'Track "boom/b": duration must be > 0',
      'Track "boom/b" uses unknown socket "tail"',
      'Track "boom/b": color must be #rrggbb',
    ]);
  });

  it("plays a timeline: effects at the event, lights and channels over time, cues for the host", () => {
    const world = new ParticleWorld();
    world.register(thruster());
    const model = new THREE.Group();
    model.position.set(100, 0, 0);
    const cues: string[] = [];
    const r = new RigInstance(world, eventRig(), { onCue: (c) => cues.push(c.type === "sound" ? `sound ${c.sound} ${c.volume}` : `shake ${c.amplitude}`) });
    model.add(r.object);
    r.update(0);

    const before = world.stats.instances;
    const handle = r.trigger("shield-hit", { position: { x: 101, y: 2, z: 0 }, normal: { x: 0, y: 1, z: 0 }, strength: 0.5 })!;
    // tracks at 0 happen at once
    expect(world.stats.instances).toBe(before + 1);
    expect(cues).toEqual(["sound shield-thump 0.4"]);
    expect(r.activeEvents).toEqual(["shield-hit"]);

    r.update(0.15);
    const light = r.object.children.find((c) => (c as THREE.PointLight).isPointLight) as THREE.PointLight;
    expect(light.position.toArray().map((v) => Math.round(v * 100) / 100)).toEqual([1, 2, 0]);
    // fades out over its 0.5 s: 10 × 0.5 strength × (1 - 0.3)
    expect(light.intensity).toBeCloseTo(3.5);
    expect(r.channel("shield-flash")).toBeCloseTo(2 * 0.5 * (1 - 0.05 / 0.4));
    r.update(0.1);
    expect(cues).toEqual(["sound shield-thump 0.4", "shake 0.25"]);

    r.update(0.3);
    expect(handle.done).toBe(true);
    expect(r.channel("shield-flash")).toBe(0);
    expect(r.object.children.some((c) => (c as THREE.PointLight).isPointLight)).toBe(false);
    expect(r.trigger("nope")).toBeNull();
  });

  it("an effect can follow its socket until the timeline ends", () => {
    const world = new ParticleWorld();
    world.register(thruster());
    const model = new THREE.Group();
    const r = new RigInstance(world, eventRig());
    model.add(r.object);
    r.trigger("destroyed");
    r.update(0.5);
    const effect = world.stats.instances;
    expect(effect).toBeGreaterThan(0);
    model.position.set(0, 0, 10);
    r.update(0.01);
    expect(r.activeEvents).toEqual([]);
  });
});
