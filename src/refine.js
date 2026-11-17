// Refines a bounce with a 3D flight model.
//
// Each side of the bounce is modelled as ballistic flight (gravity, air drag
// and an unknown spin acceleration) and projected through the calibrated
// camera. Fitting this to the image samples removes the bias a straight-line
// fit has: the ball speeds up in the image as it approaches the camera, drag
// slows it, and topspin or slice bends its path.
//
// Coordinates are box coordinates (u, v metres) with height zUp.

import { solve } from './geometry.js';
import { BALL_R } from './court.js';

const G = 9.81;
// 0.5 * air density * drag coefficient * cross-section / mass, per metre.
const DRAG_K = 0.5 * 1.21 * 0.55 * Math.PI * BALL_R * BALL_R / 0.0577;
// Spin (Magnus) acceleration is unknown; this prior keeps it near zero unless
// the samples clearly need it. 15 m/s^2 costs as much as a 1 px misfit.
const SPIN_PRIOR = 15;
const NP = 15;

function flight(B, v, da, dt, out) {
  const s = Math.hypot(v[0], v[1], v[2]);
  const ax = -DRAG_K * s * v[0] + da[0];
  const ay = -DRAG_K * s * v[1] + da[1];
  const az = -G - DRAG_K * s * v[2] + da[2];
  const h = 0.5 * dt * dt;
  out[0] = B[0] + v[0] * dt + ax * h;
  out[1] = B[1] + v[1] * dt + ay * h;
  out[2] = B[2] + v[2] * dt + az * h;
  return out;
}

// Initial 3D velocity from rays: points B + v*dt - 0.5*g*dt^2 must lie on the
// viewing rays of the samples. Linear least squares in v.
function velocityFromRays(cam, B, tau, pts) {
  const C = cam.C;
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
  for (const p of pts) {
    const d = cam.ray(p.x, p.y);
    const dt = p.t - tau;
    const Q = [B[0] - C[0], B[1] - C[1], B[2] - 0.5 * G * dt * dt - C[2]];
    // dt * [d]x v = Q x d
    const M = [
      [0, -d[2] * dt, d[1] * dt],
      [d[2] * dt, 0, -d[0] * dt],
      [-d[1] * dt, d[0] * dt, 0],
    ];
    const rhs = [Q[1] * d[2] - Q[2] * d[1], Q[2] * d[0] - Q[0] * d[2], Q[0] * d[1] - Q[1] * d[0]];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) A[j][k] += M[i][j] * M[i][k];
      for (let j = 0; j < 3; j++) b[j] += M[i][j] * rhs[i];
    }
  }
  return solve(A, b);
}

// Follows a flight back in time from the point B, where the ball has
// velocity v, to where it left the ground. Returns the distance along the
// court (box v, metres) between that place and B. lift: extra vertical
// acceleration (spin), m/s^2.
function hopLength(B, v, lift = 0) {
  const h = 0.004;
  const acc = (w) => {
    const s = Math.hypot(w[0], w[1], w[2]);
    return [-DRAG_K * s * w[0], -DRAG_K * s * w[1], -G + lift - DRAG_K * s * w[2]];
  };
  let p = [B[0], B[1], B[2]], w = [v[0], v[1], v[2]];
  for (let i = 0; i < 1000; i++) {
    // one step back: midpoint rule
    const a = acc(w);
    const wm = [w[0] - a[0] * h / 2, w[1] - a[1] * h / 2, w[2] - a[2] * h / 2];
    const am = acc(wm);
    const q = [p[0] - wm[0] * h, p[1] - wm[1] * h, p[2] - wm[2] * h];
    w = [w[0] - am[0] * h, w[1] - am[1] * h, w[2] - am[2] * h];
    // Going back in time drag speeds the ball up, without limit: an arc
    // that has not come down by now came from very far away.
    if (!(Math.hypot(w[0], w[1], w[2]) < 150)) return 1000;
    if (i > 0 && q[2] <= B[2]) {
      const k = (p[2] - B[2]) / Math.max(1e-9, p[2] - q[2]); // where this step crosses the ground level
      return B[1] - (p[1] + (q[1] - p[1]) * k);
    }
    p = q;
  }
  return B[1] - p[1];
}

