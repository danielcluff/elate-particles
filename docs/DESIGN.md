# elate-particles: design

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
elate-particles             (no three, no DOM: runs in Node, in workers and in tests)
├── core/      EffectDoc types, FloatValue/ColorValue, param schema, module registry,
│              doc helpers (create/normalize/validate), command layer (executeCommand)
├── modules/   built-in modules: schema + CPU implementation (or GPU bake)
└── sim/       compiler (doc → template), ParticleBuffer (SoA), EmitterSim, EffectSim

elate-particles/three       (three/webgpu + three/tsl)
└── three/     ParticleWorld (registry, pooling, update), SpriteBatch (instanced
               draw per emitter), TSL sprite material, LUT textures

Phase 2 adds: elate-particles/editor (Solid), elate-particles/server (MCP + bridge + AI chat)
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

| `light` | no geometry: a point light on a stable random `ratio` of the particles, at most `maxLights` per emitter instance, from the world's light pool | `intensity`, `range`; `useParticleColor` (× colour over life) or `color`; `alphaAffectsIntensity`; `sizeAffectsRange` | fire flicker on the ground, explosion flashes, muzzle flashes, glowing embers and fireworks |

The three drawing renderers share the over-life LUT (size and colour over life), the blend modes (`additive`, `alpha`, `premultiplied`,
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

How lights work (`light` renderers, see `three/lights.ts`):

- **A fixed pool.** `new ParticleWorld({ lights: { max: 16 } })` adds `max` PointLights to `world.object` once.
  Unused ones stay in the scene at intensity 0. In three, adding or removing lights changes the lighting hash and
  recompiles every lit material, and every light costs each lit fragment whether or not it is bright, so the size is
  chosen once and the feature is off by default. An effect with light renderers in a world without a pool warns once
  and lights nothing.
- **Stable picks.** A particle qualifies when its per-particle seed (fixed for its life) is below `ratio`. Qualifying
  seeds spread over `maxLights` buckets, and each bucket's highest-seed particle carries the light. The same particle
  keeps its light while it lives; taking the first N would make lights hop whenever an earlier particle dies. CPU and
  GPU pick the same way (`lightBucket`).
- **The light.** Position = the particle's (world space). Colour = its colour × colour over life (or the fixed
  `color`). Intensity = `intensity` × alpha × alpha over life (unless `alphaAffectsIntensity: false`). Range =
  `range` (× size × size over life with `sizeAffectsRange`).
- **World-wide budget.** Every instance in range offers candidates each frame. Frustum-culled instances are included,
  because a light just off screen still reaches what's on it; distance-culled ones are not. The pool lights the most
  important: intensity ÷ (1 + (camera distance / range)²), so a near light beats a far brighter one. The rest go dark.
  `stats.lights` counts the lit ones.
- **GPU emitters.** The CPU can't see their particles, so each pool runs a small gather for each light renderer:
  1. pass 1 does an `atomicMax` of the seed bits per (lane, bucket);
  2. pass 2 has each bucket's winner write its record (world position, size, velocity, age, colour);
  3. the buffer is read back asynchronously, one read in flight, restarted as soon as it lands.

  The world places each light at its read-back position plus velocity × the reading's age.
- **Checked on real WebGPU** (offscreen renders with the pool lit vs. dark): three explosions lit 7 lights and
  brightened 48,564 pixels (mean brightness 21.9 → 28.9). The GPU volley's gather landed 236 times in 240 frames
  with fresh readings, and its 6 lights brightened 3,292 pixels.
- **Not in worker mode** (the lights would need the worker's particle positions on the main thread).
- **For many lights,** three's `DynamicLighting` (counts change without recompiling) or `TiledLighting` (per-tile
  light lists) cut the per-light shading cost. The pool works the same under either.

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

### GPU simulation (`sim: "gpu"`)

For very large emitters (100k+ particles), or many instances of one effect, an emitter can simulate on the GPU with
TSL compute:

