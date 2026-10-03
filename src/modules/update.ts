import { compileFloat } from "../core/values";
import type { ModuleDef } from "../core/registry";
import type { FloatValue } from "../core/types";
import { noise3 } from "../sim/math";

// Update modules run on every live particle each step, before integration.
// FloatValue curves here are sampled over the particle's normalised age.

export const updateModules: ModuleDef[] = [
  {
    type: "update.gravity",
    stage: "update",
    label: "Gravity",
    category: "Forces",
    description: "Constant world-space acceleration.",
    params: [
      { key: "gravity", label: "Gravity", type: "vec3", default: [0, -9.81, 0] },
      { key: "scale", label: "Scale", type: "float", default: 1 },
    ],
    compile(p) {
      const [gx, gy, gz] = p.gravity as number[];
      const s = p.scale as number;
      const g = [0, 0, 0];
      return {
        run(ctx, buf, start, end) {
          ctx.worldDirToSim(gx * s * ctx.dt, gy * s * ctx.dt, gz * s * ctx.dt, g);
          const { vx, vy, vz } = buf;
          for (let i = start; i < end; i++) {
            vx[i] += g[0];
            vy[i] += g[1];
            vz[i] += g[2];
          }
        },
      };
    },
  },
  {
    type: "update.force",
    stage: "update",
    label: "Force",
    category: "Forces",
    description: "Constant acceleration in world or effect-local space (wind, thrust).",
    params: [
      { key: "force", label: "Force", type: "vec3", default: [1, 0, 0] },
      { key: "space", label: "Space", type: "enum", default: "world", options: [{ label: "World", value: "world" }, { label: "Local", value: "local" }] },
      { key: "scale", label: "Scale", type: "floatValue", default: 1, description: "Sampled over particle age." },
    ],
    compile(p) {
      const [fx, fy, fz] = p.force as number[];
      const local = p.space === "local";
      const scale = compileFloat(p.scale as FloatValue, 1);
      const f = [0, 0, 0];
      return {
        run(ctx, buf, start, end) {
          if (local) ctx.localDirToSim(fx, fy, fz, f);
          else ctx.worldDirToSim(fx, fy, fz, f);
          const dt = ctx.dt;
          const { vx, vy, vz, age, life, seed } = buf;
          for (let i = start; i < end; i++) {
            const s = (scale.constant ? scale.value : scale.sample(age[i] / life[i], seed[i], ctx.params)) * dt;
            vx[i] += f[0] * s;
            vy[i] += f[1] * s;
            vz[i] += f[2] * s;
          }
        },
      };
    },
  },
  {
    type: "update.drag",
    stage: "update",
    label: "Drag",
    category: "Forces",
    description: "Slows particles down; `drag` is the fraction of velocity lost per second (roughly).",
    params: [{ key: "drag", label: "Drag", type: "floatValue", default: 0.5, min: 0, description: "Sampled over particle age." }],
    compile(p) {
      const drag = compileFloat(p.drag as FloatValue, 0.5);
      return {
        run(ctx, buf, start, end) {
          const dt = ctx.dt;
          const { vx, vy, vz, age, life, seed } = buf;
          const kConst = 1 / (1 + drag.value * dt);
          for (let i = start; i < end; i++) {
            const k = drag.constant ? kConst : 1 / (1 + Math.max(0, drag.sample(age[i] / life[i], seed[i], ctx.params)) * dt);
            vx[i] *= k;
            vy[i] *= k;
            vz[i] *= k;
          }
        },
      };
    },
  },
  {
    type: "update.attractor",
    stage: "update",
    label: "Point Attractor",
    category: "Forces",
    description: "Pulls particles toward a point in the effect's local frame. Negative strength repels.",
    params: [
      { key: "position", label: "Position", type: "vec3", default: [0, 2, 0] },
      { key: "strength", label: "Strength", type: "float", default: 4 },
      { key: "radius", label: "Radius", type: "float", default: 2, min: 0.001, description: "Falloff: strength / (1 + (d / radius)²)." },
      { key: "killRadius", label: "Kill Radius", type: "float", default: 0, min: 0, description: "Particles closer than this die (0 = off)." },
    ],
    compile(p) {
      const [lx, ly, lz] = p.position as number[];
      const strength = p.strength as number;
      const radius = p.radius as number;
      const kill2 = (p.killRadius as number) ** 2;
      const c = [0, 0, 0];
      return {
        run(ctx, buf, start, end) {
          ctx.localPointToSim(lx, ly, lz, c);
          const dt = ctx.dt;
          const { px, py, pz, vx, vy, vz, age, life } = buf;
          for (let i = start; i < end; i++) {
            const dx = c[0] - px[i], dy = c[1] - py[i], dz = c[2] - pz[i];
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < kill2) {
              age[i] = life[i];
              continue;
            }
            const d = Math.sqrt(d2) || 1;
            const f = (strength / (1 + d2 / (radius * radius)) / d) * dt;
            vx[i] += dx * f;
            vy[i] += dy * f;
            vz[i] += dz * f;
          }
        },
      };
    },
  },
  {
    type: "update.vortex",
    stage: "update",
    label: "Vortex",
    category: "Forces",
    description: "Swirls particles around an axis through `center` (effect-local); `pull` draws them toward the axis.",
    params: [
      { key: "axis", label: "Axis", type: "vec3", default: [0, 1, 0] },
      { key: "center", label: "Center", type: "vec3", default: [0, 0, 0] },
      { key: "strength", label: "Strength", type: "float", default: 4 },
      { key: "pull", label: "Pull", type: "float", default: 0 },
    ],
    compile(p) {
      const [ax0, ay0, az0] = p.axis as number[];
      const al = Math.hypot(ax0, ay0, az0) || 1;
      const [cx0, cy0, cz0] = p.center as number[];
      const strength = p.strength as number;
      const pull = p.pull as number;
      const a = [0, 0, 0];
      const c = [0, 0, 0];
      return {
        run(ctx, buf, start, end) {
          ctx.localDirToSim(ax0 / al, ay0 / al, az0 / al, a);
          ctx.localPointToSim(cx0, cy0, cz0, c);
          const dt = ctx.dt;
          const { px, py, pz, vx, vy, vz } = buf;
          for (let i = start; i < end; i++) {
            let rx = px[i] - c[0], ry = py[i] - c[1], rz = pz[i] - c[2];
            const along = rx * a[0] + ry * a[1] + rz * a[2];
            rx -= a[0] * along;
            ry -= a[1] * along;
            rz -= a[2] * along;
            const d = Math.hypot(rx, ry, rz);
            if (d < 1e-5) continue;
            // tangent = axis × r
            const tx = a[1] * rz - a[2] * ry, ty = a[2] * rx - a[0] * rz, tz = a[0] * ry - a[1] * rx;
            const s = (strength / d) * dt;
            const k = (pull / d) * dt;
            vx[i] += tx * s - rx * k;
            vy[i] += ty * s - ry * k;
            vz[i] += tz * s - rz * k;
          }
        },
      };
    },
  },
  {
    type: "update.turbulence",
    stage: "update",
    label: "Turbulence",
    category: "Forces",
    description: "Noise-field force for smoke, embers and magic. Cost: three noise lookups per particle.",
    params: [
      { key: "strength", label: "Strength", type: "floatValue", default: 2, description: "Sampled over particle age." },
      { key: "frequency", label: "Frequency", type: "float", default: 0.5, min: 0 },
      { key: "scroll", label: "Scroll Speed", type: "float", default: 0.5, description: "How fast the field evolves." },
    ],
    compile(p) {
      const strength = compileFloat(p.strength as FloatValue, 2);
      const freq = p.frequency as number;
      const scroll = p.scroll as number;
      return {
        run(ctx, buf, start, end) {
          const dt = ctx.dt;
          const o = ctx.time * scroll;
          const { px, py, pz, vx, vy, vz, age, life, seed } = buf;
          for (let i = start; i < end; i++) {
            const s = (strength.constant ? strength.value : strength.sample(age[i] / life[i], seed[i], ctx.params)) * dt;
            const x = px[i] * freq, y = py[i] * freq, z = pz[i] * freq;
            vx[i] += noise3(x + o, y, z) * s;
            vy[i] += noise3(x + 31.4, y + o, z + 17.1) * s;
            vz[i] += noise3(x - 47.2, y + 9.7, z + o) * s;
          }
        },
      };
    },
  },
  {
    type: "update.limitVelocity",
    stage: "update",
    label: "Limit Velocity",
    category: "Velocity",
    description: "Caps particle speed; `dampen` 1 clamps hard, lower values ease toward the limit.",
    multiple: false,
    params: [
      { key: "maxSpeed", label: "Max Speed", type: "floatValue", default: 5, min: 0, description: "Sampled over particle age." },
      { key: "dampen", label: "Dampen", type: "float", default: 1, min: 0, max: 1 },
    ],
    compile(p) {
      const max = compileFloat(p.maxSpeed as FloatValue, 5);
      const dampen = p.dampen as number;
      return {
        run(ctx, buf, start, end) {
          const { vx, vy, vz, age, life, seed } = buf;
          for (let i = start; i < end; i++) {
            const m = max.constant ? max.value : max.sample(age[i] / life[i], seed[i], ctx.params);
            const s2 = vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i];
            if (s2 <= m * m) continue;
            const k = 1 + (m / Math.sqrt(s2) - 1) * dampen;
            vx[i] *= k;
            vy[i] *= k;
            vz[i] *= k;
          }
        },
      };
    },
  },
  {
    type: "update.collisionPlane",
    stage: "update",
    label: "Collision Plane",
    category: "Collision",
    description: "Bounces particles off an infinite plane given in simulation space (world for world-space emitters).",
    params: [
      { key: "point", label: "Point", type: "vec3", default: [0, 0, 0] },
      { key: "normal", label: "Normal", type: "vec3", default: [0, 1, 0] },
      { key: "bounce", label: "Bounce", type: "float", default: 0.4, min: 0, max: 1 },
      { key: "friction", label: "Friction", type: "float", default: 0.2, min: 0, max: 1 },
      { key: "lifetimeLoss", label: "Lifetime Loss", type: "float", default: 0, min: 0, max: 1, description: "Fraction of lifetime lost per hit." },
      { key: "kill", label: "Kill On Hit", type: "bool", default: false },
    ],
    compile(p) {
      const [ppx, ppy, ppz] = p.point as number[];
      const [n0, n1, n2] = p.normal as number[];
      const nl = Math.hypot(n0, n1, n2) || 1;
      const nx = n0 / nl, ny = n1 / nl, nz = n2 / nl;
      const bounce = p.bounce as number;
      const friction = p.friction as number;
      const loss = p.lifetimeLoss as number;
      const kill = p.kill as boolean;
      return {
        run(ctx, buf, start, end) {
          const dt = ctx.dt;
          const { px, py, pz, vx, vy, vz, age, life } = buf;
          for (let i = start; i < end; i++) {
            // test the position after this step's integration
            const x = px[i] + vx[i] * dt, y = py[i] + vy[i] * dt, z = pz[i] + vz[i] * dt;
            const d = (x - ppx) * nx + (y - ppy) * ny + (z - ppz) * nz;
            if (d >= 0) continue;
            const vn = vx[i] * nx + vy[i] * ny + vz[i] * nz;
            if (vn >= 0) continue;
            if (kill) {
              age[i] = life[i];
              continue;
            }
            const tvx = vx[i] - vn * nx, tvy = vy[i] - vn * ny, tvz = vz[i] - vn * nz;
            const f = 1 - friction;
            vx[i] = tvx * f - vn * bounce * nx;
            vy[i] = tvy * f - vn * bounce * ny;
            vz[i] = tvz * f - vn * bounce * nz;
            // put the particle back on the plane
            const pd = (px[i] - ppx) * nx + (py[i] - ppy) * ny + (pz[i] - ppz) * nz;
            if (pd < 0) {
              px[i] -= pd * nx;
              py[i] -= pd * ny;
              pz[i] -= pd * nz;
            }
            if (loss > 0) age[i] += loss * life[i];
          }
        },
      };
    },
  },
];