// Spin bends the flight by an amount the camera cannot tell from distance.
// Its force grows with the square of the speed, as drag does, and reaches at
// most about half of the drag; this fraction of the drag (plus a little) is
// allowed for, up or down, when the arc is followed back.
const LIFT_MAX = 0.6;

// How far back along the court (box v, metres) did the arc that ends at the
// bounce point B at time tau leave the ground, had it started from the
// ground? A ball that came over the net was above the ground there, so its
// arc reaches back beyond the net; an arc that starts on the receiver's side
// belongs to a ball that had already bounced.
//
// The arriving velocity comes from all the samples given, under gravity and
// air drag. One camera sees the speed along its line of sight only through
// the curvature of the path, which spin changes too. So the answer is a
// range: `near` is the shortest arc the samples allow (heavy topspin,
// measurement noise against it) and `far` the longest. `fwd` is the lowest
// speed away from the net (m/s) the samples allow at the bounce.
// Returns { back, near, far, v, fwd, n } or null.
export function arcBack(cam, B, tau, pts) {
  if (!cam.ray || pts.length < 4) return null;
  const C = cam.C;
  const obs = [];
  for (const p of pts) {
    const d = cam.ray(p.x, p.y);
    const n = Math.hypot(d[0], d[1], d[2]);
    const dt = p.t - tau;
    if (n > 0 && dt < 0) obs.push({ e: [d[0] / n, d[1] / n, d[2] / n], dt });
  }
  if (obs.length < 4) return null;
  // velocity at B for a given extra vertical acceleration
  const arrive = (lift) => {
    let v = null, A = null, sse = 0;
    let acc = [0, 0, -G + lift];
    for (let pass = 0; pass < 3; pass++) {
      A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      const b = [0, 0, 0];
      const rows = [];
      for (const { e, dt } of obs) {
        const h = 0.5 * dt * dt;
        const Q = [B[0] + acc[0] * h - C[0], B[1] + acc[1] * h - C[1], B[2] + acc[2] * h - C[2]];
        // the point B + v*dt + acc*dt^2/2 must lie on the ray: dt * [e]x v = Q x e
        const M = [
          [0, -e[2] * dt, e[1] * dt],
          [e[2] * dt, 0, -e[0] * dt],
          [-e[1] * dt, e[0] * dt, 0],
        ];
        const rhs = [Q[1] * e[2] - Q[2] * e[1], Q[2] * e[0] - Q[0] * e[2], Q[0] * e[1] - Q[1] * e[0]];
        rows.push([M, rhs]);
        for (let i = 0; i < 3; i++) {
          for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) A[j][k] += M[i][j] * M[i][k];
          for (let j = 0; j < 3; j++) b[j] += M[i][j] * rhs[i];
        }
      }
      v = solve(A.map((r) => r.slice()), b.slice());
      if (!v) return null;
      sse = 0;
      for (const [M, rhs] of rows) {
        for (let i = 0; i < 3; i++) sse += (M[i][0] * v[0] + M[i][1] * v[1] + M[i][2] * v[2] - rhs[i]) ** 2;
      }
      // drag for the next pass, taken as constant over these few tenths of a second
      const s = Math.hypot(v[0], v[1], v[2]);
      acc = [-DRAG_K * s * v[0], -DRAG_K * s * v[1], -G + lift - DRAG_K * s * v[2]];
    }
    return v[2] < 0 ? { v, A, sse } : null; // not coming down: no arc to follow back
  };
  const mid = arrive(0);
  if (!mid) return null;
  const { v, A, sse } = mid;
  const back = hopLength(B, v);
  // Measurement noise: the velocity is uncertain mostly in one direction
  // (along the line of sight). Find that direction and its size.
  const s2 = sse / (2 * obs.length - 3); // each sample gives two independent equations
  const cov = [];
  for (let i = 0; i < 3; i++) {
    const col = solve(A.map((r) => r.slice()), [0, 1, 2].map((k) => (k === i ? 1 : 0)));
    if (!col) return null;
    cov.push(col.map((x) => x * s2));
  }
  let e = [1, 1, 1], lam = 0;
  for (let it = 0; it < 12; it++) {
    const w = [0, 1, 2].map((i) => cov[i][0] * e[0] + cov[i][1] * e[1] + cov[i][2] * e[2]);
    lam = Math.hypot(w[0], w[1], w[2]);
    if (!(lam > 0)) break;
    e = [w[0] / lam, w[1] / lam, w[2] / lam];
  }
  const dv = 2.5 * Math.sqrt(Math.max(0, lam));
  // Unknown spin: as much lift, up or down, as a ball of this speed can have.
  const speed = Math.hypot(v[0], v[1], v[2]);
  const lift = LIFT_MAX * DRAG_K * speed * speed + 0.5;
  let near = back, far = back, fwd = v[1];
  for (const l of [-lift, 0, lift]) {
    const a = l === 0 ? mid : arrive(l);
    if (!a) return { back, near: -Infinity, far: Infinity, v, fwd: -Infinity, n: obs.length }; // may not even be coming down
    for (const k of [-dv, 0, dv]) {
      const w = [a.v[0] + k * e[0], a.v[1] + k * e[1], a.v[2] + k * e[2]];
      if (!(w[2] < 0)) return { back, near: -Infinity, far: Infinity, v, fwd: -Infinity, n: obs.length };
      if (w[1] < fwd) fwd = w[1];
      const d = hopLength(B, w, l);
      if (d < near) near = d;
      if (d > far) far = d;
    }
  }
  return { back, near, far, v, fwd, n: obs.length };
}