```ts
const world = new ParticleWorld({ renderer }); // the WebGPURenderer, needed to dispatch compute
// in the document: { ..., "sim": "gpu", "maxParticles": 250000 }
```

- **Same data, same materials.** GPU particles use the CPU path's layout (four vec4s, `pA`–`pD`), stored in
  `StorageInstancedBufferAttribute`s on the pool's geometry. Compute kernels write them with `storage()`; the
  regular sprite and mesh materials read them as instanced attributes. Nothing is read back to the CPU.
- **Spawning stays on the CPU.** It produces one number per emitter per frame. `EmitterSim` forwards it to the GPU
  target (`GpuSpawnTarget`) instead of creating CPU particles, so spawn timing, bursts, distance spawning, LOD and the
  budget work unchanged.
- **Batched across instances** (see below): every instance of an effect shares its emitters' pools, kernels and
  draw calls. Each instance owns a *lane* of `maxParticles` slots.
- **Ring-buffer allocation.** Each frame's spawns take the next `n` slots of the lane's ring. If an instance outruns
  its capacity, its oldest particles are recycled. The ring heads live on the GPU, because sub-emitter events
  allocate from them too.
- **Kernels per pool (all instances at once):**
  - clear: kills the slots of lanes flagged by play, acquire or release, and resets their counters;
  - prep (a thread per lane): claims each lane's CPU-driven spawns from its ring head, snapshots the incoming event
    count and writes the indirect dispatch size for the event kernel;
  - init: one thread per spawned particle over all lanes. Each thread finds its lane by binary search over the
    lanes' spawn prefix sums. Threads past the frame's total return, because dispatches round up to whole workgroups;
  - events (sub-emitter targets only): dispatched indirectly, sized on the GPU;
  - update: over the lanes up to the highest one in use. Dead slots return early, and on death size goes to 0 so the
    instance draws nothing;
  - sort (sorted renderers only), see below.
- **Values on the GPU.** Each built-in init/update module has a TSL implementation (`three/gpu/modules.ts`,
  extensible with `registerGpuModule`). Constants and ranges compile to constants. Values that change over the
  emitter's cycle (curves, parameter bindings) get **lane slots**. Each frame the CPU evaluates their bounds per
  instance at its cycle time (`sample(t, r = 0)` and `sample(t, r = 1)`) into the instance's row of the lane
  texture, and the kernel mixes by a per-particle hash. Slots are allocated while kernels build, so a pool compiles
  its kernels with empty dispatches before the first frame's data is written. A browser check gave two instances with
  parameter `s` = 0.25 and 3 exactly those sizes and force scales.
- **Curves over particle age** in update modules (`update.force` scale, drag, turbulence strength, speed limit) are
  baked like the CPU's tables into a small half-float texture, the lower curve in R and the upper in G, sampled by
  age and mixed by a per-particle random. A force curve checked numerically on both backends agrees to 4 significant
  figures (the remaining difference is half-float precision).
- **Same look as the CPU.** Turbulence uses a TSL port of the CPU's Perlin noise with the same permutation table (in
  a storage buffer), so the noise field is identical. Side-by-side checks show the same shapes for cone emission +
  gravity + drag + ground bounce, for vortex, and for turbulence. (An earlier version using MaterialX noise visibly
  differed.) Individual particles differ: the random streams aren't the same.
- **What the CPU knows.** It can't see GPU particles, so it keeps an upper-bound live count from spawn records and the
  largest lifetime evaluated. Spawn records also flow along sub-emitter links: a target counts `count` particles per
  source particle, born up to one source lifetime later for death events. That drives stats, the budget and when an
  effect finishes. Distance culling and LOD apply through the effect's position; frustum culling uses bounds read
  back from the GPU (below).
