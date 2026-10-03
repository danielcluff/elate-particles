import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { ParticleWorld, type ParticleEffect } from "../src/three";
import { validateEffect } from "../src/index";
import { ALL_EFFECTS, campfire, explosion, thruster } from "./effects";

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

const grid = new THREE.GridHelper(60, 60, 0x223044, 0x141c28);
scene.add(grid);

const world = new ParticleWorld();
scene.add(world.object);
for (const fx of ALL_EFFECTS) {
  const issues = validateEffect(fx);
  if (issues.length) console.warn(fx.name, issues);
  world.register(fx);
}

// ---- scenes ----------------------------------------------------------------

type Scene = { enter(): void; update(dt: number, t: number): void; exit(): void };
let live: ParticleEffect[] = [];
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
  document.querySelector<HTMLElement>("#rate-row")!.style.display = name === "stress" ? "" : "none";
  document.querySelector<HTMLElement>("#throttle-row")!.style.display = name === "thruster" ? "" : "none";
}

for (const b of document.querySelectorAll<HTMLButtonElement>("[data-scene]")) b.onclick = () => setScene(b.dataset.scene!);
document.querySelector<HTMLInputElement>("#rate")!.oninput = (e) => (ui.rate = +(e.target as HTMLInputElement).value);
document.querySelector<HTMLInputElement>("#throttle")!.oninput = (e) => (ui.throttle = +(e.target as HTMLInputElement).value);

// ---- loop ------------------------------------------------------------------

const stats = document.querySelector<HTMLElement>("#stats")!;
const clock = new THREE.Timer();
let frames = 0;
let acc = 0;
let simMs = 0;

await renderer.init();
setScene(new URLSearchParams(location.search).get("scene") ?? "campfire");

renderer.setAnimationLoop(() => {
  clock.update();
  const dt = clock.getDelta();
  const t = clock.getElapsed();
  scenes[current].update(dt, t);
  const t0 = performance.now();
  world.update(dt);
  simMs += performance.now() - t0;
  controls.update();
  renderer.render(scene, camera);

  frames++;
  acc += dt;
  if (acc >= 0.5) {
    const s = world.stats;
    stats.textContent = `${Math.round(frames / acc)} fps · sim+pack ${(simMs / frames).toFixed(2)} ms · ${s.particles} particles · ${s.instances} instances · ${s.drawCalls} draw calls`;
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

Object.assign(window, { world, THREE, renderer });
