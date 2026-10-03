# tsl-particles: design

A data-driven particle system for three.js (WebGPU/TSL). It has three consumers:

1. **Redshift** (`gameClient`), through its ECS.
2. **An effect editor**, a GUI particle tool modelled on tsl-graph (Phase 2).
3. **An FX studio** that unifies the particle tool and tsl-graph into a small effects "engine" (Phase 3, separate
   repo).

Phase 1, the runtime library, is implemented in this repo. Phases 2 and 3 are designed below.

---

## 1. What Unity and Unreal do, and what to take from them

| Tool | Top-level structure | Where graphs appear | Notes |
| --- | --- | --- | --- |
| **Unity Shuriken** (Particle System component) | One component = one emitter. A fixed list of ~20 modules (Main, Emission, Shape, Velocity/Force/Color/Size over Lifetime, Noise, Collision, Sub Emitters, Texture Sheet, Trails, Renderer), each toggled and edited in the inspector | None. Materials come from Shader Graph | `MinMaxCurve` (constant / curve / random between two constants / random between two curves) and `MinMaxGradient` are its best idea. Complex effects are prefabs of several systems. CPU only |
| **Unity VFX Graph** | A graph whose spine is **contexts** (Spawn → Initialize → Update → Output), each a vertical **stack of blocks** | Operator nodes feed block inputs; Shader Graph drives outputs | GPU simulation. Exposed properties play the role of parameters. Events and GPU events give sub-emitters |
| **Unreal Niagara** | System → emitters → a **stack** per emitter: Emitter Spawn/Update, Particle Spawn/Update, Event Handlers, Simulation Stages, Render. A timeline shows emitters over time | **Inside modules**: each module is a graph (or HLSL), and the scratch pad holds one-off modules. Materials come from the Material Editor | Parameter namespaces (User / System / Emitter / Particles), CPU or GPU simulation per emitter, data interfaces (meshes, curves), emitter inheritance, scalability tiers |
| **Unreal Cascade** (legacy) | Emitters as columns, each a module list, plus a curve editor | None | Replaced by Niagara mainly because its module set was fixed and closed |