- **Falls back to the CPU** (one warning listing the reasons) for: no `renderer` option, the WebGL fallback backend,
  modules without a GPU implementation, more than 3 sub-emitter targets, or a sub-emitter partner
  (source or target) that stays on the CPU. Events don't cross between the two simulators, so
  partners move together. `sim: "gpu"` is always safe to set.

#### Batching GPU emitters across instances

The GPU path batches the way the CPU path does: one pool per (effect, GPU emitter) serves every instance.

- **Lanes.** A pool holds `lanes × maxParticles` slots, where slot = lane × `maxParticles` + i. Each instance gets
  one lane in every pool of its effect. The instance's per-frame values live in its row of the pool's **lane
  texture** (RGBA32F, uploaded once per frame): position, previous position, rotation, scale, velocity, time, dt, spawn
  count and prefix, event scale, visibility, clear flag, then module slots. It is a texture rather than a storage
  buffer so kernels stay within 8 storage buffers. Modules read the same names they always did (`ctx.u.position`,
  `ctx.u.dt`...), now resolved per lane.
- **Instances that weren't stepped** (paused, or culled and looping) have dt 0, so the update kernel leaves their
  particles alone.
- **Hiding culled instances.** A distance-culled instance hides by flipping its particles' size negative; materials
  clamp size at 0. That keeps it within the shared draw call and works for sorted copies too.
- **Growing.** A set starts at 4 lanes, or `scalability.maxInstances` when the effect declares it, and doubles when
  full. Live particles and counters are copied across with a compute kernel. Lanes come last in the counter buffer,
  so growing only appends. WGSL declares storage arrays without a length and the lane count is a uniform, so growth
  rebuilds nodes but reuses the compiled pipelines. Replaced geometries are disposed only once the buffers they draw
  are retired (disposing a geometry destroys every buffer it uses).
- **Freeing lanes.** Released instances free their lanes right away; pooled sims hold no GPU memory. Free lanes are
  handed out lowest first, and draws and updates cover only up to the highest lane in use.
- **Shrinking.** A set shrinks once at most a quarter of its lanes have been in use for `GPU_SHRINK_AFTER` (5 s).
  - **Size:** the new size leaves room to double the current use (and never goes below the starting size). Growing
    happens when full and shrinking at a quarter, so the two can't chase each other.
  - **Compaction first:** each live lane at or above the new size moves into a free lane below it, in every pool of
    the set, since sub-emitter groups share lane numbers. The move covers particles, ring counters and trail rings
    (one dispatch per move), plus the lane's CPU row and owner. The instance's `GpuEmitter.lane` changes.
  - **Then the resize:** the growth path runs in reverse, copying only the lanes that remain.
  - **Lost on a move:** sub-emitter events still pending for a moved lane are dropped (the event kernel ignores
    lanes past the end), as are bounds readings in flight.
  - **Checked on real WebGPU:** after 12 of 13 sub-emitter volleys were released, the last one moved from lane 12 to
    lane 0 in both its pools, which went from 16 lanes to 4 (about 135 MB → 34 MB). All its live particles (20
    rockets, 35,290 burst stars) came along.
- **Local space.** A sub-emitter group containing a local-space emitter gets a single-lane set per instance: its
  meshes are placed with the instance's matrix, as before.
- **Sorting covers every instance** of a pool together, so overlapping smoke from two instances interleaves
  correctly. A readback of two instances: 20,024 particles, zero depth inversions, 9,872 switches between instances
  in draw order.

Measured with 10 × 10 and 20 × 20 grids of a 2k-particle GPU torch (additive, turbulence), against the previous
per-instance version:

| Instances | Per instance: update / render submit / frame / draws | Batched: update / render submit / frame / draws |
| --- | --- | --- |
| 100 | 1.72 ms / 0.70 ms / 16.6 ms / 101 | 1.24 ms / 0.62 ms / 16.6 ms / 2 |
| 400 | 22.7 ms / 3.6 ms / 34.7 ms (29 fps) / 401 | 2.7 ms / 0.52 ms / 16.6 ms (60 fps) / 2 |