// th = [u, v, tau, v1(3), v2(3), spin1(3), spin2(3)]; zB: height of the vertex.
function residuals(cam, th, pre, post, out, zB) {
  const B = [th[0], th[1], zB];
  const tau = th[2];
  const P = [0, 0, 0];
  let k = 0;
  const sides = [[pre, 3, 9], [post, 6, 12]];
  for (const [pts, vi, ai] of sides) {
    const v = [th[vi], th[vi + 1], th[vi + 2]];
    const da = [th[ai], th[ai + 1], th[ai + 2]];
    for (const p of pts) {
      flight(B, v, da, p.t - tau, P);
      const q = cam.project(P[0], P[1], P[2]);
      if (!q) return false;
      out[k++] = q[0] - p.x;
      out[k++] = q[1] - p.y;
    }
  }
  for (let i = 9; i < 15; i++) out[k++] = th[i] / SPIN_PRIOR;
  return true;
}

// init: { t, u, v } (bounce time and position of the vertex).
// zB: height of the ball centre at the vertex (see bounce.js).
// Returns { u, v, t, rms, v1, v2, spin1, spin2 } or null when the fit is not trustworthy.
export function refineBounce3D(cam, pre, post, init, zB = BALL_R) {
  if (!cam.ray || pre.length < 2 || post.length < 2) return null;
  const tLo = pre[pre.length - 1].t, tHi = post[0].t;
  const B0 = [init.u, init.v, zB];
  const tau0 = Math.min(tHi, Math.max(tLo, init.t));
  const v1 = velocityFromRays(cam, B0, tau0, pre);
  const v2 = velocityFromRays(cam, B0, tau0, post);
  if (!v1 || !v2) return null;
  let th = [init.u, init.v, tau0, ...v1, ...v2, 0, 0, 0, 0, 0, 0];
  const nObs = 2 * (pre.length + post.length);
  const m = nObs + 6;
  const r = new Float64Array(m), r2 = new Float64Array(m);
  if (!residuals(cam, th, pre, post, r, zB)) return null;
  let cost = r.reduce((s, x) => s + x * x, 0);
  let lambda = 1e-3;
  const steps = [1e-4, 1e-4, 1e-5, 1e-3, 1e-3, 1e-3, 1e-3, 1e-3, 1e-3, 1e-2, 1e-2, 1e-2, 1e-2, 1e-2, 1e-2];
  const J = Array.from({ length: NP }, () => new Float64Array(m));
  for (let it = 0; it < 40; it++) {
    for (let j = 0; j < NP; j++) {
      const t2 = th.slice();
      t2[j] += steps[j];
      if (!residuals(cam, t2, pre, post, r2, zB)) return null;
      for (let i = 0; i < m; i++) J[j][i] = (r2[i] - r[i]) / steps[j];
    }
    const JTJ = [], JTr = [];
    for (let a = 0; a < NP; a++) {
      JTJ.push(new Array(NP).fill(0));
      let s = 0;
      for (let i = 0; i < m; i++) s += J[a][i] * r[i];
      JTr.push(-s);
      for (let b = 0; b <= a; b++) {
        let t = 0;
        for (let i = 0; i < m; i++) t += J[a][i] * J[b][i];
        JTJ[a][b] = t;
      }
    }
    for (let a = 0; a < NP; a++) for (let b = a + 1; b < NP; b++) JTJ[a][b] = JTJ[b][a];
    let improved = false, done = false;
    for (let tries = 0; tries < 8; tries++) {
      const A = JTJ.map((row, i) => row.map((x, j) => (i === j ? x * (1 + lambda) + 1e-12 : x)));
      const d = solve(A, JTr);
      if (!d) { lambda *= 10; continue; }
      const cand = th.map((x, i) => x + d[i]);
      cand[2] = Math.min(tHi, Math.max(tLo, cand[2]));
      if (residuals(cam, cand, pre, post, r2, zB)) {
        const c2 = r2.reduce((s, x) => s + x * x, 0);
        if (c2 < cost) {
          const rel = (cost - c2) / cost;
          th = cand;
          r.set(r2);
          cost = c2;
          lambda = Math.max(1e-7, lambda / 5);
          improved = true;
          if (rel < 1e-7) done = true;
          break;
        }
      }
      lambda *= 10;
    }
    if (!improved || done) break;
  }
  let sse = 0;
  for (let i = 0; i < nObs; i++) sse += r[i] * r[i];
  const rms = Math.sqrt(sse / (nObs / 2));
  const vin = [th[3], th[4], th[5]], vout = [th[6], th[7], th[8]];
  const sIn = Math.hypot(...vin);
  // Plausible bounce: arriving downwards, leaving upwards, sane speed.
  if (!(vin[2] < 0 && vout[2] > 0 && sIn > 3 && sIn < 80)) return null;
  return {
    u: th[0], v: th[1], t: th[2], rms, v1: vin, v2: vout, speedIn: sIn,
    spin1: th.slice(9, 12), spin2: th.slice(12, 15),
  };
}

// A sample taken within a few milliseconds of the bounce can sit on either
// side of it, and the 2D kink search may have put it on the wrong one. The
// flight fit is therefore tried three ways -- as given, with the last sample
// before the bounce moved after it, and with the first sample after it moved
// before -- and the best-fitting reading wins. The reading as given keeps a
// small advantage so that noise alone does not switch it.
export function refineBounceBest(cam, pre, post, init, zB = BALL_R) {
  const base = refineBounce3D(cam, pre, post, init, zB);
  let best = base, bestScore = base ? base.rms : Infinity;
  const tryAlt = (p2, q2, t) => {
    if (p2.length < 2 || q2.length < 2) return;
    const fit = refineBounce3D(cam, p2, q2, { ...init, t }, zB);
    if (fit && fit.rms < 0.85 * bestScore) { best = fit; bestScore = fit.rms; }
  };
  const lastPre = pre[pre.length - 1], firstPost = post[0];
  tryAlt(pre.slice(0, -1), [lastPre, ...post], lastPre.t);
  tryAlt([...pre, firstPost], post.slice(1), firstPost.t);
  return best;
}
