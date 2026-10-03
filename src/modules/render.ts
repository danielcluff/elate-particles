import { bakeCurve, bakeGradient } from "../core/values";
import type { ModuleDef } from "../core/registry";
import type { Curve, Gradient } from "../core/types";

// Render modules never touch particle data on the CPU: they bake lookup tables
// that the sprite material samples by normalised age, so "over life" effects
// cost nothing per particle on the CPU and no extra upload bandwidth.

export const renderModules: ModuleDef[] = [
  {
    type: "render.sizeOverLife",
    stage: "render",
    label: "Size Over Life",
    category: "Over Life",
    description: "Multiplies particle size by a curve over normalised age (evaluated on the GPU).",
    multiple: false,
    params: [
      {
        key: "curve",
        label: "Curve",
        type: "curve",
        default: { keys: [{ t: 0, v: 0.5 }, { t: 0.2, v: 1 }, { t: 1, v: 0 }], interp: "smooth" },
      },
    ],
    bake: (p) => ({ size: bakeCurve(p.curve as Curve) }),
  },
  {
    type: "render.colorOverLife",
    stage: "render",
    label: "Color Over Life",
    category: "Over Life",
    description: "Multiplies particle colour and alpha by a gradient over normalised age (evaluated on the GPU).",
    multiple: false,
    params: [
      {
        key: "gradient",
        label: "Gradient",
        type: "gradient",
        default: {
          colors: [{ t: 0, color: "#ffffff" }, { t: 1, color: "#ffffff" }],
          alphas: [{ t: 0, a: 0 }, { t: 0.1, a: 1 }, { t: 1, a: 0 }],
        },
      },
    ],
    bake: (p) => ({ color: bakeGradient(p.gradient as Gradient) }),
  },
];
