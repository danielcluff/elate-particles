import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { vec3 } from "three/tsl";
import { DepthShell, DepthShellCapture } from "../src/three";
import { shellScreenBounds } from "../src/three/depth-shell";

function topDownCamera() {
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
  camera.position.set(0, 50, 0);
  camera.up.set(0, 0, 1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}

const viewProjection = (camera: THREE.Camera) => new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

function ship() {
  const model = new THREE.Group();
  const hull = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 4), new THREE.MeshStandardNodeMaterial());
  const wing = new THREE.Mesh(new THREE.BoxGeometry(4, 0.1, 1), new THREE.MeshStandardNodeMaterial());
  wing.position.set(0, 0, -1);
  model.add(hull, wing);
  return model;
}

describe("DepthShell", () => {
  it("captures expanded, model-only proxies that follow the model", () => {
    const camera = new THREE.PerspectiveCamera();
    const capture = new DepthShellCapture(camera);
    const model = ship();
    model.position.set(10, 0, 0);
    const shell = new DepthShell(capture, model, { shader: ({ fresnel }) => ({ color: vec3(0, 0.5, 1), opacity: fresnel }) });
    const group = capture.scene.children[0];
    expect(group.children).toHaveLength(2);
    // the proxies share geometry but not materials
    const proxy = group.children[0] as THREE.Mesh;
    expect(proxy.geometry).toBe((model.children[0] as THREE.Mesh).geometry);
    expect(proxy.material).not.toBe((model.children[0] as THREE.Mesh).material);

    shell.update();
    // scaled 1.05 around the model's origin: the hull's corner at x = 1 lands at 10 + 1.05
    const corner = new THREE.Vector3(1, 0, 0).applyMatrix4(proxy.matrix);
    expect(corner.x).toBeCloseTo(11.05, 5);
    const wingProxy = group.children[1] as THREE.Mesh;
    expect(new THREE.Vector3(0, 0, 0).applyMatrix4(wingProxy.matrix).z).toBeCloseTo(-1.05, 5);

    // hidden parts and a hidden shell aren't captured
    model.children[1].visible = false;
    shell.update();
    expect(wingProxy.visible).toBe(false);
    shell.visible = false;
    expect(group.visible).toBe(false);
    expect(shell.object.visible).toBe(false);

    shell.dispose();
    expect(capture.scene.children).toHaveLength(0);
  });

  it("gives each model its own owner id and rejects a shrinking scale", () => {
    const capture = new DepthShellCapture(new THREE.PerspectiveCamera());
    const a = capture.register(ship());
    const b = capture.register(ship());
    expect([a.id, b.id]).toEqual([1, 2]);
    a.dispose();
    expect(capture.register(ship()).id).toBe(1);
    expect(() => capture.register(ship(), { scale: 0.9 })).toThrow(/at least 1/);
  });

  it("fits the quad's screen rectangle to a box", () => {
    const vp = viewProjection(topDownCamera());
    const target = new THREE.Vector4();
    const at = (x: number, z: number) => new THREE.Box3(new THREE.Vector3(x - 1, -1, z - 1), new THREE.Vector3(x + 1, 1, z + 1));

    // a 2-unit box on a 20-unit view covers a tenth of each axis, plus the margin
    const { x, y, z, w } = shellScreenBounds(at(0, 0), vp, target);
    expect(z - x).toBeGreaterThan(0.2);
    expect(z - x).toBeLessThan(0.25);
    expect(w - y).toBeGreaterThan(0.2);
    expect(w - y).toBeLessThan(0.25);

    // clamped to the screen when partly off it
    expect(Math.max(...shellScreenBounds(at(9.5, 0), vp, target).toArray().map(Math.abs))).toBe(1);

    // nothing to draw off screen or for an empty box
    expect(shellScreenBounds(at(50, 0), vp, target).toArray()).toEqual([0, 0, 0, 0]);
    expect(shellScreenBounds(new THREE.Box3(), vp, target).toArray()).toEqual([0, 0, 0, 0]);
  });

  it("falls back to the whole screen when the box reaches behind a perspective camera", () => {
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld();
    const box = new THREE.Box3(new THREE.Vector3(-1, -1, 4), new THREE.Vector3(1, 1, 6));
    expect(shellScreenBounds(box, viewProjection(camera), new THREE.Vector4()).toArray()).toEqual([-1, -1, 1, 1]);
  });

  it("fits itself to the model when drawn, and draws nothing with the model off screen", () => {
    const camera = topDownCamera();
    const model = ship();
    const shell = new DepthShell(new DepthShellCapture(camera), model, { shader: () => ({ color: vec3(1) }) });
    const rectangle = () => {
      shell.update();
      (shell.object.onBeforeRender as () => void)();
      const nodes: THREE.Vector4[] = [];
      shell.object.material.vertexNode!.traverse((node: unknown) => {
        const value = (node as { value?: unknown }).value;
        if (value instanceof THREE.Vector4 && !nodes.includes(value)) nodes.push(value);
      });
      expect(nodes).toHaveLength(1);
      return nodes[0].toArray();
    };

    const [minX, , maxX] = rectangle();
    expect(maxX - minX).toBeGreaterThan(0.4);
    expect(maxX - minX).toBeLessThan(0.5);

    model.position.x = 100;
    expect(rectangle()).toEqual([0, 0, 0, 0]);
    shell.dispose();
  });

  it("keeps the whole screen for instanced parts, whose bounds it can't tell", () => {
    const capture = new DepthShellCapture(topDownCamera());
    const model = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshStandardNodeMaterial(), 2);
    const handle = capture.register(model);
    handle.update(true);
    expect(handle.bounds(new THREE.Box3())).toBe(false);
    handle.dispose();
  });
});
