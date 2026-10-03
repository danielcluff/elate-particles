// Sorting cost: packs N world-space particles into a batch and times end() with and without distance sorting.
//   pnpm tsx scripts/bench-sort.ts [particles]
import * as THREE from "three/webgpu";
import { EffectSim, compileEffect, createEffect, createEmitter, createModule } from "../src/index";
import { ParticleBatch } from "../src/three";

const n = Number(process.argv[2] ?? 50000);
const view = { px: 0, py: 5, pz: 40, fx: 0, fy: 0, fz: -1 };

function bench(sort: "none" | "distance") {
  const doc = createEffect("bench", { emitter: false });
  const e = createEmitter("e", "empty");
  e.maxParticles = n;
  e.spawn.push(createModule("spawn.burst", { count: n }));
  e.init.push(createModule("init.shape", { shape: "box", boxSize: [40, 10, 40], speed: 0 }), createModule("init.lifetime", { lifetime: 100 }));
  e.renderer = { type: "sprite", blend: "alpha", shape: "softCircle", facing: "camera", sort };
  doc.emitters.push(e);
  const tpl = compileEffect(doc);
  const sim = new EffectSim(tpl).play();
  sim.step(1 / 60);
  const batch = new ParticleBatch(tpl.emitters[0], new THREE.MeshBasicNodeMaterial(), undefined, n);
  const frames = 60;
  let ms = 0;
  for (let f = 0; f < frames + 10; f++) {
    batch.begin();
    batch.pack(sim.emitters[0], null);
    const t = performance.now();
    batch.end(view);
    if (f >= 10) ms += performance.now() - t;
  }
  return ms / frames;
}

const none = bench("none");
const dist = bench("distance");
console.log(`${n} particles: end() ${none.toFixed(3)} ms unsorted, ${dist.toFixed(3)} ms sorted → sort costs ${(dist - none).toFixed(2)} ms (${(((dist - none) * 1e6) / n).toFixed(1)} ns/particle)`);
