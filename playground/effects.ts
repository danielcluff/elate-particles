// Demo effects, authored as plain documents (the same JSON the editor will save).
import {
  createModule,
  defaultRenderer,
  type EffectDoc,
  type EmitterDoc,
  type LightRendererDoc,
  type ModuleInstance,
  type RendererDoc,
} from "../src/index";

type Mods = [string, Record<string, unknown>?][];

/** `renderer` may be one renderer or several (e.g. a sprite head plus a trail). */
function emitter(
  id: string,
  props: Partial<EmitterDoc>,
  mods: Mods,
  renderer: Partial<RendererDoc> | Partial<RendererDoc>[] = {},
): EmitterDoc {
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
    // stable ids keep exported .fx.json diffs readable
    renderers: (Array.isArray(renderer) ? renderer : [renderer]).map(
      (r, i) =>
        ({
          ...defaultRenderer(r.type),
          ...r,
          id: `${id}.r${i}`,
        }) as RendererDoc,
    ),
    ...props,
  };
  for (const [type, params] of mods) {
    // stable ids keep exported .fx.json diffs readable
    const m: ModuleInstance = {
      ...createModule(type, params),
      id: `${id}.${type}`,
    };
    e[type.split(".")[0] as "spawn"].push(m);
  }
  return e;
}

