// Synthetic tennis court video for testing the pipeline without a real court.
//
// World coordinates (metres): X across the court (+ = server's right),
// Y along it from the server's baseline (0) to the far baseline (23.77),
// Z up. The judged box is the far deuce box: X in [-4.115, 0.025],
// Y in [11.885, 18.285]. Box coords (u, v) -> world: X = 0.025 - u, Y = 11.885 + v.

export const NET_Y = 11.885;
export const BALL_R = 0.0335;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const nrm = (a) => scl(a, 1 / Math.hypot(a[0], a[1], a[2]));

export function boxToWorld(u, v) {
  return [0.025 - u, NET_Y + v];
}
export function worldToBox(X, Y) {
  return [0.025 - X, Y - NET_Y];
}

// Deterministic PRNG so runs are repeatable.
export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  next.gauss = () => {
    let u = 0, v = 0;
    while (u === 0) u = next();
    while (v === 0) v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  next.range = (a, b) => a + (b - a) * next();
  return next;
}

export function makeCamera({ pos, target, W = 1280, H = 720, hfov = 66 }) {
  const f = (W / 2) / Math.tan(hfov * Math.PI / 360);
  const fwd = nrm(sub(target, pos));
  const right = nrm(crs(fwd, [0, 0, 1]));
  const down = crs(fwd, right);
  return {
    C: pos, f, W, H, cx: W / 2, cy: H / 2,
    project(P) {
      const d = sub(P, pos);
      const z = dot(fwd, d);
      if (z <= 1e-6) return null;
      return [W / 2 + f * dot(right, d) / z, H / 2 + f * dot(down, d) / z, z];
    },
    ray(px, py) {
      const x = (px - W / 2) / f, y = (py - H / 2) / f;
      return nrm(add(add(scl(right, x), scl(down, y)), fwd));
    },
  };
}

// ---- Static scene ------------------------------------------------------------

const COL = {
  court: [48, 95, 140],
  surround: [58, 112, 78],
  line: [236, 238, 240],
  sky: [168, 196, 228],
  fence: [38, 62, 44],
  netTape: [242, 242, 242],
  netMesh: [25, 25, 25],
};

// Court colour presets (as a phone records a sunlit court). The default is a
// blue hard court; the others have yellowish surfaces, which are harder for a
// detector that looks for yellow.
export const COURTS = {
  blue: { court: [48, 95, 140], surround: [58, 112, 78] },
  green: { court: [70, 125, 85], surround: [58, 112, 78] },
  clay: { court: [176, 104, 70], surround: [176, 104, 70] },
  turf: { court: [125, 150, 72], surround: [125, 150, 72] }, // sun-faded artificial grass
};
export function setCourt(name) {
  const c = COURTS[name];
  if (!c) throw new Error(`unknown court ${name}`);
  COL.court = c.court;
  COL.surround = c.surround;
}

function isLine(X, Y) {
  const ax = Math.abs(X);
  if (Y < 0 || Y > 23.77 || ax > 5.485) return false;
  if (Y <= 0.10 || Y >= 23.67) return true;
  if (ax >= 5.435) return true;
  if (ax >= 4.065 && ax <= 4.115) return true;
  if (ax <= 4.115 && ((Y >= 5.485 && Y <= 5.535) || (Y >= 18.235 && Y <= 18.285))) return true;
  if (ax <= 0.025 && Y >= 5.485 && Y <= 18.285) return true;
  if (ax <= 0.025 && ((Y >= 0.10 && Y <= 0.20) || (Y >= 23.57 && Y <= 23.67))) return true;
  return false;
}

function groundColor(X, Y) {
  if (isLine(X, Y)) return COL.line;
  if (Math.abs(X) <= 5.485 && Y >= 0 && Y <= 23.77) return COL.court;
  return COL.surround;
}

const FENCE = { x: 9.15, y0: -6.4, y1: 30.17, h: 3.5 };
const netHeight = (X) => 0.914 + 0.156 * Math.min(1, Math.abs(X) / 6.4);

