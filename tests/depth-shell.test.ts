import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { vec3 } from "three/tsl";
import { DepthShell, DepthShellCapture } from "../src/three";

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
});
