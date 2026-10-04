// elate-particles core: documents, module registry, commands and the CPU
// simulator. No three.js, no DOM — safe for Node (MCP servers, validation,
// build tools). Rendering lives in "elate-particles/three".

import { registerBuiltinModules } from "./modules";

registerBuiltinModules();

export * from "./core/types";
export * from "./core/values";
export * from "./core/params";
export * from "./core/registry";
export * from "./core/doc";
export * from "./core/slug";
export * from "./rig";
export * from "./core/commands";
export { BUILTIN_MODULES, registerBuiltinModules } from "./modules";
export * from "./sim";