function effect(
  id: string,
  name: string,
  emitters: EmitterDoc[],
  parameters: EffectDoc["parameters"] = [],
): EffectDoc {
  return {
    format: "elate-particles",
    version: 1,
    id,
    name,
    emitters,
    parameters,
  };
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
      [
        "init.shape",
        {
          shape: "cone",
          radius: 0.4,
          angle: 15,
          speed: range(0.8, 1.4),
          offset: [0, 1.6, 0],
        },
      ],
      ["init.size", { size: range(0.9, 1.3) }],
      ["init.rotation", { spin: range(-30, 30) }],
      ["init.color", { color: { kind: "range", a: "#4a4a4a", b: "#6a6a6a" } }],
      ["update.force", { force: [0.5, 0.2, 0] }],
      ["update.turbulence", { strength: 0.6, frequency: 0.4 }],
      ["update.drag", { drag: 0.3 }],
      ["render.sizeOverLife", { curve: curve(0, 0.5, 1, 2.6) }],
      [
        "render.colorOverLife",
        {
          gradient: {
            colors: [{ t: 0, color: "#ffffff" }],
            alphas: [
              { t: 0, a: 0 },
              { t: 0.2, a: 0.45 },
              { t: 1, a: 0 },
            ],
          },
        },
      ],
    ],
    {
      blend: "alpha",
      shape: "softCircle",
      softness: 0.8,
      sortOrder: -1,
      sort: "distance",
      depthFade: 0.6,
      cameraFade: 1,
    },
  ),
  emitter(
    "fire",
    { maxParticles: 200 },
    [
      ["spawn.rate", { rate: 80 }],
      ["init.lifetime", { lifetime: range(0.6, 1.1) }],
      [
        "init.shape",
        { shape: "cone", radius: 0.6, angle: 10, speed: range(1.8, 3) },
      ],
      ["init.size", { size: range(0.5, 0.9) }],
      [
        "init.color",
        { color: { kind: "constant", color: "#ffffff", alpha: 0.7 } },
      ],
      ["update.attractor", { position: [0, 3, 0], strength: 4, radius: 1.5 }],
      ["update.turbulence", { strength: 1.5, frequency: 0.8, scroll: 1.2 }],
      ["render.sizeOverLife", { curve: curve(0, 0.4, 0.3, 1, 1, 0.1) }],
      [
        "render.colorOverLife",
        {
          gradient: {
            colors: [
              { t: 0, color: "#fff2c0" },
              { t: 0.35, color: "#ff8a2a" },
              { t: 1, color: "#ff2000" },
            ],
            alphas: [
              { t: 0, a: 0 },
              { t: 0.15, a: 1 },
              { t: 1, a: 0 },
            ],
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
      [
        "init.shape",
        { shape: "cone", radius: 0.4, angle: 20, speed: range(2, 3.5) },
      ],
      ["init.size", { size: range(0.04, 0.08) }],
      [
        "init.color",
        { color: { kind: "range", a: "#ffcc55", b: "#ff6622", intensity: 4 } },
      ],
      ["update.turbulence", { strength: 4, frequency: 1.2 }],
      ["update.drag", { drag: 0.4 }],
      [
        "render.colorOverLife",
        {
          gradient: {
            colors: [{ t: 0, color: "#ffffff" }],
            alphas: [
              { t: 0, a: 1 },
              { t: 0.8, a: 1 },
              { t: 1, a: 0 },
            ],
          },
        },
      ],
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
        [
          "spawn.rate",
          { rate: { kind: "param", name: "throttle", scale: 160, offset: 10 } },
        ],
        ["init.lifetime", { lifetime: range(0.25, 0.45) }],
        [
          "init.shape",
          {
            shape: "cone",
            radius: 0.15,
            angle: 6,
            rotation: [-90, 0, 0],
            speed: { kind: "param", name: "throttle", scale: 10, offset: 2 },
          },
        ],
        ["init.size", { size: range(0.25, 0.4) }],
        [
          "init.color",
          { color: { kind: "constant", color: "#ffffff", intensity: 3 } },
        ],
        ["init.inheritVelocity", { factor: 0.4 }],
        ["update.drag", { drag: 2 }],
        ["render.sizeOverLife", { curve: curve(0, 1, 1, 0.2) }],
        [
          "render.colorOverLife",
          {
            gradient: {
              colors: [
                { t: 0, color: "#ffffff" },
                { t: 0.25, color: "#66ccff" },
                { t: 1, color: "#0b2cff" },
              ],
              alphas: [
                { t: 0, a: 1 },
                { t: 1, a: 0 },
              ],
            },
          },
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
        [
          "init.color",
          { color: { kind: "constant", color: "#88aaff", intensity: 1.5 } },
        ],
        ["render.sizeOverLife", { curve: curve(0, 1, 1, 2) }],
        [
          "render.colorOverLife",
          {
            gradient: {
              colors: [
                { t: 0, color: "#ffffff" },
                { t: 1, color: "#2244ff" },
              ],
              alphas: [
                { t: 0, a: 0.8 },
                { t: 1, a: 0 },
              ],
            },
          },
        ],
      ],
      {
        type: "ribbon",
        blend: "additive",
        shape: "softCircle",
        uvMode: "stretch",
      },
    ),
  ],
  [
    {
      name: "throttle",
      type: "float",
      default: 1,
      min: 0,
      max: 1,
      description: "Engine output 0..1",
    },
  ],
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
      [
        "render.colorOverLife",
        {
          gradient: {
            colors: [{ t: 0, color: "#ffffff" }],
            alphas: [
              { t: 0, a: 0 },
              { t: 0.12, a: 0.65 },
              { t: 1, a: 0 },
            ],
          },
        },
      ],
    ],
    {
      blend: "alpha",
      shape: "softCircle",
      softness: 0.8,
      sortOrder: -1,
      sort: "distance",
      depthFade: 0.6,
      cameraFade: 1,
    },
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
      [
        "init.color",
        { color: { kind: "constant", color: "#ffffff", intensity: 2 } },
      ],
      ["update.drag", { drag: 3 }],
      ["render.sizeOverLife", { curve: curve(0, 0.3, 0.15, 1, 1, 1.4) }],
      [
        "render.colorOverLife",
        {
          gradient: {
            colors: [
              { t: 0, color: "#fff4d0" },
              { t: 0.3, color: "#ff9a3c" },
              { t: 1, color: "#5a1a08" },
            ],
            alphas: [
              { t: 0, a: 1 },
              { t: 0.6, a: 0.7 },
              { t: 1, a: 0 },
            ],
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
        [
          "init.color",
          {
            color: { kind: "range", a: "#ffe3a0", b: "#ff9a40", intensity: 6 },
          },
        ],
        ["update.drag", { drag: 1.8 }],
        ["update.gravity", { scale: 0.4 }],
        ["update.collisionPlane", { bounce: 0.3, friction: 0.4 }],
        [
          "render.colorOverLife",
          {
            gradient: {
              colors: [{ t: 0, color: "#ffffff" }],
              alphas: [
                { t: 0, a: 1 },
                { t: 0.7, a: 1 },
                { t: 1, a: 0 },
              ],
            },
          },
        ],
      ],
      [
        // one simulation, drawn twice: a stretched spark head and a short fading streak behind it
        {
          blend: "additive",
          shape: "spark",
          facing: "velocity",
          stretch: 0.05,
        },
        {
          type: "ribbon",
          mode: "particle",
          trail: { points: 8, minDistance: 0.1, lifetime: 0.15 },
          taper: 1,
          fade: 1,
          blend: "additive",
          shape: "glow",
        },
      ],
    ),
    subEmitters: [
      {
        trigger: "death",
        emitter: "puff",
        count: 1,
        probability: 0.5,
        inheritVelocity: 0.1,
      },
    ],
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
      [
        "render.sizeOverLife",
        {
          curve: {
            keys: [
              { t: 0, v: 1 },
              { t: 0.85, v: 1 },
              { t: 1, v: 0 },
            ],
            interp: "smooth",
          },
        },
      ],
    ],
    {
      type: "mesh",
      blend: "opaque",
      mesh: "icosahedron",
      orientation: "random",
      lit: true,
      roughness: 0.8,
    },
  ),
  emitter(
    "flash",
    { ...oneShot, maxParticles: 2 },
    [
      ["spawn.burst", { count: 1 }],
      ["init.lifetime", { lifetime: 0.18 }],
      ["init.shape", { shape: "point", speed: 0 }],
      ["init.size", { size: 7 }],
      [
        "init.color",
        { color: { kind: "constant", color: "#fff4d6", intensity: 4 } },
      ],
      ["render.sizeOverLife", { curve: curve(0, 0.6, 1, 1.2) }],
      [
        "render.colorOverLife",
        {
          gradient: {
            colors: [{ t: 0, color: "#ffffff" }],
            alphas: [
              { t: 0, a: 1 },
              { t: 1, a: 0 },
            ],
          },
        },
      ],
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
      [
        "init.color",
        { color: { kind: "constant", color: "#ffc080", intensity: 2 } },
      ],
      [
        "render.sizeOverLife",
        {
          curve: {
            keys: [
              { t: 0, v: 0.3 },
              { t: 1, v: 9 },
            ],
            interp: "linear",
          },
        },
      ],
      [
        "render.colorOverLife",
        {
          gradient: {
            colors: [{ t: 0, color: "#ffffff" }],
            alphas: [
              { t: 0, a: 0.9 },
              { t: 1, a: 0 },
            ],
          },
        },
      ],
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
      [
        "render.colorOverLife",
        {
          gradient: {
            colors: [{ t: 0, color: "#ffffff" }],
            alphas: [
              { t: 0, a: 0.5 },
              { t: 1, a: 0 },
            ],
          },
        },
      ],
    ],
    { blend: "alpha", shape: "softCircle", sortOrder: -1, sort: "distance" },
  ),
]);

