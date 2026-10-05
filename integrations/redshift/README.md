# Redshift integration

How elate-particles is wired into `redshift/gameClient`. All of the steps below are applied in Redshift. Later
sections cover features Redshift doesn't use yet.

## 1. Submodule, dependency and build config

The package is a git submodule at `gameClient/vendor/elate-particles`, and `gameClient/package.json` links it
(installed with pnpm, which owns `gameClient/node_modules`):

```json
"elate-particles": "link:./vendor/elate-particles"
```

After cloning Redshift, run `git submodule update --init` before installing. To move Redshift to a newer package
version, check out the commit in the submodule and commit the new pointer in Redshift.

The package ships TypeScript source, which Vite compiles directly. It has no `node_modules` of its own inside
Redshift, so its `three` import resolves upward to `gameClient/node_modules`. Both `gameClient/vite.config.ts` and
`webClient/astro.config.mts` also list `"three"` in `resolve.dedupe` (the game client also dedupes `elate-particles`,
for generated modules in `content/`, which has no `node_modules`). That keeps one three (two copies break
`NodeMaterial`/`instanceof` checks) even if someone installs the package's dev dependencies inside the submodule to
work on it. The game client's Vitest config excludes `vendor/**`, since the package runs its own tests.

## 2. One ParticleWorld per game

`Game.ts` creates the world in `#setupParticles_()`, before the factories that use it. Content comes from
`engine/loading/fx-catalog.ts`, which finds files by location with `import.meta.glob` (nothing is listed in code):

```ts
const catalog = new FxCatalog();
const [docs, particleShaders, shields] = await Promise.all([catalog.loadEffects(), catalog.loadParticleShaders(), catalog.loadShieldStyles()]);
const particles = new ParticleWorld({ renderer: this.Renderer, budget: { maxParticles: 40_000 }, lights: { max: 8 }, shaders: (id) => particleShaders.get(id) });
for (const doc of docs) particles.register(doc); // normalizeEffect(json, { id: <file name> })
```

It updates in `onStep` right after `entityManager.lateStep` (and the rig system), so effects see final entity
transforms, and is disposed in `destroy()`. Registering compiles each effect and builds its GPU materials once;
spawning afterwards is allocation-light.

Effects live in `redshift/content/effects/<slug>.fx.json` (made in redshift-fx, which writes to `content-src/`; the
content build moves them). Particle shaders are `content/effects/shaders/<slug>.ts`.

## 3. Rigs: thrusters, impacts and explosions

Ships and projectiles play rigs (`RigInstance`): `content/ships/<slug>/ship-fx.json` and
`content/weapons/<slug>/weapon-fx.json`. `RigComponent` (`engine/entityManagement/components/rig.ts`) puts one on an
entity's model and updates it in `onLateStep`; `RigSystem` (`engine/render/fx/rig-system.ts`) creates rigs and lets
the events a removed entity was playing finish where it was.

- **Ships:** `ShipRigDriver` feeds the signals (throttle, reverse, strafe, turn, brake, speed, shield, hull) and
  triggers `shield-hit`, `hit` (with where the shot landed, raycast onto the hull), `shield-break`, `shield-restore`
  and `destroyed` from the ship's components. A ship without a rig gets a stock one: the `thruster` exhaust at the
  hitbox's stern and the `hull-hit`, `shield-hit` and `explosion` effects (this replaced `EffectSpawner` and the
  hard-coded thruster).
- **Projectiles:** the weapon's rig rides the projectile (`speed`, `life`) and plays `fire`, `impact` and `expire`.
- **Cues:** shake tracks shake the camera and sound tracks play `content/sounds/<slug>.*` through Howler
  (`engine/render/fx/cues.ts`).

`gameClient/engine/render/fx/README.md` has the details.

## 4. Shields: `DepthShell` and `HitBuffer`

