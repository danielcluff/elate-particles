// Demo effects, authored as plain documents (the same JSON the editor will save).
import { createModule, defaultRenderer, type EffectDoc, type EmitterDoc, type ModuleInstance, type RendererDoc } from "../src/index";

type Mods = [string, Record<string, unknown>?][];

function emitter(id: string, props: Partial<EmitterDoc>, mods: Mods, renderer: Partial<RendererDoc> = {}): EmitterDoc {
  const e: EmitterDoc = {
    id,
    name: id,
    duration: 1,
    looping: true,
    startDelay: 0,
    maxParticles: 300,
    space: "world",
    spawn: [],
    init: [],
    update: [],
    render: [],
    renderer: { ...defaultRenderer(renderer.type), ...renderer } as RendererDoc,
    ...props,
  };
  for (const [type, params] of mods) {
    // stable ids keep exported .fx.json diffs readable
    const m: ModuleInstance = { ...createModule(type, params), id: `${id}.${type}` };
    e[type.split(".")[0] as "spawn"].push(m);
  }
  return e;
}

function effect(id: string, name: string, emitters: EmitterDoc[], parameters: EffectDoc["parameters"] = []): EffectDoc {
  return { format: "tsl-particles", version: 1, id, name, emitters, parameters };
}

const range = (min: number, max: number) => ({ kind: "range", min, max });
const curve = (...kv: number[]) => {
  const keys = [];
  for (let i = 0; i < kv.length; i += 2) keys.push({ t: kv[i], v: kv[i + 1] });
  return { keys, interp: "smooth" };
};

// ---------------------------------------------------------------------------

export const campfire = effect("campfire", "Campfire", [
  emitter(
    "smoke",
    { maxParticles: 200 },
    [
      ["spawn.rate", { rate: 14 }],
      ["init.lifetime", { lifetime: range(3, 4.5) }],
      ["init.shape", { shape: "cone", radius: 0.4, angle: 15, speed: range(0.8, 1.4), offset: [0, 1.6, 0] }],
      ["init.size", { size: range(0.9, 1.3) }],
      ["init.rotation", { spin: range(-30, 30) }],
      ["init.color", { color: { kind: "range", a: "#4a4a4a", b: "#6a6a6a" } }],
      ["update.force", { force: [0.5, 0.2, 0] }],
      ["update.turbulence", { strength: 0.6, frequency: 0.4 }],
      ["update.drag", { drag: 0.3 }],
      ["render.sizeOverLife", { curve: curve(0, 0.5, 1, 2.6) }],
      ["render.colorOverLife", { gradient: { colors: [{ t: 0, color: "#ffffff" }], alphas: [{ t: 0, a: 0 }, { t: 0.2, a: 0.45 }, { t: 1, a: 0 }] } }],
    ],
    { blend: "alpha", shape: "softCircle", softness: 0.8, sortOrder: -1, sort: "distance", depthFade: 0.6, cameraFade: 1 },
  ),
  emitter(
    "fire",
    { maxParticles: 200 },
    [
      ["spawn.rate", { rate: 80 }],
      ["init.lifetime", { lifetime: range(0.6, 1.1) }],
      ["init.shape", { shape: "cone", radius: 0.6, angle: 10, speed: range(1.8, 3) }],
      ["init.size", { size: range(0.5, 0.9) }],
      ["init.color", { color: { kind: "constant", color: "#ffffff", alpha: 0.7 } }],
      ["update.attractor", { position: [0, 3, 0], strength: 4, radius: 1.5 }],
      ["update.turbulence", { strength: 1.5, frequency: 0.8, scroll: 1.2 }],
      ["render.sizeOverLife", { curve: curve(0, 0.4, 0.3, 1, 1, 0.1) }],
      [
        "render.colorOverLife",
        {
          gradient: {
            colors: [{ t: 0, color: "#fff2c0" }, { t: 0.35, color: "#ff8a2a" }, { t: 1, color: "#ff2000" }],
            alphas: [{ t: 0, a: 0 }, { t: 0.15, a: 1 }, { t: 1, a: 0 }],
          },
        },
      ],
    ],
    { blend: "additive", shape: "softCircle", depthFade: 0.3 },
  ),
  emitter(
    "embers",
    { maxParticles: 100 },
    [
      ["spawn.rate", { rate: 10 }],
      ["init.lifetime", { lifetime: range(1.5, 3) }],
      ["init.shape", { shape: "cone", radius: 0.4, angle: 20, speed: range(2, 3.5) }],
      ["init.size", { size: range(0.04, 0.08) }],
      ["init.color", { color: { kind: "range", a: "#ffcc55", b: "#ff6622", intensity: 4 } }],
      ["update.turbulence", { strength: 4, frequency: 1.2 }],
      ["update.drag", { drag: 0.4 }],
      ["render.colorOverLife", { gradient: { colors: [{ t: 0, color: "#ffffff" }], alphas: [{ t: 0, a: 1 }, { t: 0.8, a: 1 }, { t: 1, a: 0 }] } }],
    ],
    { blend: "additive", shape: "spark", facing: "velocity", stretch: 0.08 },
  ),
]);