// one sort group for every fire/smoke sprite: alpha smoke and additive fire interleave by depth
// (smoke in front of fire dims it), across emitters and across effects, in a single draw call
for (const fx of [campfire, explosion])
  for (const e of fx.emitters)
    for (const r of e.renderers)
      if (
        r.type === "sprite" &&
        ["smoke", "fire", "embers", "fireball", "puff", "flash"].includes(e.id)
      )
        r.sortGroup = "fx";

// LOD: far explosions keep fireball + smoke; detail emitters drop out; hero particles are never thinned
explosion.scalability = {
  lodDistance: 30,
  cullDistance: 150,
  farSpawnScale: 0.3,
  maxInstances: 800,
  overflow: "killOldest",
};
for (const e of explosion.emitters) {
  if (e.id === "flash" || e.id === "shockwave") e.lod = { scaleSpawn: false };
  if (e.id === "sparks" || e.id === "debris" || e.id === "puff")
    e.lod = { maxDistance: 45, minQuality: 0.5 };
}

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
      [
        "init.color",
        { color: { kind: "constant", color: "#ff9a40", intensity: 4 } },
      ],
      [
        "render.sizeOverLife",
        {
          curve: {
            keys: [
              { t: 0, v: 1 },
              { t: 1, v: 0.2 },
            ],
          },
        },
      ],
      [
        "render.colorOverLife",
        {
          gradient: {
            colors: [
              { t: 0, color: "#ffffff" },
              { t: 1, color: "#ff3300" },
            ],
            alphas: [
              { t: 0, a: 1 },
              { t: 1, a: 0 },
            ],
          },
        },
      ],
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
      [
        "init.color",
        { color: { kind: "constant", color: "#ffd9a0", intensity: 6 } },
      ],
    ],
    {
      type: "mesh",
      blend: "additive",
      mesh: "cylinder",
      orientation: "velocity",
    },
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
        [
          "init.shape",
          { shape: "cone", radius: 0, angle: 6, speed: range(15, 18) },
        ],
        ["init.size", { size: 0.12 }],
        [
          "init.color",
          { color: { kind: "constant", color: "#ffd9a0", intensity: 3 } },
        ],
        ["update.gravity", {}],
      ],
      [
        {
          type: "ribbon",
          mode: "particle",
          trail: { points: 24, minDistance: 0.15, lifetime: 0.6 },
          taper: 1,
          fade: 1,
          blend: "additive",
          shape: "glow",
        },
        { blend: "additive", shape: "glow", sortOrder: 1 },
      ],
    ),
    subEmitters: [
      { trigger: "death", emitter: "stars", count: 90, inheritVelocity: 0.4 },
    ],
  },
  emitter(
    "stars",
    { looping: false, duration: 0.1, eventDriven: true, maxParticles: 200 },
    [
      ["init.lifetime", { lifetime: range(1.2, 1.9) }],
      [
        "init.shape",
        { shape: "sphere", radius: 0.1, thickness: 0, speed: range(7, 9) },
      ],
      ["init.size", { size: range(0.08, 0.14) }],
      [
        "init.color",
        {
          color: {
            kind: "randomGradient",
            gradient: {
              colors: [
                { t: 0, color: "#ff4060" },
                { t: 0.33, color: "#ffd040" },
                { t: 0.66, color: "#40ff90" },
                { t: 1, color: "#4080ff" },
              ],
              alphas: [{ t: 0, a: 1 }],
              intensity: 4,
            },
          },
        },
      ],
      ["update.gravity", { scale: 0.35 }],
      ["update.drag", { drag: 1.1 }],
      [
        "render.colorOverLife",
        {
          gradient: {
            colors: [{ t: 0, color: "#ffffff" }],
            alphas: [
              { t: 0, a: 1 },
              { t: 0.7, a: 1 },
              { t: 1, a: 0 },
            ],
          },
        },
      ],
    ],
    [
      {
        type: "ribbon",
        mode: "particle",
        trail: { points: 16, minDistance: 0.08, lifetime: 0.45 },
        taper: 1,
        fade: 1,
        blend: "additive",
        shape: "glow",
      },
      // bright head on every star, drawn over its trail
      { blend: "additive", shape: "glow", sortOrder: 1 },
    ],
  ),
]);

