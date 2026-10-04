# elate-particles

Data-driven particle effects for three.js (WebGPU / TSL).

- **Effects are JSON documents.** Emitters are stacks of modules in four stages (spawn → init → update → render), in
  the style of Unity VFX Graph and Unreal Niagara.
- **A zero-allocation CPU simulator** stores particles as structure-of-arrays. Curves are baked, and size/colour over
  life is evaluated on the GPU.
- **Sprite, mesh and ribbon renderers**, several per emitter if you like (a spark head *and* its trail): billboards with flipbooks and velocity stretch; tumbling or velocity-aligned
  instanced meshes (built-ins or your own geometry); camera-facing ribbons, either one strip per emitter (tracers, engine trails) or a trail behind every particle (sparks,
  fireworks).
- **Sort groups**: alpha and additive sprites from different emitters and effects share one depth-sorted draw call,
  so smoke in front of fire actually dims it.
- **GPU simulation** (`sim: "gpu"`) for huge emitters: TSL compute, same materials, CPU fallback. 240k particles at
  60 fps for 0.4 ms of CPU. Instances of an effect share one pool, one set of kernels and one draw call per renderer
  (400 instances: 401 → 2 draws, 22.7 → 2.7 ms of CPU). Sub-emitters (GPU → GPU events via atomics and indirect
  dispatch), bitonic depth/age sorting across instances, curves over particle age, ribbons (per-particle trails and
  emitter strips, read from storage in the vertex shader) and sort groups shared with CPU emitters all run on the GPU,
  and GPU instances are frustum-culled from bounds reduced on the GPU and read back asynchronously.
- **Per-particle lights** (`light` renderer): a stable random fraction of an emitter's particles carry point lights
  from a fixed world pool (`ParticleWorld({ lights: { max } })`), CPU and GPU emitters alike; the most important
  candidates are lit each frame.
- **Worker simulation** (`WorkerParticleWorld`): same API, CPU simulation in a Web Worker, packed arrays ping-ponged
  back as transferables. ~7 ms of main-thread time freed in the stress scene.
- **Batched rendering.** Every live instance of an emitter shares one instanced draw call, so 1,900 explosions render
  in 6 draw calls.
- **Scalability**: a world particle budget (feedforward, no oscillation), quality tiers, distance LOD and culling,
  frustum culling, instance caps, essential effects exempt from the budget.
- **One command layer** (`executeCommand`) for every kind of editing: UI, MCP, AI agents and scripts.

Design, research and roadmap: [docs/DESIGN.md](docs/DESIGN.md). Redshift wiring:
[integrations/redshift](integrations/redshift/README.md).

## Use

```ts
import * as THREE from "three/webgpu";
import { ParticleWorld } from "elate-particles/three";
import { normalizeEffect } from "elate-particles";

const world = new ParticleWorld({ budget: { maxParticles: 50_000 }, quality: settings.effectsQuality });
scene.add(world.object);
world.register(normalizeEffect(await (await fetch("/effects/explosion.fx.json")).json()));

// fire and forget (pooled, auto-released when finished)
world.spawn("explosion", { position: hit.point, scale: 1.5 });

// attached + controlled
const engine = world.spawn("thruster", { autoRelease: false, params: { throttle: 0 } });

renderer.setAnimationLoop(() => {
  engine.setTransform(ship.position, ship.quaternion).setParam("throttle", input.forward ? 1 : 0.1);
  world.update(clock.getDelta(), camera); // camera: for emitters with sort: "distance"
  renderer.render(scene, camera);
});
```

Build effects in code with the same commands the editor will use:

```ts
import { createEffect, executeCommand } from "elate-particles";

const fx = createEffect("Sparks", { emitter: false });
executeCommand(fx, {
  op: "batch",
  ops: [
    { op: "addEmitter", name: "sparks", template: "empty", ref: "s" },
    { op: "addModule", emitterId: "$s", type: "spawn.burst", params: { count: 60 } },
    { op: "addModule", emitterId: "$s", type: "init.shape", params: { shape: "sphere", speed: { kind: "range", min: 6, max: 14 } } },
    { op: "addModule", emitterId: "$s", type: "update.gravity" },
    { op: "setRenderer", emitterId: "$s", renderer: { shape: "spark", facing: "velocity" } },
    // same particles, drawn a second way: a fading streak behind each spark
    { op: "addRenderer", emitterId: "$s", renderer: { type: "ribbon", mode: "particle", fade: 1, taper: 1 } },
  ],
});
```

## Entry points

| Import | Runs in | What |
| --- | --- | --- |
| `elate-particles` | anywhere | Types, values, module registry, doc helpers, commands, CPU simulator. No three, no DOM |
| `elate-particles/three` | browser | `ParticleWorld`, `WorkerParticleWorld`, handles, materials, batches, GPU emitters |
| `elate-particles/worker` | worker | `startParticleWorker()` for the worker side of `WorkerParticleWorld` |

`three >= 0.184` is a peer dependency. The package ships TypeScript source.

## Develop

```bash
pnpm install
pnpm dev                                   # playground: campfire, thruster, explosion, tracers, fireworks, gpu, gpu events, gpu crowd, stress (?worker=1: worker mode)
pnpm test
pnpm typecheck
pnpm tsx scripts/bench.ts explosion 1000   # headless simulator benchmark
pnpm tsx scripts/bench-trails.ts           # per-particle trail simulation + packing
pnpm tsx scripts/export-effects.ts         # regenerate examples/*.fx.json
```
