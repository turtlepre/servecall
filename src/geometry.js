// Plane geometry: 4-point homography, inversion, and camera pose recovery.
// Matrices are flat row-major arrays of 9 numbers.

export function mul3(A, B) {
  const C = new Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
    }
  }
  return C;
}

export function invert3(M) {
  const [a, b, c, d, e, f, g, h, i] = M;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!det || !Number.isFinite(det)) return null;
  const k = 1 / det;
  return [
    A * k, -(b * i - c * h) * k, (b * f - c * e) * k,
    B * k, (a * i - c * g) * k, -(a * f - c * d) * k,
    C * k, -(a * h - b * g) * k, (a * e - b * d) * k,
  ];
}

export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

// Gaussian elimination with partial pivoting. Returns null when singular.
export function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    if (p !== c) [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r][c] / M[c][c];
      if (k === 0) continue;
      for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

function normalizer(pts) {
  let mx = 0, my = 0;
  for (const [x, y] of pts) { mx += x; my += y; }
  mx /= pts.length; my /= pts.length;
  let d = 0;
  for (const [x, y] of pts) d += Math.hypot(x - mx, y - my);
  d /= pts.length;
  const s = d > 0 ? Math.SQRT2 / d : 1;
  return [s, 0, -s * mx, 0, s, -s * my, 0, 0, 1];
}

function normalizeScale(H) {
  const s = H[8] !== 0 ? H[8] : Math.hypot(...H);
  return H.map((v) => v / s);
}

// Homography mapping 4 src points onto 4 dst points (Hartley-normalized DLT).
export function homography(src, dst) {
  if (src.length !== 4 || dst.length !== 4) throw new Error('homography needs 4 point pairs');
  const Ts = normalizer(src), Td = normalizer(dst);
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = applyH(Ts, src[i][0], src[i][1]);
    const [X, Y] = applyH(Td, dst[i][0], dst[i][1]);
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
  }
  const h = solve(A, b);
  if (!h) return null;
  const TdInv = invert3(Td);
  if (!TdInv) return null;
  return normalizeScale(mul3(TdInv, mul3([...h, 1], Ts)));
}

// True when the 4 image points form a convex quad with consistent winding.
export function isConvexQuad(pts) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % 4], [cx, cy] = pts[(i + 2) % 4];
    const z = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(z) < 1e-9) return false;
    const s = Math.sign(z);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function poseWithFocal(h1, h2, h3, fp) {
  const k1 = [h1[0] / fp, h1[1] / fp, h1[2]];
  const k2 = [h2[0] / fp, h2[1] / fp, h2[2]];
  const k3 = [h3[0] / fp, h3[1] / fp, h3[2]];
  const lam = Math.sqrt(norm(k1) * norm(k2));
  if (!(lam > 0)) return null;
  let r1 = scale(k1, 1 / lam), r2 = scale(k2, 1 / lam), t = scale(k3, 1 / lam);
  // The plane origin must lie in front of the camera.
  if (t[2] < 0) { r1 = scale(r1, -1); r2 = scale(r2, -1); t = scale(t, -1); }
  // Symmetric orthonormalization of r1, r2.
  const a = scale(r1, 1 / norm(r1)), b = scale(r2, 1 / norm(r2));
  const c = add(a, b), d = sub(a, b);
  const cn = scale(c, 1 / norm(c)), dn = scale(d, 1 / norm(d));
  r1 = scale(add(cn, dn), Math.SQRT1_2);
  r2 = scale(sub(cn, dn), Math.SQRT1_2);
  const r3 = cross(r1, r2);
  const C = [-dot(r1, t), -dot(r2, t), -dot(r3, t)];
  return { fp, r1, r2, r3, t, C };
}

// Recovers the camera from a plane->image homography, assuming square pixels
// and the principal point at the image centre. The focal length is estimated
// from the homography itself; when that is ill-conditioned the fallback
// horizontal field of view is used.
//   H: maps plane coords (metres) to image pixels.
// Returns { f, hfov, estimated, height, C:[u,v,h], project(u,v,zUp) }.
export function cameraFromHomography(H, W, Hh, fallbackHfovDeg = 67) {
  const cx = W / 2, cy = Hh / 2;
  const T = [1 / W, 0, -cx / W, 0, 1 / W, -cy / W, 0, 0, 1];
  const M = mul3(T, H);
  const h1 = [M[0], M[3], M[6]], h2 = [M[1], M[4], M[7]], h3 = [M[2], M[5], M[8]];
  const a1 = h1[0] * h2[0] + h1[1] * h2[1], b1 = h1[2] * h2[2];
  const a2 = h1[0] ** 2 + h1[1] ** 2 - h2[0] ** 2 - h2[1] ** 2, b2 = h1[2] ** 2 - h2[2] ** 2;
  const den = a1 * a1 + a2 * a2;
  let fp = NaN, estimated = false;
  if (den > 0) {
    const w = -(a1 * b1 + a2 * b2) / den;
    if (w > 0) {
      const cand = 1 / Math.sqrt(w);
      const hfov = 2 * Math.atan(0.5 / cand) * 180 / Math.PI;
      // 8 degrees is a strongly zoomed view; narrower than that or wider
      // than a fisheye means the corners do not describe a real camera.
      if (hfov >= 8 && hfov <= 125) { fp = cand; estimated = true; }
    }
  }
  if (!estimated) fp = 0.5 / Math.tan((fallbackHfovDeg * Math.PI / 180) / 2);
  let pose = poseWithFocal(h1, h2, h3, fp);
  if (estimated && (!pose || Math.abs(pose.C[2]) < 0.3 || Math.abs(pose.C[2]) > 25)) {
    estimated = false;
    fp = 0.5 / Math.tan((fallbackHfovDeg * Math.PI / 180) / 2);
    pose = poseWithFocal(h1, h2, h3, fp);
  }
  if (!pose) return null;
  const upSign = pose.C[2] >= 0 ? 1 : -1;
  const f = fp * W;
  const { r1, r2, r3, t } = pose;
  return {
    f,
    hfov: 2 * Math.atan(0.5 / fp) * 180 / Math.PI,
    estimated,
    height: Math.abs(pose.C[2]),
    C: [pose.C[0], pose.C[1], Math.abs(pose.C[2])],
    // Projects a point given in plane coords plus height above the plane.
    project(u, v, zUp = 0) {
      const z = upSign * zUp;
      const X = r1[0] * u + r2[0] * v + r3[0] * z + t[0];
      const Y = r1[1] * u + r2[1] * v + r3[1] * z + t[1];
      const Z = r1[2] * u + r2[2] * v + r3[2] * z + t[2];
      if (Z <= 1e-6) return null;
      return [cx + f * X / Z, cy + f * Y / Z, Z];
    },
    // Direction (u, v, zUp) of the viewing ray through an image pixel.
    ray(x, y) {
      const dc = [(x - cx) / f, (y - cy) / f, 1];
      return [dot(r1, dc), dot(r2, dc), upSign * dot(r3, dc)];
    },
  };
}
