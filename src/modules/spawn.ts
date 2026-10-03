import { compileFloat } from "../core/values";
import type { ModuleDef } from "../core/registry";
import type { FloatValue } from "../core/types";

export const spawnModules: ModuleDef[] = [
  {
    type: "spawn.rate",
    stage: "spawn",
    label: "Spawn Rate",
    category: "Spawn",
    description: "Continuous emission in particles per second. A curve is sampled over the emitter cycle.",
    params: [{ key: "rate", label: "Rate", type: "floatValue", default: 20, min: 0, unit: "/s" }],
    compile(p) {
      const rate = compileFloat(p.rate as FloatValue);
      return {
        stateSize: 1,
        spawn(ctx, s) {
          s[0] += Math.max(0, rate.sample(ctx.cycleT, 0.5, ctx.params)) * ctx.dt;
          const n = Math.floor(s[0]);
          s[0] -= n;
          return n;
        },
      };
    },
  },
  {
    type: "spawn.burst",
    stage: "spawn",
    label: "Burst",
    category: "Spawn",
    description: "Emits `count` particles at `time` seconds into each cycle, repeated `cycles` times every `interval` seconds.",
    params: [
      { key: "time", label: "Time", type: "float", default: 0, min: 0, unit: "s" },
      { key: "count", label: "Count", type: "floatValue", default: 30, min: 0 },
      { key: "cycles", label: "Cycles", type: "int", default: 1, min: 1 },
      { key: "interval", label: "Interval", type: "float", default: 0.1, min: 0, unit: "s" },
      { key: "probability", label: "Probability", type: "float", default: 1, min: 0, max: 1 },
    ],
    compile(p) {
      const time = p.time as number;
      const count = compileFloat(p.count as FloatValue);
      const cycles = Math.max(1, p.cycles as number);
      const interval = Math.max(0, p.interval as number);
      const probability = p.probability as number;
      return {
        // [cycle index the counter belongs to + 1, bursts fired in that cycle]
        stateSize: 2,
        spawn(ctx, s) {
          if (s[0] !== ctx.cycle + 1) {
            s[0] = ctx.cycle + 1;
            s[1] = 0;
          }
          let n = 0;
          while (s[1] < cycles && ctx.cycleTime >= time + s[1] * interval) {
            s[1]++;
            if (probability >= 1 || ctx.rng.next() < probability)
              n += Math.max(0, Math.round(count.sample(ctx.cycleT, ctx.rng.next(), ctx.params)));
          }
          return n;
        },
      };
    },
  },
  {
    type: "spawn.distance",
    stage: "spawn",
    label: "Spawn Over Distance",
    category: "Spawn",
    description: "Emits particles as the effect moves (trails, exhaust). New particles are spread along the path travelled this frame.",
    params: [{ key: "perUnit", label: "Per Unit", type: "floatValue", default: 2, min: 0, unit: "/unit" }],
    compile(p) {
      const perUnit = compileFloat(p.perUnit as FloatValue);
      return {
        stateSize: 1,
        spawn(ctx, s) {
          s[0] += Math.max(0, perUnit.sample(ctx.cycleT, 0.5, ctx.params)) * ctx.distance;
          const n = Math.floor(s[0]);
          s[0] -= n;
          return n;
        },
      };
    },
  },
];
