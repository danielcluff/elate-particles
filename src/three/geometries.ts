// Built-in mesh primitives for the mesh renderer, all roughly 1 unit across so
// particle size reads the same as for sprites.

import * as THREE from "three/webgpu";

const FACTORIES: Record<string, () => THREE.BufferGeometry> = {
  box: () => new THREE.BoxGeometry(1, 1, 1),
  sphere: () => new THREE.SphereGeometry(0.5, 16, 12),
  icosahedron: () => new THREE.IcosahedronGeometry(0.5, 0),
  octahedron: () => new THREE.OctahedronGeometry(0.5, 0),
  tetrahedron: () => new THREE.TetrahedronGeometry(0.6, 0),
  cone: () => new THREE.ConeGeometry(0.4, 1, 12),
  cylinder: () => new THREE.CylinderGeometry(0.3, 0.3, 1, 12),
  torus: () => new THREE.TorusGeometry(0.35, 0.12, 8, 24),
  plane: () => new THREE.PlaneGeometry(1, 1),
};

export function isBuiltinMesh(name: string): boolean {
  return name in FACTORIES;
}

export function createBuiltinMesh(name: string): THREE.BufferGeometry | null {
  return FACTORIES[name]?.() ?? null;
}