function sceneColor(C, d) {
  let best = Infinity, col = COL.sky;
  // ground
  if (d[2] < 0) {
    const t = -C[2] / d[2];
    const X = C[0] + d[0] * t, Y = C[1] + d[1] * t;
    if (Math.abs(X) <= FENCE.x && Y >= FENCE.y0 && Y <= FENCE.y1 && t < best) { best = t; col = groundColor(X, Y); }
  }
  // fence walls
  const walls = [
    [0, FENCE.x], [0, -FENCE.x], [1, FENCE.y0], [1, FENCE.y1],
  ];
  for (const [axis, val] of walls) {
    if (Math.abs(d[axis]) < 1e-9) continue;
    const t = (val - C[axis]) / d[axis];
    if (t <= 0 || t >= best) continue;
    const P = add(C, scl(d, t));
    const other = axis === 0 ? P[1] : P[0];
    const inRange = axis === 0 ? other >= FENCE.y0 && other <= FENCE.y1 : Math.abs(other) <= FENCE.x;
    if (inRange && P[2] >= 0 && P[2] <= FENCE.h) { best = t; col = COL.fence; }
  }
  // net
  if (Math.abs(d[1]) > 1e-9) {
    const t = (NET_Y - C[1]) / d[1];
    if (t > 0 && t < best) {
      const P = add(C, scl(d, t));
      const h = netHeight(P[0]);
      if (Math.abs(P[0]) <= 6.4 && P[2] >= 0 && P[2] <= h) {
        if (P[2] >= h - 0.05) col = COL.netTape;
        else col = col.map((c, i) => 0.62 * c + 0.38 * COL.netMesh[i]);
      }
    }
  }
  return col;
}

// Full-frame RGB background with 2x2 supersampling and a little texture.
export function renderBackground(cam, seed = 7) {
  const { W, H, C } = cam;
  const out = new Float32Array(W * H * 3);
  const r = rng(seed);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let R = 0, G = 0, B = 0;
      for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const c = sceneColor(C, cam.ray(x + ox, y + oy));
        R += c[0]; G += c[1]; B += c[2];
      }
      const tex = (r() - 0.5) * 6;
      const i = (y * W + x) * 3;
      out[i] = R / 4 + tex; out[i + 1] = G / 4 + tex; out[i + 2] = B / 4 + tex;
    }
  }
  return out;
}

// ---- Ball flight ---------------------------------------------------------------

// setDragScale (or SIM_DRAG_SCALE) lets a test fly the ball with more or less
// air drag than the app's flight model assumes.
const DRAG_K0 = 0.5 * 1.21 * 0.55 * Math.PI * BALL_R * BALL_R / 0.0577;
let DRAG_K = DRAG_K0 * Number(process.env.SIM_DRAG_SCALE ?? 1);
export function setDragScale(k) {
  DRAG_K = DRAG_K0 * k;
}

// spin: the acceleration (m/s^2) topspin gives the ball at SPIN_REF m/s. Like
// drag, the force of spin grows with the square of the speed, so a slow ball
// is bent much less than a fast one.
const SPIN_REF = 45;
function accel(v, spin) {
  const s = Math.hypot(v[0], v[1], v[2]);
  const a = [-DRAG_K * s * v[0], -DRAG_K * s * v[1], -9.81 - DRAG_K * s * v[2]];
  if (spin) {
    const hx = v[0], hy = v[1];
    const hn = Math.hypot(hx, hy) || 1;
    const side = [hy / hn, -hx / hn, 0];
    const dir = nrm(crs(scl(v, 1 / s), side)); // downward for topspin
    const k = spin * (s / SPIN_REF) ** 2;
    a[0] += k * dir[0]; a[1] += k * dir[1]; a[2] += k * dir[2];
  }
  return a;
}

// Contact phase of the bounce. The ball stays on the court for tauC seconds:
// it is compressed while its vertical speed goes to zero (tau1), then restored
// (tau2 = tau1 / e, so it leaves with e times the incoming vertical speed).
// Friction acts in proportion to the normal force, taking the horizontal
// speed from v to mu*v. Returns fine-grained samples of the ball centre and of
// the contact patch (centre and radius), which together form the mark.
function contactPhase(pc, vc, e, mu, tauC) {
  const vz0 = -vc[2];
  const tau1 = tauC * e / (1 + e), tau2 = tauC / (1 + e);
  const delta = vz0 * tau1 * 2 / Math.PI;
  const frac = (t) => (t <= tau1
    ? (1 - Math.cos(Math.PI / 2 * t / tau1)) / (1 + e)
    : (1 + e * Math.sin(Math.PI / 2 * (t - tau1) / tau2)) / (1 + e));
  const N = 60, dt = tauC / N;
  let x = pc[0], y = pc[1];
  const T = [0], P = [[x, y, BALL_R]], mark = [{ X: x, Y: y, a: 0 }];
  for (let i = 1; i <= N; i++) {
    const k = 1 - (1 - mu) * frac((i - 0.5) * dt);
    x += vc[0] * k * dt; y += vc[1] * k * dt;
    const t = i * dt;
    const z = t <= tau1
      ? BALL_R - delta * Math.sin(Math.PI / 2 * t / tau1)
      : BALL_R - delta * Math.cos(Math.PI / 2 * (t - tau1) / tau2);
    const d = BALL_R - z;
    T.push(t); P.push([x, y, z]);
    mark.push({ X: x, Y: y, a: Math.sqrt(Math.max(0, 2 * BALL_R * d - d * d)) });
  }
  return { T, P, mark, tau1, delta, end: [x, y, BALL_R], vOut: [vc[0] * mu, vc[1] * mu, vz0 * e] };
}

