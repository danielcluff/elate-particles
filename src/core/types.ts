// Serialisable effect documents. Shared by the runtime, the editor and any
// server-side tooling, so nothing in src/core may import three, DOM or UI code.
//
// An effect is a stack of emitters; each emitter is a stack of modules grouped
// by stage (the Niagara / VFX Graph "context" model):
//
//   spawn   how many particles to create this frame (rate, bursts, distance)
//   init    runs once on each new particle (lifetime, shape, velocity, colour…)
//   update  runs every frame on every live particle (forces, drag, noise…)
//   render  evaluated on the GPU from the particle's normalised age (size/colour over life)

export const EFFECT_FORMAT = "tsl-particles";
export const EFFECT_VERSION = 1;

export type Vec3 = [number, number, number];

// ---------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------

export interface CurveKey {
  /** 0..1 */
  t: number;
  v: number;
}

export type CurveInterp = "linear" | "smooth" | "step";

export interface Curve {
  keys: CurveKey[];
  interp?: CurveInterp;
}

/**
 * A scalar that may vary (Unity's MinMaxCurve plus parameter bindings).
 * The `t` a curve is sampled at depends on where it is used: emitter time for
 * spawn/init modules, particle age for update/render modules.
 */
export type FloatValue =
  | number
  | { kind: "range"; min: number; max: number }
  | { kind: "curve"; curve: Curve; scale?: number }
  /** Random between two curves, picked per particle. */
  | { kind: "rangeCurve"; min: Curve; max: Curve; scale?: number }
  /** Bound to an effect parameter (set at runtime, e.g. engine throttle): `param * scale + offset`. */
  | { kind: "param"; name: string; scale?: number; offset?: number };

export interface ColorStop {
  t: number;
  /** sRGB hex, "#rrggbb". */
  color: string;
}

export interface AlphaStop {
  t: number;
  a: number;
}

export interface Gradient {
  colors: ColorStop[];
  alphas: AlphaStop[];
  /** HDR multiplier applied to rgb (values > 1 drive bloom). */
  intensity?: number;
}

export type ColorValue =
  /** sRGB hex shorthand, opaque. */
  | string
  | { kind: "constant"; color: string; alpha?: number; intensity?: number }
  /** Random blend between two colours, per particle. */
  | { kind: "range"; a: string; b: string; alphaA?: number; alphaB?: number; intensity?: number }
  /** Sampled over the context's `t` (emitter time for init, age for over-life). */
  | { kind: "gradient"; gradient: Gradient }
  /** Random point on the gradient, per particle. */
  | { kind: "randomGradient"; gradient: Gradient };

// ---------------------------------------------------------------------------
// document
// ---------------------------------------------------------------------------

export type Stage = "spawn" | "init" | "update" | "render";
export const STAGES: Stage[] = ["spawn", "init", "update", "render"];

export interface ModuleInstance {
  id: string;
  /** Registry key, e.g. "init.shape". */
  type: string;
  /** Defaults to true. */
  enabled?: boolean;
  /** User title override. */
  label?: string;
  params: Record<string, unknown>;
}

/**
 * Draw order of particles *within* an emitter (across all its live instances):
 * distance = back to front along the camera's view direction (needed for alpha
 * blending), oldestOnTop / newestOnTop = by age. Between emitters, sortOrder decides.
 */
export type SortMode = "none" | "distance" | "oldestOnTop" | "newestOnTop";

/** "opaque" writes depth and ignores alpha (solid debris meshes). */
export type BlendMode = "additive" | "alpha" | "premultiplied" | "opaque";
export type SpriteShape = "softCircle" | "circle" | "glow" | "spark" | "ring" | "square" | "texture";
export type Facing = "camera" | "velocity" | "horizontal";

export interface Flipbook {
  cols: number;
  rows: number;
  /** overLife: plays once over the particle's life; fps: loops at `fps`; random: one random frame. */
  mode: "overLife" | "fps" | "random";
  fps?: number;
}