// ---------------------------------------------------------------------------

export const thruster = effect(
  "thruster",
  "Ship Thruster",
  [
    emitter(
      "exhaust",
      { maxParticles: 400 },
      [
        ["spawn.rate", { rate: { kind: "param", name: "throttle", scale: 160, offset: 10 } }],
        ["init.lifetime", { lifetime: range(0.25, 0.45) }],
        ["init.shape", { shape: "cone", radius: 0.15, angle: 6, rotation: [-90, 0, 0], speed: { kind: "param", name: "throttle", scale: 10, offset: 2 } }],
        ["init.size", { size: range(0.25, 0.4) }],
        ["init.color", { color: { kind: "constant", color: "#ffffff", intensity: 3 } }],
        ["init.inheritVelocity", { factor: 0.4 }],
        ["update.drag", { drag: 2 }],
        ["render.sizeOverLife", { curve: curve(0, 1, 1, 0.2) }],
        [
          "render.colorOverLife",
          { gradient: { colors: [{ t: 0, color: "#ffffff" }, { t: 0.25, color: "#66ccff" }, { t: 1, color: "#0b2cff" }], alphas: [{ t: 0, a: 1 }, { t: 1, a: 0 }] } },
        ],
      ],
      { blend: "additive", shape: "glow" },
    ),
    emitter(
      "trail",
      { maxParticles: 200 },
      [
        ["spawn.distance", { perUnit: 2 }],
        ["init.lifetime", { lifetime: 1.6 }],
        ["init.shape", { shape: "point", speed: 0 }],
        ["init.size", { size: 0.35 }],
        ["init.color", { color: { kind: "constant", color: "#88aaff", intensity: 1.5 } }],
        ["render.sizeOverLife", { curve: curve(0, 1, 1, 2) }],
        ["render.colorOverLife", { gradient: { colors: [{ t: 0, color: "#ffffff" }, { t: 1, color: "#2244ff" }], alphas: [{ t: 0, a: 0.8 }, { t: 1, a: 0 }] } }],
      ],
      { type: "ribbon", blend: "additive", shape: "softCircle", uvMode: "stretch" },
    ),
  ],
  [{ name: "throttle", type: "float", default: 1, min: 0, max: 1, description: "Engine output 0..1" }],
);

// ---------------------------------------------------------------------------

const oneShot = { looping: false, duration: 0.5 };

