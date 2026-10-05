// A rig on a model: effects and lights on its sockets, parameters fed by signals.
//
//   const rig = new RigInstance(world, rigDoc);
//   shipModel.add(rig.object);              // sockets follow the model
//   // every frame, after the model's transform is final and before world.update:
//   rig.setSignals({ throttle: input.forward ? 1 : 0.2, speed });
//   rig.update(dt);
//   // when something happens (world-space position and normal, 0..1 strength):
//   rig.trigger("shield-hit", { position: impact, normal, strength: damage / maxShield });
import * as THREE from "three/webgpu";
import { evalCurve } from "../core/values";
import type { Curve } from "../core/types";
import { eventDuration } from "../rig/doc";
import type { RigDoc, RigEventDoc, RigLightDoc, SocketDoc, TrackDoc } from "../rig/types";
import type { ParticleEffect, ParticleWorld } from "./world";

interface XYZ {
  x: number;
  y: number;
  z: number;
}

/** Where and how hard an event happened. Positions and normals are in world space. */
export interface RigEventContext {
  position?: XYZ;
  /** Effects without a socket point their +Z along it. */
  normal?: XYZ;
  /** 0..1, default 1: scales lights, shakes, sounds and channels; effect params can bind "strength". */
  strength?: number;
  /** Extra values effect params can bind by name (beside signals and "strength"). */
  params?: Record<string, number>;
}

/** Something the host does for a track (the rig owns neither the camera nor audio). */
export type RigCue =
  | { type: "shake"; event: string; track: string; position: THREE.Vector3; amplitude: number; frequency: number; duration: number }
  | { type: "sound"; event: string; track: string; position: THREE.Vector3; sound: string; volume: number };

/** A playing event; stop() ends it early (effects already spawned finish on their own). */
export interface RigEventHandle {
  readonly event: string;
  readonly done: boolean;
  /** Seconds since the event. */
  readonly time: number;
  stop(): void;
}

interface Timeline {
  event: string;
  doc: RigEventDoc;
  duration: number;
  t: number;
  ctx: RigEventContext;
  position: THREE.Vector3 | null;
  orientation: THREE.Quaternion | null;
  fired: Set<string>;
  lights: Map<string, THREE.PointLight>;
  following: Map<string, ParticleEffect>;
  done: boolean;
}

const FADE_OUT: Curve = { keys: [{ t: 0, v: 1 }, { t: 1, v: 0 }] };

export interface RigInstanceOptions {
  /** Initial signal values (others read as 0). */
  signals?: Record<string, number>;
  /** Start without playing (call play()). */
  paused?: boolean;
  /** Called for shake and sound tracks as their time comes. */
  onCue?: (cue: RigCue) => void;
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
  #timelines: Timeline[] = [];
  #channels = new Map<string, number>();
  #warned = new Set<string>();
  /** Shake and sound tracks, as their time comes. */
  onCue: ((cue: RigCue) => void) | null;

  // scratch
  #pos = new THREE.Vector3();
  #quat = new THREE.Quaternion();
  #scale = new THREE.Vector3();

  constructor(world: ParticleWorld, doc: RigDoc, opts: RigInstanceOptions = {}) {
    this.#world = world;
    this.#doc = doc;
    this.#playing = !opts.paused;
    this.onCue = opts.onCue ?? null;
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
  update(dt: number): void {
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
    this.#advance(dt);
  }

  // -- events ----------------------------------------------------------------

  /**
   * Play an event's timeline (an unknown event does nothing). The timeline is
   * a snapshot: editing the rig doesn't change events already playing.
   */
  trigger(event: string, ctx: RigEventContext = {}): RigEventHandle | null {
    const doc = this.#doc.events[event];
    if (!doc) {
      if (!this.#warned.has(event)) console.warn(`elate-particles: rig has no event "${event}"`);
      this.#warned.add(event);
      return null;
    }
    const position = ctx.position ? new THREE.Vector3(ctx.position.x, ctx.position.y, ctx.position.z) : null;
    const orientation = ctx.normal ? new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(ctx.normal.x, ctx.normal.y, ctx.normal.z).normalize()) : null;
    const tl: Timeline = {
      event,
      doc: structuredClone(doc),
      duration: eventDuration(doc),
      t: 0,
      ctx,
      position,
      orientation,
      fired: new Set(),
      lights: new Map(),
      following: new Map(),
      done: false,
    };
    this.#timelines.push(tl);
    // tracks at 0 happen now, not a frame late
    this.#step(tl, 0);
    return {
      event,
      get done() {
        return tl.done;
      },
      get time() {
        return tl.t;
      },
      stop: () => this.#finish(tl),
    };
  }

  /** A channel's current value: the sum of its playing channel tracks (0 when none). */
  channel(name: string): number {
    return this.#channels.get(name) ?? 0;
  }

  /** Events playing now. */
  get activeEvents(): string[] {
    return this.#timelines.map((tl) => tl.event);
  }

  #advance(dt: number) {
    this.#channels.clear();
    for (const tl of [...this.#timelines]) this.#step(tl, Math.max(0, dt));
  }

  #step(tl: Timeline, dt: number) {
    if (tl.done) return;
    tl.t += dt;
    const strength = tl.ctx.strength ?? 1;
    for (const [slug, track] of Object.entries(tl.doc.tracks)) {
      if (track.enabled === false) continue;
      if (track.type === "effect") this.#effectTrack(tl, slug, track, strength);
      else if (track.type === "light") this.#lightTrack(tl, slug, track, strength);
      else if (track.type === "channel") {
        const u = (tl.t - track.at) / track.duration;
        if (u >= 0 && u <= 1) this.#channels.set(track.channel, this.channel(track.channel) + (track.value ?? 1) * strength * evalCurve(track.curve ?? FADE_OUT, u));
      } else if ((track.type === "shake" || track.type === "sound") && !tl.fired.has(slug) && tl.t >= track.at) {
        tl.fired.add(slug);
        this.#cue(tl, slug, track, strength);
      }
    }
    if (tl.t >= tl.duration) this.#finish(tl);
  }

  /** World transform of a track: its socket, else the event's position (and normal), else the rig's origin. */
  #where(tl: Timeline, socketSlug: string | undefined, pos: THREE.Vector3, quat: THREE.Quaternion, scale: THREE.Vector3) {
    this.object.updateWorldMatrix(true, true);
    const socket = socketSlug ? this.#sockets.get(socketSlug) : undefined;
    (socket ?? this.object).matrixWorld.decompose(pos, quat, scale);
    if (!socket && tl.position) pos.copy(tl.position);
    if (!socket && tl.orientation) quat.copy(tl.orientation);
  }

