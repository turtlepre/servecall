// Links ball candidates across frames and finds the bounce.
//
// A bounce shows up as a kink in the image trajectory: before it the ball
// falls towards the court, after it the vertical motion reverses, so the
// image velocity jumps upwards. A ball that approaches the camera can keep
// moving down the picture after the bounce; only the velocity change is
// reliable, not its sign. "Upwards" is the image direction of a vertical
// post at the court, supplied from the calibration, so a rotated or tilted
// picture works too.
//
// All positions are full-frame pixels, times in seconds. Speed thresholds are
// given in px/s; the pipeline scales them by the focal length.

function lsqVel(pts) {
  const n = pts.length;
  let st = 0, sx = 0, sy = 0;
  for (const p of pts) { st += p.t; sx += p.x; sy += p.y; }
  st /= n; sx /= n; sy /= n;
  let stt = 0, stx = 0, sty = 0;
  for (const p of pts) {
    const dt = p.t - st;
    stt += dt * dt; stx += dt * (p.x - sx); sty += dt * (p.y - sy);
  }
  if (stt <= 0) return { x: 0, y: 0 };
  return { x: stx / stt, y: sty / stt };
}

// Velocity change between the two halves of a segment of 3 or more samples.
function segChange(p) {
  const m = p.length >> 1, n = p.length - 1;
  const ax = (p[m].x - p[0].x) / (p[m].t - p[0].t), ay = (p[m].y - p[0].y) / (p[m].t - p[0].t);
  const bx = (p[n].x - p[m].x) / (p[n].t - p[m].t), by = (p[n].y - p[m].y) / (p[n].t - p[m].t);
  return Math.hypot(bx - ax, by - ay);
}

function solve3(a) {
  // a: 3x4 augmented, in place. Returns [x0,x1,x2] or null.
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-15) return null;
    if (p !== c) [a[c], a[p]] = [a[p], a[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const k = a[r][c] / a[c][c];
      for (let j = c; j < 4; j++) a[r][j] -= k * a[c][j];
    }
  }
  return [a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]];
}

// Continuous piecewise-linear fit with the break at time tau.
// Returns { sse, x, y } where (x, y) is the fitted position at tau.
function fitAt(pts, tau) {
  const ax = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const ay = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (const p of pts) {
    const d = p.t - tau;
    const row = [1, d < 0 ? d : 0, d > 0 ? d : 0];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) { ax[i][j] += row[i] * row[j]; ay[i][j] += row[i] * row[j]; }
      ax[i][3] += row[i] * p.x;
      ay[i][3] += row[i] * p.y;
    }
  }
  const cx = solve3(ax), cy = solve3(ay);
  if (!cx || !cy) return null;
  let sse = 0;
  for (const p of pts) {
    const d = p.t - tau;
    const a = d < 0 ? d : 0, b = d > 0 ? d : 0;
    const ex = cx[0] + cx[1] * a + cx[2] * b - p.x;
    const ey = cy[0] + cy[1] * a + cy[2] * b - p.y;
    sse += ex * ex + ey * ey;
  }
  return { sse, x: cx[0], y: cy[0] };
}

// Finds the bounce time between the last pre and first post sample.
export function locateKink(pre, post) {
  const pts = [...pre, ...post];
  const t0 = pre[pre.length - 1].t, t1 = post[0].t;
  let best = null;
  const N = 24;
  for (let i = 0; i <= N; i++) {
    const tau = t0 + (t1 - t0) * i / N;
    const r = fitAt(pts, tau);
    if (r && (!best || r.sse < best.sse)) best = { ...r, t: tau };
  }
  if (!best) return null;
  // Refine around the best grid point.
  let lo = Math.max(t0, best.t - (t1 - t0) / N), hi = Math.min(t1, best.t + (t1 - t0) / N);
  for (let it = 0; it < 20; it++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    const r1 = fitAt(pts, m1), r2 = fitAt(pts, m2);
    if (!r1 || !r2) break;
    if (r1.sse < r2.sse) hi = m2; else lo = m1;
  }
  const tau = (lo + hi) / 2;
  const r = fitAt(pts, tau);
  if (r && r.sse <= best.sse) best = { ...r, t: tau };
  best.rms = Math.sqrt(best.sse / pts.length);
  return best;
}

