import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { pass } from "three/tsl";
import { ParticleWorld, WorkerParticleWorld, type ParticleEffect, type WorkerParticleEffect } from "../src/three";
import { validateEffect } from "../src/index";
import { ALL_EFFECTS, campfire, explosion, firework, gpuSmoke, swarm, thruster, torch, tracer, volley } from "./effects";

const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070c);
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 500);
camera.position.set(5, 3.5, 7);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.5, 0);
controls.enableDamping = true;

// solid ground and rocks: opaque geometry for soft particles to fade against
const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2), new THREE.MeshStandardNodeMaterial({ color: 0x0c111a, roughness: 1 }));
scene.add(ground);
for (const [x, z, s] of [[0.9, 0.2, 0.55], [-0.7, 0.6, 0.45], [-0.2, -0.9, 0.5], [0.5, -0.6, 0.35]]) {
  const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), new THREE.MeshStandardNodeMaterial({ color: 0x2a2622, roughness: 0.9 }));
  rock.position.set(x, s * 0.4, z);
  rock.rotation.set(x, z, s);
  scene.add(rock);
}
const grid = new THREE.GridHelper(60, 60, 0x223044, 0x141c28);
grid.position.y = 0.002;
scene.add(grid);
// for lit mesh particles
scene.add(new THREE.HemisphereLight(0xb0c4ff, 0x302010, 1.2));
const sun = new THREE.DirectionalLight(0xffeedd, 2.5);
sun.position.set(5, 10, 4);
scene.add(sun);

// ?worker=1 runs the CPU simulation in a Web Worker (same API)
const useWorker = new URLSearchParams(location.search).has("worker");
const world = useWorker
  ? new WorkerParticleWorld(new Worker(new URL("./particles.worker.ts", import.meta.url), { type: "module" }))
  : new ParticleWorld({ renderer });
type Handle = ParticleEffect | WorkerParticleEffect;
scene.add(world.object);
const registerAll = () => {
  for (const fx of ALL_EFFECTS) {
    const issues = validateEffect(fx);
    if (issues.length) console.warn(fx.name, issues);
    world.register(fx);
  }
};

// ---- scenes ----------------------------------------------------------------

type Scene = { enter(): void; update(dt: number, t: number): void; exit(): void };
let live: Handle[] = [];
const clearLive = () => {
  for (const h of live) h.release();
  live = [];
};

const ui = {
  rate: 20,
  throttle: 1,
};

const scenes: Record<string, Scene> = {
  campfire: {
    enter() {
      live.push(world.spawn(campfire, { autoRelease: false }));
    },
    update() {},
    exit: clearLive,
  },
  thruster: {
    enter() {
      live.push(world.spawn(thruster, { autoRelease: false }));
    },
    update(_dt, t) {
      const h = live[0];
      const a = t * 0.8;
      const pos = new THREE.Vector3(Math.cos(a) * 6, 2 + Math.sin(t * 1.3) * 0.5, Math.sin(a) * 6);
      // ship faces along its path (+Z forward), exhaust out the back
      const forward = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a));
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), forward);
      h.setTransform(pos, q).setParam("throttle", ui.throttle);
      ship.position.copy(pos);
      ship.quaternion.copy(q);
    },
    exit() {
      clearLive();
      ship.visible = false;
    },
  },
  explosion: {
    enter() {
      timer = 0;
    },
    update(dt) {
      timer -= dt;
      if (timer <= 0) {
        timer = 1.6;
        world.spawn(explosion, { position: new THREE.Vector3(0, 1.2, 0) });
      }
    },
    exit() {},
  },
  tracers: {
    enter() {
      timer = 0;
    },
    update(dt) {
      timer -= dt;
      if (timer <= 0) {
        timer = 0.08;
        // a volley crossing the scene at 60 u/s
        const from = new THREE.Vector3(-25, 1 + Math.random() * 3, (Math.random() - 0.5) * 8);
        const dir = new THREE.Vector3(1, Math.random() * 0.1, (Math.random() - 0.5) * 0.2).normalize();
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
        bolts.push({ h: world.spawn(tracer, { position: from, rotation: q, autoRelease: false }), pos: from, dir, t: 0 });
      }
      for (let i = bolts.length - 1; i >= 0; i--) {
        const b = bolts[i];
        b.t += dt;
        b.pos.addScaledVector(b.dir, 60 * dt);
        b.h.setTransform(b.pos).setVelocity(b.dir.clone().multiplyScalar(60));
        if (b.t > 0.9) {
          world.spawn(explosion, { position: b.pos, scale: 0.3 });
          b.h.release();
          bolts.splice(i, 1);
        }
      }
    },
    exit() {
      for (const b of bolts) b.h.release();
      bolts.length = 0;
    },
  },
  fireworks: {
    enter() {
      timer = 0;
      camera.position.set(0, 6, 28);
      controls.target.set(0, 9, 0);
    },
    update(dt) {
      timer -= dt;
      if (timer <= 0) {
        timer = 0.7 + Math.random() * 0.5;
        world.spawn(firework, { position: new THREE.Vector3((Math.random() - 0.5) * 14, 0, (Math.random() - 0.5) * 6) });
      }
    },
    exit() {
      camera.position.set(5, 3.5, 7);
      controls.target.set(0, 1.5, 0);
    },
  },
  gpu: {
    enter() {
      camera.position.set(0, 14, 26);
      controls.target.set(0, 2, 0);
      live.push(world.spawn(swarm, { autoRelease: false, position: new THREE.Vector3(-6, 3, 0) }));
      live.push(world.spawn(gpuSmoke, { autoRelease: false, position: new THREE.Vector3(8, 0, 0) }));
    },
    update() {},
    exit() {
      clearLive();
      camera.position.set(5, 3.5, 7);
      controls.target.set(0, 1.5, 0);
    },
  },
  crowd: {
    // 100 GPU torches: one pool, one draw call (batched across instances); every 2 s one is replaced
    enter() {
      camera.position.set(0, 26, 34);
      controls.target.set(0, 0, 0);
      for (let x = 0; x < 10; x++) for (let z = 0; z < 10; z++) live.push(world.spawn(torch, { autoRelease: false, position: new THREE.Vector3(x * 4 - 18, 0, z * 4 - 18) }));
      timer = 0;
    },
    update(dt, t) {
      // the corner torch circles: per-instance transforms are per lane
      live[0]?.setPosition(-18 + Math.cos(t) * 3, 0, -18 + Math.sin(t) * 3);
      timer += dt;
      if (timer > 2 && live.length > 1) {
        timer = 0;
        const i = 1 + Math.floor(Math.random() * (live.length - 1));
        const p = live[i].sim!.transform.position;
        live[i].release();
        live[i] = world.spawn(torch, { autoRelease: false, position: new THREE.Vector3(p[0], 0, p[2]) });
      }
    },
    exit() {
      clearLive();
      camera.position.set(5, 3.5, 7);
      controls.target.set(0, 1.5, 0);
    },
  },
  volley: {
    enter() {
      camera.position.set(0, 10, 42);
      controls.target.set(0, 12, 0);
      live.push(world.spawn(volley, { autoRelease: false }));
    },
    update() {},
    exit() {
      clearLive();
      camera.position.set(5, 3.5, 7);
      controls.target.set(0, 1.5, 0);
    },
  },
  stress: {
    enter() {
      timer = 0;
    },
    update(dt) {
      timer += dt * ui.rate;
      while (timer >= 1) {
        timer -= 1;
        world.spawn(explosion, { position: new THREE.Vector3((Math.random() - 0.5) * 40, 1 + Math.random() * 3, (Math.random() - 0.5) * 40), scale: 0.6 + Math.random() * 0.6 });
      }
    },
    exit() {},
  },
};
let timer = 0;
const bolts: { h: Handle; pos: THREE.Vector3; dir: THREE.Vector3; t: number }[] = [];