  #effectTrack(tl: Timeline, slug: string, track: Extract<TrackDoc, { type: "effect" }>, strength: number) {
    const following = tl.following.get(slug);
    if (following) {
      this.#where(tl, track.socket, this.#pos, this.#quat, this.#scale);
      following.setTransform(this.#pos, this.#quat, (track.scale ?? 1) * this.#scale.x);
      return;
    }
    if (tl.fired.has(slug) || tl.t < track.at) return;
    tl.fired.add(slug);
    if (!this.#world.has(track.effect)) return;
    this.#where(tl, track.socket, this.#pos, this.#quat, this.#scale);
    const params: Record<string, number> = {};
    for (const [name, b] of Object.entries(track.params ?? {}))
      params[name] = typeof b === "number" ? b : b === "strength" ? strength : (tl.ctx.params?.[b] ?? this.signal(b));
    const follow = !!track.follow && !!track.socket;
    const handle = this.#world.spawn(track.effect, { position: this.#pos, rotation: this.#quat, scale: (track.scale ?? 1) * this.#scale.x, params, autoRelease: !follow });
    if (follow) tl.following.set(slug, handle);
  }

  #lightTrack(tl: Timeline, slug: string, track: Extract<TrackDoc, { type: "light" }>, strength: number) {
    const u = (tl.t - track.at) / track.duration;
    let light = tl.lights.get(slug);
    if (u < 0 || u > 1) {
      if (light && u > 1) {
        light.removeFromParent();
        light.dispose();
        tl.lights.delete(slug);
      }
      return;
    }
    if (!light) {
      light = new THREE.PointLight(track.color, 0, track.range, 2);
      light.name = `${tl.event}/${slug}`;
      const socket = track.socket ? this.#sockets.get(track.socket) : undefined;
      (socket ?? this.object).add(light);
      // at the event's position: placed once, then moves with the rig
      if (!socket && tl.position) {
        this.object.updateWorldMatrix(true, false);
        light.position.copy(this.object.worldToLocal(tl.position.clone()));
      }
      tl.lights.set(slug, light);
    }
    light.intensity = track.intensity * strength * evalCurve(track.curve ?? FADE_OUT, u);
  }

  #cue(tl: Timeline, slug: string, track: Extract<TrackDoc, { type: "shake" | "sound" }>, strength: number) {
    if (!this.onCue) return;
    const position = new THREE.Vector3();
    this.#where(tl, undefined, position, new THREE.Quaternion(), new THREE.Vector3());
    if (track.type === "shake")
      this.onCue({ type: "shake", event: tl.event, track: slug, position, amplitude: track.amplitude * strength, frequency: track.frequency ?? 20, duration: track.duration });
    else this.onCue({ type: "sound", event: tl.event, track: slug, position, sound: track.sound, volume: (track.volume ?? 1) * strength });
  }

  #finish(tl: Timeline) {
    if (tl.done) return;
    tl.done = true;
    for (const light of tl.lights.values()) {
      light.removeFromParent();
      light.dispose();
    }
    tl.lights.clear();
    // effects that followed a socket finish where they are
    for (const h of tl.following.values()) h.autoRelease = true;
    tl.following.clear();
    this.#timelines = this.#timelines.filter((x) => x !== tl);
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
    for (const tl of [...this.#timelines]) this.#finish(tl);
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