export interface SpriteRendererDoc {
  type: "sprite";
  blend: BlendMode;
  shape: SpriteShape;
  /** Texture URL or host asset id (shape = "texture"); resolved by the runtime's `loadTexture`. */
  texture?: string;
  flipbook?: Flipbook;
  facing: Facing;
  /** facing = "velocity": extra length per unit of speed. */
  stretch?: number;
  /** Draw order between emitters (higher draws later). */
  /** Soft particles: fade over this many world units where the particle meets scene geometry (needs scene depth; 0 = off). */
  depthFade?: number;
  /** Fade particles closer to the camera than this many world units (fly-through smoke; 0 = off). */
  cameraFade?: number;
  sortOrder?: number;
  /** Particle draw order within this emitter. Default "none". "distance" needs a camera in ParticleWorld.update. */
  sort?: SortMode;
  /** Scale applied to the sprite (shape falloff, glow strength). */
  softness?: number;
}

/** Built-in mesh primitives; any other name refers to a geometry registered on the ParticleWorld. */
export const BUILTIN_MESHES = ["box", "sphere", "icosahedron", "octahedron", "tetrahedron", "cone", "cylinder", "torus", "plane"] as const;

/** Instanced mesh per particle (debris, shards, rocks). Uses the same per-particle data as sprites. */
export interface MeshRendererDoc {
  type: "mesh";
  blend: BlendMode;
  /** A BUILTIN_MESHES primitive or the name of a geometry registered with ParticleWorld.registerGeometry. */
  mesh: string;
  /**
   * random: tumbles around a per-particle axis by the particle's rotation/spin;
   * velocity: +Y points along the direction of travel (rotation spins around it);
   * fixed: world-aligned, rotation spins around +Y.
   */
  orientation: "random" | "velocity" | "fixed";
  /** Lit by scene lights (MeshStandardNodeMaterial) instead of unlit. */
  lit?: boolean;
  roughness?: number;
  metalness?: number;
  /** Colour map sampled with the geometry's UVs. */
  texture?: string;
  sortOrder?: number;
  /** Particle draw order within this emitter. Default "none". "distance" needs a camera in ParticleWorld.update. */
  sort?: SortMode;
}

/** Per-particle trail history (ribbon mode "particle"). */
export interface TrailSettings {
  /** History points kept per particle (trail resolution × length). */
  points: number;
  /** A new point is recorded once the particle has moved this far (world units). */
  minDistance: number;
  /** Points older than this (seconds) are not drawn: the trail's length in time. */
  lifetime: number;
}

/**
 * Ribbons, in two modes:
 *  - emitter (default): one strip through an emitter's particles in spawn
 *    order (Niagara's ribbon renderer): tracers, engine trails, beams. Each
 *    effect instance draws its own strip.
 *  - particle: a trail behind every particle (Unity's Trails module): sparks
 *    with streaks, fireworks, magic missiles.
 * Particle size is the ribbon width.
 */
export interface RibbonRendererDoc {
  type: "ribbon";
  mode?: "emitter" | "particle";
  /** mode "particle": history settings (defaults: 16 points, 0.1 units, 0.5 s). */
  trail?: TrailSettings;
  /** 0..1: width shrinks toward the tail (1 = to a point). */
  taper?: number;
  /** 0..1: alpha fades toward the tail (1 = fully transparent at the end). */
  fade?: number;
  blend: BlendMode;
  /** Cross-section falloff (procedural) or "texture" (u along the ribbon, v across). */
  shape: "softCircle" | "glow" | "square" | "texture";
  texture?: string;
  /** camera: always faces the viewer; horizontal: lies flat (ground scorch, wakes). */
  facing: "camera" | "horizontal";
  /** stretch: u runs 0 (newest) → 1 (oldest); tile: u repeats every `uvTile` world units. */
  uvMode: "stretch" | "tile";
  uvTile?: number;
  /** Soft particles: fade over this many world units where the particle meets scene geometry (needs scene depth; 0 = off). */
  depthFade?: number;
  /** Fade particles closer to the camera than this many world units (fly-through smoke; 0 = off). */
  cameraFade?: number;
  sortOrder?: number;
  /** Particle draw order within this emitter. Default "none". "distance" needs a camera in ParticleWorld.update. */
  sort?: SortMode;
  softness?: number;
}