**The common pattern:** every one of them uses a **stack of modules grouped by stage** for particle behaviour. Even VFX
Graph's graph is a stack with nodes hanging off it. Graphs show up in two places: in **materials** (Shader Graph, the
Material Editor) and in **custom module logic** (Niagara's module graphs and scratch pad).

**Recommendation: don't make the particle tool a graph.** Build a stack editor (Niagara/VFX Graph contexts), a
timeline (Niagara), and first-class curve and gradient editors (Shuriken). Use tsl-graph exactly where the engines use
graphs:

- for the **particle material** (it already is a TSL shader graph), and
- later, for **custom modules**: a graph that compiles to an update function, like Niagara's scratch pad.

This also keeps the two tools complementary in Phase 3 rather than two node editors that look alike.

What Phase 1 takes from each:

- **Shuriken:** `FloatValue` / `ColorValue` (constant, range, curve, range-of-curves, gradient, random gradient),
  sub-emitters on birth/death, burst/rate/distance emission, shape module semantics (radius thickness, arc, cone angle).
- **Niagara:** Spawn/Init/Update/Render stages, module instances with ids, user **parameters** bound into values
  (`throttle` → spawn rate), emitter timeline fields (start delay, duration, loop), per-emitter world/local space.
- **VFX Graph:** context-style stages, per-particle attributes as named channels that modules declare, GPU evaluation of
  "over life" modules.

---

## 2. Architecture

The layering mirrors tsl-graph (`core` → `runtime` → `editor` → `server`), so the two can merge cleanly in Phase 3:

```
tsl-particles             (no three, no DOM: runs in Node, in workers and in tests)
├── core/      EffectDoc types, FloatValue/ColorValue, param schema, module registry,
│              doc helpers (create/normalize/validate), command layer (executeCommand)
├── modules/   built-in modules: schema + CPU implementation (or GPU bake)
└── sim/       compiler (doc → template), ParticleBuffer (SoA), EmitterSim, EffectSim

tsl-particles/three       (three/webgpu + three/tsl)
└── three/     ParticleWorld (registry, pooling, update), SpriteBatch (instanced
               draw per emitter), TSL sprite material, LUT textures

Phase 2 adds: tsl-particles/editor (Solid), tsl-particles/server (MCP + bridge + AI chat)
```

Every edit goes through `executeCommand(doc, command)`. That covers the editor UI, MCP tools, the AI chat agent, and
scripts. This is tsl-graph's application abstraction layer applied to effects: one validated, serialisable mutation API,
so humans and agents get the same behaviour and undo granularity. Batches are atomic and support `$ref` names for
objects created earlier in the same batch.

### Data model (`src/core/types.ts`)

```
EffectDoc
├── parameters[]          user-facing knobs (throttle, size) bound into values with { kind: "param" }
└── emitters[]
    ├── duration, looping, startDelay, prewarm, maxParticles, space (world|local), eventDriven, seed
    ├── spawn[]           modules → how many particles this frame
    ├── init[]            modules → run once on each new particle
    ├── update[]          modules → run on every particle every frame
    ├── render[]          modules → baked to GPU lookup tables (size/colour over life)
    ├── renderers[]       sprite | mesh | ribbon, each its own draw call over the same particles (see Renderers)
    └── subEmitters[]     on birth/death → spawn N in another emitter (inherit velocity/colour)
```

### Renderers

| Type | Instance | Options | Use for |
| --- | --- | --- | --- |
| `sprite` | one quad per particle | `shape` (procedural or `texture`), `flipbook`, `facing`: camera / velocity (stretched) / horizontal | fire, smoke, sparks, glows, shockwave rings |
| `mesh` | one mesh per particle: a built-in primitive or a geometry the host registers by name (`world.registerGeometry("rock", geo)`) | `orientation`: random (tumble by rotation/spin around a per-particle axis) / velocity (+Y along travel) / fixed; `lit` (MeshStandardNodeMaterial); `texture` | debris, shards, bolts, coins |
| `ribbon` | one quad per segment. `mode: "emitter"`: one strip per effect instance through its particles, oldest → newest. `mode: "particle"`: a trail behind every particle | `facing`: camera / horizontal; `uvMode`: stretch (0 at the head → 1 at the tail) / tile (every `uvTile` units); `taper`, `fade` toward the tail; `trail: { points, minDistance, lifetime }` for particle mode; `shape` is the cross-section falloff or a texture | tracers, engine trails, beams (emitter mode); sparks with streaks, fireworks, magic missiles (particle mode) |

All three share the over-life LUT (size and colour over life), the blend modes (`additive`, `alpha`, `premultiplied`,
`opaque`), the material hook, and batching: one draw call per renderer however many instances are alive.

**Several renderers per emitter** (as in Niagara): `EmitterDoc.renderers` is a list, so one simulation can be drawn
several ways, e.g. a stretched sprite head *and* a fading trail on the same spark, or a mesh plus a glow sprite.

- Each renderer has an `id` (stable, used by commands, the editor and agents), `enabled`, its own material, `sort`
  mode and `sortOrder`, and becomes its own batch and draw call. The emitter's over-life LUT is shared.
- What the simulator needs from rendering is derived across the list: ordered compaction if any enabled renderer is an
  emitter-mode ribbon; the trail history from the first particle-mode ribbon (one history per emitter; validation
  warns if two particle-mode ribbons disagree); culling margins as the maximum.
- An empty list is valid: the emitter simulates (and can drive sub-emitters) but draws nothing.
- Commands: `addRenderer`, `removeRenderer`, `moveRenderer`, and `setRenderer` with an optional `rendererId` (the
  first renderer when omitted). Batches support `$ref` names for new renderers.
- Files with the older single `renderer` field still load: `normalizeEffect` migrates it to `renderers: [renderer]`.
- Cost: each renderer packs the emitter's particles again (about the cost of one pack per extra renderer). The
  simulation runs once. `drawnParticles` counts each particle once.

How ribbons work:

- A ribbon emitter switches the simulator from swap-remove to **order-preserving compaction** (`EmitterTemplate.ordered`),
  so the buffer stays in spawn order. That costs one copy per survivor on frames where something dies, and only for
  ribbon emitters.
- The CPU writes **both endpoints of every segment** (position, tangent from neighbouring points, texture u, width,
  colour). Adjacent segments therefore compute identical edge vertices and the strip has no seams.
- Segments are only written *within* a strip, so several instances' ribbons share one buffer and one draw call without
  joining up. (Reading neighbouring particles through attribute offsets isn't possible: WebGPU requires attribute
  offset + size ≤ the buffer's stride.)
- Particle size is the ribbon width. Size/colour over life, `taper` and `fade` shape the tail.

### Sorting

`renderer.sort` (sprite, mesh, ribbon): `none` (default), `distance` (back to front along the camera's view direction;
needs `world.update(dt, camera)`), `oldestOnTop`, `newestOnTop`.

- It sorts **the whole batch after packing**, so the order is correct across every live instance of the emitter
  (overlapping smoke from several explosions), not just within each one. Ribbons sort segments by their midpoint.
- Keys are quantised to 16 bits within the batch's range, then sorted by a **stable two-pass radix sort** (`KeySorter`):
  O(n), no comparator, no steady-state allocation. Cost is about 26 ns per particle, mostly the permutation copy:
  0.5 ms for 20k particles, 3 ms for 100k (`scripts/bench-sort.ts`). Turn it on only where blending needs it (alpha or
  premultiplied smoke); additive emitters are order-independent.
- Between batches, `sortOrder` (the mesh's `renderOrder`) decides, unless they share a sort group (below).

**Sort groups: alpha (and additive) across emitters and effects.** Separate draw calls can't interleave by depth, so
two alpha emitters, or fire behind and in front of smoke, would always layer in one fixed order. Sprite renderers with
the same `sortGroup` name, in any emitter of any effect, are merged into **one draw call sorted back to front
together**:

- **One blend state for alpha and additive.** The group draws with premultiplied blending (One, OneMinusSrcAlpha):
  alpha members output (rgb·a, a), additive members (rgb·a, 0). Smoke in front of fire dims it; fire in front of smoke
  adds over it.
- **Per-renderer data in a table texture.** Members differ in over-life curves, shape, facing, softness, stretch,
  additive vs alpha, depth/camera fade and flipbook. Each member has three rows (colour LUT, size LUT, parameters) in
  a half-float table texture, and each particle carries its member index in the spare `pC.w` slot. One "uber" sprite
  shader (`materials/group.ts`) reads the row. Adding or removing members rewrites rows; the shader is rebuilt only
  when the table grows or the group gets its texture.
- **Limits.** Sprites only. Textured members of a group must share one texture (an atlas); a member with a different
  texture, or `blend: "opaque"`, is drawn on its own with a warning. A group always sorts by distance. The uber
  fragment shader evaluates every shape mask, so it costs more per pixel than a dedicated sprite material; group only
  what actually overlaps.
- Measured: the campfire's fire, smoke and embers become one draw call (3 → 1) and the explosion goes from 8 to 5. A
  top-down A/B shows smoke now veiling the fire it rises in front of, where before the fire always drew on top.

### Scalability: budget, LOD, culling

Modelled on Niagara's scalability settings, scoped to what a game needs:

| Where | Setting | Effect |
| --- | --- | --- |
| `EffectDoc.scalability` | `cullDistance` | Beyond it (camera distance): looping effects pause and are hidden; one-shots spawned out there return a `rejected` inert handle |
| | `lodDistance`, `farSpawnScale` | Spawn counts ramp from 1 down to `farSpawnScale` (0.25) between `lodDistance` and `cullDistance` |
| | `maxInstances`, `overflow` | Cap live instances; `rejectNew` (default) refuses the spawn, `killOldest` releases the oldest instance, whose particles vanish at once |
| | `pauseOffscreen` | Looping effects outside the frustum stop simulating; their frozen bounds keep being tested, so they resume when seen |
| | `essential` | Exempt from the world budget (the player's own engines and weapons) |
| `EmitterDoc.lod` | `maxDistance`, `minQuality` | Drop detail emitters (sparks, debris) far away or at low quality while the fireball and smoke stay |
| | `scaleSpawn: false` | Never thin out this emitter: single hero particles (flash, shockwave) would otherwise vanish at random |
| `ParticleWorld` | `budget.maxParticles` | Soft cap on simulated particles (below) |
| | `quality` | 0..1 global spawn multiplier and `minQuality` threshold (device tiers / settings menu) |
| | `frustumCulling` | Instances outside the view aren't drawn (default on; needs a camera in `update`) |

- **Spawn scaling** multiplies spawn and sub-emitter counts. It uses stochastic rounding with the emitter's own RNG,
  so average rates are exact and runs stay deterministic.
- **Bounds** for frustum culling are tracked inside the existing integrate loop (min/max position, largest size,
  largest speed), plus margins for sprite size, size over life, velocity stretch and trail length. Branch-free
  `Math.min`/`Math.max` keeps this to about 1.5 ns per particle; `if` compares cost about 8.
- **The budget is feedforward, not feedback.** A controller that reacts to the live particle count oscillates,
  because the count lags spawn decisions by a whole lifetime (measured: a 3 s limit cycle between 250 and 2,300 on a
  1,000 budget). Instead each emitter tracks its unscaled spawn demand and the average lifetime it spawns. The world
  predicts the steady population (Little's law: rate × lifetime) and solves for the scale that fits the budget, with
  essential effects and non-scalable emitters as fixed load, plus a correction if the live count runs over 1.25×. It
  converges to the exact ratio without oscillating. Known transient: when many effects start at the same instant, the
  demand estimate needs about 0.5 s, so the count can overshoot for a second or two before settling.
- Stats report `particles` (simulated), `drawnParticles`, `culledInstances`, `budgetScale` and `rejectedSpawns`.

Measured in the stress scene (200 explosions/s): unconstrained ~17k particles; budget 10k holds 9.9–10.6k; quality 0.3
gives ~3.4k and drops sparks, debris and puffs (7 → 4 draw calls). With the camera turned away, all 470 instances are
culled, 0 particles are drawn and all of them keep simulating. Facing the field again resumes drawing.

### Soft particles and camera fade

Sprite and ribbon renderers take `depthFade` (soft particles) and `cameraFade`, both in world units, 0 = off:

- **`depthFade`** fades a particle as it gets within that distance of scene geometry, so smoke on the ground or fire
  around rocks has no hard intersection lines. Alpha × `saturate((sceneDistance − particleDistance) / depthFade)`.
- **`cameraFade`** fades particles closer to the camera than that distance, so a camera flying through smoke doesn't
  fill the screen with one huge sprite.

Scene depth comes from three's shared `viewportLinearDepth`. When the first transparent material that needs it draws,
the depth buffer is copied once per render. That happens after the opaque pass, so the copy holds opaque geometry
only; particles never write depth. Particle distance comes from the view-space position the vertex shader already
computes. Nothing is needed from the host.

Verified on WebGPU rendering straight to an antialiased (MSAA) canvas, and through `RenderPipeline` + `pass(scene,
camera)` (Redshift's setup). **Not verified:** three's WebGL2 fallback. Mesh renderers don't support fades; they're
usually opaque.

Per-particle trails (`mode: "particle"`, Unity's Trails module):

- History lives in a `TrailStore` (`src/sim/trails.ts`), not in particle channels. Each trailed particle owns a slot:
  a ring of `points` timestamped positions. The particle stores only its slot id (`trailSlot` channel), so
  swap-remove still copies one float per channel. Slots come from a free list and are returned when the particle dies.
- A point is recorded once the particle has moved `minDistance` (Unity's minimum vertex distance). Points older than
  `lifetime` seconds aren't drawn, so trail length is in time, independent of frame rate. Each trail is drawn from its
  oldest point to the particle's **live** position, so it never detaches.
- A trail disappears with its particle. Fade the particle out with colour over life to end it smoothly.
- Cost: recording is negligible. Packing is memory-bound at about 25 ns per segment (128 bytes each). 18,000 trailed
  particles with ~15 segments each = 6.9 ms, so a few hundred to a couple of thousand trails is comfortable
  (`scripts/bench-trails.ts`).

Files are plain JSON (`*.fx.json`, see `examples/`). `normalizeEffect` parses untrusted input. `validateEffect`
returns issues and never throws. The compiler skips invalid modules and reports them, so a half-edited effect still
plays in the editor.

### Modules: the extension point

A module is a schema plus an implementation:

```ts
registerModule({
  type: "update.orbit",
  stage: "update",
  label: "Orbit",
  category: "Forces",
  description: "Circles particles around the effect's Y axis.",
  params: [{ key: "speed", label: "Speed", type: "floatValue", default: 1 }],
  compile(p) {
    const speed = compileFloat(p.speed as FloatValue);
    return {
      run(ctx, buf, start, end) {
        for (let i = start; i < end; i++) {
          const s = speed.sample(buf.age[i] / buf.life[i], buf.seed[i], ctx.params) * ctx.dt;
          buf.vx[i] += -buf.pz[i] * s;
          buf.vz[i] += buf.px[i] * s;
        }
      },
    };
  },
});
```

One schema drives validation, default filling, the editor's inspector widgets (with `showIf` for conditional fields),
and the descriptions agents get from `describeModuleType`. Modules can declare extra particle channels
(`attributes: ["temperature"]`) and per-instance state (`stateSize`). Render-stage modules implement `bake` instead of
`compile` and never touch particles on the CPU.

Built in (20): `spawn.rate`, `spawn.burst`, `spawn.distance`; `init.lifetime`, `init.shape` (point, sphere,
hemisphere, cone, box, circle, line), `init.velocity`, `init.size`, `init.rotation`, `init.color`,
`init.inheritVelocity`; `update.gravity`, `update.force`, `update.drag`, `update.attractor`, `update.vortex`,
`update.turbulence`, `update.limitVelocity`, `update.collisionPlane`; `render.sizeOverLife`, `render.colorOverLife`.

### Runtime performance

| Decision | Why |
| --- | --- |
| Structure-of-arrays `Float32Array` channels, fixed capacity, swap-remove on death | No allocation or GC in steady state; tight loops V8 optimises well. The course reference allocated several `Vector3`s per particle per frame and re-filtered arrays |
| Compile once per effect; modules are closures with constant fast paths | No per-particle dispatch on value kinds |
| Curves and gradients baked to 64-entry LUTs | A per-particle curve sample is two array reads |
| Size/colour over life evaluated **on the GPU** from a half-float LUT texture | No CPU work and no extra upload for the most common modules |
| 64-byte interleaved instance stream (4 × vec4), one `writeBuffer` with an update range | One small upload per emitter per frame |
| Billboarding, velocity stretch, flipbook and shapes in the TSL vertex/fragment shader | The CPU never builds matrices (the current Redshift renderer composes a matrix per particle) |
| **Batching:** one `InstancedBufferGeometry` per emitter template; every live instance packs into it in world space | Draw calls equal the number of distinct emitters, not instances. 1,900 live explosions = 6 draw calls |
| Materials compiled once per emitter template and shared | WebGPU pipeline creation is the expensive part; spawning never creates one |
| Pooled simulations; handles are never reused | Spawning is allocation-light, and a stale handle is harmless (no-op), not a bug |
| Sub-frame spawn interpolation along the emitter's path | Fast emitters (ships at 200 u/s) leave continuous trails, not clumps |
| Seeded PRNG per emitter | Deterministic previews, scrubbable timelines, reproducible tests |

Measured on this machine:

| Scenario | Particles | CPU (sim) | Draw calls |
| --- | --- | --- | --- |
| Node bench, 1000 looping explosions (6 emitters, smoke has turbulence) | 161k | 6.9 ms/frame, 43 ns/particle | n/a |
| Node bench, 500 thrusters | 29k | 0.4 ms, 13 ns/particle | n/a |
| Browser stress, 200 explosions/s (≈510 alive) | 30k | 3.8 ms sim + pack, 60 fps | 6 |
| Browser campfire | ~140 | 0.2 ms | 3 |

`update.turbulence` is the most expensive built-in (three gradient-noise lookups per particle, ~90 ns). Everything
else is ~15–20 ns per particle.

**Known gaps, in priority order:**

1. **GPU compute backend.** Same `EffectDoc`, with modules supplying a TSL implementation next to the CPU one, for
   100k+ particle emitters (`emitter.sim: "cpu" | "gpu"`, as in Niagara). The CPU path stays the default because it
   supports gameplay callbacks, sub-emitters and determinism cheaply.
2. A **worker simulation** if main-thread time gets tight (SoA buffers are transferable).

### three.js and framework compatibility

- `three >= 0.184` (Redshift is 0.184, tsl-graph is 0.186). Only stable TSL is used: `attribute`, `vertexNode`,
  `select`, `varying`, `texture`, instanced interleaved buffers.
- The core has no dependencies. The editor will use Solid 2 like tsl-graph. Redshift's Solid 1.9 doesn't matter
  because the editor isn't embedded in the game.

---

## 3. Redshift integration (Phase 1)

See [`integrations/redshift/README.md`](../integrations/redshift/README.md). In summary:

- One `ParticleWorld` owned by `Game.ts`, updated right after `entityManager.lateStep`.
- `ParticleEffectComponent` for effects attached to entities (thrusters, shield glows). It follows an entity-space
  offset, reads velocity from `ShipEngineComponent`, and on death lets particles fade instead of popping.
- `particles.spawn("explosion", { position, scale })` for one-shots. This replaces `EffectSpawner`'s entity-per-effect
  meshes and the unused `ParticleEmitterComponent`.
- Effects ship as `content/effects/*.fx.json`, which is the same file the editor saves.

---

## 4. Phase 2: the effect editor

### Shape

Mirror tsl-graph so Phase 3 is a merge, not a rewrite:

| Import | What |
| --- | --- |
| `tsl-particles/editor` | `<EffectEditor host projectId />` (Solid) and `mountEffectEditor(el, props)` for any framework |
| `tsl-particles/server` | `createEffectServer({ store, mcp: "graph" \| "parent", ai })`: MCP endpoint, WebSocket bridge to open editors, AI chat loop |
| `EffectHost` | Same contract as `GraphHost`: `projects.load/save/create`, `openProject`, `exit`, `projectUrl`, `server`, `mcp`, `ai.getApiKey` |

Tech: Solid 2, Tailwind v4, Geist/Geist Mono, lucide icons, and **tsl-graph's UI kit and tokens** (`tsl-graph/ui`,
`.tsl-graph-root` variables), so both tools look like one product from day one.

### Layout

Floating panels over a full-bleed viewport, the same composition as tsl-graph's `GraphEditor`:

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ ◆ Explosion ▾            ▶ ⏸ ⟲  1.0×  ⟳ loop   motion: ○ circle     ⋯  Share │  top bar
├──────────────┬─────────────────────────────────────────────┬──────────────────┤
│ EMITTERS     │                                             │ fireball         │
│ ● flash      │                                             │ ▾ Emitter        │
│ ● fireball ◀ │              live viewport                  │   duration 0.5   │
│ ● sparks ↳   │          (ParticleWorld + grid,             │   loop ☐ space ▾ │
│   puff       │           orbit camera, stats)              │ ▾ Spawn       ＋ │
│ ● smoke      │                                             │   Burst  40 @0s  │
│ ● shockwave  │                                             │ ▾ Initialize  ＋ │
│ ＋ emitter    │                                             │   Lifetime 0.5–0.9│
│──────────────│                                             │   Shape ◯ sphere │
│ PARAMETERS   │                                             │   Color ▇▇▇▇     │
│ scale  1.0 ─ │                                             │ ▾ Update      ＋ │
│              │  163 particles · 6 draws · 0.2 ms           │   Drag 3         │
│              ├─────────────────────────────────────────────┤ ▾ Render      ＋ │
│              │ timeline  0s     0.5    1.0    1.5    2.0   │   Size ╱‾╲ curve │
│              │ flash     ▮                                 │   Color ▇▇▇▇▇▇   │
│              │ fireball  ▮━━━━━━                           │ ▾ Renderer       │
│              │ sparks    ▮━━━━━━━━━━━  ↳ puff              │   sprite · add   │
└──────────────┴─────────────────────────────────────────────┴──────────────────┘
                                                       [AI chat ▴] (as in tsl-graph)
```

- **Emitter list** (left): enable/solo/duplicate/reorder. Sub-emitter children are indented under their parent
  (Niagara-style). Below it are effect parameters with live sliders.
- **Module stack** (right): four collapsible stage sections. Each module is a card with an enable toggle, a drag
  handle, and a header that summarises its values. The module picker is searchable and grouped by `category`, like
  tsl-graph's node picker. Cards render their params from the schema, so custom modules get a UI for free.
- **Timeline** (bottom of viewport): one row per emitter showing start delay, duration and loop, with bursts as ticks
  and sub-emitter links. Drag to edit delay and duration. Because simulations are seeded, **scrubbing** works by
  re-simulating from 0 at a fixed step.
- **Viewport**: play/pause/restart, time scale, **motion preview** (circle or line path, to test trails and inherit
  velocity), background presets, stats, and a module-level "show bounds/shape" gizmo for `init.shape`.

### Value widgets (the crux of the UX)

| Param type | Widget |
| --- | --- |
| `floatValue` | Inline number with a mode menu: Constant · Random between · Curve · Random between curves · Parameter. Curves open the curve editor |
| `colorValue` | Swatch with modes: Color · Random between · Gradient · Random from gradient. HDR intensity slider |
| `curve` | Curve editor popover: add/move keys, interpolation, presets (fade in, fade out, pulse, linear), live preview of the sampled LUT |
| `gradient` | Gradient bar with colour stops above and alpha stops below (Unity style), plus HDR intensity |
| `vec3`, `float`, `int`, `bool`, `enum` | tsl-graph's existing inspector inputs |

### Editor store

Same pattern as tsl-graph's `editor/store.ts`. The doc lives in a signal. Every UI action is a `Command` passed to
`executeCommand`, with undo/redo storing a doc snapshot per command (effects are small, under 50 KB). On change, the
store calls `world.register(doc)` (debounced, about 30 ms). That recompiles in under a millisecond and restarts the
preview with the new definition. Autosave is debounced through `EffectHost.projects.save`.

### MCP tools and AI chat

The same tool table serves the MCP server and the in-editor chat (as in tsl-graph's `server/tools.ts`):

`list_effects`, `create_effect`, `open_effect`, `get_effect`, `list_module_types`, `get_module_type`, `add_emitter`,
`update_emitter`, `remove_emitter`, `duplicate_emitter`, `add_module`, `update_module`, `remove_module`, `move_module`,
`add_renderer`, `set_renderer`, `remove_renderer`, `set_sub_emitters`, `set_parameter`, `apply_operations` (atomic batch with `$refs`),
`validate_effect`, `capture_preview` (screenshot of the live editor at time *t*), `get_stats`.

Every tool is a thin wrapper over a `Command`, which already exists. The system prompt teaches the stage model and the
`FloatValue`/`ColorValue` shapes. `describeModuleType` already produces agent-ready schemas. "Make the explosion
bigger and bluer" becomes one `apply_operations` call.

### Shader integration (the bridge to tsl-graph)

`ParticleWorldOptions.materialHook` already exposes the particle nodes (age, seed, life, velocity, colour, flipbook UV,
shape, time) to custom TSL. Phase 2 finishes the loop:

1. tsl-graph gains a **`particle` graph kind** with input nodes *Particle Age*, *Particle Color*, *Particle Seed*,
   *Particle Velocity*, *Sprite UV*, *Life* and an output node (*Particle Color/Opacity*).
2. The sprite renderer gets `material: { kind: "graph", shaderId }`. The effect editor shows the referenced shader's
   thumbnail with an "Edit in shader graph" button.
3. At runtime the compiled graph body is evaluated through the hook (tsl-graph's `evaluateMaterial` path), with
   particle nodes bound to the sprite attributes.

---

## 5. Phase 3: FX studio (new repo)

A pnpm monorepo that turns the two tools into one small effects engine:

```
fx-studio/
├── packages/
│   ├── studio-kit/      shared: UI kit + theme, AI chat (client + provider loop), bridge,
│   │                    MCP plumbing, host contracts, asset store interface
│   ├── tsl-graph/       shader editor (moved in; core/runtime/editor/server unchanged)
│   └── tsl-particles/   this repo
└── apps/
    └── studio/          the app: project browser, asset library, docked editors, scene preview
```

- **Assets, not projects.** A studio project holds typed assets: shaders (`ProjectDoc`), effects (`EffectDoc`),
  textures and flipbooks, and **VFX prefabs** (an effect plus lights, camera shake, audio cues and a mesh, with a
  shared timeline). Assets reference each other by id. A dependency index means editing a shader hot-reloads every
  effect that uses it.
- **One MCP server** registers `shader_*`, `fx_*`, `asset_*` tools. Both packages already support this through
  `mcp: "parent"` and prefixed registration. One AI chat panel has all tools in scope.
- **Unity/Unreal analogues:** content browser (assets), details panel (inspector), viewport, a lightweight sequencer
  for prefabs, and play-in-scene with a test environment (ground, sky, motion paths, a sample Redshift ship).
- **Export** produces a runtime bundle a game can load: `*.fx.json` plus generated TSL modules for graph materials (via
  tsl-graph's codegen) and a texture atlas. Redshift loads that bundle through `ParticleWorld`.

`studio-kit` is extracted from tsl-graph (AI provider adapters, chat loop, bridge, UI kit), and tsl-graph then depends
on it. That's the only change Phase 3 asks of tsl-graph.

---

## 6. Roadmap

| Phase | Milestone | Scope |
| --- | --- | --- |
| **1** ✅ | Runtime library | Core, 20 modules, CPU sim, batched TSL sprite/mesh/ribbon renderers, Redshift adapter, examples, tests, playground |
| 1.1 | Redshift adoption | Wire `ParticleWorld` into `Game.ts`; thrusters on ships; replace `EffectSpawner`; delete the old particle system |
| 1.2 | Runtime gaps | ✅ mesh + ribbon renderers, per-particle trails, multiple renderers per emitter, sorting + sort groups, soft particles + camera fade, budget/LOD/culling |
| **2** | Effect editor | Stack UI, value widgets, timeline, viewport, store and undo, MCP + AI chat, `particle` graph kind in tsl-graph |
| 2.1 | GPU backend | TSL compute implementations for built-in modules, `sim: "gpu"` per emitter |
| **3** | FX studio | Monorepo, `studio-kit` extraction, asset model, prefabs, unified MCP, export bundle |

### Decisions to confirm

1. **Package name.** `tsl-particles` is chosen to pair with `tsl-graph`.
2. **Stack UI over a graph** for particle behaviour, with tsl-graph for materials and later custom modules (section 1).
3. **CPU-first simulation**, with the GPU backend in 2.1. Redshift's effects are hundreds to tens of thousands of
   particles, where CPU simulation is cheaper overall and supports sub-emitters and gameplay hooks.
4. **Redshift wiring.** The adapter is written and typechecked against Redshift's ECS but not applied there yet.