(Draw counts include the scene's campfire. In the batched runs most of the remaining update time is the 100–400
CPU-side effect simulations deciding spawn counts.)

#### GPU ribbons

Ribbon renderers on GPU emitters build nothing per segment. The ribbon material is the CPU one, with its endpoint
source swapped (`createRibbonMaterial(..., source)`): instead of reading packed instance attributes, it reads the
pool's particle buffers (and trail rings) as read-only storage in the vertex shader. Each pool builds its own ribbon
materials, rebuilt when the pool grows. Invalid segments get zero width at the origin.

- **mode `"particle"` (per-particle trails).** Each slot owns a ring of `points` history points (xyz, time) plus a
  meta vec4 (head, count, live, skip-newest).
  - The update kernel records a point when the particle has moved `minDistance`, and starts a fresh trail when it
    sees a particle born this frame (age 0).
  - It also counts how many points are younger than the trail lifetime, so the vertex shader doesn't walk the ring.
  - Drawing is one instance per (slot, history point): the live points oldest first, then the particle itself, with
    central-difference tangents.
  - Strip coordinate, taper, fade and `uvMode: "tile"` (a bounded loop over the trail) match the CPU.
  - The playground's GPU volley rockets use this.
- **mode `"emitter"`.** On the GPU a lane's spawn order *is* ring order, so the strip runs slot i → i + 1, up to the
  newest slot (one before the lane's ring head, read from the counter buffer).
  - Differences from the CPU: the strip coordinate (taper, fade, `stretch` u) is the particle's age rather than its
    position along the strip, which is the same for equal lifetimes. `tile` tiles by age in seconds, because there
    is no running distance along the strip. A dead particle in the middle breaks the strip rather than being
    bridged.
  - A browser check against the same effect on the CPU, moving in a circle, gave the same arc.
- **Sorted ribbons** (`sort: "distance"`, `"oldestOnTop"`, `"newestOnTop"`) sort segments, not particles.
  1. A key kernel runs the same endpoint code the vertex shader does, for both ends of every segment. The sources
     take the segment index as a parameter, so the same code serves both. The key is the negative view depth of the
     midpoint (like the CPU's sort on the segment's two endpoints), or the segment's age for the age modes. Invalid
     segments get a key that sorts last.
  2. `GpuKeySort`, the bitonic sort factored out of `GpuSorter`, orders the segment indices.
  3. The sorted material reads its segment as `order[instanceIndex]`. Live segments sort first and never outnumber
     the drawn instances, so nothing else changes.
  - **Cost:** a pool sorts `capacity × points` keys for trails (`capacity` for strips), rounded up to a power of
    two. A 512-particle, 20-point trail emitter at 4 lanes sorts 65,536 keys in 136 passes, all in one compute call.
  - **Checked on real WebGPU:** two sorted comet strips gave 284 live segments, keys in order, each key equal to the
    segment's midpoint depth recomputed on the CPU, and the two instances interleaved by depth (163 switches). A
    sorted trail volley came back in order too.
  - **Buffer limit:** the key kernel evaluates both ends, so each source creates its storage nodes once, outside the
    per-end function. Otherwise the second end binds every buffer again, 9 storage buffers in all.
- **Device requirements:** storage reads in the vertex stage need `maxStorageBuffersInVertexStage` ≥ 6, or 7 for
  sorted ribbons. Core WebGPU has 8; compatibility-mode devices may have 0.
- **A TSL pitfall found here:** `select(cond, a, b)` over `toVar()` nodes compiles to an if/else, and the vars'
  first assignments land inside the branches, so one branch reads them unset. Build such values arithmetically (the
  endpoint index is `i + select(end, 1, 0)`, not `select(end, i + 1, i)`).

#### GPU sort groups

A GPU emitter's sprite renderer can join a `sortGroup` with CPU members and other GPU emitters. Once a GPU member
joins, the group sorts and draws on the GPU (`GpuSortGroup`):

1. **CPU members** still pack into the group's batch, now unsorted and not drawn (hidden meshes aren't uploaded).
   Its packed array is uploaded as a storage buffer (only the used range).