export const TRACKER_DEFAULTS = {
  gateMin: 6, // px
  gateVelFrac: 0.6, // of the predicted displacement
  bounceMu: 0.6, // sideways image speed kept through a bounce (for prediction)
  bounceE: 0.85, // falling image speed returned upwards by a bounce (for prediction)
  vMax: 6000, // px/s, fastest plausible image speed
  vMinLink: 60, // px/s, slower pairs are treated as static noise
  maxGap: 0.11, // s without a detection before a track ends (or 3.2 frame periods if longer)
  vMin: 250, // px/s, minimum speed before the bounce
  jAbs: 120, // px/s, minimum upward velocity jump
  jRel: 0.25, // ... or this fraction of the incoming speed, whichever is larger
  cons: 0.45, // velocity change inside a segment must stay below this fraction of the jump
  refractory: 1.2, // s after a call during which further bounces are ignored
  maxTracks: 24,
  up: [0, -1], // image direction of "up" at the court (unit vector)
  keep: 0.6, // s of samples a track remembers (at least 14 samples)
};

export class Tracker {
  constructor(opts = {}) {
    this.o = { ...TRACKER_DEFAULTS, ...opts };
    this.reset();
  }

  configure(opts) {
    Object.assign(this.o, opts);
  }

  reset() {
    this.tracks = [];
    this.ended = [];
    this.nextId = 1;
    this.refractoryUntil = -Infinity;
    this.lastT = undefined;
    this.dts = [];
    this.period = 1 / 30;
  }

  // True while some track is following something that moves like a ball.
  // bornBefore: only count tracks that already existed at that time.
  busy(bornBefore = Infinity) {
    for (const tr of this.tracks) {
      if (tr.born > bornBefore) continue;
      if (tr.pts.length >= 3 && Math.hypot(tr.vx, tr.vy) >= this.o.vMin) return true;
    }
    return false;
  }

  // Suppresses bounce detection until time t.
  holdUntil(t) {
    this.refractoryUntil = Math.max(this.refractoryUntil, t);
  }

  // Frame period from the spacing of update() calls (median, so dropped
  // frames do not stretch it).
  _notePeriod(t) {
    if (this.lastT !== undefined) {
      const d = t - this.lastT;
      if (d > 0 && d < 0.5) {
        this.dts.push(d);
        if (this.dts.length > 21) this.dts.shift();
        if (this.dts.length >= 5) {
          const s = [...this.dts].sort((a, b) => a - b);
          this.period = s[s.length >> 1];
        }
      }
    }
    this.lastT = t;
  }

