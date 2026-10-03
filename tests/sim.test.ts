import { describe, expect, it } from "vitest";
import { EffectSim, compileEffect, createEffect, createEmitter, createModule, type EffectDoc, type EmitterDoc } from "../src/index";

function effectWith(...emitters: EmitterDoc[]): EffectDoc {
  const doc = createEffect("test", { emitter: false });
  doc.emitters.push(...emitters);
  return doc;
}

function emitter(opts: Partial<EmitterDoc> & { modules?: [string, Record<string, unknown>?][] } = {}): EmitterDoc {
  const e = createEmitter("e", "empty");
  for (const [type, params] of opts.modules ?? []) {
    const m = createModule(type, params);
    const stage = type.split(".")[0] as "spawn" | "init" | "update" | "render";
    e[stage].push(m);
  }
  const { modules: _m, ...rest } = opts;
  return Object.assign(e, rest);
}

function run(sim: EffectSim, seconds: number, dt = 1 / 60) {
  for (let t = 0; t < seconds - 1e-9; t += dt) sim.step(dt);
}

describe("spawning", () => {
  it("spawns at the configured rate", () => {
    const doc = effectWith(emitter({ duration: 10, modules: [["spawn.rate", { rate: 60 }], ["init.lifetime", { lifetime: 100 }]] }));
    const sim = new EffectSim(compileEffect(doc)).play();
    run(sim, 1);
    expect(sim.particleCount).toBeGreaterThanOrEqual(59);
    expect(sim.particleCount).toBeLessThanOrEqual(61);
  });

  it("fires bursts once per cycle and repeats on loop", () => {
    const doc = effectWith(
      emitter({ duration: 1, looping: true, modules: [["spawn.burst", { time: 0.5, count: 10 }], ["init.lifetime", { lifetime: 100 }]] }),
    );
    const sim = new EffectSim(compileEffect(doc)).play();
    run(sim, 0.4);
    expect(sim.particleCount).toBe(0);
    run(sim, 0.2);
    expect(sim.particleCount).toBe(10);
    run(sim, 1);
    expect(sim.particleCount).toBe(20);
  });

  it("spawns over distance and spreads births along the path", () => {
    const doc = effectWith(emitter({ duration: 10, modules: [["spawn.distance", { perUnit: 10 }], ["init.lifetime", { lifetime: 100 }]] }));
    const sim = new EffectSim(compileEffect(doc)).play();
    sim.step(1 / 60);
    expect(sim.particleCount).toBe(0);
    sim.setPosition(1, 0, 0).step(1 / 60);
    expect(sim.particleCount).toBe(10);
    const xs = Array.from(sim.emitters[0].buf.px.subarray(0, 10)).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(0.1, 5);
    expect(xs[9]).toBeCloseTo(1, 5);
  });

  it("respects maxParticles", () => {
    const doc = effectWith(emitter({ maxParticles: 25, modules: [["spawn.burst", { count: 100 }], ["init.lifetime", { lifetime: 100 }]] }));
    const sim = new EffectSim(compileEffect(doc)).play();
    sim.step(1 / 60);
    expect(sim.particleCount).toBe(25);
  });

  it("is deterministic for a given seed", () => {
    const doc = effectWith(emitter({ modules: [["spawn.rate", { rate: 100 }], ["init.shape", { shape: "sphere" }]] }));
    const tpl = compileEffect(doc);
    const a = new EffectSim(tpl, 7).play();
    const b = new EffectSim(tpl, 7).play();
    run(a, 0.5);
    run(b, 0.5);
    expect(Array.from(a.emitters[0].buf.px.subarray(0, a.particleCount))).toEqual(Array.from(b.emitters[0].buf.px.subarray(0, b.particleCount)));
  });
});