// Integrates a serve; returns samples and the contact description.
// contact.X/Y/t is the virtual vertex: where the incoming and outgoing
// flight paths, extended, meet (what a kink fit recovers). contact.mark
// lists the contact patch over time; the ball is in when the mark touches
// the box.
function fly(start, vel, spin, e, mu, tMax = 2.2, tauC = 0.0045) {
  const dt = 0.0005;
  let p = [...start], v = [...vel], t = 0;
  const T = [0], P = [[...p]];
  let contact = null, netZ = null, bounced = false, bounces = 0;
  while (t < tMax) {
    // midpoint integration
    const a1 = accel(v, bounced ? spin * 0.5 : spin);
    const vm = add(v, scl(a1, dt / 2));
    const a2 = accel(vm, bounced ? spin * 0.5 : spin);
    const pn = add(p, scl(vm, dt));
    const vn = add(v, scl(a2, dt));
    if (netZ === null && p[1] < NET_Y && pn[1] >= NET_Y) {
      const k = (NET_Y - p[1]) / (pn[1] - p[1]);
      netZ = { z: p[2] + (pn[2] - p[2]) * k, x: p[0] + (pn[0] - p[0]) * k };
    }
    if (bounces < 2 && v[2] < 0 && pn[2] <= BALL_R) {
      const k = (p[2] - BALL_R) / (p[2] - pn[2]);
      const tc = t + dt * k;
      const pc = add(p, scl(sub(pn, p), k));
      const vc = add(v, scl(sub(vn, v), k));
      bounces++;
      if (bounces === 2) {
        // Second bounce: the ball carries on; only the first one is the serve's landing.
        const c = tauC > 0 ? contactPhase(pc, vc, e, mu, tauC) : null;
        if (c) {
          for (let i = 0; i < c.T.length; i++) { T.push(tc + c.T[i]); P.push(c.P[i]); }
          p = c.end; v = c.vOut; t = tc + tauC;
        } else {
          T.push(tc); P.push([pc[0], pc[1], BALL_R]);
          p = [pc[0], pc[1], BALL_R]; v = [vc[0] * mu, vc[1] * mu, -vc[2] * e]; t = tc;
        }
        contact.second = { t: tc, X: pc[0], Y: pc[1] };
        continue;
      }
      if (tauC > 0) {
        const c = contactPhase(pc, vc, e, mu, tauC);
        for (let i = 0; i < c.T.length; i++) { T.push(tc + c.T[i]); P.push(c.P[i]); }
        contact = {
          t: tc + c.tau1, X: pc[0] + vc[0] * c.tau1, Y: pc[1] + vc[1] * c.tau1,
          t0: tc, t1: tc + tauC, X0: pc[0], Y0: pc[1], X1: c.end[0], Y1: c.end[1],
          vIn: vc, vOut: c.vOut, mark: c.mark, zVertex: BALL_R + vc[2] * c.tau1, tauC,
        };
        p = c.end; v = c.vOut; t = tc + tauC;
      } else {
        contact = { t: tc, X: pc[0], Y: pc[1], t0: tc, t1: tc, X0: pc[0], Y0: pc[1], X1: pc[0], Y1: pc[1], vIn: vc, vOut: [vc[0] * mu, vc[1] * mu, -vc[2] * e], mark: [{ X: pc[0], Y: pc[1], a: 0 }], zVertex: BALL_R, tauC: 0 };
        T.push(tc); P.push([pc[0], pc[1], BALL_R]);
        p = [pc[0], pc[1], BALL_R];
        v = [vc[0] * mu, vc[1] * mu, -vc[2] * e];
        t = tc;
      }
      bounced = true;
      continue;
    }
    p = pn; v = vn; t += dt;
    T.push(t); P.push([...p]);
    if (bounced && (p[2] < 0 || p[1] > 40 || (bounces >= 2 && t > contact.second.t + 0.6))) break;
  }
  return { T, P, contact, netZ };
}

