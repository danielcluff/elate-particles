// The worker side: a complete ParticleWorld (LOD, budget, culling, sort
// groups, ribbons, trails, sorting) whose packed batch arrays are shipped to
// the main thread each frame. Its three.js objects are never rendered.

import * as THREE from "three/webgpu";
import "../index";
import { ParticleWorld, type ParticleEffect } from "../three/world";
import type { FrameResult, FromWorker, HandleOp, ToWorker } from "./protocol";

const toV = (v: number[]) => ({ x: v[0], y: v[1], z: v[2] });
const toQ = (q: number[]) => ({ x: q[0], y: q[1], z: q[2], w: q[3] });

/**
 * Returns the message handler. `post` sends a message with its transfer list
 * (worker: `self.postMessage`; tests: an in-process channel).
 */
export function createParticleWorkerHost(post: (msg: FromWorker, transfer: Transferable[]) => void): (msg: ToWorker) => void {
  let world: ParticleWorld | null = null;
  let layout = 0;
  const handles = new Map<number, ParticleEffect>();
  const finished: number[] = [];
  const placeholder = new THREE.Texture();
  // stand-in for the main thread's camera: matrices are copied in, never derived
  const camera = new THREE.PerspectiveCamera();
  camera.matrixAutoUpdate = false;

  const ensureWorld = (): ParticleWorld => (world ??= new ParticleWorld({ silent: true, loadTexture: () => placeholder }));

  function apply(op: HandleOp, rejected: number[]): void {
    const w = ensureWorld();
    if (op.op === "spawn") {
      if (!w.has(op.effect)) {
        rejected.push(op.id);
        return;
      }
      const o = op.opts;
      const h = w.spawn(op.effect, {
        position: o.position ? toV(o.position) : undefined,
        rotation: o.rotation ? toQ(o.rotation) : undefined,
        scale: o.scale,
        params: o.params,
        autoRelease: o.autoRelease,
        paused: o.paused,
        seed: o.seed,
      });
      if (h.rejected) {
        rejected.push(op.id);
        return;
      }
      h.onFinished = () => finished.push(op.id);
      handles.set(op.id, h);
      return;
    }
    const h = handles.get(op.id);
    if (!h) return;
    switch (op.op) {
      case "transform":
        h.setTransform(toV(op.p), op.q ? toQ(op.q) : undefined, op.s);
        break;
      case "velocity":
        h.setVelocity(op.v ? toV(op.v) : null);
        break;
      case "param":
        h.setParam(op.name, op.value);
        break;
      case "autoRelease":
        h.autoRelease = op.value;
        break;
      case "play":
        h.play();
        break;
      case "stop":
        h.stop();
        break;
      case "clear":
        h.clear();
        break;
      case "teleport":
        h.teleport();
        break;
      case "release":
        h.release();
        break;
    }
  }

  return (msg: ToWorker) => {
    switch (msg.type) {
      case "init":
        world = new ParticleWorld({ ...msg.options, silent: true, loadTexture: () => placeholder });
        break;
      case "register":
        ensureWorld().register(msg.doc);
        layout++;
        break;
      case "unregister":
        ensureWorld().unregister(msg.id);
        layout++;
        break;
      case "settings": {
        const w = ensureWorld();
        if (msg.quality !== undefined) w.quality = msg.quality;
        if (msg.budget !== undefined) w.budget = msg.budget;
        break;
      }
      case "frame": {
        const w = ensureWorld();
        const before = w._batchList();
        msg.spares.forEach((a, i) => a && before[i]?.adoptSpare(a));
        const rejected: number[] = [];
        for (const op of msg.ops) apply(op, rejected);

        let cam: THREE.Camera | undefined;
        if (msg.camera) {
          const c = msg.camera;
          camera.matrix.fromArray(c.matrixWorld);
          camera.matrixWorldNeedsUpdate = true;
          camera.projectionMatrix.fromArray(c.projection);
          camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
          camera.coordinateSystem = c.coordinateSystem as THREE.CoordinateSystem;
          (camera as unknown as { _reversedDepth: boolean })._reversedDepth = c.reversedDepth;
          cam = camera;
        }
        w.update(msg.dt, cam);

        const transfer: Transferable[] = [];
        const batches = w._batchList().map((b) => {
          if (b.instances === 0) return { data: null, count: 0 };
          const f = b.exportFrame();
          transfer.push(f.data.buffer);
          return f;
        });

        const released: number[] = [];
        const states = new Float64Array(handles.size * 3);
        let k = 0;
        for (const [id, h] of handles) {
          if (h.released) {
            released.push(id);
            handles.delete(id);
            continue;
          }
          states[k++] = id;
          states[k++] = h.particleCount;
          states[k++] = (h.alive ? 1 : 0) | (h.culled ? 2 : 0);
        }
        const result: FrameResult = {
          type: "result",
          frame: msg.frame,
          layout,
          batches,
          stats: w.stats,
          states: states.subarray(0, k),
          finished: finished.splice(0),
          released,
          rejected,
        };
        post(result, transfer);
        break;
      }
    }
  };
}
