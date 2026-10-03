// Which emitters can run on the GPU. The simulation itself is batched across
// effect instances in pools (pool.ts).

import type { EffectDoc } from "../../core/types";
import { resolveParams } from "../../core/params";
import type { EmitterTemplate } from "../../sim/compile";
import { getGpuModule } from "./modules";
import { MAX_GPU_TARGETS } from "./pool";
import "./modules";

export { GpuEmitter, GpuPool, GpuPoolSet, GPU_SHRINK_AFTER, MAX_GPU_TARGETS, type GpuDraw } from "./pool";

/** Reasons `tpl` can't be simulated on the GPU (empty = supported). */
export function gpuSupport(tpl: EmitterTemplate, doc: EffectDoc): string[] {
  const why = new Set<string>();
  // sub-emitters work when both ends run on the GPU (ParticleWorld checks partners, see gpuPartners)
  if (new Set([...tpl.birth, ...tpl.death].map((s) => s.target)).size > MAX_GPU_TARGETS) why.add(`more than ${MAX_GPU_TARGETS} sub-emitter targets`);
  if (tpl.eventDriven && !doc.emitters.some((e) => e.subEmitters?.some((s) => s.emitter === tpl.id))) why.add("event-driven without a sub-emitter source");
  for (const r of tpl.renderers) if (r.type === "ribbon" && r.sort && r.sort !== "none") why.add("sorted ribbons");
  for (const m of [...tpl.initLocal, ...tpl.initSim, ...tpl.update]) {
    const impl = getGpuModule(m.def.type);
    if (!impl) {
      why.add(`${m.def.label} has no GPU implementation`);
      continue;
    }
    const reason = impl.unsupported?.(resolveParams(m.def.params, m.instance.params));
    if (reason) why.add(`${m.def.label}: ${reason}`);
  }
  return [...why];
}

/** Indices of the emitters `tpl` exchanges sub-emitter events with (sources and targets). */
export function gpuPartners(tpl: EmitterTemplate, all: EmitterTemplate[]): number[] {
  const out = new Set<number>();
  for (const s of [...tpl.birth, ...tpl.death]) out.add(s.target);
  for (const o of all) if ([...o.birth, ...o.death].some((s) => s.target === tpl.index)) out.add(o.index);
  return [...out];
}
