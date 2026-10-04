// A rig on a model: effects and lights on its sockets, parameters fed by signals.
//
//   const rig = new RigInstance(world, rigDoc);
//   shipModel.add(rig.object);              // sockets follow the model
//   // every frame, after the model's transform is final and before world.update:
//   rig.setSignals({ throttle: input.forward ? 1 : 0.2, speed });
//   rig.update(dt);
import * as THREE from "three/webgpu";
import type { RigDoc, RigLightDoc, SocketDoc } from "../rig/types";
import type { ParticleEffect, ParticleWorld } from "./world";

export interface RigInstanceOptions {
  /** Initial signal values (others read as 0). */
  signals?: Record<string, number>;
  /** Start without playing (call play()). */
  paused?: boolean;
}

interface LiveAttachment {
  key: string;
  handle: ParticleEffect | null;
}

const DEG = Math.PI / 180;

export class RigInstance {
  /** Add under the model's object; socket transforms are relative to it. */
  readonly object = new THREE.Group();
  #world: ParticleWorld;
  #doc: RigDoc;
  #sockets = new Map<string, THREE.Object3D>();
  #attachments = new Map<string, LiveAttachment>();
  #lights = new Map<string, THREE.PointLight>();
  #signals = new Map<string, number>();
  #playing: boolean;
  #disposed = false;

  // scratch
  #pos = new THREE.Vector3();
  #quat = new THREE.Quaternion();
  #scale = new THREE.Vector3();

  constructor(world: ParticleWorld, doc: RigDoc, opts: RigInstanceOptions = {}) {
    this.#world = world;
    this.#doc = doc;
    this.#playing = !opts.paused;
    this.object.name = "Rig";
    for (const [k, v] of Object.entries(opts.signals ?? {})) this.#signals.set(k, v);
    this.setDoc(doc);
  }

  get doc(): RigDoc {
    return this.#doc;
  }

  /** The socket's object (children follow it), e.g. to attach a gizmo or another mesh. */
  socket(slug: string): THREE.Object3D | undefined {
    return this.#sockets.get(slug);
  }

  /** Live effect handle of an attachment (null until its effect is registered). */
  effect(slug: string): ParticleEffect | null {
    return this.#attachments.get(slug)?.handle ?? null;
  }

  light(slug: string): THREE.PointLight | undefined {
    return this.#lights.get(slug);
  }

  setSignal(name: string, value: number): this {
    this.#signals.set(name, value);
    return this;
  }

  setSignals(values: Record<string, number>): this {
    for (const [k, v] of Object.entries(values)) this.#signals.set(k, v);
    return this;
  }

  signal(name: string): number {
    return this.#signals.get(name) ?? 0;
  }

