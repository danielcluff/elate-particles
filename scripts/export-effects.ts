// Writes the playground effects to examples/<slug>.fx.json (validated). Files
// don't store their slug: the file name is the slug.
//   pnpm tsx scripts/export-effects.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { serializeEffect, validateEffect } from "../src/index";
import { ALL_EFFECTS } from "../playground/effects";

mkdirSync("examples", { recursive: true });
for (const fx of ALL_EFFECTS) {
  const issues = validateEffect(fx);
  if (issues.some((i) => i.level === "error")) throw new Error(`${fx.name}: ${JSON.stringify(issues)}`);
  writeFileSync(`examples/${fx.id}.fx.json`, JSON.stringify(serializeEffect(fx), null, 2) + "\n");
  console.log(`examples/${fx.id}.fx.json`, issues.length ? issues : "ok");
}