2. **Gather.** One small kernel per source copies its particles into a combined buffer: CPU members first, then
   each GPU pool's used lanes. The member index goes into `pC.w`, and local-space pools are moved to world space via
   their lane rows. Segment offsets and counts are uniforms, so joining and leaving don't rebuild anything; only
   growing the combined buffer does (doubling). A fill kernel marks the stale tail dead.
3. **Sort and draw.** The combined buffer is depth-sorted (`GpuSorter`) and drawn with the group's uber material.
   That is one draw call, with CPU and GPU particles interleaved by depth.

When the last GPU member leaves, the group goes back to sorting on the CPU. A browser readback of the playground's
GPU scene (CPU campfire fire/smoke/embers plus GPU smoke in group `fx`) showed 25,047 particles from four members in
one draw, with zero depth inversions and 283 switches between members along the draw order.

#### GPU frustum culling

The CPU can't see GPU particles, so each pool measures them:

1. **Measure.** While the world frustum-culls, a pool with no read in flight measures at most every
   `GPU_BOUNDS_INTERVAL` (1/15 s, about every 4th frame; readings are used late and widened for their age anyway). It resets 8 counters per lane, then runs a
   2D dispatch: one 64-thread workgroup per chunk of a lane (`y` = lane), so a workgroup never spans two instances.
   Each workgroup reduces its particles' world AABB, max speed² and max size in workgroup memory (6 halving steps
   with barriers, no early returns, so control flow stays uniform). It then does one `atomicMin`/`atomicMax` per
   value, on floats mapped to order-preserving u32. Local-space pools are moved to world space with their lane rows.
2. **Read back.** The counters are copied into a reused `ReadbackBuffer`, with one read in flight per pool. When it
   lands a few frames later, each lane's result goes to the instance that owned the lane when measured. If the lane
   changed hands in between, the result is dropped.
3. **Cull.** The world tests a conservative box per lane:
   - the measured box, widened by max size × the template's size margin, and by max speed × (trail/stretch reach +
     the reading's age + a frame);
   - joined with itself shifted by the instance's movement since the measurement, which covers particles that
     follow or spawn around it.

   An unmeasured lane counts as visible. An empty reading is a point at the instance.
4. **Act.** A culled instance counts in `culledInstances`. From the next frame its lane hides on the GPU (the same
   negative-size flag as distance culling). A pool whose used lanes are all hidden skips its draw. Looping effects
   with `pauseOffscreen` stop stepping (their lane gets dt 0).
5. **Skip their vertex work.** With hidden lanes inside the used span, a pool mesh draws only the runs of shown
   lanes: one indirect record per run, `firstInstance` = first lane × instances per lane (slots, or slots × history
   points for trails). Lanes are contiguous instance ranges, and `instance_index` and instanced attributes both
   include `firstInstance`, so shaders don't change.
   - The runs are computed on the CPU from the lane rows, and records are rewritten only when they change.
   - At most `MAX_RANGE_DRAWS` (8) draws per mesh: more runs merge across the smallest hidden gaps.
   - Needs the `indirect-first-instance` feature, which three requests when the adapter has it. Without it, or with
     nothing hidden, or for sorted draws (depth order, not lane order), the mesh draws whole as before.
   - Distance-culled instances benefit the same way.
   - Checked on real WebGPU: a row of 24 torches alternating shown and culled drew as 8 merged ranges, and a 400 ×
     300 render matched the whole draw pixel for pixel.

GPU time, measured with timestamp queries: 256 GPU torches × 2,048 particles, rendered at 1920 × 1080, 186 of them
behind the camera.

