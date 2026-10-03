# tsl-particles

Data-driven particle effects for three.js (WebGPU / TSL).

- **Effects are JSON documents.** Emitters are stacks of modules in four stages (spawn → init → update → render), in
  the style of Unity VFX Graph and Unreal Niagara.
- **A zero-allocation CPU simulator** stores particles as structure-of-arrays. Curves are baked, and size/colour over
  life is evaluated on the GPU.
- **Batched rendering.** Every live instance of an emitter shares one instanced draw call, so 1,900 explosions render
  in 6 draw calls.
- **One command layer** (`executeCommand`) for every kind of editing: UI, MCP, AI agents and scripts.

Design, research and roadmap: [docs/DESIGN.md](docs/DESIGN.md). Redshift wiring:
[integrations/redshift](integrations/redshift/README.md).

## Use

```ts
import * as THREE from "three/webgpu";
import { ParticleWorld } from "tsl-particles/three";
import { normalizeEffect } from "tsl-particles";

const world = new ParticleWorld();
scene.add(world.object);
world.register(normalizeEffect(await (await fetch("/effects/explosion.fx.json")).json()));

// fire and forget (pooled, auto-released when finished)
world.spawn("explosion", { position: hit.point, scale: 1.5 });

// attached + controlled
const engine = world.spawn("thruster", { autoRelease: false, params: { throttle: 0 } });

renderer.setAnimationLoop(() => {
  engine.setTransform(ship.position, ship.quaternion).setParam("throttle", input.forward ? 1 : 0.1);
  world.update(clock.getDelta());
  renderer.render(scene, camera);
});
```

Build effects in code with the same commands the editor will use:

```ts
import { createEffect, executeCommand } from "tsl-particles";

const fx = createEffect("Sparks", { emitter: false });
executeCommand(fx, {
  op: "batch",
  ops: [
    { op: "addEmitter", name: "sparks", template: "empty", ref: "s" },
    { op: "addModule", emitterId: "$s", type: "spawn.burst", params: { count: 60 } },
    { op: "addModule", emitterId: "$s", type: "init.shape", params: { shape: "sphere", speed: { kind: "range", min: 6, max: 14 } } },
    { op: "addModule", emitterId: "$s", type: "update.gravity" },
    { op: "setRenderer", emitterId: "$s", renderer: { shape: "spark", facing: "velocity" } },
  ],
});
```

## Entry points

| Import | Runs in | What |
| --- | --- | --- |
| `tsl-particles` | anywhere | Types, values, module registry, doc helpers, commands, CPU simulator. No three, no DOM |
| `tsl-particles/three` | browser | `ParticleWorld`, `ParticleEffect`, TSL sprite material, batches |

`three >= 0.184` is a peer dependency. The package ships TypeScript source.

## Develop

```bash
pnpm install
pnpm dev                                   # playground: campfire, thruster, explosion, stress test
pnpm test
pnpm typecheck
pnpm tsx scripts/bench.ts explosion 1000   # headless simulator benchmark
pnpm tsx scripts/export-effects.ts         # regenerate examples/*.fx.json
```
