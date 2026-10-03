// One draw call per emitter template: every live instance of an emitter packs
// its particles (in world space) into a shared instanced buffer. Draw calls
// therefore scale with the number of distinct emitters, not with the number
// of explosions on screen.

import * as THREE from "three/webgpu";
import type { EmitterSim } from "../sim/emitter";
import type { EmitterTemplate } from "../sim/compile";
import { SPRITE_ATTRIBUTES, SPRITE_STRIDE } from "./sprite-material";

export class SpriteBatch {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.Material>;
  readonly template: EmitterTemplate;
  #data: Float32Array;
  #buffer: THREE.InstancedInterleavedBuffer;
  #capacity: number;
  #count = 0;

  constructor(template: EmitterTemplate, material: THREE.Material, capacity = template.capacity) {
    this.template = template;
    this.#capacity = Math.max(16, capacity);
    this.#data = new Float32Array(this.#capacity * SPRITE_STRIDE);
    this.#buffer = this.#makeBuffer();
    this.mesh = new THREE.Mesh(this.#makeGeometry(), material);
    this.mesh.name = `particles:${template.doc.name}`;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = template.renderer.sortOrder ?? 0;
    this.mesh.visible = false;
  }

  get count(): number {
    return this.#count;
  }

  get capacity(): number {
    return this.#capacity;
  }

  #makeBuffer(): THREE.InstancedInterleavedBuffer {
    const b = new THREE.InstancedInterleavedBuffer(this.#data, SPRITE_STRIDE, 1);
    b.setUsage(THREE.DynamicDrawUsage);
    return b;
  }

  #makeGeometry(): THREE.InstancedBufferGeometry {
    // own copy of the quad: disposing a geometry frees its attributes' GPU buffers
    const quad = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = quad.index;
    g.setAttribute("position", quad.getAttribute("position"));
    g.setAttribute("uv", quad.getAttribute("uv"));
    g.setAttribute(SPRITE_ATTRIBUTES.a, new THREE.InterleavedBufferAttribute(this.#buffer, 4, 0));
    g.setAttribute(SPRITE_ATTRIBUTES.b, new THREE.InterleavedBufferAttribute(this.#buffer, 4, 4));
    g.setAttribute(SPRITE_ATTRIBUTES.c, new THREE.InterleavedBufferAttribute(this.#buffer, 4, 8));
    g.setAttribute(SPRITE_ATTRIBUTES.d, new THREE.InterleavedBufferAttribute(this.#buffer, 4, 12));
    g.instanceCount = 0;
    return g;
  }

  /** Grows the GPU buffer (doubling) so `needed` particles fit. Rare: allocates. */
  #ensure(needed: number): void {
    if (needed <= this.#capacity) return;
    let cap = this.#capacity;
    while (cap < needed) cap *= 2;
    const data = new Float32Array(cap * SPRITE_STRIDE);
    data.set(this.#data.subarray(0, this.#count * SPRITE_STRIDE));
    this.#data = data;
    this.#capacity = cap;
    this.#buffer = this.#makeBuffer();
    const old = this.mesh.geometry;
    this.mesh.geometry = this.#makeGeometry();
    old.dispose();
  }

  begin(): void {
    this.#count = 0;
  }

  /** Appends an emitter's live particles. `matrix` is set for local-space emitters. */
  pack(sim: EmitterSim, matrix: Float32Array | null): void {
    const b = sim.buf;
    const n = b.count;
    if (n === 0) return;
    this.#ensure(this.#count + n);
    const out = this.#data;
    const { px, py, pz, vx, vy, vz, age, life, seed, size, rot, r, g, b: bl, a } = b;
    let o = this.#count * SPRITE_STRIDE;
    if (!matrix) {
      for (let i = 0; i < n; i++, o += SPRITE_STRIDE) {
        out[o] = px[i];
        out[o + 1] = py[i];
        out[o + 2] = pz[i];
        out[o + 3] = age[i] / life[i];
        out[o + 4] = vx[i];
        out[o + 5] = vy[i];
        out[o + 6] = vz[i];
        out[o + 7] = seed[i];
        out[o + 8] = size[i];
        out[o + 9] = rot[i];
        out[o + 10] = life[i];
        out[o + 12] = r[i];
        out[o + 13] = g[i];
        out[o + 14] = bl[i];
        out[o + 15] = a[i];
      }
    } else {
      const m = matrix;
      // uniform scale = length of the first basis column
      const sc = Math.hypot(m[0], m[1], m[2]);
      for (let i = 0; i < n; i++, o += SPRITE_STRIDE) {
        const x = px[i], y = py[i], z = pz[i];
        out[o] = m[0] * x + m[4] * y + m[8] * z + m[12];
        out[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
        out[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        out[o + 3] = age[i] / life[i];
        const ux = vx[i], uy = vy[i], uz = vz[i];
        out[o + 4] = m[0] * ux + m[4] * uy + m[8] * uz;
        out[o + 5] = m[1] * ux + m[5] * uy + m[9] * uz;
        out[o + 6] = m[2] * ux + m[6] * uy + m[10] * uz;
        out[o + 7] = seed[i];
        out[o + 8] = size[i] * sc;
        out[o + 9] = rot[i];
        out[o + 10] = life[i];
        out[o + 12] = r[i];
        out[o + 13] = g[i];
        out[o + 14] = bl[i];
        out[o + 15] = a[i];
      }
    }
    this.#count += n;
  }

  end(): void {
    const n = this.#count;
    const geo = this.mesh.geometry;
    geo.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n === 0) return;
    this.#buffer.clearUpdateRanges();
    this.#buffer.addUpdateRange(0, n * SPRITE_STRIDE);
    this.#buffer.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
  }
}
