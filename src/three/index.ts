// three.js (WebGPU / TSL) runtime for tsl-particles.
import "../index";

export { ParticleWorld, ParticleEffect, type ParticleWorldOptions, type SpawnOptions, type ParticleWorldStats } from "./world";
export { InstanceBatch, ParticleBatch, RibbonBatch, SpriteBatch } from "./batch";
export { createSpriteMaterial } from "./materials/sprite";
export { createMeshMaterial } from "./materials/mesh";
export { createRibbonMaterial, RIBBON_ATTRIBUTES, RIBBON_STRIDE } from "./materials/ribbon";
export { createLutTexture, PARTICLE_ATTRIBUTES, PARTICLE_STRIDE, type ParticleMaterialContext, type MaterialOptions } from "./materials/common";
export { createBuiltinMesh, isBuiltinMesh } from "./geometries";
/** @deprecated renamed to ParticleMaterialContext */
export type { ParticleMaterialContext as SpriteMaterialContext } from "./materials/common";
