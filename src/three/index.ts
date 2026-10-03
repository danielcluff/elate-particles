// three.js (WebGPU / TSL) runtime for tsl-particles.
import "../index";

export { ParticleWorld, ParticleEffect, type ParticleWorldOptions, type SpawnOptions, type ParticleWorldStats } from "./world";
export { InstanceBatch, ParticleBatch, RibbonBatch, SpriteBatch, type SortView } from "./batch";
export { KeySorter } from "./sort";
export { SortGroup } from "./sort-group";
export { createGroupMaterial, GROUP_SHAPES, GROUP_FACINGS } from "./materials/group";
export { createSpriteMaterial } from "./materials/sprite";
export { createMeshMaterial } from "./materials/mesh";
export { createRibbonMaterial, RIBBON_ATTRIBUTES, RIBBON_STRIDE } from "./materials/ribbon";
export { createLutTexture, PARTICLE_ATTRIBUTES, PARTICLE_STRIDE, type ParticleMaterialContext, type MaterialOptions } from "./materials/common";
export { createBuiltinMesh, isBuiltinMesh } from "./geometries";
/** @deprecated renamed to ParticleMaterialContext */
export type { ParticleMaterialContext as SpriteMaterialContext } from "./materials/common";
export { GpuEmitter, GpuPool, GpuPoolSet, GPU_SHRINK_AFTER, gpuSupport, gpuPartners, MAX_GPU_TARGETS, type GpuDraw } from "./gpu/emitter";
export { GpuSorter } from "./gpu/sort";
export { registerGpuModule, getGpuModule, type GpuModuleImpl } from "./gpu/modules";
export { GpuBuildContext, LaneLayout, LaneValues, LANE, type GpuParticle, type FrameInfo } from "./gpu/context";
export { WorkerParticleWorld, WorkerParticleEffect, type ParticlePort, type WorkerParticleWorldOptions } from "./worker-world";