// ---------------------------------------------------------------------------

/** A very large emitter for the GPU simulator (falls back to the CPU without WebGPU). */
export const swarm = effect("swarm", "GPU Swarm", [
  emitter(
    "swarm",
    { maxParticles: 250_000, sim: "gpu" },
    [
      ["spawn.rate", { rate: 60_000 }],
      ["init.lifetime", { lifetime: range(3, 4) }],
      ["init.shape", { shape: "sphere", radius: 0.5, speed: range(3, 7) }],
      ["init.size", { size: range(0.03, 0.07) }],
      [
        "init.color",
        {
          color: {
            kind: "randomGradient",
            gradient: {
              colors: [
                { t: 0, color: "#40a0ff" },
                { t: 0.5, color: "#c060ff" },
                { t: 1, color: "#ff7040" },
              ],
              alphas: [{ t: 0, a: 1 }],
              intensity: 2,
            },
          },
        },
      ],
      ["update.vortex", { axis: [0, 1, 0], strength: 6, pull: 1.5 }],
      ["update.turbulence", { strength: 4, frequency: 0.4, scroll: 0.4 }],
      ["update.drag", { drag: 0.4 }],
      [
        "render.colorOverLife",
        {
          gradient: {
            colors: [{ t: 0, color: "#ffffff" }],
            alphas: [
              { t: 0, a: 0 },
              { t: 0.1, a: 1 },
              { t: 0.8, a: 1 },
              { t: 1, a: 0 },
            ],
          },
        },
      ],
    ],
    { blend: "additive", shape: "glow" },
  ),
]);