export const explosion = effect("explosion", "Explosion", [
  emitter(
    "smoke",
    { ...oneShot, maxParticles: 40 },
    [
      ["spawn.burst", { time: 0.05, count: 18 }],
      ["init.lifetime", { lifetime: range(1.6, 2.6) }],
      ["init.shape", { shape: "sphere", radius: 0.8, speed: range(0.5, 1.6) }],
      ["init.size", { size: range(1.6, 2.6) }],
      ["init.rotation", { spin: range(-40, 40) }],
      ["init.color", { color: { kind: "range", a: "#2c2c2c", b: "#464646" } }],
      ["update.drag", { drag: 1 }],
      ["update.force", { force: [0, 0.6, 0] }],
      ["update.turbulence", { strength: 0.5, frequency: 0.5 }],
      ["render.sizeOverLife", { curve: curve(0, 0.5, 1, 1.7) }],
      ["render.colorOverLife", { gradient: { colors: [{ t: 0, color: "#ffffff" }], alphas: [{ t: 0, a: 0 }, { t: 0.12, a: 0.65 }, { t: 1, a: 0 }] } }],
    ],
    { blend: "alpha", shape: "softCircle", softness: 0.8, sortOrder: -1, sort: "distance", depthFade: 0.6, cameraFade: 1 },
  ),
  emitter(
    "fireball",
    { ...oneShot, maxParticles: 60 },
    [
      ["spawn.burst", { count: 40 }],
      ["init.lifetime", { lifetime: range(0.5, 0.9) }],
      ["init.shape", { shape: "sphere", radius: 0.4, speed: range(2, 6) }],
      ["init.size", { size: range(1, 1.8) }],
      ["init.rotation", { spin: range(-90, 90) }],
      ["init.color", { color: { kind: "constant", color: "#ffffff", intensity: 2 } }],
      ["update.drag", { drag: 3 }],
      ["render.sizeOverLife", { curve: curve(0, 0.3, 0.15, 1, 1, 1.4) }],
      [
        "render.colorOverLife",
        {
          gradient: {
            colors: [{ t: 0, color: "#fff4d0" }, { t: 0.3, color: "#ff9a3c" }, { t: 1, color: "#5a1a08" }],
            alphas: [{ t: 0, a: 1 }, { t: 0.6, a: 0.7 }, { t: 1, a: 0 }],
          },
        },
      ],
    ],
    { blend: "additive", shape: "softCircle", softness: 0.8 },
  ),
  {
    ...emitter(
      "sparks",
      { ...oneShot, maxParticles: 120 },
      [
        ["spawn.burst", { count: 70 }],
        ["init.lifetime", { lifetime: range(0.5, 1.3) }],
        ["init.shape", { shape: "sphere", radius: 0.2, speed: range(8, 20) }],
        ["init.size", { size: range(0.06, 0.12) }],
        ["init.color", { color: { kind: "range", a: "#ffe3a0", b: "#ff9a40", intensity: 6 } }],
        ["update.drag", { drag: 1.8 }],
        ["update.gravity", { scale: 0.4 }],
        ["update.collisionPlane", { bounce: 0.3, friction: 0.4 }],
        ["render.colorOverLife", { gradient: { colors: [{ t: 0, color: "#ffffff" }], alphas: [{ t: 0, a: 1 }, { t: 0.7, a: 1 }, { t: 1, a: 0 }] } }],
      ],
      { blend: "additive", shape: "spark", facing: "velocity", stretch: 0.05 },
    ),
    subEmitters: [{ trigger: "death", emitter: "puff", count: 1, probability: 0.5, inheritVelocity: 0.1 }],
  },
  emitter(
    "debris",
    { ...oneShot, maxParticles: 30 },
    [
      ["spawn.burst", { count: 16 }],
      ["init.lifetime", { lifetime: range(1.6, 2.4) }],
      ["init.shape", { shape: "hemisphere", radius: 0.3, speed: range(4, 9) }],
      ["init.size", { size: range(0.12, 0.3) }],
      ["init.rotation", { spin: range(-540, 540) }],
      ["init.color", { color: { kind: "range", a: "#3a3430", b: "#6b5e52" } }],
      ["update.gravity", {}],
      ["update.drag", { drag: 0.3 }],
      ["update.collisionPlane", { bounce: 0.35, friction: 0.5 }],
      ["render.sizeOverLife", { curve: { keys: [{ t: 0, v: 1 }, { t: 0.85, v: 1 }, { t: 1, v: 0 }], interp: "smooth" } }],
    ],
    { type: "mesh", blend: "opaque", mesh: "icosahedron", orientation: "random", lit: true, roughness: 0.8 },
  ),
  emitter(
    "flash",
    { ...oneShot, maxParticles: 2 },
    [
      ["spawn.burst", { count: 1 }],
      ["init.lifetime", { lifetime: 0.18 }],
      ["init.shape", { shape: "point", speed: 0 }],
      ["init.size", { size: 7 }],
      ["init.color", { color: { kind: "constant", color: "#fff4d6", intensity: 4 } }],
      ["render.sizeOverLife", { curve: curve(0, 0.6, 1, 1.2) }],
      ["render.colorOverLife", { gradient: { colors: [{ t: 0, color: "#ffffff" }], alphas: [{ t: 0, a: 1 }, { t: 1, a: 0 }] } }],
    ],
    { blend: "additive", shape: "glow" },
  ),
  emitter(
    "shockwave",
    { ...oneShot, maxParticles: 2 },
    [
      ["spawn.burst", { count: 1 }],
      ["init.lifetime", { lifetime: 0.55 }],
      ["init.shape", { shape: "point", speed: 0, offset: [0, 0.05, 0] }],
      ["init.size", { size: 1 }],
      ["init.rotation", { angle: 0 }],
      ["init.color", { color: { kind: "constant", color: "#ffc080", intensity: 2 } }],
      ["render.sizeOverLife", { curve: { keys: [{ t: 0, v: 0.3 }, { t: 1, v: 9 }], interp: "linear" } }],
      ["render.colorOverLife", { gradient: { colors: [{ t: 0, color: "#ffffff" }], alphas: [{ t: 0, a: 0.9 }, { t: 1, a: 0 }] } }],
    ],
    { blend: "additive", shape: "ring", facing: "horizontal" },
  ),
  emitter(
    "puff",
    { ...oneShot, eventDriven: true, maxParticles: 80 },
    [
      ["init.lifetime", { lifetime: range(0.5, 0.9) }],
      ["init.shape", { shape: "point", speed: 0 }],
      ["init.size", { size: range(0.25, 0.45) }],
      ["init.color", { color: "#5a5a5a" }],
      ["update.force", { force: [0, 0.5, 0] }],
      ["render.sizeOverLife", { curve: curve(0, 0.5, 1, 1.6) }],
      ["render.colorOverLife", { gradient: { colors: [{ t: 0, color: "#ffffff" }], alphas: [{ t: 0, a: 0.5 }, { t: 1, a: 0 }] } }],
    ],
    { blend: "alpha", shape: "softCircle", sortOrder: -1, sort: "distance" },
  ),
]);