  update(t, cands) {
    const o = this.o;
    this._notePeriod(t);
    const [ux, uy] = o.up;
    const pairs = [];
    for (const tr of this.tracks) {
      const last = tr.pts[tr.pts.length - 1];
      const dt = t - last.t;
      if (dt <= 0) continue;
      if (tr.pts.length >= 2) {
        // Where the ball should be: straight on if it keeps flying, or, if it
        // bounces somewhere in this interval, anywhere towards the point it
        // would reach had it bounced right at the last sample (falling motion
        // reversed and damped, sideways motion slowed). Steep, slow serves
        // nearly reverse their image motion at the bounce, so a single
        // straight-on prediction loses them exactly there.
        const ax = last.x + tr.vx * dt, ay = last.y + tr.vy * dt;
        let bx = ax, by = ay;
        const vUp = tr.vx * ux + tr.vy * uy; // > 0: rising in the picture
        if (vUp < 0) {
          const cx = tr.vx - vUp * ux, cy = tr.vy - vUp * uy; // sideways part
          bx = last.x + (cx * o.bounceMu - vUp * o.bounceE * ux) * dt;
          by = last.y + (cy * o.bounceMu - vUp * o.bounceE * uy) * dt;
        }
        // The sample after a bounce is predicted from a mixed velocity; size
        // the gate by the fastest recent motion.
        const gate = o.gateMin + o.gateVelFrac * Math.max(Math.hypot(tr.vx, tr.vy), tr.vRef || 0) * dt;
        const sx = bx - ax, sy = by - ay, sl = sx * sx + sy * sy;
        cands.forEach((c, ci) => {
          let k = sl > 0 ? ((c.x - ax) * sx + (c.y - ay) * sy) / sl : 0;
          k = k < 0 ? 0 : k > 1 ? 1 : k;
          const d = Math.hypot(c.x - (ax + k * sx), c.y - (ay + k * sy));
          // Pairs are ranked by how likely the detection is for the track:
          // the distance in units of the spread expected for this track
          // (a third of its gate), plus a charge for a wide spread. So a
          // detection that continues a slow ball's track to within a pixel
          // belongs to that ball, however wide the gate of a fast track
          // that has missed a frame; and a slow, steady track does not get
          // a detection eight pixels off its path that a fast ball, just
          // bounced, explains easily. (The straight-on reading is preferred
          // a little when both fit.)
          if (d <= gate) {
            const spread = gate / 3, de = d + 0.15 * k * Math.sqrt(sl);
            pairs.push({ tr, ci, d, gate, score: (de / spread) ** 2 + 2 * Math.log(spread) });
          }
        });
      } else {
        // a lone detection takes only what no established track claims
        cands.forEach((c, ci) => {
          const sp = Math.hypot(c.x - last.x, c.y - last.y) / dt;
          if (sp >= o.vMinLink && sp <= o.vMax) pairs.push({ tr, ci, score: 1e6 + sp });
        });
      }
    }
    pairs.sort((a, b) => a.score - b.score);
    const byC = new Map(), byT = new Map(); // detection -> pair, track -> pair
    for (const p of pairs) {
      if (byC.has(p.ci) || byT.has(p.tr)) continue;
      byC.set(p.ci, p);
      byT.set(p.tr, p);
    }
    // Two balls close together: a fast ball that has just bounced can lie a
    // little further from its track's straight-on prediction than another
    // ball does, and its track then takes that ball's detection. If the
    // track left empty-handed fits the detection well, and the track that
    // took it has another detection that fits it well, each gets its own.
    const fits = (q) => q.d !== undefined && q.d <= 0.3 * q.gate + 1.5;
    for (const p of pairs) {
      if (byT.has(p.tr) || !fits(p)) continue;
      const holder = byC.get(p.ci);
      if (!holder || holder.tr === p.tr) continue;
      const alt = pairs.find((q) => q.tr === holder.tr && q.ci !== p.ci && !byC.has(q.ci) && fits(q));
      if (!alt) continue;
      byT.set(holder.tr, alt);
      byC.set(alt.ci, alt);
      byC.set(p.ci, p);
      byT.set(p.tr, p);
    }
    const usedC = new Set(byC.keys());
    const touched = [];
    for (const p of byT.values()) {
      const c = cands[p.ci];
      const tr = p.tr;
      const last = tr.pts[tr.pts.length - 1];
      const pvx = tr.vx, pvy = tr.vy;
      tr.vx = (c.x - last.x) / (t - last.t);
      tr.vy = (c.y - last.y) / (t - last.t);
      // fastest of the last two steps (0 for the very first step)
      tr.vRef = tr.pts.length >= 2 ? Math.hypot(pvx, pvy) : 0;
      tr.pts.push({ t, x: c.x, y: c.y, a: c.area });
      tr.count++;
      // keep the last 0.6 s (the same stretch of flight at any frame rate)
      while (tr.pts.length > 14 && (t - tr.pts[0].t > o.keep || tr.pts.length > 64)) tr.pts.shift();
      touched.push(tr);
    }
    cands.forEach((c, ci) => {
      if (usedC.has(ci)) return;
      this.tracks.push({ id: this.nextId++, pts: [{ t, x: c.x, y: c.y, a: c.area }], vx: 0, vy: 0, born: t, count: 1, first: { x: c.x, y: c.y } });
    });

    const events = [];
    const consider = (tr, final) => {
      if (tr.done) return;
      const ev = this._evalBounce(tr, final);
      if (!ev) return;
      if (ev.t < this.refractoryUntil) return;
      tr.done = true;
      events.push(ev);
    };
    for (const tr of touched) consider(tr, false);

    // End tracks that lost the ball; give them a last look with a shorter tail.
    // Those that end without a bounce are handed on in `ended`. A lone
    // detection that nothing continues is dropped quickly, so that it cannot
    // capture the ball a few frames later.
    const endGap = Math.max(o.maxGap, 3.2 * this.period);
    const loneGap = 1.6 * this.period;
    const alive = [];
    this.ended = [];
    for (const tr of this.tracks) {
      const last = tr.pts[tr.pts.length - 1];
      if (t - last.t > (tr.count === 1 ? loneGap : endGap)) {
        consider(tr, true);
        if (!tr.done) this.ended.push(tr);
      } else alive.push(tr);
    }
    if (alive.length > o.maxTracks) {
      alive.sort((a, b) => b.pts.length - a.pts.length || b.born - a.born);
      alive.length = o.maxTracks;
    }
    // A track that has given its bounce keeps following the ball, so the
    // second bounce stays with it and is never mistaken for a new serve.
    this.tracks = alive;
    return events;
  }

