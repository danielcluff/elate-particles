import { compileColor, compileFloat } from "../core/values";
import type { ModuleDef } from "../core/registry";
import type { ColorValue, FloatValue } from "../core/types";
import { isIdentityQuat, quatFromEulerDeg, rotate } from "../sim/math";

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

const SHAPES = ["point", "sphere", "hemisphere", "cone", "box", "circle", "line"] as const;
type Shape = (typeof SHAPES)[number];

export const initModules: ModuleDef[] = [
  {
    type: "init.lifetime",
    stage: "init",
    label: "Lifetime",
    category: "Initialize",
    description: "How long each particle lives, in seconds.",
    multiple: false,
    params: [{ key: "lifetime", label: "Lifetime", type: "floatValue", default: { kind: "range", min: 1, max: 2 }, min: 0, unit: "s" }],
    compile(p) {
      const lifetime = compileFloat(p.lifetime as FloatValue, 1);
      return {
        run(ctx, buf, start, end) {
          const life = buf.life;
          for (let i = start; i < end; i++) life[i] = Math.max(1e-3, lifetime.sample(ctx.cycleT, ctx.rng.next(), ctx.params));
        },
      };
    },
  },
  {
    type: "init.shape",
    stage: "init",
    label: "Shape",
    category: "Initialize",
    description:
      "Where particles are born and which way they head. Cone and hemisphere emit along +Y, circle lies in the XZ plane; use rotation to orient the shape. `speed` launches particles along the shape direction.",
    multiple: false,
    params: [
      { key: "shape", label: "Shape", type: "enum", default: "cone", options: SHAPES.map((s) => ({ label: s[0].toUpperCase() + s.slice(1), value: s })) },
      { key: "radius", label: "Radius", type: "float", default: 0.5, min: 0, showIf: { key: "shape", values: ["sphere", "hemisphere", "cone", "circle"] } },
      {
        key: "thickness",
        label: "Radius Thickness",
        type: "float",
        default: 1,
        min: 0,
        max: 1,
        description: "0 emits from the surface/edge only, 1 from the whole volume.",
        showIf: { key: "shape", values: ["sphere", "hemisphere", "cone", "circle"] },
      },
      { key: "angle", label: "Angle", type: "float", default: 25, min: 0, max: 90, unit: "°", showIf: { key: "shape", values: ["cone"] } },
      { key: "arc", label: "Arc", type: "float", default: 360, min: 0, max: 360, unit: "°", showIf: { key: "shape", values: ["cone", "circle"] } },
      { key: "boxSize", label: "Box Size", type: "vec3", default: [1, 1, 1], showIf: { key: "shape", values: ["box"] } },
      { key: "length", label: "Length", type: "float", default: 1, min: 0, showIf: { key: "shape", values: ["line"] } },
      { key: "offset", label: "Offset", type: "vec3", default: [0, 0, 0] },
      { key: "rotation", label: "Rotation", type: "vec3", default: [0, 0, 0], unit: "°" },
      { key: "speed", label: "Speed", type: "floatValue", default: 2, unit: "/s" },
      { key: "randomDirection", label: "Randomise Direction", type: "float", default: 0, min: 0, max: 1 },
    ],
    compile(p) {
      const shape = p.shape as Shape;
      const radius = p.radius as number;
      const k = p.thickness as number;
      const cosAngle = Math.cos((p.angle as number) * DEG);
      const tanAngle = Math.tan(Math.min(89.9, p.angle as number) * DEG);
      const arc = ((p.arc as number) / 360) * TAU;
      const [bx, by, bz] = p.boxSize as number[];
      const len = p.length as number;
      const [ox, oy, oz] = p.offset as number[];
      const [rx, ry, rz] = p.rotation as number[];
      const q = quatFromEulerDeg(rx, ry, rz);
      const rotated = !isIdentityQuat(q);
      const speed = compileFloat(p.speed as FloatValue);
      const randomDir = p.randomDirection as number;
      const inner3 = Math.pow(1 - k, 3);
      const inner2 = Math.pow(1 - k, 2);
      const tmp = [0, 0, 0];
      return {
        run(ctx, buf, start, end) {
          const rng = ctx.rng;
          const { px, py, pz, vx, vy, vz } = buf;
          for (let i = start; i < end; i++) {
            let x = 0, y = 0, z = 0, dx = 0, dy = 1, dz = 0;
            switch (shape) {
              case "point":
              case "sphere":
              case "hemisphere": {
                const u = rng.next() * 2 - 1;
                const phi = rng.next() * TAU;
                const s = Math.sqrt(1 - u * u);
                dx = s * Math.cos(phi);
                dy = shape === "hemisphere" ? Math.abs(u) : u;
                dz = s * Math.sin(phi);
                if (shape !== "point") {
                  const r = radius * Math.cbrt(inner3 + (1 - inner3) * rng.next());
                  x = dx * r;
                  y = dy * r;
                  z = dz * r;
                }
                break;
              }
              case "cone": {
                const phi = rng.next() * arc;
                const c = Math.cos(phi), s = Math.sin(phi);
                if (radius > 0) {
                  // position on the base disc; direction tilts with distance from the axis (no crossing rays)
                  const rn = Math.sqrt(inner2 + (1 - inner2) * rng.next());
                  x = c * rn * radius;
                  z = s * rn * radius;
                  const t = rn * tanAngle;
                  const l = Math.sqrt(1 + t * t);
                  dx = (c * t) / l;
                  dy = 1 / l;
                  dz = (s * t) / l;
                } else {
                  const ct = 1 - (1 - cosAngle) * rng.next();
                  const st = Math.sqrt(1 - ct * ct);
                  dx = c * st;
                  dy = ct;
                  dz = s * st;
                }
                break;
              }
              case "box":
                x = (rng.next() - 0.5) * bx;
                y = (rng.next() - 0.5) * by;
                z = (rng.next() - 0.5) * bz;
                break;
              case "circle": {
                const phi = rng.next() * arc;
                const rn = Math.sqrt(inner2 + (1 - inner2) * rng.next());
                dx = Math.cos(phi);
                dy = 0;
                dz = Math.sin(phi);
                x = dx * rn * radius;
                z = dz * rn * radius;
                break;
              }
              case "line":
                x = (rng.next() - 0.5) * len;
                break;
            }
            if (randomDir > 0) {
              const u = rng.next() * 2 - 1;
              const phi = rng.next() * TAU;
              const s = Math.sqrt(1 - u * u);
              dx += (s * Math.cos(phi) - dx) * randomDir;
              dy += (u - dy) * randomDir;
              dz += (s * Math.sin(phi) - dz) * randomDir;
              const l = Math.hypot(dx, dy, dz) || 1;
              dx /= l;
              dy /= l;
              dz /= l;
            }
            if (rotated) {
              rotate(q, x, y, z, tmp);
              x = tmp[0];
              y = tmp[1];
              z = tmp[2];
              rotate(q, dx, dy, dz, tmp);
              dx = tmp[0];
              dy = tmp[1];
              dz = tmp[2];
            }
            const v = speed.constant ? speed.value : speed.sample(ctx.cycleT, rng.next(), ctx.params);
            px[i] = x + ox;
            py[i] = y + oy;
            pz[i] = z + oz;
            vx[i] = dx * v;
            vy[i] = dy * v;
            vz[i] = dz * v;
          }
        },
      };
    },
  },
  {
    type: "init.velocity",
    stage: "init",
    label: "Add Velocity",
    category: "Initialize",
    description: "Adds a velocity in the effect's local frame, plus a random ± spread per axis.",
    params: [
      { key: "velocity", label: "Velocity", type: "vec3", default: [0, 1, 0] },
      { key: "spread", label: "Random Spread", type: "vec3", default: [0, 0, 0] },
    ],
    compile(p) {
      const [x, y, z] = p.velocity as number[];
      const [sx, sy, sz] = p.spread as number[];
      return {
        run(ctx, buf, start, end) {
          const rng = ctx.rng;
          for (let i = start; i < end; i++) {
            buf.vx[i] += x + (rng.next() * 2 - 1) * sx;
            buf.vy[i] += y + (rng.next() * 2 - 1) * sy;
            buf.vz[i] += z + (rng.next() * 2 - 1) * sz;
          }
        },
      };
    },
  },
  {
    type: "init.size",
    stage: "init",
    label: "Size",
    category: "Initialize",
    description: "Particle size in world units (multiplied by Size Over Life).",
    multiple: false,
    params: [{ key: "size", label: "Size", type: "floatValue", default: { kind: "range", min: 0.3, max: 0.6 }, min: 0 }],
    compile(p) {
      const size = compileFloat(p.size as FloatValue, 1);
      return {
        run(ctx, buf, start, end) {
          for (let i = start; i < end; i++) buf.size[i] = size.sample(ctx.cycleT, ctx.rng.next(), ctx.params);
        },
      };
    },
  },
  {
    type: "init.rotation",
    stage: "init",
    label: "Rotation",
    category: "Initialize",
    description: "Initial sprite rotation and spin, in degrees and degrees per second.",
    multiple: false,
    params: [
      { key: "angle", label: "Angle", type: "floatValue", default: { kind: "range", min: 0, max: 360 }, unit: "°" },
      { key: "spin", label: "Spin", type: "floatValue", default: 0, unit: "°/s" },
    ],
    compile(p) {
      const angle = compileFloat(p.angle as FloatValue);
      const spin = compileFloat(p.spin as FloatValue);
      return {
        run(ctx, buf, start, end) {
          for (let i = start; i < end; i++) {
            buf.rot[i] = angle.sample(ctx.cycleT, ctx.rng.next(), ctx.params) * DEG;
            buf.spin[i] = spin.sample(ctx.cycleT, ctx.rng.next(), ctx.params) * DEG;
          }
        },
      };
    },
  },
  {
    type: "init.color",
    stage: "init",
    label: "Color",
    category: "Initialize",
    description: "Base colour (multiplied by Color Over Life). A gradient is sampled over the emitter cycle; a random gradient picks a random point per particle.",
    multiple: false,
    params: [{ key: "color", label: "Color", type: "colorValue", default: "#ffffff" }],
    compile(p) {
      const color = compileColor(p.color as ColorValue);
      const tmp = new Float32Array(4);
      return {
        run(ctx, buf, start, end) {
          const { r, g, b, a } = buf;
          for (let i = start; i < end; i++) {
            color.sample(ctx.cycleT, ctx.rng.next(), tmp, 0);
            r[i] = tmp[0];
            g[i] = tmp[1];
            b[i] = tmp[2];
            a[i] = tmp[3];
          }
        },
      };
    },
  },
  {
    type: "init.inheritVelocity",
    stage: "init",
    label: "Inherit Velocity",
    category: "Initialize",
    phase: "sim",
    multiple: false,
    description: "Adds a fraction of the effect's own velocity (a moving ship, a projectile) to new particles.",
    params: [{ key: "factor", label: "Factor", type: "floatValue", default: 1 }],
    compile(p) {
      const factor = compileFloat(p.factor as FloatValue, 1);
      const v = [0, 0, 0];
      return {
        run(ctx, buf, start, end) {
          const tv = ctx.transform.velocity;
          ctx.worldDirToSim(tv[0], tv[1], tv[2], v);
          for (let i = start; i < end; i++) {
            const f = factor.sample(ctx.cycleT, ctx.rng.next(), ctx.params);
            buf.vx[i] += v[0] * f;
            buf.vy[i] += v[1] * f;
            buf.vz[i] += v[2] * f;
          }
        },
      };
    },
  },
];
