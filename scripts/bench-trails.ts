// Per-particle trail benchmark: 200 fireworks mid-burst, simulation + ribbon packing.
//   pnpm tsx scripts/bench-trails.ts
import * as THREE from "three/webgpu";
import { EffectSim, compileEffect, type RibbonRendererDoc } from "../src/index";
import { RibbonBatch } from "../src/three";
import { firework } from "../playground/effects";
const tpl = compileEffect(firework);
const sims = Array.from({ length: 200 }, (_, i) => new EffectSim(tpl, i + 1).play());
const batch = new RibbonBatch(tpl.emitters[1], tpl.emitters[1].renderers[0] as RibbonRendererDoc, new THREE.MeshBasicNodeMaterial());
const dt = 1 / 60;
for (let f = 0; f < 85; f++) for (const s of sims) s.step(dt); // shells have burst, stars mid-flight
let step = 0, pack = 0, frames = 20;
for (let f = 0; f < frames; f++) {
  let t = performance.now();
  for (const s of sims) s.step(dt);
  step += performance.now() - t;
  t = performance.now();
  batch.begin();
  for (const s of sims) batch.pack(s.emitters[1], null);
  batch.end();
  pack += performance.now() - t;
}
console.log(`${batch.particles} trailed particles, ${batch.instances} segments: step ${(step / frames).toFixed(2)} ms, pack ${(pack / frames).toFixed(2)} ms, ${(((step + pack) / frames) * 1e6 / batch.particles).toFixed(0)} ns/particle`);