// ---------------------------------------------------------------------------

/** A fast projectile: ribbon tracer, glowing head, velocity-aligned bolt mesh. */
export const tracer = effect("tracer", "Tracer", [
  emitter(
    "trail",
    { maxParticles: 64 },
    [
      ["spawn.distance", { perUnit: 1.5 }],
      ["init.lifetime", { lifetime: 0.35 }],
      ["init.shape", { shape: "point", speed: 0 }],
      ["init.size", { size: 0.18 }],
      ["init.color", { color: { kind: "constant", color: "#ff9a40", intensity: 4 } }],
      ["render.sizeOverLife", { curve: { keys: [{ t: 0, v: 1 }, { t: 1, v: 0.2 }] } }],
      ["render.colorOverLife", { gradient: { colors: [{ t: 0, color: "#ffffff" }, { t: 1, color: "#ff3300" }], alphas: [{ t: 0, a: 1 }, { t: 1, a: 0 }] } }],
    ],
    { type: "ribbon", blend: "additive", shape: "glow", uvMode: "stretch" },
  ),
  emitter(
    "bolt",
    { maxParticles: 1, space: "local" },
    [
      ["spawn.burst", { count: 1 }],
      ["init.lifetime", { lifetime: 1000 }],
      ["init.shape", { shape: "point", speed: 0 }],
      ["init.velocity", { velocity: [0, 0, 1e-3] }],
      ["init.size", { size: 0.35 }],
      ["init.rotation", { angle: 0 }],
      ["init.color", { color: { kind: "constant", color: "#ffd9a0", intensity: 6 } }],
    ],
    { type: "mesh", blend: "additive", mesh: "cylinder", orientation: "velocity" },
  ),
]);

// ---------------------------------------------------------------------------

/** Per-particle trails + sub-emitters: a shell rises and bursts into trailed stars. */
export const firework = effect("firework", "Firework", [
  {
    ...emitter(
      "shell",
      { looping: false, duration: 0.1, maxParticles: 2 },
      [
        ["spawn.burst", { count: 1 }],
        ["init.lifetime", { lifetime: range(1.1, 1.4) }],
        ["init.shape", { shape: "cone", radius: 0, angle: 6, speed: range(15, 18) }],
        ["init.size", { size: 0.12 }],
        ["init.color", { color: { kind: "constant", color: "#ffd9a0", intensity: 3 } }],
        ["update.gravity", {}],
      ],
      { type: "ribbon", mode: "particle", trail: { points: 24, minDistance: 0.15, lifetime: 0.6 }, taper: 1, fade: 1, blend: "additive", shape: "glow" },
    ),
    subEmitters: [{ trigger: "death", emitter: "stars", count: 90, inheritVelocity: 0.4 }],
  },
  emitter(
    "stars",
    { looping: false, duration: 0.1, eventDriven: true, maxParticles: 200 },
    [
      ["init.lifetime", { lifetime: range(1.2, 1.9) }],
      ["init.shape", { shape: "sphere", radius: 0.1, thickness: 0, speed: range(7, 9) }],
      ["init.size", { size: range(0.08, 0.14) }],
      [
        "init.color",
        {
          color: {
            kind: "randomGradient",
            gradient: { colors: [{ t: 0, color: "#ff4060" }, { t: 0.33, color: "#ffd040" }, { t: 0.66, color: "#40ff90" }, { t: 1, color: "#4080ff" }], alphas: [{ t: 0, a: 1 }], intensity: 4 },
          },
        },
      ],
      ["update.gravity", { scale: 0.35 }],
      ["update.drag", { drag: 1.1 }],
      ["render.colorOverLife", { gradient: { colors: [{ t: 0, color: "#ffffff" }], alphas: [{ t: 0, a: 1 }, { t: 0.7, a: 1 }, { t: 1, a: 0 }] } }],
    ],
    { type: "ribbon", mode: "particle", trail: { points: 16, minDistance: 0.08, lifetime: 0.45 }, taper: 1, fade: 1, blend: "additive", shape: "glow" },
  ),
]);

export const ALL_EFFECTS = [campfire, thruster, explosion, tracer, firework];
