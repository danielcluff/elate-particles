// A sort group: sprite renderers from any emitters/effects that share a
// `sortGroup` name, drawn as one depth-sorted batch with the group material.
// Membership changes rewrite rows of the table texture; the shader is only
// rebuilt when the table must grow or the group's texture first appears.

import * as THREE from "three/webgpu";
import type { SpriteRendererDoc } from "../core/types";
import { LUT_SIZE } from "../core/values";
import type { EmitterTemplate } from "../sim/compile";
import { ParticleBatch } from "./batch";
import type { MaterialOptions } from "./materials/common";
import type { GpuSortGroup } from "./gpu/group";
import { GROUP_FACINGS, GROUP_FLIPBOOK_MODES, GROUP_ROWS_PER_MEMBER, GROUP_SHAPES, createGroupMaterial } from "./materials/group";

interface Member {
  effectId: string;
  index: number;
}

export class SortGroup {
  readonly name: string;
  readonly batch: ParticleBatch;
  /** The GPU half, once a GPU emitter joins: gathers CPU and GPU members and sorts them together on the GPU. */
  gpu: GpuSortGroup | null = null;
  #capacity: number;
  #table: THREE.DataTexture;
  #material: THREE.MeshBasicNodeMaterial;
  #mapUrl: string | null = null;
  readonly #members: (Member | null)[] = [];
  readonly #opts: MaterialOptions;
  readonly #loadTexture: (url: string) => THREE.Texture;

  constructor(name: string, opts: MaterialOptions, capacity = 8) {
    this.name = name;
    this.#opts = opts;
    this.#loadTexture = opts.loadTexture;
    this.#capacity = capacity;
    this.#table = this.#makeTable(capacity);
    this.#material = createGroupMaterial(name, this.#table, capacity * GROUP_ROWS_PER_MEMBER, null, opts);
    const renderer: SpriteRendererDoc = { type: "sprite", blend: "premultiplied", shape: "softCircle", facing: "camera", sort: "distance" };
    this.batch = new ParticleBatch({ doc: { name: `group:${name}` }, capacity: 256 }, renderer, this.#material);
    this.batch.mesh.name = `particles:group:${name}`;
  }

  /** The current group material (rebuilt when the table grows or the group's texture first appears). */
  get material(): THREE.MeshBasicNodeMaterial {
    return this.#material;
  }

  get memberCount(): number {
    return this.#members.filter(Boolean).length;
  }

  #makeTable(capacity: number): THREE.DataTexture {
    const rows = capacity * GROUP_ROWS_PER_MEMBER;
    const tex = new THREE.DataTexture(new Uint16Array(LUT_SIZE * rows * 4), LUT_SIZE, rows, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * Adds a renderer as a member and returns its index, or null when it can't
   * join (opaque blend, or a texture different from the group's).
   */
  add(effectId: string, tpl: EmitterTemplate, r: SpriteRendererDoc): number | null {
    if (r.blend === "opaque") return null;
    const url = r.shape === "texture" && r.texture ? r.texture : null;
    if (url && this.#mapUrl && url !== this.#mapUrl) return null;
    let index = this.#members.findIndex((m) => m === null);
    if (index < 0) index = this.#members.length;
    this.#members[index] = { effectId, index };

    let rebuild = false;
    if (url && !this.#mapUrl) {
      this.#mapUrl = url;
      rebuild = true;
    }
    if (index >= this.#capacity) {
      const old = this.#table;
      while (this.#capacity <= index) this.#capacity *= 2;
      this.#table = this.#makeTable(this.#capacity);
      (this.#table.image.data as Uint16Array).set(old.image.data as Uint16Array);
      old.dispose();
      rebuild = true;
    }
    this.#write(index, tpl, r);
    if (rebuild) this.#rebuild();
    return index;
  }

  /** Frees every member that belongs to `effectId` (on re-register / unregister). */
  removeEffect(effectId: string): void {
    for (let i = 0; i < this.#members.length; i++) if (this.#members[i]?.effectId === effectId) this.#members[i] = null;
  }

  #rebuild(): void {
    const old = this.#material;
    const map = this.#mapUrl ? this.#loadTexture(this.#mapUrl) : null;
    this.#material = createGroupMaterial(this.name, this.#table, this.#capacity * GROUP_ROWS_PER_MEMBER, map, this.#opts);
    this.batch.mesh.material = this.#material;
    old.dispose();
  }

  #write(index: number, tpl: EmitterTemplate, r: SpriteRendererDoc): void {
    const data = this.#table.image.data as Uint16Array;
    const h = THREE.DataUtils.toHalfFloat;
    const row = (k: number) => (index * GROUP_ROWS_PER_MEMBER + k) * LUT_SIZE * 4;
    const c = row(0), s = row(1), p = row(2);
    for (let i = 0; i < LUT_SIZE; i++) {
      for (let ch = 0; ch < 4; ch++) data[c + i * 4 + ch] = h(tpl.colorLut ? tpl.colorLut[i * 4 + ch] : 1);
      data[s + i * 4] = h(tpl.sizeLut ? tpl.sizeLut[i] : 1);
      data[s + i * 4 + 1] = data[s + i * 4 + 2] = data[s + i * 4 + 3] = h(1);
    }
    const fb = r.flipbook && r.flipbook.cols * r.flipbook.rows > 1 ? r.flipbook : null;
    const params = [
      [GROUP_SHAPES.indexOf(r.shape), Math.max(0, GROUP_FACINGS.indexOf(r.facing)), r.softness ?? 1, r.stretch ?? 0.1],
      [r.blend === "additive" ? 1 : 0, r.depthFade ?? 0, r.cameraFade ?? 0, 0],
      fb ? [fb.cols, fb.rows, GROUP_FLIPBOOK_MODES.indexOf(fb.mode), fb.fps ?? 15] : [1, 1, 0, 0],
    ];
    params.forEach((vals, k) => vals.forEach((v, ch) => (data[p + k * 4 + ch] = h(v))));
    this.#table.needsUpdate = true;
  }

  dispose(): void {
    this.gpu?.dispose();
    this.batch.dispose();
    this.#material.dispose();
    this.#table.dispose();
  }
}