  // The bounce test looks at the same stretch of flight on each side of a
  // gap whatever the frame rate, about 67 ms: two frame intervals at 30 fps
  // (3 samples), four at 60 fps (5 samples). With fewer, faster samples the
  // same pixel noise would hide the kink.
  _span() {
    return Math.max(2, Math.min(6, Math.round(0.0667 / this.period)));
  }

  // Enough samples around the gap between g and g+1 to test it at all?
  _testable(P, g, w = this._span()) {
    return g >= w && g + 1 + (w >> 1) < P.length;
  }

  // Tests whether the bounce lies between samples g and g+1, using the
  // samples of one span before it and up to one span after. Returns the
  // fitted kink or null.
  _testGap(P, g) {
    const o = this.o;
    const w = this._span();
    if (!this._testable(P, g, w)) return null;
    const pre = P.slice(g - w, g + 1);
    const post = P.slice(g + 1, Math.min(P.length, g + 2 + w));
    // No hole between samples longer than one missing frame at 30 fps.
    // Across the bounce itself a longer hole still shows that the ball
    // bounced, but leaves the time and place too loosely pinned to call:
    // such a bounce is marked `loose`.
    const hole = 2.2 * Math.max(this.period, 1 / 30);
    for (let i = 1; i < pre.length; i++) if (pre[i].t - pre[i - 1].t > hole) return null;
    const loose = post[0].t - pre[w].t > hole;
    for (let i = 1; i < post.length; i++) if (post[i].t - post[i - 1].t > hole) return null;
    const v1 = lsqVel(pre), v2 = lsqVel(post);
    const s1 = Math.hypot(v1.x, v1.y);
    if (s1 < o.vMin) return null;
    const dvx = v2.x - v1.x, dvy = v2.y - v1.y;
    const need = Math.max(o.jAbs, o.jRel * s1);
    // The velocity must jump upwards (along the picture's "up" at the court).
    if (dvx * o.up[0] + dvy * o.up[1] < need) return null;
    const jump = Math.hypot(dvx, dvy);
    const c1 = segChange(pre);
    const c2 = post.length >= 3 ? segChange(post) : 0;
    if (Math.max(c1, c2) > o.cons * jump) return null;
    const kink = locateKink(pre, post);
    if (!kink) return null;
    // A kink pinned to one end of the gap really belongs to the neighbouring
    // gap. If that neighbour cannot be tested (the track starts or ends too
    // close), the bounce cannot be located: make no call.
    const t0 = pre[w].t, t1 = post[0].t, edge = 0.04 * (t1 - t0);
    if (kink.t >= t1 - edge && !this._testable(P, g + 1, w)) return null;
    if (kink.t <= t0 + edge && !this._testable(P, g - 1, w)) return null;
    return { g, kink, v1, v2, jump, loose };
  }

  // A gap is decided once the gap after it has a full span of samples behind
  // it too (4 samples after the gap at 30 fps), by comparing it with its
  // neighbours: a sample taken just after the bounce can make the gap one
  // frame early look like a kink too, but it fits worse. When the track ends,
  // the last undecided gaps are examined with the samples available.
  _evalBounce(tr, final) {
    const P = tr.pts;
    const n = P.length;
    const w = this._span();
    let best = null;
    const consider = (g) => {
      const r = this._testGap(P, g);
      if (r && (!best || r.kink.rms < best.kink.rms)) best = r;
    };
    const decide = [];
    if (!final) {
      decide.push(n - 3 - w);
      [n - 4 - w, n - 3 - w, n - 2 - w].forEach(consider);
    } else {
      for (let g = n - 2 - w; g <= n - 2 - (w >> 1); g++) decide.push(g);
      consider(n - 3 - w);
      decide.forEach(consider);
    }
    if (!best || !decide.includes(best.g)) return null;
    const g = best.g;
    // Wider windows for the 3D refinement.
    const pre = P.slice(Math.max(0, g - w - 1), g + 1);
    const post = P.slice(g + 1, Math.min(n, g + 3 + w));
    return {
      t: best.kink.t,
      x: best.kink.x,
      y: best.kink.y,
      rms: best.kink.rms,
      v1: best.v1,
      v2: best.v2,
      jump: best.jump,
      loose: best.loose,
      trackId: tr.id,
      track: tr,
      born: tr.born,
      pre,
      post,
      samples: pre.length + post.length,
    };
  }
}
