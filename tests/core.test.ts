import { describe, expect, it } from "vitest";
import {
  bakeGradient,
  compileColor,
  compileFloat,
  createEffect,
  describeModuleType,
  evalCurve,
  executeCommand,
  listModuleTypes,
  normalizeEffect,
  parseHex,
  validateEffect,
  type EffectDoc,
} from "../src/index";

describe("values", () => {
  it("evaluates curves with clamping and interpolation modes", () => {
    const c = { keys: [{ t: 0, v: 0 }, { t: 1, v: 10 }] };
    expect(evalCurve(c, -1)).toBe(0);
    expect(evalCurve(c, 0.5)).toBe(5);
    expect(evalCurve({ ...c, interp: "step" as const }, 0.9)).toBe(0);
    expect(evalCurve({ ...c, interp: "smooth" as const }, 0.25)).toBeCloseTo(1.5625);
  });

  it("compiles float values", () => {
    expect(compileFloat(3).constant).toBe(true);
    expect(compileFloat({ kind: "range", min: 2, max: 4 }).sample(0, 0.5, {})).toBe(3);
    expect(compileFloat({ kind: "curve", curve: { keys: [{ t: 0, v: 0 }, { t: 1, v: 2 }] }, scale: 2 }).sample(0.5, 0, {})).toBeCloseTo(2, 1);
    expect(compileFloat({ kind: "param", name: "x", scale: 2, offset: 1 }).sample(0, 0, { x: 3 })).toBe(7);
  });

  it("converts sRGB hex to linear and bakes gradients with intensity", () => {
    expect(parseHex("#ffffff")).toEqual([1, 1, 1]);
    expect(parseHex("#808080")[0]).toBeCloseTo(0.2158, 3);
    const lut = bakeGradient({ colors: [{ t: 0, color: "#ff0000" }], alphas: [{ t: 0, a: 1 }, { t: 1, a: 0 }], intensity: 3 }, 3);
    expect(Array.from(lut.subarray(0, 4))).toEqual([3, 0, 0, 1]);
    expect(lut[11]).toBe(0);
    const out = [0, 0, 0, 0];
    compileColor({ kind: "range", a: "#000000", b: "#ffffff" }).sample(0, 1, out, 0);
    expect(out).toEqual([1, 1, 1, 1]);
  });
});

describe("documents", () => {
  it("round-trips through JSON and validates cleanly", () => {
    const doc = createEffect("Fire");
    const back = normalizeEffect(JSON.parse(JSON.stringify(doc)));
    expect(back).toEqual(doc);
    expect(validateEffect(back)).toEqual([]);
  });

  it("rejects non-effects", () => {
    expect(() => normalizeEffect(42)).toThrow();
    expect(() => normalizeEffect({ format: "tsl-graph", emitters: [] })).toThrow();
  });
});

describe("commands", () => {
  const fresh = (): EffectDoc => createEffect("t", { emitter: false });

  it("builds an effect with refs in one batch", () => {
    const doc = fresh();
    executeCommand(doc, {
      op: "batch",
      ops: [
        { op: "addEmitter", name: "Sparks", template: "empty", ref: "sparks" },
        { op: "addModule", emitterId: "$sparks", type: "spawn.burst", params: { count: 40 } },
        { op: "addModule", emitterId: "$sparks", type: "update.gravity", ref: "g" },
        { op: "updateModule", emitterId: "$sparks", moduleId: "$g", params: { scale: 0.5 } },
        { op: "setRenderer", emitterId: "$sparks", renderer: { facing: "velocity", shape: "spark" } },
      ],
    });
    const e = doc.emitters[0];
    expect(e.name).toBe("Sparks");
    expect(e.spawn[0].params.count).toBe(40);
    expect(e.update[0].params.scale).toBe(0.5);
    expect(e.renderers[0]).toMatchObject({ type: "sprite", facing: "velocity" });
    expect(validateEffect(doc)).toEqual([]);
  });

  it("is atomic: a failing batch changes nothing", () => {
    const doc = fresh();
    const before = JSON.stringify(doc);
    expect(() =>
      executeCommand(doc, {
        op: "batch",
        ops: [
          { op: "addEmitter", ref: "a" },
          { op: "addModule", emitterId: "$a", type: "update.drag", params: { drag: "very" } },
        ],
      }),
    ).toThrow(/drag/);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it("rejects unknown params and duplicate single-instance modules", () => {
    const doc = fresh();
    const { emitterId } = executeCommand(doc, { op: "addEmitter" }) as { emitterId: string };
    expect(() => executeCommand(doc, { op: "addModule", emitterId, type: "update.gravity", params: { strength: 1 } })).toThrow(/no param "strength"/);
    expect(() => executeCommand(doc, { op: "addModule", emitterId, type: "init.lifetime" })).toThrow(/already/);
  });

  it("removing an emitter drops sub-emitter bindings to it", () => {
    const doc = fresh();
    const a = (executeCommand(doc, { op: "addEmitter", name: "a" }) as { emitterId: string }).emitterId;
    const b = (executeCommand(doc, { op: "addEmitter", name: "b", props: { eventDriven: true } }) as { emitterId: string }).emitterId;
    executeCommand(doc, { op: "setSubEmitters", emitterId: a, subEmitters: [{ trigger: "death", emitter: b, count: 3 }] });
    executeCommand(doc, { op: "removeEmitter", emitterId: b });
    expect(doc.emitters[0].subEmitters).toEqual([]);
  });

  it("describes modules for agents", () => {
    expect(listModuleTypes().length).toBeGreaterThan(15);
    const shape = describeModuleType("init.shape");
    expect(shape.params.find((p) => p.key === "shape")?.options).toContain("cone");
  });
});