/** Alpha-blended smoke on the GPU, depth-sorted on the GPU (bitonic sort + gather). */
export const gpuSmoke = effect("gpuSmoke", "GPU Smoke", [
  emitter(
    "smoke",
    { maxParticles: 32_768, sim: "gpu" },
    [
      ["spawn.rate", { rate: 5000 }],
      ["init.lifetime", { lifetime: range(4, 6) }],
      ["init.shape", { shape: "circle", radius: 1.2, speed: range(0.2, 0.6) }],
      ["init.velocity", { velocity: [0, 2, 0], spread: [0.3, 0.4, 0.3] }],
      ["init.size", { size: range(0.5, 0.9) }],
      ["init.rotation", { angle: range(0, 360), spin: range(-30, 30) }],
      [
        "init.color",
        {
          color: {
            kind: "randomGradient",
            gradient: {
              colors: [
                { t: 0, color: "#2a2622" },
                { t: 0.5, color: "#6d655c" },
                { t: 1, color: "#d8d0c4" },
              ],
              alphas: [{ t: 0, a: 1 }],
            },
          },
        },
      ],
      ["update.turbulence", { strength: 1.2, frequency: 0.35, scroll: 0.3 }],
      ["update.drag", { drag: 0.6 }],
      [
        "update.force",
        {
          force: [1, 0, 0],
          scale: { kind: "curve", curve: curve(0, 0, 0.4, 0, 1, 1.5) },
        },
      ],
      ["render.sizeOverLife", { curve: curve(0, 0.4, 1, 2.2) }],
      [
        "render.colorOverLife",
        {
          gradient: {
            colors: [{ t: 0, color: "#ffffff" }],
            alphas: [
              { t: 0, a: 0 },
              { t: 0.1, a: 0.8 },
              { t: 0.7, a: 0.5 },
              { t: 1, a: 0 },
            ],
          },
        },
      ],
    ],
    // in the "fx" sort group: sorted on the GPU together with the (CPU) campfire's fire and smoke
    { blend: "alpha", shape: "softCircle", sort: "distance", sortGroup: "fx" },
  ),
]);

/** Emitter-mode ribbon on the GPU: a strip through the particles in spawn order, behind a moving effect. */
export const comet = effect("comet", "GPU Comet", [
  emitter(
    "tail",
    { maxParticles: 512, sim: "gpu" },
    [
      ["spawn.rate", { rate: 90 }],
      ["init.lifetime", { lifetime: 1.6 }],
      ["init.size", { size: 0.5 }],
      ["init.color", { color: { kind: "constant", color: "#60c0ff", intensity: 3 } }],
      ["update.turbulence", { strength: 1.5, frequency: 0.5, scroll: 0.5 }],
      ["render.colorOverLife", { gradient: { colors: [{ t: 0, color: "#ffffff" }, { t: 1, color: "#4060ff" }], alphas: [{ t: 0, a: 1 }, { t: 1, a: 0 }] } }],
    ],
    [
      { type: "ribbon", mode: "emitter", taper: 1, fade: 0.5, blend: "additive", shape: "glow" },
      { blend: "additive", shape: "glow", sortOrder: 1 },
    ],
  ),
]);

/** A small GPU effect meant to be spawned many times: instances share one pool and draw call (batching). */
export const torch: EffectDoc = {
  ...effect("torch", "GPU Torch", [
    emitter(
      "flame",
      { maxParticles: 2048, sim: "gpu" },
      [
        ["spawn.rate", { rate: 1200 }],
        ["init.lifetime", { lifetime: range(0.6, 1.1) }],
        [
          "init.shape",
          { shape: "cone", radius: 0.15, angle: 12, speed: range(1, 2.2) },
        ],
        ["init.size", { size: range(0.08, 0.16) }],
        [
          "init.color",
          {
            color: {
              kind: "randomGradient",
              gradient: {
                colors: [
                  { t: 0, color: "#ff5010" },
                  { t: 1, color: "#ffc040" },
                ],
                alphas: [{ t: 0, a: 1 }],
                intensity: 3,
              },
            },
          },
        ],
        ["update.turbulence", { strength: 2, frequency: 1.2, scroll: 1 }],
        ["update.drag", { drag: 0.8 }],
        ["render.sizeOverLife", { curve: curve(0, 1, 1, 0.2) }],
        [
          "render.colorOverLife",
          {
            gradient: {
              colors: [
                { t: 0, color: "#ffffff" },
                { t: 1, color: "#802010" },
              ],
              alphas: [
                { t: 0, a: 0 },
                { t: 0.1, a: 1 },
                { t: 1, a: 0 },
              ],
            },
          },
        ],
      ],
      { blend: "additive", shape: "glow" },
    ),
  ]),
  // sizes the shared GPU pool up front (it would otherwise double from 4 lanes as torches arrive)
  scalability: { maxInstances: 128 },
};

/**
 * GPU sub-emitters: rockets die into bursts, burst stars die into slow embers,
 * all on the GPU (events are appended with atomics and spawned by an indirect
 * dispatch). Burst drag is a curve over particle age.
 */