describe("lifecycle", () => {
  it("kills particles at end of life and compacts the buffer", () => {
    const doc = effectWith(emitter({ looping: false, duration: 0.1, modules: [["spawn.burst", { count: 50 }], ["init.lifetime", { lifetime: { kind: "range", min: 0.2, max: 0.6 } }]] }));
    const sim = new EffectSim(compileEffect(doc)).play();
    sim.step(1 / 60);
    expect(sim.particleCount).toBe(50);
    run(sim, 0.4);
    const buf = sim.emitters[0].buf;
    expect(buf.count).toBeGreaterThan(0);
    expect(buf.count).toBeLessThan(50);
    for (let i = 0; i < buf.count; i++) expect(buf.age[i]).toBeLessThan(buf.life[i]);
  });

  it("finishes a one-shot effect", () => {
    const doc = effectWith(emitter({ looping: false, duration: 0.5, modules: [["spawn.burst", { count: 5 }], ["init.lifetime", { lifetime: 0.25 }]] }));
    const sim = new EffectSim(compileEffect(doc)).play();
    run(sim, 0.4);
    expect(sim.alive).toBe(true);
    run(sim, 0.3);
    expect(sim.alive).toBe(false);
    expect(sim.state).toBe("stopped");
  });

  it("stop() lets particles finish", () => {
    const doc = effectWith(emitter({ modules: [["spawn.rate", { rate: 100 }], ["init.lifetime", { lifetime: 0.5 }]] }));
    const sim = new EffectSim(compileEffect(doc)).play();
    run(sim, 1);
    sim.stop();
    expect(sim.state).toBe("stopping");
    run(sim, 0.3);
    expect(sim.particleCount).toBeGreaterThan(0);
    run(sim, 0.3);
    expect(sim.alive).toBe(false);
  });

  it("honours start delay", () => {
    const doc = effectWith(emitter({ startDelay: 1, modules: [["spawn.rate", { rate: 100 }], ["init.lifetime", { lifetime: 10 }]] }));
    const sim = new EffectSim(compileEffect(doc)).play();
    run(sim, 0.9);
    expect(sim.particleCount).toBe(0);
    run(sim, 0.5);
    expect(sim.particleCount).toBeGreaterThan(0);
  });

  it("prewarms looping emitters", () => {
    const doc = effectWith(emitter({ prewarm: true, duration: 1, modules: [["spawn.rate", { rate: 100 }], ["init.lifetime", { lifetime: 10 }]] }));
    const sim = new EffectSim(compileEffect(doc)).play();
    expect(sim.particleCount).toBeGreaterThan(90);
  });
});

describe("spaces and transforms", () => {
  it("world-space particles stay behind when the effect moves", () => {
    const doc = effectWith(emitter({ modules: [["spawn.burst", { count: 1 }], ["init.shape", { shape: "point", speed: 0 }], ["init.lifetime", { lifetime: 10 }]] }));
    const sim = new EffectSim(compileEffect(doc)).play();
    sim.step(1 / 60);
    sim.setPosition(5, 0, 0).step(1 / 60);
    expect(sim.emitters[0].buf.px[0]).toBeCloseTo(0);
  });

  it("local-space particles move with the effect (positions stay local)", () => {
    const doc = effectWith(emitter({ space: "local", modules: [["spawn.burst", { count: 1 }], ["init.shape", { shape: "point", speed: 0 }], ["init.lifetime", { lifetime: 10 }]] }));
    const sim = new EffectSim(compileEffect(doc)).play();
    sim.setPosition(5, 0, 0).teleport();
    sim.step(1 / 60);
    expect(sim.emitters[0].buf.px[0]).toBeCloseTo(0);
    expect(sim.matrix[12]).toBe(5);
  });

  it("rotates emission direction with the effect", () => {
    const doc = effectWith(emitter({ modules: [["spawn.burst", { count: 1 }], ["init.shape", { shape: "cone", angle: 0, radius: 0, speed: 1 }], ["init.lifetime", { lifetime: 10 }]] }));
    const sim = new EffectSim(compileEffect(doc));
    // 90° about Z: +Y → -X
    const s = Math.SQRT1_2;
    sim.setRotation(0, 0, s, s).play();
    sim.step(1 / 60);
    const b = sim.emitters[0].buf;
    expect(b.vx[0]).toBeCloseTo(-1);
    expect(b.vy[0]).toBeCloseTo(0);
  });

  it("inherits the effect's velocity", () => {
    const doc = effectWith(emitter({ modules: [["spawn.distance", { perUnit: 1 }], ["init.shape", { shape: "point", speed: 0 }], ["init.inheritVelocity", { factor: 0.5 }], ["init.lifetime", { lifetime: 10 }]] }));
    const sim = new EffectSim(compileEffect(doc)).play();
    sim.setPosition(1, 0, 0).step(0.1); // 10 units/s
    expect(sim.emitters[0].buf.vx[0]).toBeCloseTo(5);
  });
});