const ship = new THREE.Mesh(new THREE.ConeGeometry(0.3, 1.2, 8).rotateX(Math.PI / 2), new THREE.MeshBasicNodeMaterial({ color: 0x8899aa, wireframe: true }));
ship.visible = false;
scene.add(ship);

let current = "campfire";
function setScene(name: string) {
  scenes[current].exit();
  current = name;
  ship.visible = name === "thruster";
  if (name === "stress") camera.position.set(30, 22, 34);
  scenes[current].enter();
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-scene]")) b.classList.toggle("on", b.dataset.scene === name);
  for (const id of ["#rate-row", "#budget-row", "#quality-row"]) document.querySelector<HTMLElement>(id)!.style.display = name === "stress" ? "" : "none";
  document.querySelector<HTMLElement>("#throttle-row")!.style.display = name === "thruster" ? "" : "none";
}

for (const b of document.querySelectorAll<HTMLButtonElement>("[data-scene]")) b.onclick = () => setScene(b.dataset.scene!);
document.querySelector<HTMLInputElement>("#rate")!.oninput = (e) => (ui.rate = +(e.target as HTMLInputElement).value);
document.querySelector<HTMLInputElement>("#budget")!.oninput = (e) => {
  const v = +(e.target as HTMLInputElement).value;
  world.budget = v || null;
  document.querySelector("#budget-label")!.textContent = v ? `${v / 1000}k` : "off";
};
document.querySelector<HTMLInputElement>("#quality")!.oninput = (e) => {
  world.quality = +(e.target as HTMLInputElement).value;
  document.querySelector("#quality-label")!.textContent = world.quality.toFixed(2);
};
document.querySelector<HTMLInputElement>("#throttle")!.oninput = (e) => (ui.throttle = +(e.target as HTMLInputElement).value);

// ---- loop ------------------------------------------------------------------

const stats = document.querySelector<HTMLElement>("#stats")!;
const clock = new THREE.Timer();
let frames = 0;
let acc = 0;
let simMs = 0;

await renderer.init();
registerAll();

// ?post=1 renders through a RenderPipeline scene pass, as Redshift does
const pipeline = new URLSearchParams(location.search).has("post") ? new THREE.RenderPipeline(renderer) : null;
if (pipeline) pipeline.outputNode = pass(scene, camera);
setScene(new URLSearchParams(location.search).get("scene") ?? "campfire");

renderer.setAnimationLoop(() => {
  clock.update();
  const dt = clock.getDelta();
  const t = clock.getElapsed();
  scenes[current].update(dt, t);
  const t0 = performance.now();
  world.update(dt, camera);
  simMs += performance.now() - t0;
  controls.update();
  if (pipeline) pipeline.render();
  else renderer.render(scene, camera);

  frames++;
  acc += dt;
  if (acc >= 0.5) {
    const s = world.stats;
    stats.textContent =
      `${useWorker ? "[worker] " : ""}${Math.round(frames / acc)} fps · ${useWorker ? "main thread" : "sim+pack"} ${(simMs / frames).toFixed(2)} ms` +
      (world instanceof WorkerParticleWorld ? ` + apply ${world.lastApplyMs.toFixed(2)} ms` : "") +
      ` · ${s.particles} simulated / ${s.drawnParticles} drawn · ` +
      `${s.instances} instances (${s.culledInstances} culled) · ${s.drawCalls} draws` +
      (world.budget ? ` · budget scale ${s.budgetScale.toFixed(2)}` : "");
    frames = 0;
    acc = 0;
    simMs = 0;
  }
});

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

Object.assign(window, { world, THREE, renderer, camera, controls });
