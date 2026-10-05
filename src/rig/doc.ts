// Creating, normalising and validating rig documents.
import { isSlug } from "../core/slug";
import type { Curve, Vec3 } from "../core/types";
import { RIG_FORMAT, RIG_VERSION, TRACK_TYPES, type AttachmentDoc, type ParamBinding, type RigDoc, type RigEventDoc, type RigIssue, type RigLightDoc, type SocketDoc, type TrackDoc } from "./types";

export function createRig(): RigDoc {
  return { format: RIG_FORMAT, version: RIG_VERSION, sockets: {}, attachments: {}, lights: {}, events: {} };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const vec3 = (v: unknown, d: Vec3): Vec3 => (Array.isArray(v) && v.length === 3 ? [num(v[0], d[0]), num(v[1], d[1]), num(v[2], d[2])] : [...d]);

/**
 * Parses untrusted JSON into a RigDoc. Throws when the input is not a rig;
 * content problems (unknown sockets, bad slugs) are left for validateRig.
 */
export function normalizeRig(json: unknown): RigDoc {
  if (json === undefined || json === null) return createRig();
  if (!isObj(json)) throw new Error("Rig must be a JSON object");
  if (json.format !== undefined && json.format !== RIG_FORMAT) throw new Error(`Not a ${RIG_FORMAT} document (format "${String(json.format)}")`);
  const rig = createRig();
  for (const [slug, s] of Object.entries(isObj(json.sockets) ? json.sockets : {})) {
    if (!isObj(s)) continue;
    const socket: SocketDoc = { position: vec3(s.position, [0, 0, 0]) };
    const rotation = vec3(s.rotation, [0, 0, 0]);
    if (rotation.some((v) => v !== 0)) socket.rotation = rotation;
    rig.sockets[slug] = socket;
  }
  for (const [slug, a] of Object.entries(isObj(json.attachments) ? json.attachments : {})) {
    if (!isObj(a)) continue;
    const att: AttachmentDoc = { socket: String(a.socket ?? ""), effect: String(a.effect ?? "") };
    if (typeof a.scale === "number" && a.scale !== 1) att.scale = a.scale;
    if (isObj(a.params)) {
      const params = Object.fromEntries(Object.entries(a.params).filter(([, v]) => typeof v === "string" || (typeof v === "number" && Number.isFinite(v)))) as AttachmentDoc["params"];
      if (Object.keys(params!).length) att.params = params;
    }
    if (a.enabled === false) att.enabled = false;
    rig.attachments[slug] = att;
  }
  for (const [slug, l] of Object.entries(isObj(json.lights) ? json.lights : {})) {
    if (!isObj(l)) continue;
    const light: RigLightDoc = {
      socket: String(l.socket ?? ""),
      color: typeof l.color === "string" ? l.color : "#ffffff",
      intensity: num(l.intensity, 1),
      range: num(l.range, 5),
    };
    if (typeof l.signal === "string" && l.signal) light.signal = l.signal;
    if (l.enabled === false) light.enabled = false;
    rig.lights[slug] = light;
  }
  for (const [slug, e] of Object.entries(isObj(json.events) ? json.events : {})) {
    if (!isObj(e)) continue;
    const event: RigEventDoc = { tracks: {} };
    for (const [trackSlug, t] of Object.entries(isObj(e.tracks) ? e.tracks : {})) if (isObj(t)) event.tracks[trackSlug] = normalizeTrack(t);
    rig.events[slug] = event;
  }
  return rig;
}

const bindings = (v: unknown): Record<string, ParamBinding> | undefined => {
  if (!isObj(v)) return undefined;
  const out = Object.fromEntries(Object.entries(v).filter(([, b]) => typeof b === "string" || (typeof b === "number" && Number.isFinite(b)))) as Record<string, ParamBinding>;
  return Object.keys(out).length ? out : undefined;
};

const curve = (v: unknown): Curve | undefined => {
  if (!isObj(v) || !Array.isArray(v.keys)) return undefined;
  const keys = v.keys.filter(isObj).map((k) => ({ t: num(k.t, 0), v: num(k.v, 0) }));
  return keys.length ? { keys, ...(v.interp === "smooth" || v.interp === "step" ? { interp: v.interp } : {}) } : undefined;
};

/** A track with its type's defaults left out; an unknown type is kept as-is (validateRig reports it). */
function normalizeTrack(t: Record<string, unknown>): TrackDoc {
  const at = Math.max(0, num(t.at, 0));
  const base = { at, ...(t.enabled === false ? { enabled: false } : {}) };
  const socket = typeof t.socket === "string" && t.socket ? { socket: t.socket } : {};
  switch (t.type) {
    case "effect": {
      const params = bindings(t.params);
      return {
        type: "effect",
        ...base,
        effect: String(t.effect ?? ""),
        ...socket,
        ...(typeof t.scale === "number" && t.scale !== 1 ? { scale: t.scale } : {}),
        ...(params ? { params } : {}),
        ...(t.follow === true ? { follow: true } : {}),
      };
    }
    case "light": {
      const c = curve(t.curve);
      return {
        type: "light",
        ...base,
        duration: num(t.duration, 0.3),
        ...socket,
        color: typeof t.color === "string" ? t.color : "#ffffff",
        intensity: num(t.intensity, 4),
        range: num(t.range, 6),
        ...(c ? { curve: c } : {}),
      };
    }
    case "shake":
      return { type: "shake", ...base, duration: num(t.duration, 0.3), amplitude: num(t.amplitude, 0.2), ...(typeof t.frequency === "number" && t.frequency !== 20 ? { frequency: t.frequency } : {}) };
    case "sound":
      return { type: "sound", ...base, sound: String(t.sound ?? ""), ...(typeof t.volume === "number" && t.volume !== 1 ? { volume: t.volume } : {}) };
    case "channel": {
      const c = curve(t.curve);
      return {
        type: "channel",
        ...base,
        duration: num(t.duration, 0.3),
        channel: String(t.channel ?? ""),
        ...(typeof t.value === "number" && t.value !== 1 ? { value: t.value } : {}),
        ...(c ? { curve: c } : {}),
      };
    }
    default:
      return { ...(t as unknown as TrackDoc), at };
  }
}

/** When an event's timeline ends: the last track's start plus its duration (effects count their start). */
export function eventDuration(event: RigEventDoc): number {
  let end = 0;
  for (const t of Object.values(event.tracks)) end = Math.max(end, t.at + ("duration" in t ? t.duration : 0));
  return end;
}

/** The rig as written to a file (normalised, so defaults are left out and key order is stable). */
export function serializeRig(rig: RigDoc): RigDoc {
  return normalizeRig(rig);
}

/**
 * Structural checks. `effects` (optional) is the set of known effect slugs;
 * attachments naming others get a warning (the game may register them later).
 */
export function validateRig(rig: RigDoc, opts: { effects?: Iterable<string> } = {}): RigIssue[] {
  const issues: RigIssue[] = [];
  const effects = opts.effects ? new Set(opts.effects) : null;
  for (const [slug, s] of Object.entries(rig.sockets)) {
    const path = `sockets.${slug}`;
    if (!isSlug(slug)) issues.push({ level: "error", message: `Socket "${slug}" is not a slug (lowercase-kebab-case)`, path });
    if (![...s.position, ...(s.rotation ?? [])].every(Number.isFinite)) issues.push({ level: "error", message: "Socket transform has a non-finite number", path });
  }
  for (const [slug, a] of Object.entries(rig.attachments)) {
    const path = `attachments.${slug}`;
    if (!isSlug(slug)) issues.push({ level: "error", message: `Attachment "${slug}" is not a slug (lowercase-kebab-case)`, path });
    if (!rig.sockets[a.socket]) issues.push({ level: "error", message: `Attachment "${slug}" uses unknown socket "${a.socket}"`, path });
    if (!a.effect) issues.push({ level: "error", message: `Attachment "${slug}" has no effect`, path });
    else if (effects && !effects.has(a.effect)) issues.push({ level: "warning", message: `Attachment "${slug}" uses unknown effect "${a.effect}"`, path });
    if (a.scale !== undefined && !(a.scale > 0)) issues.push({ level: "error", message: "scale must be > 0", path });
  }
  for (const [slug, l] of Object.entries(rig.lights)) {
    const path = `lights.${slug}`;
    if (!isSlug(slug)) issues.push({ level: "error", message: `Light "${slug}" is not a slug (lowercase-kebab-case)`, path });
    if (!rig.sockets[l.socket]) issues.push({ level: "error", message: `Light "${slug}" uses unknown socket "${l.socket}"`, path });
    if (!/^#[0-9a-f]{6}$/i.test(l.color)) issues.push({ level: "error", message: "Light color must be a #rrggbb hex colour", path });
    if (!(l.intensity >= 0)) issues.push({ level: "error", message: "Light intensity must be ≥ 0", path });
    if (!(l.range > 0)) issues.push({ level: "error", message: "Light range must be > 0", path });
  }
  for (const [slug, e] of Object.entries(rig.events)) {
    if (!isSlug(slug)) issues.push({ level: "error", message: `Event "${slug}" is not a slug (lowercase-kebab-case)`, path: `events.${slug}` });
    for (const [trackSlug, t] of Object.entries(e.tracks)) {
      const path = `events.${slug}.tracks.${trackSlug}`;
      const where = `Track "${slug}/${trackSlug}"`;
      if (!isSlug(trackSlug)) issues.push({ level: "error", message: `${where} is not a slug (lowercase-kebab-case)`, path });
      if (!TRACK_TYPES.includes(t.type)) {
        issues.push({ level: "error", message: `${where} has unknown type "${String((t as { type?: unknown }).type)}" (types: ${TRACK_TYPES.join(", ")})`, path });
        continue;
      }
      if (!(t.at >= 0)) issues.push({ level: "error", message: `${where}: at must be ≥ 0`, path });
      if ("duration" in t && !(t.duration > 0)) issues.push({ level: "error", message: `${where}: duration must be > 0`, path });
      if ((t.type === "effect" || t.type === "light") && t.socket && !rig.sockets[t.socket]) issues.push({ level: "error", message: `${where} uses unknown socket "${t.socket}"`, path });
      if (t.type === "effect") {
        if (!t.effect) issues.push({ level: "error", message: `${where} has no effect`, path });
        else if (effects && !effects.has(t.effect)) issues.push({ level: "warning", message: `${where} uses unknown effect "${t.effect}"`, path });
        if (t.follow && !t.socket) issues.push({ level: "warning", message: `${where} follows nothing (follow needs a socket)`, path });
      }
      if (t.type === "light" && !/^#[0-9a-f]{6}$/i.test(t.color)) issues.push({ level: "error", message: `${where}: color must be #rrggbb`, path });
      if (t.type === "sound" && !t.sound) issues.push({ level: "error", message: `${where} has no sound`, path });
      if (t.type === "channel" && !t.channel) issues.push({ level: "error", message: `${where} has no channel name`, path });
    }
  }
  return issues;
}

/** Signal names a rig reads (attachment param bindings and light signals). */
export function rigSignals(rig: RigDoc): string[] {
  const out = new Set<string>();
  for (const a of Object.values(rig.attachments)) for (const v of Object.values(a.params ?? {})) if (typeof v === "string") out.add(v);
  for (const l of Object.values(rig.lights)) if (l.signal) out.add(l.signal);
  for (const e of Object.values(rig.events))
    for (const t of Object.values(e.tracks)) if (t.type === "effect") for (const v of Object.values(t.params ?? {})) if (typeof v === "string" && v !== "strength") out.add(v);
  return [...out];
}