| Mode | Instances drawn | Render | Compute |
| --- | --- | --- | --- |
| No culling | 524,288 | 4.2–4.65 ms | 0.50–0.59 ms |
| Culled, hidden but drawn whole (before range draws) | 524,288 | 4.22 ms | 0.85–0.89 ms |
| Culled, drawn in ranges, measuring every frame | 143,360 | 1.35 ms | 0.82–0.85 ms |
| Culled, drawn in ranges, measuring at 15 Hz | 143,360 | 1.50–1.53 ms | 0.64–0.68 ms |

Notes:
- Hiding alone saves nothing: the vertex shader still runs for every hidden instance. The saving comes from the
  range draws.
- Measuring every frame cost about 0.35 ms of compute. At 15 Hz it costs about 0.1 ms.
- The net saving here is about 2.9 ms of GPU time per frame. The culled instances were still simulated; with
  `pauseOffscreen` their update work would go too.

Checked in the browser:
- A torch's cull box contained its real particle extent with about 0.15 units of margin per side.
- Looking along the edge of a 20 × 20 torch grid culled 369 of 401 instances. Not one culled torch had a particle in
  view, and no off-screen torch was kept.
- Turning back un-culled within 5 frames.
- CPU cost: about 0.14 ms per frame for 400 instances (1.95 vs 1.81 ms with no camera).

#### GPU sub-emitters

Birth and death events stay on the GPU, with no readback:

1. **A source particle appends an event** to its target when it is born (init and event kernels) or dies (update
   kernel). `atomicAdd` on the target pool's event counter gives the event its index. A second `atomicAdd` on the
   ring head of the same lane in the target **reserves the event's slots right away**, so spawning needs no further
   allocation. Pools of a sub-emitter group share lane numbers. The event stores the lane, slot base, world position,
   count, inherited velocity and colour.
2. **Count and probability are decided per event:** count × the target's LOD/budget scale, stochastically rounded,
   0 when LOD switched the target off.
3. **The target's prep kernel** snapshots the event count, resets it, and writes the event kernel's
   `dispatchWorkgroupsIndirect` arguments (`events × maxCountPerEvent / 64`).
