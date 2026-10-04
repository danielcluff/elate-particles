// Creating, normalising and validating rig documents.
import { isSlug } from "../core/slug";
import type { Vec3 } from "../core/types";
import { RIG_FORMAT, RIG_VERSION, type AttachmentDoc, type RigDoc, type RigIssue, type RigLightDoc, type SocketDoc } from "./types";

export function createRig(): RigDoc {
  return { format: RIG_FORMAT, version: RIG_VERSION, sockets: {}, attachments: {}, lights: {} };
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
  return rig;
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
  return issues;
}

/** Signal names a rig reads (attachment param bindings and light signals). */
export function rigSignals(rig: RigDoc): string[] {
  const out = new Set<string>();
  for (const a of Object.values(rig.attachments)) for (const v of Object.values(a.params ?? {})) if (typeof v === "string") out.add(v);
  for (const l of Object.values(rig.lights)) if (l.signal) out.add(l.signal);
  return [...out];
}
