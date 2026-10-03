// GPU (TSL compute) implementations of the built-in modules, mirroring the
// CPU versions in src/modules. Spawn modules have none: spawning stays on the
// CPU. Render modules have none: they are baked to LUTs for every backend.

import { If, abs, clamp, cos, cross, dot, float, length, max, normalize, select, sin, sqrt, vec3, vec4 } from "three/tsl";
import { turbulenceField } from "./noise";
import type { ColorValue, FloatValue, Vec3 } from "../../core/types";
import { quatFromEulerDeg, isIdentityQuat } from "../../sim/math";
import type { Node } from "../materials/common";
import { rotateQ, type GpuBuildContext, type GpuParticle } from "./context";

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

export interface GpuModuleImpl {
  /** Emits TSL for this module into the init or update kernel. */
  emit(p: GpuParticle, ctx: GpuBuildContext, params: Record<string, unknown>): void;
  /** Why these params can't run on the GPU, or null. */
  unsupported?(params: Record<string, unknown>): string | null;
}

const registry = new Map<string, GpuModuleImpl>();

export function registerGpuModule(type: string, impl: GpuModuleImpl): void {
  registry.set(type, impl);
}

export function getGpuModule(type: string): GpuModuleImpl | undefined {
  return registry.get(type);
}

/** Uniform random unit vector from two randoms. */
function randomDir(u: Node, phi: Node): Node {
  const z: Node = u.mul(2).sub(1);
  const s: Node = sqrt(float(1).sub(z.mul(z)));
  return vec3(s.mul(cos(phi)), z, s.mul(sin(phi)));
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

registerGpuModule("init.lifetime", {
  emit(p, ctx, params) {
    const v = params.lifetime as FloatValue;
    // (the CPU's live-count upper bound reads init.lifetime from the template: GpuEmitter)
    p.life.assign(max(ctx.float(v, 1, 101), 1e-3));
  },
});

registerGpuModule("init.shape", {
  emit(p, ctx, params) {
    const shape = params.shape as string;
    const radius = params.radius as number;
    const k = params.thickness as number;
    const angle = (params.angle as number) * DEG;
    const arc = ((params.arc as number) / 360) * TAU;
    const [bx, by, bz] = params.boxSize as number[];
    const len = params.length as number;
    const [ox, oy, oz] = params.offset as number[];
    const [rx, ry, rz] = params.rotation as number[];
    const q = quatFromEulerDeg(rx, ry, rz);
    const randomDirAmt = params.randomDirection as number;
    const inner3 = Math.pow(1 - k, 3);
    const inner2 = Math.pow(1 - k, 2);

    let pos: Node = vec3(0);
    let dir: Node = vec3(0, 1, 0);
    switch (shape) {
      case "point":
      case "sphere":
      case "hemisphere": {
        let d: Node = randomDir(ctx.rand(201), ctx.rand(202).mul(TAU));
        if (shape === "hemisphere") d = vec3(d.x, abs(d.y), d.z);
        dir = d;
        if (shape !== "point") {
          const r: Node = ctx.rand(203).mul(1 - inner3).add(inner3).pow(1 / 3).mul(radius);
          pos = d.mul(r);
        }
        break;
      }
      case "cone": {
        const phi: Node = ctx.rand(204).mul(arc);
        const c: Node = cos(phi);
        const s: Node = sin(phi);
        if (radius > 0) {
          const rn: Node = sqrt(ctx.rand(205).mul(1 - inner2).add(inner2));
          pos = vec3(c.mul(rn).mul(radius), 0, s.mul(rn).mul(radius));
          const t: Node = rn.mul(Math.tan(Math.min(89.9 * DEG, angle)));
          const l: Node = t.mul(t).add(1).sqrt();
          dir = vec3(c.mul(t).div(l), float(1).div(l), s.mul(t).div(l));
        } else {
          const ct: Node = float(1).sub(ctx.rand(205).mul(1 - Math.cos(angle)));
          const st: Node = float(1).sub(ct.mul(ct)).sqrt();
          dir = vec3(c.mul(st), ct, s.mul(st));
        }
        break;
      }
      case "box":
        pos = vec3(ctx.rand(206).sub(0.5).mul(bx), ctx.rand(207).sub(0.5).mul(by), ctx.rand(208).sub(0.5).mul(bz));
        break;
      case "circle": {
        const phi: Node = ctx.rand(209).mul(arc);
        const rn: Node = sqrt(ctx.rand(210).mul(1 - inner2).add(inner2));
        dir = vec3(cos(phi), 0, sin(phi));
        pos = dir.mul(rn.mul(radius));
        break;
      }
      case "line":
        pos = vec3(ctx.rand(211).sub(0.5).mul(len), 0, 0);
        break;
    }
    if (randomDirAmt > 0) dir = normalize(dir.mul(1 - randomDirAmt).add(randomDir(ctx.rand(212), ctx.rand(213).mul(TAU)).mul(randomDirAmt)));
    if (!isIdentityQuat(q)) {
      const qn: Node = vec4(...q);
      pos = rotateQ(qn, pos);
      dir = rotateQ(qn, dir);
    }
    p.pos.assign(pos.add(vec3(ox, oy, oz)));
    p.vel.assign(dir.mul(ctx.float(params.speed as FloatValue, 0, 214)));
  },
});

registerGpuModule("init.velocity", {
  emit(p, ctx, params) {
    const [x, y, z] = params.velocity as number[];
    const [sx, sy, sz] = params.spread as number[];
    p.vel.addAssign(vec3(x, y, z).add(vec3(ctx.rand(301).mul(2).sub(1).mul(sx), ctx.rand(302).mul(2).sub(1).mul(sy), ctx.rand(303).mul(2).sub(1).mul(sz))));
  },
});

registerGpuModule("init.size", {
  emit(p, ctx, params) {
    p.size.assign(ctx.float(params.size as FloatValue, 1, 401));
  },
});

registerGpuModule("init.rotation", {
  emit(p, ctx, params) {
    p.rot.assign(ctx.float(params.angle as FloatValue, 0, 501).mul(DEG));
    p.spin.assign(ctx.float(params.spin as FloatValue, 0, 502).mul(DEG));
  },
});

registerGpuModule("init.color", {
  emit(p, ctx, params) {
    p.color.assign(ctx.color(params.color as ColorValue, 601));
  },
});

registerGpuModule("init.inheritVelocity", {
  emit(p, ctx, params) {
    p.vel.addAssign(ctx.worldDirToSim(ctx.u.velocity).mul(ctx.float(params.factor as FloatValue, 1, 701)));
  },
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

registerGpuModule("update.gravity", {
  emit(p, ctx, params) {
    const g = params.gravity as Vec3;
    p.vel.addAssign(ctx.worldDirToSim(g).mul((params.scale as number) * 1).mul(ctx.u.dt));
  },
});

registerGpuModule("update.force", {
  emit(p, ctx, params) {
    const f = params.force as Vec3;
    const dirNode = params.space === "local" ? ctx.localDirToSim(f) : ctx.worldDirToSim(f);
    p.vel.addAssign(dirNode.mul(ctx.float(params.scale as FloatValue, 1, 801)).mul(ctx.u.dt));
  },
});

registerGpuModule("update.drag", {
  emit(p, ctx, params) {
    p.vel.mulAssign(float(1).div(max(ctx.float(params.drag as FloatValue, 0.5, 901), 0).mul(ctx.u.dt).add(1)));
  },
});

registerGpuModule("update.attractor", {
  emit(p, ctx, params) {
    const c: Node = ctx.localPointToSim(params.position as Vec3);
    const strength = params.strength as number;
    const radius = params.radius as number;
    const kill2 = (params.killRadius as number) ** 2;
    const d: Node = c.sub(p.pos);
    const d2: Node = dot(d, d);
    if (kill2 > 0) If(d2.lessThan(kill2), () => void p.age01.assign(1));
    const f: Node = float(strength).div(d2.div(radius * radius).add(1)).div(max(sqrt(d2), 1e-4)).mul(ctx.u.dt);
    p.vel.addAssign(d.mul(f));
  },
});

registerGpuModule("update.vortex", {
  emit(p, ctx, params) {
    const [ax, ay, az] = params.axis as number[];
    const al = Math.hypot(ax, ay, az) || 1;
    const a: Node = ctx.localDirToSim([ax / al, ay / al, az / al]);
    const c: Node = ctx.localPointToSim(params.center as Vec3);
    const strength = params.strength as number;
    const pull = params.pull as number;
    const r0: Node = p.pos.sub(c);
    const r: Node = r0.sub(a.mul(dot(r0, a)));
    const d: Node = max(length(r), 1e-5);
    const t: Node = cross(a, r);
    p.vel.addAssign(t.mul(float(strength).div(d).mul(ctx.u.dt)).sub(r.mul(float(pull).div(d).mul(ctx.u.dt))));
  },
});

registerGpuModule("update.turbulence", {
  emit(p, ctx, params) {
    const freq = params.frequency as number;
    const scroll = params.scroll as number;
    const s: Node = ctx.float(params.strength as FloatValue, 2, 1001).mul(ctx.u.dt);
    // same field as the CPU (sim/math noise3 with its permutation table), so effects look alike on both backends
    const o: Node = ctx.u.time.mul(scroll);
    p.vel.addAssign(turbulenceField(p.pos.mul(freq), o).mul(s));
  },
});

registerGpuModule("update.limitVelocity", {
  emit(p, ctx, params) {
    const m: Node = ctx.float(params.maxSpeed as FloatValue, 5, 1101);
    const dampen = params.dampen as number;
    const speed: Node = length(p.vel);
    const k: Node = select(speed.greaterThan(m), m.div(max(speed, 1e-6)).sub(1).mul(dampen).add(1), float(1));
    p.vel.mulAssign(k);
  },
});

registerGpuModule("update.collisionPlane", {
  emit(p, ctx, params) {
    const point: Node = vec3(...(params.point as Vec3));
    const [n0, n1, n2] = params.normal as number[];
    const nl = Math.hypot(n0, n1, n2) || 1;
    const n: Node = vec3(n0 / nl, n1 / nl, n2 / nl);
    const bounce = params.bounce as number;
    const friction = params.friction as number;
    const loss = params.lifetimeLoss as number;
    const kill = params.kill as boolean;
    const next: Node = p.pos.add(p.vel.mul(ctx.u.dt));
    const vn: Node = dot(p.vel, n);
    If(dot(next.sub(point), n).lessThan(0).and(vn.lessThan(0)), () => {
      if (kill) {
        p.age01.assign(1);
        return;
      }
      const tangent: Node = p.vel.sub(n.mul(vn));
      p.vel.assign(tangent.mul(1 - friction).sub(n.mul(vn.mul(bounce))));
      const pd: Node = dot(p.pos.sub(point), n);
      p.pos.subAssign(n.mul(clamp(pd, -1e9, 0)));
      if (loss > 0) p.age01.addAssign(loss);
    });
  },
});