4. **The event kernel** runs one thread per (event, particle) pair. Threads past an event's count return. It runs
   the target's init modules, places the particle at the event like the CPU path does, and can emit birth events of
   its own, so chains work (rockets → bursts → embers in the playground's *GPU events* scene).

Events emitted by a source that dispatches after its target are spawned the next frame, as on the CPU.

- **One buffer per target.** Counters, slot bases and the event payload (floats stored as bits) share one atomic u32
  buffer per pool. A source's kernels therefore bind 4 particle buffers, its own counters and one buffer per
  target, within WebGPU's default limit of 8 storage buffers per shader stage. That is where the 3-target limit
  comes from.
- **Capacity.** A target pool holds up to `min(65536, max(1024, maxParticles))` events per frame across all its
  instances; extra events are dropped.

Measured: the volley scene (3 GPU emitters, 1,500-particle bursts, ~1 in 7 stars leaving an ember) runs at 60 fps
with 0.55 ms of CPU per frame.

#### GPU sorting

A sprite or mesh renderer with `sort` on a GPU emitter sorts on the GPU:

1. A key kernel writes one key per slot: negative view depth, or age in seconds for the age modes. Dead slots and
   the power-of-two padding get huge keys, so they sort to the end.
2. A bitonic sort orders (key, slot) pairs. Each of the `log2(n)·(log2(n)+1)/2` passes is its own compute node with
   constant `(k, j)` uniforms. They share one shader and pipeline and are encoded in a **single
   `renderer.compute([...])` call**: one compute pass, one submit per frame.
3. A gather kernel copies the particles into a sorted copy of the four buffers. It is split in two halves to stay
   within 8 storage buffers.

Only the sorted renderers' meshes read the sorted copy; the emitter's other renderers keep the unsorted buffers. A
readback of a 32k-capacity smoke emitter (120 passes) showed every live particle in far-to-near order and every dead
slot after them, at 60 fps and 0.9 ms of CPU per frame for the scene. Distance sorting needs the camera passed to
`update`; without it the last order stands.
- **First use stalls.** three compiles compute pipelines synchronously on first dispatch. Expect a hitch the first
  time a GPU effect plays (longer with sorting: about 120 small kernels for 32k particles); later instances share the
  pool's kernels. Play a GPU effect once behind a loading screen to warm them up.
- **Memory.** Every instance reserves a full lane of `maxParticles` slots (64 bytes each). A pool shrinks back a few
  seconds after a peak, but not below its starting size (`scalability.maxInstances` when set).

Measured (this machine, browser): a 250k-capacity swarm (60k/s, vortex + turbulence + drag) runs at 60 fps with
**0.4 ms** of CPU time per frame and ~240k live particles. The same effect on the CPU took 22–62 ms per frame
(1–15 fps) while still ramping up.

### Worker simulation (`WorkerParticleWorld`)

The same API as `ParticleWorld`, with the CPU simulation in a Web Worker:

```ts
// particles.worker.ts
import { startParticleWorker } from "elate-particles/worker";
import "./my-custom-modules"; // custom modules must be registered in the worker too
startParticleWorker();

// main thread
const world = new WorkerParticleWorld(new Worker(new URL("./particles.worker.ts", import.meta.url), { type: "module" }));
scene.add(world.object);
world.register(doc);
const fx = world.spawn("explosion", { position });
world.update(dt, camera); // each frame
```

- **A mirrored world.** The worker runs a complete `ParticleWorld`: LOD, budget, culling, sort groups, ribbons,
  trails, sorting, everything. Its three.js objects are never rendered, and textures are placeholders. The main thread
  keeps a render-only `ParticleWorld` (materials, meshes, GPU buffers) built from the *same registrations in the same
  order*, so both produce identical batch lists (`_batchList()`, including sort-group member indices). No simulation
  code is duplicated or forked.
- **Each frame:**
  1. The main thread sends `dt`, the camera matrices and queued handle commands. Transforms are coalesced to the last
     one per frame, and a pending transform is sent before later commands on the same handle.
  2. The worker steps, culls, sorts and packs.
  3. The worker transfers each non-empty batch array.
  4. The main thread adopts them (`InstanceBatch.adopt`: no copy) and schedules the GPU upload.
- **Ping-pong transfers.** The array a main batch replaced goes back to the worker with the next frame
  (`adoptSpare`), so steady state neither copies nor allocates. Plain transferables, so no `SharedArrayBuffer` and no
  cross-origin-isolation headers are needed.
- **At most one frame in flight.** If the worker falls behind, `dt` accumulates instead of queueing frames, so latency
  can't grow. A registration made while a frame is in flight bumps a layout counter; that one stale result's arrays
  are skipped, but its events still apply.
- **Handles** (`WorkerParticleEffect`) have the `ParticleEffect` surface. `alive`, `particleCount`, `culled`,
  `rejected` and `onFinished` come back with each result.
- **Trade-off: one frame of latency.** Particles render the worker's previous frame, so effects attached to
  fast-moving objects trail by a frame (a ship at 200 u/s moves ~3 units per frame). Both worlds can run side by side:
  main thread for the player's own effects, worker for the rest.
- **Not in worker mode:** GPU emitters (they need the renderer on the main thread; they fall back to CPU-in-worker
  with a warning), and per-particle lights. Mesh geometries are registered on the main thread only; the worker doesn't need them.
- Tests drive the host and client over an in-process channel that really transfers (detaches) buffers via
  `structuredClone(..., { transfer })`, so a reuse-after-transfer bug would throw.

Measured in the browser (stress scene, 200 explosions/s, ~33k particles, 800 instances): main-thread particle cost
went from **7.3 ms** (sim + pack) to **0.01 ms** for `update()`, plus result handling below the ~0.1 ms timer
resolution. That scene is GPU-bound, so frame rate is similar (52 vs 54 fps); the win is ~7 ms of main-thread time per
frame back for game logic.

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

**Known gaps:** none from the original list. All six runtime gaps (renderers, sorting, soft particles, budget/LOD,
multiple renderers, GPU and worker simulation) are closed, and GPU emitters now cover sub-emitters, sorting,
curves over age, batching across instances, ribbons (sorted too), sort groups, frustum culling and pools that shrink
after a peak.
Every renderer feature now runs on the GPU too, and culled GPU instances cost neither simulation (with
`pauseOffscreen`) nor vertex work. Particles can light the scene (`light` renderers). Candidates next: the effect
editor (Phase 2).

### three.js and framework compatibility

- `three >= 0.184` (Redshift is 0.184, tsl-graph is 0.186). Only stable TSL is used: `attribute`, `vertexNode`,
  `select`, `varying`, `texture`, instanced interleaved buffers.
- The core has no dependencies. The editor will use Solid 2 like tsl-graph. Redshift's Solid 1.9 doesn't matter
  because the editor isn't embedded in the game.

---

## 3. Redshift integration (Phase 1)

Applied in Redshift (gameClient links this repo). See [`integrations/redshift/README.md`](../integrations/redshift/README.md). In summary:

- One `ParticleWorld` owned by `Game.ts`, updated right after `entityManager.lateStep`.
- `ParticleEffectComponent` for effects attached to entities (thrusters, shield glows). It follows an entity-space
  offset, reads velocity from `ShipEngineComponent`, and on death lets particles fade instead of popping.
- `particles.spawn("explosion", { position, scale })` for one-shots. `EffectSpawner` now spawns `explosion`,
  `shield-hit` and `hull-hit` this way instead of an entity with a sphere mesh per hit; every ship gets a `thruster`.
- Effects ship as `content/effects/*.fx.json`, which is the same file the editor saves.

---

## 4. Phase 2: the effect editor

### Shape

Mirror tsl-graph so Phase 3 is a merge, not a rewrite:

| Import | What |
| --- | --- |
| `elate-particles/editor` | `<EffectEditor host projectId />` (Solid) and `mountEffectEditor(el, props)` for any framework |
| `elate-particles/server` | `createEffectServer({ store, mcp: "graph" \| "parent", ai })`: MCP endpoint, WebSocket bridge to open editors, AI chat loop |
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
│   └── elate-particles/   this repo
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
| 1.2 ✅ | Runtime gaps | mesh + ribbon renderers, per-particle trails, multiple renderers per emitter, sorting + sort groups, soft particles + camera fade, budget/LOD/culling, worker simulation |
| **2** | Effect editor | Stack UI, value widgets, timeline, viewport, store and undo, MCP + AI chat, `particle` graph kind in tsl-graph |
| 2.1 ✅ | GPU backend | TSL compute implementations for built-in modules, `sim: "gpu"` per emitter, CPU fallback |
| **3** | FX studio | Monorepo, `studio-kit` extraction, asset model, prefabs, unified MCP, export bundle |

### Decisions to confirm

1. **Package name.** `elate-particles` (renamed from `tsl-particles`, chosen to pair with `tsl-graph`). Effect files use `"format": "elate-particles"` (`EFFECT_FORMAT`); files with the old `"tsl-particles"` still load.
2. **Stack UI over a graph** for particle behaviour, with tsl-graph for materials and later custom modules (section 1).
3. **CPU-first simulation**, with `sim: "gpu"` per emitter for huge effects (done). Redshift's effects are hundreds to tens of thousands of
   particles, where CPU simulation is cheaper overall and supports sub-emitters and gameplay hooks.
4. **Redshift wiring.** The adapter is written and typechecked against Redshift's ECS but not applied there yet.