describe("forces", () => {
  it("applies gravity and drag", () => {
    const doc = effectWith(emitter({ modules: [["spawn.burst", { count: 1 }], ["init.shape", { shape: "point", speed: 0 }], ["init.lifetime", { lifetime: 10 }], ["update.gravity", {}]] }));
    const sim = new EffectSim(compileEffect(doc)).play();
    run(sim, 1, 1 / 100);
    expect(sim.emitters[0].buf.vy[0]).toBeCloseTo(-9.81, 1);

    const dragged = effectWith(emitter({ modules: [["spawn.burst", { count: 1 }], ["init.shape", { shape: "point", speed: 0 }], ["init.velocity", { velocity: [10, 0, 0] }], ["init.lifetime", { lifetime: 10 }], ["update.drag", { drag: 1 }]] }));
    const s2 = new EffectSim(compileEffect(dragged)).play();
    run(s2, 1, 1 / 100);
    expect(s2.emitters[0].buf.vx[0]).toBeLessThan(4);
    expect(s2.emitters[0].buf.vx[0]).toBeGreaterThan(3);
  });

  it("bounces off a collision plane", () => {
    const doc = effectWith(emitter({ modules: [["spawn.burst", { count: 1 }], ["init.shape", { shape: "point", speed: 0, offset: [0, 1, 0] }], ["init.velocity", { velocity: [0, -10, 0] }], ["init.lifetime", { lifetime: 10 }], ["update.collisionPlane", { bounce: 0.5, friction: 0 }]] }));
    const sim = new EffectSim(compileEffect(doc)).play();
    run(sim, 0.2, 1 / 100);
    const b = sim.emitters[0].buf;
    expect(b.py[0]).toBeGreaterThanOrEqual(-1e-4);
    expect(b.vy[0]).toBeCloseTo(5, 3);
  });

  it("limits velocity", () => {
    const doc = effectWith(emitter({ modules: [["spawn.burst", { count: 1 }], ["init.shape", { shape: "point", speed: 0 }], ["init.velocity", { velocity: [100, 0, 0] }], ["init.lifetime", { lifetime: 10 }], ["update.limitVelocity", { maxSpeed: 5 }]] }));
    const sim = new EffectSim(compileEffect(doc)).play();
    sim.step(1 / 60);
    expect(sim.emitters[0].buf.vx[0]).toBeCloseTo(5);
  });
});

describe("sub-emitters", () => {
  it("spawns children where parents die, inheriting colour", () => {
    const child = emitter({ eventDriven: true, modules: [["init.shape", { shape: "point", speed: 0 }], ["init.lifetime", { lifetime: 10 }]] });
    child.id = "child";
    const parent = emitter({
      looping: false,
      duration: 0.1,
      modules: [["spawn.burst", { count: 3 }], ["init.shape", { shape: "point", speed: 0, offset: [2, 0, 0] }], ["init.lifetime", { lifetime: 0.1 }], ["init.color", { color: "#ff0000" }]],
    });
    parent.subEmitters = [{ trigger: "death", emitter: "child", count: 4, inheritColor: true }];
    const sim = new EffectSim(compileEffect(effectWith(parent, child))).play();
    run(sim, 0.2);
    const c = sim.emitters[1].buf;
    expect(c.count).toBe(12);
    expect(c.px[0]).toBeCloseTo(2);
    expect(c.r[0]).toBeCloseTo(1);
    expect(c.g[0]).toBeCloseTo(0);
    expect(sim.alive).toBe(true);
  });
});

describe("parameters", () => {
  it("binds spawn rate to an effect parameter", () => {
    const doc = effectWith(emitter({ modules: [["spawn.rate", { rate: { kind: "param", name: "throttle", scale: 100 } }], ["init.lifetime", { lifetime: 10 }]] }));
    doc.parameters.push({ name: "throttle", type: "float", default: 0 });
    const sim = new EffectSim(compileEffect(doc)).play();
    run(sim, 0.5);
    expect(sim.particleCount).toBe(0);
    sim.setParam("throttle", 1);
    run(sim, 0.5);
    expect(sim.particleCount).toBeGreaterThanOrEqual(49);
  });
});

describe("compile", () => {
  it("skips invalid modules and reports them", () => {
    const e = emitter({ modules: [["spawn.rate", {}]] });
    e.init.push({ id: "bad", type: "init.nope", params: {} });
    e.update.push({ id: "bad2", type: "update.drag", params: { drag: "lots" } });
    const tpl = compileEffect(effectWith(e));
    expect(tpl.issues.map((i) => i.moduleId)).toEqual(["bad", "bad2"]);
    expect(tpl.emitters[0].update).toHaveLength(0);
  });

  it("bakes render-stage LUTs", () => {
    const e = emitter({ modules: [["render.sizeOverLife", {}], ["render.colorOverLife", {}]] });
    const tpl = compileEffect(effectWith(e));
    expect(tpl.emitters[0].sizeLut).toHaveLength(64);
    expect(tpl.emitters[0].colorLut).toHaveLength(256);
  });
});