// Aims a serve from `start` at world point (X, Y) with the given speed (m/s).
export function aimServe({ start, X, Y, speed, spin = 0, e = 0.75, mu = 0.65, tauC = 0.0045, tMax = 2.2 }) {
  const dx = X - start[0], dy = Y - start[1];
  const az = Math.atan2(dy, dx);
  const dist = Math.hypot(dx, dy);
  const launch = (el) => [speed * Math.cos(el) * Math.cos(az), speed * Math.cos(el) * Math.sin(az), speed * Math.sin(el)];
  const landDist = (el) => {
    const r = fly(start, launch(el), spin, e, mu, 2.5, tauC);
    if (!r.contact) return Infinity;
    return Math.hypot(r.contact.X - start[0], r.contact.Y - start[1]);
  };
  let lo = -25 * Math.PI / 180, hi = 30 * Math.PI / 180;
  if (landDist(lo) > dist || landDist(hi) < dist) return null;
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    if (landDist(m) < dist) lo = m; else hi = m;
  }
  const r = fly(start, launch((lo + hi) / 2), spin, e, mu, tMax, tauC);
  if (!r.contact || !r.netZ) return null;
  r.netClear = r.netZ.z - (netHeight(r.netZ.x) + BALL_R);
  r.launch = launch((lo + hi) / 2);
  return r;
}

// A long flight for tests of what gets announced: free flight with any
// number of bounces, rolling at the end, and a back fence that sends the
// ball back towards the net. The bounces are instantaneous (no contact
// model): where exactly the ball lands is not what these tests are about.
//   eFence: share of the speed the fence returns; fenceY: where it stands.
// Returns { T, P, bounces: [{ t, X, Y }] }.
export function flyOn(start, vel, { spin = 0, e = 0.75, mu = 0.65, tMax = 6, fenceY = 30.2, eFence = 0.3, roll = 0.6 } = {}) {
  const dt = 0.001;
  let p = [...start], v = [...vel], t = 0, rolling = false;
  const T = [0], P = [[...p]], bounces = [];
  while (t < tMax) {
    if (rolling) {
      const sp = Math.hypot(v[0], v[1]);
      if (sp < 0.05) break;
      const k = Math.max(0, sp - roll * dt) / sp;
      v = [v[0] * k, v[1] * k, 0];
      p = [p[0] + v[0] * dt, p[1] + v[1] * dt, BALL_R];
    } else {
      const sa = bounces.length ? spin * 0.5 : spin;
      const a1 = accel(v, sa);
      const vm = add(v, scl(a1, dt / 2));
      const a2 = accel(vm, sa);
      p = add(p, scl(vm, dt));
      v = add(v, scl(a2, dt));
      if (v[2] < 0 && p[2] <= BALL_R) {
        bounces.push({ t, X: p[0], Y: p[1] });
        const m = bounces.length === 1 ? mu : 0.85;
        v = [v[0] * m, v[1] * m, -v[2] * e];
        p[2] = BALL_R;
        if (v[2] < 0.35) { rolling = true; v[2] = 0; }
      }
    }
    if (p[1] >= fenceY && v[1] > 0) { v = [v[0] * 0.7, -eFence * v[1], v[2] * 0.7]; p[1] = fenceY; }
    // a ball coming back into the net stops there
    if (p[1] <= NET_Y + 0.03 && v[1] < 0 && start[1] > NET_Y - 1 && p[2] < 0.95) v = [v[0] * 0.3, 0.05, v[2] * 0.3];
    t += dt;
    T.push(t);
    P.push([...p]);
  }
  return { T, P, bounces };
}

// Position at time t (linear between samples).
export function ballAt(traj, t) {
  const { T, P } = traj;
  if (t <= T[0]) return P[0];
  if (t >= T[T.length - 1]) return P[P.length - 1];
  let lo = 0, hi = T.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (T[m] <= t) lo = m; else hi = m;
  }
  const k = (t - T[lo]) / (T[hi] - T[lo]);
  return add(P[lo], scl(sub(P[hi], P[lo]), k));
}

// ---- Frame rendering ------------------------------------------------------------

const BALL_RGB = [214, 228, 72];
const SUN = nrm([0.55, -0.35, 0.76]); // towards the sun

