# Redshift integration

How elate-particles is wired into `redshift/gameClient`. All of the steps below are applied in Redshift. Later
sections cover features Redshift doesn't use yet.

## 1. Dependency and build config

`gameClient/package.json` links this checkout (installed with pnpm, which owns `gameClient/node_modules`):

```json
"elate-particles": "link:../../particle-system"
```

The package ships TypeScript source, which Vite compiles directly. Two config changes make the link work, in both
`gameClient/vite.config.ts` and `webClient/astro.config.mts` (the website embeds the game at `/play` and `/dev/arena`):

- `resolve.dedupe` includes `"three"`. A linked package would otherwise resolve three from its own `node_modules`, and
  two copies of three break `NodeMaterial`/`instanceof` checks.
- `server.fs.allow` includes the package's real path, since it lives outside the Redshift repo.

The link means a Redshift build needs this repo checked out next to `redshift/`. A git or registry dependency would
remove that requirement once the package is published.

Editor-only caveat: TypeScript follows the symlink and reads three's types from this repo's `@types/three`, which is a
different copy from Redshift's. Passing the renderer, camera or `world.object` across the boundary can therefore show
type errors in the editor. Vite's dedupe means there is still only one three at runtime.

## 2. One ParticleWorld per game

`Game.ts` creates the world in `#setupParticles_()`, before the factories that use it:

```ts
const particles = new ParticleWorld({ renderer: this.Renderer, budget: { maxParticles: 40_000 }, lights: { max: 8 } });
this.Scene.add(particles.object);
for (const id of PARTICLE_EFFECTS) particles.register(normalizeEffect(await (await fetch(`/content/effects/${id}.fx.json`)).json()));
```

It updates in `onStep` right after `entityManager.lateStep`, so effects see final entity transforms, and is disposed in
`destroy()`. Registering compiles each effect and builds its GPU materials once; spawning afterwards is
allocation-light.

Effect files live in `redshift/content/effects/`: `explosion`, `shield-hit`, `hull-hit` and `thruster`. They were
derived from this repo's examples for space: no gravity or ground bounce (y = 0 is the ships' plane), no rising
smoke, and LOD/cull distances for a camera ~100 units out. Edit them directly (or in the Phase 2 editor). To add an
effect, drop the file in and add its id to `PARTICLE_EFFECTS`.

## 3. Impacts: `EffectSpawner`

`engine/render/vfx/effect-spawner.ts` keeps its API (`explosion(position, scale)`, `shieldHit(position)`) plus a new
`hullHit(position)`, and spawns fire-and-forget particle effects instead of an entity with a sphere mesh per hit.
`ProjectileComponent` uses `hullHit` for unshielded hull impacts. Each emitter of an effect is one draw call no matter
how many instances are alive, so a busy fight costs the same draw calls as a single hit. The size multipliers at the top
of the file account for the gameplay camera being further out than the playground's.

## 4. Thrusters: `ParticleEffectComponent`

`particle-effect.ts` (copied to `engine/entityManagement/components/`, registered in `register.ts`) attaches an
effect to an entity. It follows the entity in `onLateStep`, can inherit velocity from another component, and has a
`drive(effect, entity)` hook for per-frame parameters. On dispose it stops spawning and lets live particles fade
(`lingerOnDispose`, default true), so a destroyed ship's trail doesn't pop out of existence.

`ShipFactory` gives every ship a thruster at its stern (the hitbox's rearmost point; ships face +Z). Velocity is
inherited from `ShipEngineComponent`. The `drive` hook does two things:
- **Throttle:** `throttle` is 1 while `InputControllerComponent` reports forward thrust, otherwise 0.15 (idle).
- **Docking:** the exhaust stops while the ship model is hidden.

Remote ships have no input component, so they idle.

`ParticleEmitterComponent` and `engine/particles/particle-system.ts` (the old particle system) are still registered
but unused by gameplay; `EffectComponent` is now unused too. They can be deleted when convenient.

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
