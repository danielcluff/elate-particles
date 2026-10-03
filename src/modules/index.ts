import { getModuleDef, registerModule } from "../core/registry";
import { initModules } from "./init";
import { renderModules } from "./render";
import { spawnModules } from "./spawn";
import { updateModules } from "./update";

export const BUILTIN_MODULES = [...spawnModules, ...initModules, ...updateModules, ...renderModules];

/** Registers the built-in modules (idempotent). */
export function registerBuiltinModules(): void {
  for (const def of BUILTIN_MODULES) if (!getModuleDef(def.type)) registerModule(def);
}
