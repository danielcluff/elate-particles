// Minimal allocation-free vector helpers (the simulator does not depend on three).

export type V3 = [number, number, number];
export type Q4 = [number, number, number, number];

/** out = q * v (rotate v by unit quaternion q). `out` may alias `v`. */
export function rotate(q: ArrayLike<number>, x: number, y: number, z: number, out: number[] | Float32Array, o = 0): void {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[o] = x + qw * tx + (qy * tz - qz * ty);
  out[o + 1] = y + qw * ty + (qz * tx - qx * tz);
  out[o + 2] = z + qw * tz + (qx * ty - qy * tx);
}

/** Quaternion from XYZ Euler angles in degrees (three's default order). */
export function quatFromEulerDeg(ex: number, ey: number, ez: number): Q4 {
  const d = Math.PI / 360;
  const c1 = Math.cos(ex * d), c2 = Math.cos(ey * d), c3 = Math.cos(ez * d);
  const s1 = Math.sin(ex * d), s2 = Math.sin(ey * d), s3 = Math.sin(ez * d);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

export function isIdentityQuat(q: ArrayLike<number>): boolean {
  return q[0] === 0 && q[1] === 0 && q[2] === 0 && q[3] === 1;
}

/** Column-major 4x4 (three.js layout) from position, rotation and uniform scale. */
export function composeMatrix(p: ArrayLike<number>, q: ArrayLike<number>, s: number, out: Float32Array): void {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  out[0] = (1 - (yy + zz)) * s;
  out[1] = (xy + wz) * s;
  out[2] = (xz - wy) * s;
  out[3] = 0;
  out[4] = (xy - wz) * s;
  out[5] = (1 - (xx + zz)) * s;
  out[6] = (yz + wx) * s;
  out[7] = 0;
  out[8] = (xz + wy) * s;
  out[9] = (yz - wx) * s;
  out[10] = (1 - (xx + yy)) * s;
  out[11] = 0;
  out[12] = p[0];
  out[13] = p[1];
  out[14] = p[2];
  out[15] = 1;
}

// ---------------------------------------------------------------------------
// 3D gradient noise (Perlin "improved"), deterministic, ~[-1, 1]
// ---------------------------------------------------------------------------

const PERM = new Uint8Array(512);
{
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  let s = 1337;
  for (let i = 255; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
}

function grad(h: number, x: number, y: number, z: number): number {
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

function lerp(t: number, a: number, b: number): number {
  return a + t * (b - a);
}

export function noise3(x: number, y: number, z: number): number {
  const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
  const X = fx & 255, Y = fy & 255, Z = fz & 255;
  x -= fx;
  y -= fy;
  z -= fz;
  const u = x * x * x * (x * (x * 6 - 15) + 10);
  const v = y * y * y * (y * (y * 6 - 15) + 10);
  const w = z * z * z * (z * (z * 6 - 15) + 10);
  const A = PERM[X] + Y, AA = PERM[A] + Z, AB = PERM[A + 1] + Z;
  const B = PERM[X + 1] + Y, BA = PERM[B] + Z, BB = PERM[B + 1] + Z;
  return lerp(
    w,
    lerp(v, lerp(u, grad(PERM[AA] & 15, x, y, z), grad(PERM[BA] & 15, x - 1, y, z)), lerp(u, grad(PERM[AB] & 15, x, y - 1, z), grad(PERM[BB] & 15, x - 1, y - 1, z))),
    lerp(
      v,
      lerp(u, grad(PERM[AA + 1] & 15, x, y, z - 1), grad(PERM[BA + 1] & 15, x - 1, y, z - 1)),
      lerp(u, grad(PERM[AB + 1] & 15, x, y - 1, z - 1), grad(PERM[BB + 1] & 15, x - 1, y - 1, z - 1)),
    ),
  );
}