// Applies 4:2:0 chroma subsampling to a patch of a full-frame RGB float buffer.
function chromaSubsample(buf, W, H, x0, y0, x1, y1) {
  x0 = Math.max(0, x0 & ~1); y0 = Math.max(0, y0 & ~1);
  x1 = Math.min(W - 1, x1 | 1); y1 = Math.min(H - 1, y1 | 1);
  for (let by = y0; by < y1; by += 2) {
    for (let bx = x0; bx < x1; bx += 2) {
      let su = 0, sv = 0;
      const Ys = [];
      for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const i = ((by + oy) * W + bx + ox) * 3;
        const r = buf[i], g = buf[i + 1], b = buf[i + 2];
        const Y = 0.299 * r + 0.587 * g + 0.114 * b;
        su += b - Y; sv += r - Y;
        Ys.push([i, Y]);
      }
      su /= 4; sv /= 4;
      for (const [i, Y] of Ys) {
        const r = Y + sv, b = Y + su;
        const g = (Y - 0.299 * r - 0.114 * b) / 0.587;
        buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
      }
    }
  }
}

export class FrameRenderer {
  constructor(cam, bg, { noise = 2.5, seed = 3, chroma = true } = {}) {
    this.cam = cam;
    this.bg = bg;
    this.noise = noise;
    this.chroma = chroma;
    this.r = rng(seed);
    const N = 1 << 20;
    this.noiseTab = new Float32Array(N);
    for (let i = 0; i < N; i++) this.noiseTab[i] = this.r.gauss() * noise;
    this.work = new Float32Array(bg.length);
    this.work.set(bg);
    if (chroma) chromaSubsample(this.work, cam.W, cam.H, 0, 0, cam.W - 1, cam.H - 1);
    this.base = Float32Array.from(this.work);
    this.dirty = null;
  }

  // Makes balls lying still on the court part of the scene.
  bakeBalls(points) {
    for (const P of points) {
      this._drawBall([P]);
      this.dirty = null; // keep it
    }
    this.base.set(this.work);
  }

  // Renders the region (x, y, w, h) at full resolution with the ball sampled
  // at the given positions (exposure sub-samples). Returns RGBA bytes.
  // shift: [dx, dy] moves the whole picture by that many pixels (camera shake).
  render(roi, ballPositions, shift = null) {
    const { cam } = this;
    const W = cam.W, H = cam.H;
    const work = this.work;
    // restore the previously touched patch
    if (this.dirty) {
      const [x0, y0, x1, y1] = this.dirty;
      for (let y = y0; y <= y1; y++) {
        const a = (y * W + x0) * 3, b = (y * W + x1 + 1) * 3;
        work.set(this.base.subarray(a, b), a);
      }
      this.dirty = null;
    }
    if (ballPositions && ballPositions.length) this._drawBall(ballPositions);
    const out = new Uint8ClampedArray(roi.w * roi.h * 4);
    const tab = this.noiseTab, mask = tab.length - 1;
    let ni = (this.r() * tab.length) | 0;
    if (shift && (shift[0] || shift[1])) {
      // bilinear resampling of the scene at the shifted position
      for (let y = 0; y < roi.h; y++) {
        const fy = Math.min(H - 1.001, Math.max(0, y + roi.y - shift[1]));
        const y0 = Math.floor(fy), wy = fy - y0;
        let di = y * roi.w * 4;
        for (let x = 0; x < roi.w; x++, di += 4) {
          const fx = Math.min(W - 1.001, Math.max(0, x + roi.x - shift[0]));
          const x0 = Math.floor(fx), wx = fx - x0;
          const a = (y0 * W + x0) * 3, b = a + 3, c = a + W * 3, d = c + 3;
          for (let ch = 0; ch < 3; ch++) {
            const v = (work[a + ch] * (1 - wx) + work[b + ch] * wx) * (1 - wy) + (work[c + ch] * (1 - wx) + work[d + ch] * wx) * wy;
            out[di + ch] = v + tab[(ni++) & mask];
          }
          out[di + 3] = 255;
        }
        ni += 7919;
      }
      return out;
    }
    for (let y = 0; y < roi.h; y++) {
      const sy = y + roi.y;
      if (sy < 0 || sy >= H) continue;
      let si = (sy * W + roi.x) * 3, di = y * roi.w * 4;
      for (let x = 0; x < roi.w; x++, si += 3, di += 4) {
        out[di] = work[si] + tab[(ni++) & mask];
        out[di + 1] = work[si + 1] + tab[(ni++) & mask];
        out[di + 2] = work[si + 2] + tab[(ni++) & mask];
        out[di + 3] = 255;
      }
      ni += 7919;
    }
    return out;
  }