export type RendererDoc = SpriteRendererDoc | MeshRendererDoc | RibbonRendererDoc;
export type RendererType = RendererDoc["type"];
export const RENDERER_TYPES: RendererType[] = ["sprite", "mesh", "ribbon"];

/** Spawn particles in another emitter when particles of this one are born or die (Unity sub-emitters). */
export interface SubEmitterBinding {
  trigger: "birth" | "death";
  /** Target emitter id in the same effect. */
  emitter: string;
  /** Particles spawned per event. */
  count: number;
  /** 0..1 chance per event. */
  probability?: number;
  /** Fraction of the source particle's velocity added to spawned particles. */
  inheritVelocity?: number;
  /** Multiply spawned particle colour by the source particle's colour. */
  inheritColor?: boolean;
}

/** Per-emitter level of detail (Niagara "detail level" / scalability). */
export interface EmitterLod {
  /** Stop spawning beyond this camera distance (world units): drop detail emitters on far effects. */
  maxDistance?: number;
  /** Skip this emitter while ParticleWorld.quality is below this (0..1). */
  minQuality?: number;
  /**
   * Spawn counts follow the world's quality / budget / distance scale (default
   * true). Turn off for single "hero" particles (flash, shockwave) that must not
   * be randomly thinned out.
   */
  scaleSpawn?: boolean;
}

export interface EmitterDoc {
  id: string;
  name: string;
  enabled?: boolean;
  /** Seconds per cycle. */
  duration: number;
  looping: boolean;
  /** Seconds before the emitter starts (timeline offset). */
  startDelay: number;
  /** Simulate one full cycle on play so a looping emitter starts "full". */
  prewarm?: boolean;
  /** Hard capacity; spawns beyond it are dropped. */
  maxParticles: number;
  /** world: particles stay where they spawned; local: they move with the effect transform. */
  space: "world" | "local";
  /** Only spawn from sub-emitter events (no spawn modules required). */
  eventDriven?: boolean;
  seed?: number;
  spawn: ModuleInstance[];
  init: ModuleInstance[];
  update: ModuleInstance[];
  render: ModuleInstance[];
  renderer: RendererDoc;
  subEmitters?: SubEmitterBinding[];
  lod?: EmitterLod;
}

export interface EffectParameter {
  name: string;
  type: "float";
  default: number;
  min?: number;
  max?: number;
  description?: string;
}

export interface PreviewSettings {
  background?: string;
  showGrid?: boolean;
  /** Move the effect along a path to preview trails and inherit-velocity. */
  motion?: "none" | "circle" | "line";
  motionSpeed?: number;
}

/** Per-effect scalability (Niagara scalability settings). Distances are from the camera, in world units. */
export interface EffectScalability {
  /**
   * Beyond this distance the effect is culled: looping effects pause and are
   * hidden; one-shot effects spawned out there are not created at all.
   */
  cullDistance?: number;
  /** Spawn counts ramp from 1 at this distance down to `farSpawnScale` at `cullDistance`. */
  lodDistance?: number;
  /** Spawn scale reached at `cullDistance` (default 0.25). */
  farSpawnScale?: number;
  /** Looping effects outside the view frustum stop simulating, not just drawing (default false). */
  pauseOffscreen?: boolean;
  /** Live instances allowed at once. */
  maxInstances?: number;
  /** What happens when spawning beyond maxInstances (default "rejectNew"). */
  overflow?: "rejectNew" | "killOldest";
  /** Exempt from the world particle budget (e.g. the player's own engines and weapons). */
  essential?: boolean;
}

export interface EffectDoc {
  format: typeof EFFECT_FORMAT;
  version: typeof EFFECT_VERSION;
  id: string;
  name: string;
  emitters: EmitterDoc[];
  parameters: EffectParameter[];
  scalability?: EffectScalability;
  createdAt?: number;
  updatedAt?: number;
  thumbnail?: string;
  preview?: PreviewSettings;
}

export interface Issue {
  level: "error" | "warning";
  message: string;
  emitterId?: string;
  moduleId?: string;
}
