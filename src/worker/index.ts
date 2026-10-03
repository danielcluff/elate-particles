// tsl-particles/worker: run the CPU simulation off the main thread.
//
//   // particles.worker.ts
//   import { startParticleWorker } from "tsl-particles/worker";
//   import "./my-custom-modules"; // register custom modules here too
//   startParticleWorker();
//
// and on the main thread use WorkerParticleWorld (tsl-particles/three).

import { createParticleWorkerHost } from "./host";
import type { FromWorker, ToWorker } from "./protocol";

export { createParticleWorkerHost } from "./host";
export type * from "./protocol";

interface WorkerScope {
  postMessage(msg: FromWorker, transfer: Transferable[]): void;
  addEventListener(type: "message", fn: (e: { data: ToWorker }) => void): void;
}

/** Wires the particle host to the current worker scope. */
export function startParticleWorker(scope: WorkerScope = self as unknown as WorkerScope): void {
  const handle = createParticleWorkerHost((msg, transfer) => scope.postMessage(msg, transfer));
  scope.addEventListener("message", (e) => handle(e.data));
}