export const volley = effect("volley", "GPU Volley", [
  {
    ...emitter(
      "rockets",
      { maxParticles: 512, sim: "gpu" },
      [
        ["spawn.rate", { rate: 14 }],
        ["init.lifetime", { lifetime: range(1.2, 1.8) }],
        ["init.shape", { shape: "box", boxSize: [40, 0, 20], speed: 0 }],
        ["init.velocity", { velocity: [0, 17, 0], spread: [2.5, 3, 2.5] }],
        ["init.size", { size: 0.18 }],
        [
          "init.color",
          { color: { kind: "constant", color: "#ffd9a0", intensity: 4 } },
        ],
        ["update.gravity", {}],
      ],
      [
        // per-particle trails on the GPU: a history ring per particle, drawn from storage in the vertex shader
        { type: "ribbon", mode: "particle", trail: { points: 20, minDistance: 0.25, lifetime: 0.6 }, taper: 1, fade: 1, blend: "additive", shape: "glow" },
        { blend: "additive", shape: "glow", sortOrder: 1 },
      ],
    ),
    subEmitters: [
      {
        trigger: "death",
        emitter: "burst",
        count: 1500,
        inheritVelocity: 0.3,
        inheritColor: false,
      },
    ],
  },
  {
    ...emitter(
      "burst",
      { maxParticles: 131_072, sim: "gpu", eventDriven: true },
      [
        ["init.lifetime", { lifetime: range(1.2, 2.2) }],
        [
          "init.shape",
          { shape: "sphere", radius: 0.1, thickness: 0, speed: range(4, 10) },
        ],
        ["init.size", { size: range(0.04, 0.09) }],
        [
          "init.color",
          {
            color: {
              kind: "randomGradient",
              gradient: {
                colors: [
                  { t: 0, color: "#ff4060" },
                  { t: 0.33, color: "#ffd040" },
                  { t: 0.66, color: "#40ff90" },
                  { t: 1, color: "#4080ff" },
                ],
                alphas: [{ t: 0, a: 1 }],
                intensity: 4,
              },
            },
          },
        ],
        ["update.gravity", { scale: 0.35 }],
        // little drag while the shell opens, then heavy: the burst hangs in the air
        [
          "update.drag",
          { drag: { kind: "curve", curve: curve(0, 0.3, 0.25, 2.5, 1, 3) } },
        ],
        [
          "render.colorOverLife",
          {
            gradient: {
              colors: [{ t: 0, color: "#ffffff" }],
              alphas: [
                { t: 0, a: 1 },
                { t: 0.7, a: 1 },
                { t: 1, a: 0 },
              ],
            },
          },
        ],
      ],
      { blend: "additive", shape: "glow" },
    ),
    subEmitters: [
      {
        trigger: "death",
        emitter: "embers",
        count: 1,
        probability: 0.15,
        inheritColor: true,
      },
    ],
  },
  emitter(
    "embers",
    { maxParticles: 32_768, sim: "gpu", eventDriven: true },
    [
      ["init.lifetime", { lifetime: range(1, 1.6) }],
      ["init.shape", { shape: "point", speed: range(0.2, 0.6) }],
      ["init.size", { size: range(0.05, 0.08) }],
      ["update.gravity", { scale: 0.08 }],
      ["update.turbulence", { strength: 1.5, frequency: 0.6 }],
      ["render.sizeOverLife", { curve: curve(0, 1, 1, 0) }],
    ],
    { blend: "additive", shape: "glow" },
  ),
]);

// per-particle lights (they need ParticleWorld({ lights: { max } })): the fire flickers on the ground, fireballs
// flash, GPU firework bursts glow
const addLight = (fx: EffectDoc, emitterId: string, l: Partial<LightRendererDoc>) =>
  fx.emitters.find((e) => e.id === emitterId)!.renderers.push({ ...(defaultRenderer("light") as LightRendererDoc), ...l, id: `${emitterId}.light` });
addLight(campfire, "fire", { ratio: 0.3, maxLights: 1, intensity: 30, range: 10 });
addLight(explosion, "fireball", { ratio: 0.5, maxLights: 2, intensity: 60, range: 16 });
addLight(volley, "burst", { ratio: 0.02, maxLights: 6, intensity: 120, range: 24 });

export const ALL_EFFECTS = [
  campfire,
  thruster,
  explosion,
  tracer,
  firework,
  swarm,
  gpuSmoke,
  comet,
  volley,
  torch,
];
