# Redshift integration

Wiring tsl-particles into `redshift/gameClient`. Nothing here has been applied to Redshift yet. Each step is small and
reversible.

## 1. Depend on the package

`gameClient/package.json`:

```json
"dependencies": {
    "tsl-particles": "link:../../particle-system"
}
```

The package ships TypeScript source, which Vite compiles directly. Redshift's three version (0.184) matches the
package's minimum.

`gameClient/vite.config.ts`: make sure there is exactly **one** copy of three. A linked package would otherwise resolve
`three` from its own `node_modules`, and two copies of three break `NodeMaterial`/`instanceof` checks:

```ts
resolve: {
    dedupe: ["three"],
    alias: [ /* existing aliases */ ],
},
```

## 2. One ParticleWorld per game

`Game.ts`:

```ts
import { ParticleWorld } from "tsl-particles/three";
import { normalizeEffect } from "tsl-particles";

#particles_ = new ParticleWorld();

// setup (after the scene exists)
this.Scene.add(this.#particles_.object);
for (const id of ["explosion", "thruster", "shield-hit"]) {
    const json = await fetch(`/content/effects/${id}.fx.json`).then((r) => r.json());
    this.#particles_.register(normalizeEffect(json));
}

// onStep: after entityManager.lateStep, so effects see final entity transforms
this.#entityManager_.lateStep(timeElapsed, totalTime);
this.#particles_.update(timeElapsed, this.Camera); // camera enables sort: "distance" (smoke)

// teardown
this.#particles_.dispose();
```

Effect files live in `content/effects/*.fx.json`; `examples/` in this repo has three to start from. Registering
compiles the effect and builds its GPU materials once. Spawning after that is allocation-light: simulations are pooled
and the GPU buffers are shared.

## 3. Attached effects: `ParticleEffectComponent`

Copy `particle-effect.ts` to `gameClient/engine/entityManagement/components/particle-effect.ts` and register it in
`register.ts`:

```ts
import { ParticleEffectComponent } from "./components/particle-effect.ts";
Entity.registerComponent("ParticleEffectComponent", ParticleEffectComponent);
```

Example: an engine trail on a ship (ship forward is +Z; the thruster effect exhausts along -Z):

```ts
entity.addComponent("ParticleEffectComponent", {
    world: particles,
    effect: "thruster",
    offset: new THREE.Vector3(0, 0, -1.4), // nozzle, entity space
    velocityFrom: "ShipEngineComponent", // inherit-velocity uses the engine's real velocity
    params: { throttle: 0 },
});

// e.g. in an input or engine component:
(entity.getComponent("ParticleEffectComponent") as ParticleEffectComponent).setParam("throttle", actions.forward ? 1 : 0.1);
```

When the entity dies, the component stops spawning and lets live particles fade (`lingerOnDispose`, default true), so
a destroyed ship's trail doesn't pop out of existence.

The component runs in `onLateStep`. Entity components have finished moving by then, and `ParticleWorld.update` runs
right after.

`ParticleEmitterComponent` and `engine/particles/particle-system.ts` can be deleted once nothing uses them. Today only
`register.ts` references them.

## 4. One-shot effects: no entity needed

Explosions and impacts don't need an entity. Fire and forget:

```ts
particles.spawn("explosion", { position, scale });
```

`EffectSpawner.explosion` / `shieldHit` can become one-liners like this, which removes the per-effect entity +
`StaticObjectComponent` + `EffectComponent` and a mesh/material allocation per hit. Each emitter of an effect is one
draw call no matter how many instances are alive, so 50 simultaneous impacts cost the same draw calls as one.

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

## Notes

- **Units.** Effects are authored in world units. Use `scale` on spawn (or the component) to resize an effect per use,
  e.g. explosion size from the destroyed entity's radius. Scale applies to spawn positions, velocities and sizes.
- **Bloom.** Colours are linear and HDR: `intensity > 1` in a colour or gradient drives bloom in the post pipeline.
- **Networking.** Effects are client-side only and seeded per spawn, so they never touch the Zig protocol. Pass
  `seed` to `spawn` if two clients should see an identical effect.
- **Large dt.** `ParticleWorld` clamps frame deltas to `maxDelta` (0.1 s) so a backgrounded tab doesn't produce a burst
  of particles when it returns.
