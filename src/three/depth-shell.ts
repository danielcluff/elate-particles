// Model-shaped shells: an effect (a shield, a cloak, a hit flash) drawn on a
// slightly expanded copy of a model's visible surface rather than on a sphere.
//
// A DepthShellCapture renders expanded, model-only copies of every registered
// model into one depth/normal/owner target per camera. Each DepthShell is a
// full-screen pass that reconstructs its model's surface from that depth,
// keeps only pixels the model owns (overlapping ships don't borrow each
// other's effect), and tests against the scene depth so nearer objects still
// occlude it. Holes and separate wings keep the model's silhouette.
//
//   const capture = new DepthShellCapture(camera);
//   const shell = new DepthShell(capture, shipModel, {
//     shader: ({ fresnel, localPosition }) => ({ color: vec3(0.3, 0.7, 1), opacity: fresnel.pow(2) }),
//   });
//   scene.add(shell.object);
//   // every frame, after the model moved:
//   shell.update();
import * as THREE from "three/webgpu";
import { cameraProjectionMatrixInverse, cameraWorldMatrix, float, getViewPosition, normalView, pass, positionGeometry, screenUV, uniform, vec3, vec4 } from "three/tsl";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

/** What a shell's shader reads, per pixel of the reconstructed surface. */
export interface ShellSurface {
  /** Screen-space UV. */
  uv: Node;
  /** Surface position in world space. */
  worldPosition: Node;
  /** Surface position in the model's space (moves with the model). */
  localPosition: Node;
  /** Surface position in view space. */
  viewPosition: Node;
  /** Surface normal in view space. */
  normal: Node;
  /** 0 facing the camera, 1 at grazing angles. */
  fresnel: Node;
}

/** Linear RGB and opacity; null takes a default (white, opaque). */
export type ShellShader = (surface: ShellSurface) => { color?: Node | null; opacity?: Node | null };

interface CaptureHandle {
  id: number;
  depth: Node;
  normalOwner: Node;
  update(visible: boolean): void;
  dispose(): void;
}

/** One depth/normal/owner capture per camera, however many shells use it. */
export class DepthShellCapture {
  /** Shells per capture (owner ids are stored exactly in a half-float channel). */
  static readonly MAX = 2048;
  readonly scene = new THREE.Scene();
  #pass: Node | undefined;
  #ids = new Set<number>();

  constructor(readonly camera: THREE.Camera) {
    this.scene.background = new THREE.Color(0);
  }

  /**
   * Capture an expanded copy of `model` (`scale` around the model's origin,
   * at least 1). The expansion puts the shell in front of the model's own
   * depth, so its rim shows without disabling scene occlusion.
   */
  register(model: THREE.Object3D, { scale = 1.05 }: { scale?: number } = {}): CaptureHandle {
    if (!Number.isFinite(scale) || scale < 1) throw new RangeError("Depth shell scale must be finite and at least 1");
    let id = 1;
    while (this.#ids.has(id)) id++;
    if (id > DepthShellCapture.MAX) throw new Error(`A depth shell capture holds at most ${DepthShellCapture.MAX} models`);
    this.#ids.add(id);
    if (!this.#pass) {
      this.#pass = pass(this.scene, this.camera);
      // owner ids must never blend at silhouettes or between neighbours
      const target = this.#pass.getTexture("output") as THREE.Texture;
      target.minFilter = THREE.NearestFilter;
      target.magFilter = THREE.NearestFilter;
    }
    const material = new THREE.MeshBasicNodeMaterial();
    material.fragmentNode = vec4(normalView.mul(0.5).add(0.5), id);
    const group = new THREE.Group();
    this.scene.add(group);
    const proxies: { source: THREE.Mesh; proxy: THREE.Mesh }[] = [];
    model.traverse((object) => {
      if (!(object as THREE.Mesh).isMesh) return;
      const source = object as THREE.Mesh;
      // share geometry, skeleton and instance attributes; no children
      const proxy = source.clone(false);
      proxy.material = material;
      proxy.matrixAutoUpdate = false;
      group.add(proxy);
      proxies.push({ source, proxy });
    });
    const modelInverse = new THREE.Matrix4();
    const scaleMatrix = new THREE.Matrix4().makeScale(scale, scale, scale);
    const expanded = new THREE.Matrix4();
    let disposed = false;
    return {
      id,
      depth: this.#pass.getTextureNode("depth"),
      normalOwner: this.#pass.getTextureNode(),
      update: (visible) => {
        group.visible = visible;
        if (!visible || disposed) return;
        model.updateWorldMatrix(true, true);
        modelInverse.copy(model.matrixWorld).invert();
        for (const { source, proxy } of proxies) {
          // scale around the model's origin, not each mesh's, for one coherent shell
          expanded.copy(model.matrixWorld).multiply(scaleMatrix).multiply(modelInverse).multiply(source.matrixWorld);
          proxy.matrix.copy(expanded);
          proxy.matrixWorld.copy(expanded);
          proxy.visible = true;
          for (let o: THREE.Object3D | null = source; o; o = o.parent)
            if (!o.visible) {
              proxy.visible = false;
              break;
            }
          if (source.morphTargetInfluences) proxy.morphTargetInfluences = source.morphTargetInfluences;
        }
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        group.removeFromParent();
        group.clear();
        material.dispose();
        this.#ids.delete(id);
        if (this.#ids.size === 0) {
          this.#pass?.dispose?.();
          this.#pass = undefined;
        }
      },
    };
  }
}

export interface DepthShellOptions {
  shader: ShellShader;
  /** Expansion around the model's origin. Default 1.05. */
  scale?: number;
  /** Draw order of the full-screen pass. Default 10 (after the scene). */
  renderOrder?: number;
}

/** A model-shaped shell drawn by one full-screen pass. Add `object` to the scene and call `update()` every frame. */
export class DepthShell {
  readonly object: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicNodeMaterial>;
  #capture: CaptureHandle;
  #model: THREE.Object3D;
  #modelInverse = uniform(new THREE.Matrix4());
  #surface: ShellSurface;
  #visible = true;

