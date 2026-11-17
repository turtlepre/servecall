// What happens while the ball is on the court.
//
// A tennis ball stays in contact for about 4-5 ms. In that time it is
// compressed and restored, and it skids forward roughly 10 cm on a fast
// serve. Two consequences for line calls:
//
//  1. The point a kink fit recovers is the virtual vertex, where the incoming
//     and outgoing flight paths meet when extended. It lies below the height
//     of an undeformed ball resting on the court (BALL_R): the incoming path
//     keeps descending for tau1 = tauC * e / (1 + e) after first contact.
//  2. The ball touches the court along a mark that starts at first contact
//     (vertex minus incoming velocity times tau1) and ends where it leaves.
//     The ball is in when any part of that mark touches the box.
//
// Model: vertical motion is a quarter sine down (tau1) and a quarter sine up
// (tau2 = tau1 / e), so the ball leaves with e times its incoming vertical
// speed; friction follows the normal force and takes the horizontal speed
// from |v1| to |v2|.

import { BALL_R } from './court.js';

export const CONTACT_TIME = 0.0045; // seconds
export const VERTEX_HEIGHT_DEFAULT = 0.02; // metres, typical serve

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// v1, v2: velocities (u, v, zUp) just before and after the bounce.
export function bounceParams(v1, v2, tauC = CONTACT_TIME) {
  const vz = Math.max(0.5, -v1[2]);
  const e = clamp(v2[2] / vz, 0.4, 0.95);
  const h1 = Math.hypot(v1[0], v1[1]), h2 = Math.hypot(v2[0], v2[1]);
  const mu = h1 > 1e-6 ? clamp(h2 / h1, 0.3, 1) : 1;
  const tau1 = tauC * e / (1 + e), tau2 = tauC - tau1;
  return { vz, e, mu, tau1, tau2, tauC, zVertex: clamp(BALL_R - vz * tau1, 0.005, BALL_R) };
}

// Contact patch over time, as discs { u, v, a } in box coordinates, for a
// bounce whose vertex is at (u, v).
export function contactMark(u, v, v1, v2, tauC = CONTACT_TIME, n = 24) {
  const { vz, e, mu, tau1, tau2 } = bounceParams(v1, v2, tauC);
  const delta = vz * tau1 * 2 / Math.PI;
  const frac = (t) => (t <= tau1
    ? (1 - Math.cos(Math.PI / 2 * t / tau1)) / (1 + e)
    : (1 + e * Math.sin(Math.PI / 2 * (t - tau1) / tau2)) / (1 + e));
  let x = u - v1[0] * tau1, y = v - v1[1] * tau1; // first contact
  const out = [{ u: x, v: y, a: 0 }];
  const dt = tauC / n;
  for (let i = 1; i <= n; i++) {
    const k = 1 - (1 - mu) * frac((i - 0.5) * dt);
    x += v1[0] * k * dt; y += v1[1] * k * dt;
    const t = i * dt;
    const d = t <= tau1
      ? delta * Math.sin(Math.PI / 2 * t / tau1)
      : delta * Math.cos(Math.PI / 2 * (t - tau1) / tau2);
    out.push({ u: x, v: y, a: Math.sqrt(Math.max(0, 2 * BALL_R * d - d * d)) });
  }
  return out;
}

// Mark for a bounce whose velocities are unknown: a typical serve travelling
// straight away from the net.
export function nominalMark(u, v) {
  return contactMark(u, v, [0, 28, -6.5], [0, 18, 4.9]);
}