  _drawBall(positions) {
    const { cam } = this;
    const W = cam.W, H = cam.H, work = this.work;
    const proj = positions.map((P) => {
      const q = cam.project(P);
      return q ? { x: q[0], y: q[1], r: cam.f * BALL_R / q[2], P } : null;
    }).filter(Boolean);
    if (!proj.length) return;
    // Shadow footprints on the ground.
    const shadows = positions.map((P) => [P[0] - P[2] * SUN[0] / SUN[2], P[1] - P[2] * SUN[1] / SUN[2]]);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = (x, y, r) => {
      x0 = Math.min(x0, x - r); x1 = Math.max(x1, x + r);
      y0 = Math.min(y0, y - r); y1 = Math.max(y1, y + r);
    };
    for (const p of proj) grow(p.x, p.y, p.r + 2);
    const shadowPx = [];
    for (const [sx, sy] of shadows) {
      const q = cam.project([sx, sy, 0]);
      if (q) {
        const rr = cam.f * BALL_R / q[2] * 1.6 + 2;
        shadowPx.push(q);
        grow(q[0], q[1], rr);
      }
    }
    x0 = Math.max(0, Math.floor(x0) - 2); y0 = Math.max(0, Math.floor(y0) - 2);
    x1 = Math.min(W - 1, Math.ceil(x1) + 2); y1 = Math.min(H - 1, Math.ceil(y1) + 2);
    if (x1 < x0 || y1 < y0) return;
    if ((x1 - x0) * (y1 - y0) > 200000) return; // ball far out of view
    const SS = 4, J = proj.length;
    const C = cam.C;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        // shadow (2x2 supersampled)
        let shade = 0;
        if (shadowPx.length) {
          for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
            const d = cam.ray(x + ox, y + oy);
            if (d[2] >= 0) continue;
            const t = -C[2] / d[2];
            const gx = C[0] + d[0] * t, gy = C[1] + d[1] * t;
            let inS = 0;
            for (const [sx, sy] of shadows) if ((gx - sx) ** 2 + (gy - sy) ** 2 <= BALL_R * BALL_R) inS++;
            shade += inS / shadows.length;
          }
          shade /= 4;
        }
        // ball coverage
        let cov = 0, lum = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
            for (const p of proj) {
              const dd = ((px - p.x) ** 2 + (py - p.y) ** 2) / (p.r * p.r);
              if (dd <= 1) { cov++; lum += 0.82 + 0.18 * (1 - dd); }
            }
          }
        }
        if (shade === 0 && cov === 0) continue;
        const i = (y * W + x) * 3;
        const k = 1 - 0.45 * shade;
        let r = work[i] * k, g = work[i + 1] * k, b = work[i + 2] * k;
        if (cov) {
          const c = cov / (SS * SS * J), l = lum / cov;
          r = r * (1 - c) + BALL_RGB[0] * l * c;
          g = g * (1 - c) + BALL_RGB[1] * l * c;
          b = b * (1 - c) + BALL_RGB[2] * l * c;
        }
        work[i] = r; work[i + 1] = g; work[i + 2] = b;
      }
    }
    if (this.chroma) chromaSubsample(work, W, H, x0, y0, x1, y1);
    this.dirty = [Math.max(0, x0 - 2), Math.max(0, y0 - 2), Math.min(W - 1, x1 + 2), Math.min(H - 1, y1 + 2)];
  }
}

// Exposure sub-sample positions for a frame starting at t.
export function exposurePositions(traj, t, exposure, n = 5) {
  const out = [];
  if (t < traj.T[0] || t > traj.T[traj.T.length - 1]) return out;
  for (let i = 0; i < n; i++) out.push(ballAt(traj, t + exposure * (i + 0.5) / n));
  return out;
}

// Signed distance (m) of a box point from the service box: negative inside.
export function boxSignedDistance(u, v, W = 4.14, L = 6.4) {
  const dx = Math.max(-u, u - W), dy = Math.max(-v, v - L);
  if (dx <= 0 && dy <= 0) return Math.max(dx, dy);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
}

// Gap between the contact mark and the box: <= 0 means the ball touched it.
export function markGap(contact) {
  let gap = Infinity;
  for (const m of contact.mark) {
    const [u, v] = worldToBox(m.X, m.Y);
    gap = Math.min(gap, boxSignedDistance(u, v) - m.a);
  }
  return gap;
}
