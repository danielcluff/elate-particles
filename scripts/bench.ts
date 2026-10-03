// Headless simulator benchmark: steady-state cost per particle for the demo effects.
//   pnpm tsx scripts/bench.ts [explosion|campfire|thruster] [instances]
import { EffectSim, compileEffect, type EffectDoc } from "../src/index";
import { campfire, explosion, thruster, tracer } from "../playground/effects";

const effects: Record<string, EffectDoc> = { explosion, campfire, thruster, tracer };
const name = process.argv[2] ?? "explosion";
const count = Number(process.argv[3] ?? 1000);
const only = process.argv[4]; // optional: disable every update module except this type ("none" = no update modules)

const doc: EffectDoc = structuredClone(effects[name]);
if (only) for (const e of doc.emitters) e.update = e.update.filter((m) => m.type === only);
for (const e of doc.emitters) e.looping = true; // keep one-shots running for a steady state
const tpl = compileEffect(doc);
const sims = Array.from({ length: count }, (_, i) => new EffectSim(tpl, i + 1).setPosition(i % 40, 0, Math.floor(i / 40)).play());

const dt = 1 / 60;
for (let f = 0; f < 240; f++) for (const s of sims) s.step(dt); // warm up / fill
let particles = 0;
const frames = 120;
const t0 = performance.now();
for (let f = 0; f < frames; f++) {
  for (const s of sims) s.step(dt);
}
const ms = (performance.now() - t0) / frames;
for (const s of sims) particles += s.particleCount;
console.log(`${name}${only ? ` [update: ${only}]` : ""}: ${count} instances, ${particles} particles, ${ms.toFixed(2)} ms/frame, ${((ms * 1e6) / particles).toFixed(0)} ns/particle`);