`ShieldVisualComponent` draws each shield as a `DepthShell` (all shields share the context's `DepthShellCapture`) and
keeps a `HitBuffer` of the last hits in the ship's space, fed from `ShieldComponent.lastHit`. Styles
(`content/shields/<slug>/shield-shader.ts`, or built in) take redshift-fx's shield inputs and return
`{ color, opacity }`.

`particle-effect.ts` (an effect that follows an entity) is still registered in the game for one-off uses; rigs cover
ships and projectiles.

## One-shot effects elsewhere

Anything can fire an effect without an entity:

```ts
particles.spawn("explosion", { position, scale });
```

If an effect needs to follow something for its whole life (a projectile's tracer), keep the handle and call
`handle.setTransform(...)` each frame, or use the component.

## Tracers and trails

`examples/tracer.fx.json` is a ribbon tracer plus a velocity-aligned bolt mesh. Spawn one per projectile with
`autoRelease: false`, move it with `setTransform` every frame, and `release()` it on impact. A projectile moving at
200 u/s still gets a continuous ribbon, because spawns are spread along the path travelled each frame. The `thruster`
example's trail is also a ribbon. For debris from a GLB, register its geometry once and refer to it by name from a mesh
renderer:

```ts
particles.registerGeometry("hull-shard", gltf.scene.getObjectByName("Shard").geometry);
```

## Scalability

Redshift sets `budget: { maxParticles: 40_000 }`. A graphics setting can feed `quality` (0..1) the same way.

- Mark the player's own effects `scalability.essential: true` so a busy battle never thins out your own engines or
  guns. Everyone else's effects share the budget.
- `examples/explosion.fx.json` shows the pattern for distant combat: `lodDistance` / `cullDistance` thin and then skip
  far explosions; sparks, debris and puffs have `lod.maxDistance` so far explosions draw only fireball and smoke; the
  flash and shockwave have `lod.scaleSpawn: false` so they never randomly disappear.
- In space, distances are large. Set `cullDistance` from the camera's typical framing, e.g. a bit beyond the radar
  range where an explosion is still a visible dot.
- `pauseOffscreen` suits ambient loops (station vents, nebula sparkle), not gameplay effects whose state should
  advance off-screen.

## Sort groups

The explosion's smoke, fire and flash share the `"fx"` sort group. Give the alpha-blended smoke/dust sprites, and the fire and glows that sit among them, one `sortGroup` (e.g. `"fx"`)
across effects. Smoke from one explosion then layers correctly against fire from another, and with engine haze, in a
single draw call. Keep tracers, sparks and other additive
effects that don't overlap smoke out of the group: they're cheaper on their own.

## GPU emitters

Redshift already passes the renderer, so big ambient effects can run on the GPU with `"sim": "gpu"`: nebula
dust around a station, a debris field, a sun's corona, alpha-blended smoke from a burning capital ship (sorted on the
GPU). Sub-emitters work when both ends are `"sim": "gpu"`, so a large set-piece (a fleet-wide fireworks salute, a
shattering asteroid shedding dust) can stay entirely on the GPU. GPU instances of one effect are batched into one
pool and draw call, so many copies of a GPU effect are fine too: engine glow on every ship of a fleet, running lights
along a station. Set `scalability.maxInstances` on those to size the pool up front. Each instance reserves its full
`maxParticles`, so keep that tight. GPU emitters can have ribbons and join sort groups with CPU effects, so a GPU
smoke column and a CPU explosion in the same group still blend in depth order. GPU instances are frustum-culled
too (bounds measured on the GPU, a few frames late, widened for the delay), so `pauseOffscreen` works for ambient
GPU effects behind the camera.
Play each GPU effect once during loading: three compiles compute pipelines on first use.

## Per-particle lights

Redshift's world has an 8-light pool (`lights: { max: 8 }`). The explosion's fireball and the impact flashes carry
`light` renderers, so hits flash on nearby hulls. Exhaust glowing on the ship or a burning wreck flickering would work
the same way. Size the pool once (changing the light count recompiles lit materials) and keep it
small. If Redshift moves to many lights, three's `DynamicLighting` or `TiledLighting` makes each light cheaper. The
pool lights the most important candidates world-wide each frame, so a big battle degrades gracefully.

## Worker simulation

Big battles can move particle simulation off the main thread: create a `WorkerParticleWorld` (see the design doc) for
explosions, impacts and ambient effects, and keep a main-thread `ParticleWorld` for the player ship's thrusters and
weapons. Worker results are a frame behind, which is invisible for effects that don't follow a fast mover. Register
the same effect files in both if both may spawn them.

## Notes

- **Units.** Effects are authored in world units. Use `scale` on spawn (or the component) to resize an effect per use,
  e.g. explosion size from the destroyed entity's radius. Scale applies to spawn positions, velocities and sizes.
- **Bloom.** Colours are linear and HDR: `intensity > 1` in a colour or gradient drives bloom in the post pipeline.
- **Networking.** Effects are client-side only and seeded per spawn, so they never touch the Zig protocol. Pass
  `seed` to `spawn` if two clients should see an identical effect.
- **Large dt.** `ParticleWorld` clamps frame deltas to `maxDelta` (0.1 s) so a backgrounded tab doesn't produce a burst
  of particles when it returns.
