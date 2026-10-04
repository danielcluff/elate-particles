// Slugs: lowercase kebab-case names ("engine-left", "spawn-rate") used as the
// identity of everything in an effect. An effect's own slug is its file name;
// emitters are unique within the effect, modules and renderers within their
// emitter. Slugs are chosen when a thing is created and never change; display
// names are separate text.

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isSlug(value: unknown): value is string {
  return typeof value === "string" && SLUG_PATTERN.test(value);
}

/** "Engine Left" → "engine-left", "sizeOverLife" → "size-over-life"; `fallback` when nothing is left. */
export function slugify(text: string, fallback = "item"): string {
  const slug = text
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug || fallback;
}

/** The first of `base`, `base-2`, `base-3`, … not in `taken`. */
export function uniqueSlug(base: string, taken: Iterable<string>): string {
  const set = taken instanceof Set ? (taken as Set<string>) : new Set(taken);
  if (!set.has(base)) return base;
  for (let i = 2; ; i++) if (!set.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** A module's slug comes from its type: "render.sizeOverLife" → "render-size-over-life". */
export const moduleSlug = (type: string) => slugify(type.replace(/\./g, "-"), "module");