  /**
   * Apply a new version of the rig. Sockets and lights update in place;
   * attachments keep their effect instance unless their effect or socket
   * changed, so editing doesn't restart running effects.
   */
  setDoc(doc: RigDoc): void {
    this.#doc = doc;
    for (const [slug, obj] of this.#sockets)
      if (!doc.sockets[slug]) {
        obj.removeFromParent();
        this.#sockets.delete(slug);
      }
    for (const [slug, s] of Object.entries(doc.sockets)) {
      let obj = this.#sockets.get(slug);
      if (!obj) {
        obj = new THREE.Object3D();
        obj.name = slug;
        this.#sockets.set(slug, obj);
        this.object.add(obj);
      }
      applySocket(obj, s);
    }

    for (const [slug, live] of this.#attachments) {
      const a = doc.attachments[slug];
      if (!a || a.enabled === false || attachmentKey(a) !== live.key) {
        this.#releaseEffect(live);
        this.#attachments.delete(slug);
      }
    }
    for (const [slug, a] of Object.entries(doc.attachments)) {
      if (a.enabled === false || this.#attachments.has(slug)) continue;
      this.#attachments.set(slug, { key: attachmentKey(a), handle: null });
    }

    for (const [slug, light] of this.#lights) {
      const l = doc.lights[slug];
      if (!l || l.enabled === false || !this.#sockets.has(l.socket)) {
        light.removeFromParent();
        light.dispose();
        this.#lights.delete(slug);
      }
    }
    for (const [slug, l] of Object.entries(doc.lights)) {
      if (l.enabled === false) continue;
      const socket = this.#sockets.get(l.socket);
      if (!socket) continue;
      let light = this.#lights.get(slug);
      if (!light) {
        light = new THREE.PointLight();
        light.name = slug;
        this.#lights.set(slug, light);
      }
      if (light.parent !== socket) socket.add(light);
      this.#applyLight(light, l);
    }
  }

  #applyLight(light: THREE.PointLight, l: RigLightDoc) {
    light.color.set(l.color);
    light.distance = l.range;
    light.decay = 2;
    light.intensity = l.intensity * (l.signal ? this.signal(l.signal) : 1);
    light.visible = this.#playing;
  }

  /**
   * Move effects to their sockets and feed parameters. Call once per frame
   * after the model's transform is final and before ParticleWorld.update.
   */
  update(_dt: number): void {
    if (this.#disposed) return;
    this.object.updateWorldMatrix(true, true);
    for (const [slug, live] of this.#attachments) {
      const a = this.#doc.attachments[slug];
      const socket = this.#sockets.get(a.socket);
      if (!socket) continue;
      socket.matrixWorld.decompose(this.#pos, this.#quat, this.#scale);
      const scale = (a.scale ?? 1) * this.#scale.x;
      if (!live.handle || live.handle.released) {
        if (!this.#world.has(a.effect)) continue;
        live.handle = this.#world.spawn(a.effect, { position: this.#pos, rotation: this.#quat, scale, autoRelease: false, paused: !this.#playing, params: this.#params(a.params) });
        continue;
      }
      // the simulation derives inherited velocity from the movement
      const h = live.handle;
      h.setTransform(this.#pos, this.#quat, scale);
      for (const [name, value] of Object.entries(this.#params(a.params))) h.setParam(name, value);
    }
    for (const [slug, light] of this.#lights) this.#applyLight(light, this.#doc.lights[slug]);
  }

  #params(bindings: Record<string, string | number> | undefined): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [name, b] of Object.entries(bindings ?? {})) out[name] = typeof b === "number" ? b : this.signal(b);
    return out;
  }

  /** Start (or restart) every effect and turn the lights on. */
  play(): this {
    this.#playing = true;
    for (const live of this.#attachments.values()) live.handle?.teleport().play();
    for (const light of this.#lights.values()) light.visible = true;
    return this;
  }

  /** Stop spawning (live particles finish) and turn the lights off. */
  stop(): this {
    this.#playing = false;
    for (const live of this.#attachments.values()) live.handle?.stop();
    for (const light of this.#lights.values()) light.visible = false;
    return this;
  }

  get playing(): boolean {
    return this.#playing;
  }

  /** The model jumped (warp, respawn): don't smear particles along the jump. */
  teleport(): this {
    this.object.updateWorldMatrix(true, true);
    for (const [slug, live] of this.#attachments) {
      const socket = this.#sockets.get(this.#doc.attachments[slug].socket);
      if (!socket || !live.handle) continue;
      socket.matrixWorld.decompose(this.#pos, this.#quat, this.#scale);
      live.handle.setTransform(this.#pos, this.#quat).teleport();
    }
    return this;
  }

  #releaseEffect(live: LiveAttachment, linger = false) {
    const h = live.handle;
    live.handle = null;
    if (!h) return;
    if (linger && h.alive) {
      h.autoRelease = true;
      h.stop();
    } else h.release();
  }

  /**
   * Remove the rig. With `linger` (default true) effects stop spawning and
   * their live particles finish in place, so a destroyed ship's trail fades.
   */
  dispose(opts: { linger?: boolean } = {}): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const live of this.#attachments.values()) this.#releaseEffect(live, opts.linger ?? true);
    this.#attachments.clear();
    for (const light of this.#lights.values()) light.dispose();
    this.#lights.clear();
    this.object.removeFromParent();
  }
}

function attachmentKey(a: { effect: string; socket: string }): string {
  return `${a.effect}\u0000${a.socket}`;
}

function applySocket(obj: THREE.Object3D, s: SocketDoc) {
  obj.position.set(...s.position);
  const r = s.rotation ?? [0, 0, 0];
  obj.rotation.set(r[0] * DEG, r[1] * DEG, r[2] * DEG, "XYZ");
}