  constructor(capture: DepthShellCapture, model: THREE.Object3D, opts: DepthShellOptions) {
    this.#model = model;
    this.#capture = capture.register(model, { scale: opts.scale });
    const depth = this.#capture.depth.sample(screenUV).r;
    const normalOwner = this.#capture.normalOwner.sample(screenUV);
    const normal = normalOwner.rgb.mul(2).sub(1).normalize();
    const viewPosition = getViewPosition(screenUV, depth, cameraProjectionMatrixInverse);
    const worldPosition = cameraWorldMatrix.mul(vec4(viewPosition, 1)).xyz;
    this.#surface = {
      uv: screenUV,
      worldPosition,
      localPosition: this.#modelInverse.mul(vec4(worldPosition, 1)).xyz,
      viewPosition,
      normal,
      fresnel: normal.dot(viewPosition.negate().normalize()).abs().oneMinus().clamp(),
    };
    this.object = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.#material(opts.shader, depth, normalOwner));
    this.object.frustumCulled = false;
    this.object.renderOrder = opts.renderOrder ?? 10;
    this.object.name = "DepthShell";
    this.#depth = depth;
    this.#normalOwner = normalOwner;
  }

  #depth: Node;
  #normalOwner: Node;

  /** The surface nodes a shader reads (also handy for building inputs outside the shader). */
  get surface(): ShellSurface {
    return this.#surface;
  }

  #material(shader: ShellShader, depth: Node, normalOwner: Node): THREE.MeshBasicNodeMaterial {
    const out = shader(this.#surface);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, toneMapped: false });
    material.vertexNode = vec4(positionGeometry.xy, 0, 1);
    // test against the real scene so nearer objects occlude the shell
    material.depthNode = depth;
    material.colorNode = out.color ?? vec3(1);
    const owned = depth.lessThan(1).and(normalOwner.a.equal(this.#capture.id)).select(1, 0);
    material.opacityNode = float(out.opacity ?? 1).mul(owned);
    return material;
  }

  /** Swap the shader (e.g. after an edit). */
  setShader(shader: ShellShader): void {
    const old = this.object.material;
    this.object.material = this.#material(shader, this.#depth, this.#normalOwner);
    old.dispose();
  }

  get visible(): boolean {
    return this.#visible;
  }

  set visible(value: boolean) {
    this.#visible = value;
    this.object.visible = value;
    this.#capture.update(value);
  }

  /** Follow the model: call every frame after its transform is final. */
  update(): void {
    this.object.visible = this.#visible;
    this.#capture.update(this.#visible);
    if (!this.#visible) return;
    this.#modelInverse.value.copy(this.#model.matrixWorld).invert();
  }

  dispose(): void {
    this.object.removeFromParent();
    this.object.geometry.dispose();
    this.object.material.dispose();
    this.#capture.dispose();
  }
}
