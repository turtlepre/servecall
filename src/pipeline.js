// Frame-by-frame processing: calibration -> region of interest -> detection ->
// tracking -> bounce -> court position -> call.

import { homography, invert3, applyH, cameraFromHomography, isConvexQuad } from './geometry.js';
import { BOX_W, BOX_L, BALL_R, CORNERS, NEAR_BAND, judgeMark } from './court.js';
import { bounceParams, contactMark, nominalMark, VERTEX_HEIGHT_DEFAULT } from './bounce.js';
import { Detector } from './detector.js';
import { Tracker, TRACKER_DEFAULTS } from './tracker.js';
import { refineBounceBest, arcBack } from './refine.js';
import { FrameClock } from './timing.js';

export { FrameClock, TimeSource } from './timing.js';

// Region watched for the ball, in box coordinates (metres) and height.
const ROI_MARGIN = { center: 2.5, side: 2.5, net: 3.5, back: 5.6, height: 2.4 }; // back: to the baseline
// Bounces outside this area are ignored as false detections.
const PLAUSIBLE = { uMin: -5, uMax: BOX_W + 5, vMin: -0.3, vMax: BOX_L + 6 };
// A serve that was followed but whose bounce could not be found is reported
// as "unsure", so that silence normally means nothing came over the net.
const UNSURE = {
  minSamples: 5, speedFactor: 1.0, pastNet: 0.5, advance: 1.0, // what counts as a serve (see _serveLike)
  ceiling: 4.5, // m: near the net no served ball is higher than this
  delay: 0.25, // s to wait after a serve was lost, in case its bounce still turns up
  wait: 1.0, // ... at most this long when the ball was picked up again
  overdue: 0.8, // s a serve may be followed low over the court without a bounce being found
  sameBall: 1.5, // s after a report during which a new track is the same ball, not a new serve
  hopping: 6.0, // s after a report during which a bounce that is clearly not a first one belongs to that ball, still hopping on
  rejoin: 0.35, // s within which a ball lost while still high may reappear low over the court
  arcSpan: 0.45, // s of flight before a bounce used to follow its arc back
  arcMin: 0.12, // ... and at least this much of it must have been seen
  second: 2.0, // s after a report within which no other serve can have come over the net
};

// Joins detections that belong to one ball. Against a white line or the net
// tape the ball can come out as a main blob plus a few stray pixels beside
// it; left separate, the stray blob can steal the track.
function mergeNear(cands) {
  if (cands.length < 2) return cands;
  const out = [];
  const used = new Array(cands.length).fill(false);
  for (let i = 0; i < cands.length; i++) { // cands are sorted heaviest first
    if (used[i]) continue;
    const a = cands[i];
    let sw = a.weight, sx = a.x * a.weight, sy = a.y * a.weight, area = a.area;
    const reach = 1.2 * Math.max(4, a.w, a.h);
    for (let j = i + 1; j < cands.length; j++) {
      if (used[j]) continue;
      const b = cands[j];
      if (Math.hypot(b.x - a.x, b.y - a.y) <= reach) {
        used[j] = true;
        sw += b.weight; sx += b.x * b.weight; sy += b.y * b.weight; area += b.area;
      }
    }
    out.push({ ...a, x: sx / sw, y: sy / sw, area, weight: sw });
  }
  return out;
}

export const DEFAULT_SETTINGS = {
  threshold: 30, // detector sensitivity (lower = more sensitive)
  maxPixels: 520000, // region larger than this is downscaled before processing
  fallbackHfov: 67,
};

export class Pipeline {
  constructor(settings = {}) {
    this.s = { ...DEFAULT_SETTINGS, ...settings };
    this.detector = new Detector();
    this.tracker = new Tracker();
    this.calib = null;
    this.lastCands = [];
    this.stats = { frames: 0, skipped: 0 };
    this.clock = new FrameClock();
  }

  setThreshold(thr) {
    this.s.threshold = thr;
    this.detector.configure({ threshold: thr });
  }

  // Forget motion history (after a seek, a pause or a camera hiccup).
  resetState() {
    this.detector.reset();
    this.tracker.reset();
    this.clock.reset();
    this.pendingLost = null;
    this.lostHigh = null;
    this.lastEventT = -Infinity;
    this.lastT = undefined;
  }

  // Is a ball seen at this image point certainly on the receiver's side of
  // the net, whatever its height? One camera cannot tell how far away a
  // ball is, but the ball is somewhere on the line of sight, above the
  // ground and below a ceiling:
  //  - if the line of sight meets the ground before it gets back to the net,
  //    the ball is in front of that ground point (the point must lie in the
  //    lane of this court, or the ball may belong to the court next door);
  //  - if at the net the line of sight is higher than any serve flies, the
  //    ball is nearer than the net.
  // anyLane: the question is only "past the net or not", on whichever court.
  _pastNet(x, y, anyLane = false) {
    const c = this.calib;
    const [cu, cv, ch] = c.cam.C;
    if (!(cv > UNSURE.pastNet)) return false; // the camera itself must stand on the receiver's side
    const d = c.cam.ray(x, y);
    const g = d[2] < 0 ? -ch / d[2] : NaN; // along the line of sight to the ground
    const gu = cu + g * d[0];
    const inLane = d[2] < 0 && (anyLane || (gu > PLAUSIBLE.uMin && gu < PLAUSIBLE.uMax));
    if (!(d[1] < 0)) return inLane; // looking away from the net: all of this line of sight is past it
    const zAtNet = ch + ((UNSURE.pastNet - cv) / d[1]) * d[2];
    if (zAtNet > UNSURE.ceiling) return true;
    return zAtNet < 0 && inLane;
  }

  // Was this track first seen on the receiver's side of the net? A serve is
  // first seen far away or high up, where that cannot be said. A ball first
  // seen low on this side (of this court or the next) is another ball, or
  // one that has bounced, or one coming back from the fence.
  _bornPast(tr) {
    if (tr.bornPast === undefined) tr.bornPast = !!tr.first && this._pastNet(tr.first.x, tr.first.y, true);
    return tr.bornPast;
  }

  // How this track moved: fast and long enough to be a served ball, how far
  // it advanced away from the net (ground points of its samples), and
  // whether it was seen certainly past the net.
  _motion(tr) {
    const c = this.calib, P = tr.pts;
    const out = { fast: false, advance: 0, past: false };
    if (tr.count < UNSURE.minSamples || P.length < UNSURE.minSamples) return out;
    const dur = P[P.length - 1].t - P[0].t;
    if (!(dur > 0)) return out;
    let len = 0;
    for (let i = 1; i < P.length; i++) len += Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y);
    out.fast = len / dur >= UNSURE.speedFactor * this.tracker.o.vMin;
    let vFirst = null, vBest = -Infinity;
    for (const p of P) {
      if (!out.past && this._pastNet(p.x, p.y)) out.past = true;
      const w = c.Hinv[6] * p.x + c.Hinv[7] * p.y + c.Hinv[8];
      if (Math.sign(w) !== c.wSign) continue;
      const v = applyH(c.Hinv, p.x, p.y)[1];
      if (vFirst === null) vFirst = v;
      if (v > vBest) vBest = v;
    }
    if (vFirst !== null) out.advance = vBest - vFirst;
    return out;
  }

  // Did this track look like a serve that reached the receiver's side? It
  // must have been first seen where a serve is first seen, be fast and long
  // enough, have travelled away from the net, and at some point have been
  // certainly past the net.
  _serveLike(tr) {
    if (tr.foreign || this._bornPast(tr)) return false;
    const m = this._motion(tr);
    return m.fast && m.past && m.advance >= UNSURE.advance;
  }

  // The same, but for a ball lost before it was certainly past the net:
  // still high over the court, or stopped by the net. Which of the two
  // cannot be told from this track alone.
  _approach(tr) {
    if (tr.foreign || this._bornPast(tr)) return false;
    const m = this._motion(tr);
    return m.fast && m.advance >= UNSURE.advance;
  }

  // Does this track belong to a ball that has already been reported (called,
  // or announced as not judged)? Tracks that existed when that ball bounced
  // or was lost follow the same ball, and so does one that appears within
  // the next second and a half, while that ball is still flying on to its
  // second bounce. (The next serve cannot be in view that soon; a ball
  // hopping on or coming back from the fence later than that is told apart
  // by where it is first seen and by its arc.)
  _reported(tr) {
    return tr.born - this.lastEventT < UNSURE.sameBall;
  }

  // points: 4 image points [x, y] in CORNERS order, frame size in pixels.
  setCalibration(points, frameW, frameH) {
    if (!points || points.length !== 4 || !isConvexQuad(points)) throw new Error('코너 4개가 볼록한 사각형을 이루지 않습니다.');
    const uv = CORNERS.map((c) => c.uv);
    const H = homography(uv, points);
    if (!H) throw new Error('코너 위치로 코트를 계산할 수 없습니다.');
    const Hinv = invert3(H);
    const cam = cameraFromHomography(H, frameW, frameH, this.s.fallbackHfov);
    if (!cam) throw new Error('카메라 위치를 계산할 수 없습니다.');
    const roi = this._roi(H, cam, frameW, frameH);
    const f = cam.f;
    // Expected ball diameter (px) over the watched volume.
    let dMin = Infinity, dMax = 0;
    for (const p of roi.corners3d) {
      const q = cam.project(p[0], p[1], p[2]);
      if (!q) continue;
      const d = f * 2 * BALL_R / q[2];
      dMin = Math.min(dMin, d);
      dMax = Math.max(dMax, d);
    }
    if (!Number.isFinite(dMin)) { dMin = 2; dMax = 12; }
    // Sign of the inverse mapping's denominator for points on the court;
    // image points above the horizon have the opposite sign.
    const centre = applyH(H, BOX_W / 2, BOX_L / 2);
    const wSign = Math.sign(Hinv[6] * centre[0] + Hinv[7] * centre[1] + Hinv[8]) || 1;
    this.calib = { points, frameW, frameH, H, Hinv, cam, roi, f, dMin, dMax, wSign };
    this.pendingLost = null;
    this.lostHigh = null;
    this.lastEventT = -Infinity;
    const s = roi.scale;
    const dm = Math.max(2, dMax * s);
    this.detector.configure({
      threshold: this.s.threshold,
      minArea: 2,
      maxArea: Math.max(60, Math.round(14 * dm * dm)),
      maxSpan: Math.max(18, Math.round(7 * dm)),
    });
    this.detector.reset();
    // Image-speed thresholds scale with the focal length (px per radian).
    const k = f / 1000;
    // Which way is up in the picture, at the middle of the box.
    let up = [0, -1];
    const g0 = cam.project(BOX_W / 2, BOX_L / 2, 0), g1 = cam.project(BOX_W / 2, BOX_L / 2, 1);
    if (g0 && g1) {
      const n = Math.hypot(g1[0] - g0[0], g1[1] - g0[1]);
      if (n > 1e-6) up = [(g1[0] - g0[0]) / n, (g1[1] - g0[1]) / n];
    }
    this.tracker.configure({
      gateMin: Math.max(4, 6 * k),
      vMax: TRACKER_DEFAULTS.vMax * k,
      vMinLink: TRACKER_DEFAULTS.vMinLink * k,
      vMin: TRACKER_DEFAULTS.vMin * k,
      jAbs: TRACKER_DEFAULTS.jAbs * k,
      up,
    });
    this.tracker.reset();
    return this.calib;
  }

  _roi(H, cam, W, Hh) {
    const m = ROI_MARGIN;
    const us = [-m.center, BOX_W + m.side], vs = [-m.net, BOX_L + m.back], zs = [0, m.height];
    const corners3d = [];
    for (const u of us) for (const v of vs) for (const z of zs) corners3d.push([u, v, z]);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    let behind = false;
    for (const [u, v, z] of corners3d) {
      const p = cam.project(u, v, z);
      if (!p) { behind = true; continue; }
      x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
      y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
    }
    // The ground quad from the homography itself is exact; make sure it is inside.
    for (const u of us) for (const v of vs) {
      const [x, y] = applyH(H, u, v);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
        y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
    }
    if (behind || !Number.isFinite(x0)) { x0 = 0; y0 = 0; x1 = W; y1 = Hh; }
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(W, Math.ceil(x1)); y1 = Math.min(Hh, Math.ceil(y1));
    const w = Math.max(8, x1 - x0), h = Math.max(8, y1 - y0);
    const scale = Math.min(1, Math.sqrt(this.s.maxPixels / (w * h)));
    return {
      x: x0, y: y0, w, h, scale,
      outW: Math.max(8, Math.round(w * scale)),
      outH: Math.max(8, Math.round(h * scale)),
      corners3d,
    };
  }

  // Image point of the ball centre at the bounce vertex -> the point on the
  // court below it, in box metres. z is the height of the ball centre there.
  imageToCourt(x, y, z = VERTEX_HEIGHT_DEFAULT) {
    const c = this.calib;
    const [ug, vg] = applyH(c.Hinv, x, y);
    // The viewing ray meets the ground beyond the ball; walk back along it.
    const [cu, cv, ch] = c.cam.C;
    const k = ch > z ? z / ch : 0;
    return { u: ug + (cu - ug) * k, v: vg + (cv - vg) * k, uRaw: ug, vRaw: vg };
  }

  // Box point -> image point (for drawing).
  courtToImage(u, v) {
    return applyH(this.calib.H, u, v);
  }

  // rgba: pixels of the region (roi.outW x roi.outH), tRaw: seconds.
  // opts.trusted: the timestamp is accurate as given (video files, steady
  // camera clocks) and must not be moved onto a regular grid.
  process(tRaw, rgba, w, h, opts = {}) {
    const c = this.calib;
    if (!c) return { events: [], cands: [] };
    const t = opts.trusted || this.s.dejitter === false ? tRaw : this.clock.map(tRaw);
    this.stats.frames++;
    const raw = this.detector.process(rgba, w, h);
    if (this.detector.lastSkipped) this.stats.skipped++;
    // A frame whose time cannot be told apart from the one before it: the
    // detector has seen it (it compares neighbouring frames), the tracker
    // does not get it.
    if (t === null || t === this.lastT) return { events: [], cands: [] };
    // Time went backwards: the clock has started again, and nothing that
    // was being followed can be compared with what comes now.
    if (t < this.lastT) {
      this.tracker.reset();
      this.pendingLost = null;
      this.lostHigh = null;
      this.lastEventT = -Infinity;
    }
    this.lastT = t;
    const sx = c.roi.w / w, sy = c.roi.h / h;
    const cands = mergeNear(raw.map((b) => ({ ...b, x: c.roi.x + b.x * sx, y: c.roi.y + b.y * sy, w: b.w * sx, h: b.h * sy })));
    this.lastCands = cands;
    const bounces = this.tracker.update(t, cands);
    // Note when a track starts to look like a serve, while its early samples
    // are still held; later only its most recent samples remain.
    for (const tr of this.tracker.tracks) {
      if (!tr.done && !tr.serveLike && tr.count >= UNSURE.minSamples && this._serveLike(tr)) { tr.serveLike = true; tr.serveT = t; }
    }
    // A ball was lost while still high (see below). If a ball now appears
    // low over this side of the net, it did come down here: a serve that
    // will not be judged unless its bounce still turns up.
    if (this.lostHigh && t - this.lostHigh.t > UNSURE.rejoin) this.lostHigh = null;
    if (this.lostHigh && !this.pendingLost) {
      for (const tr of this.tracker.tracks) {
        if (tr.born !== t || !this._bornPast(tr)) continue;
        this.pendingLost = { t: this.lostHigh.t, due: t + UNSURE.delay, why: 'rejoin' };
        this.lostHigh = null;
        break;
      }
    }
    const events = [];
    const calls = [];
    let unjudged = null; // time of a serve that was seen but cannot be judged
    for (const b of bounces) {
      const tr = b.track;
      const flat = this.imageToCourt(b.x, b.y);
      let court = flat, method = '2d', fit3d = null, mark = null, zVertex = VERTEX_HEIGHT_DEFAULT;
      if (this.s.refine3d !== false) {
        const accept = (f) => f && f.rms <= Math.max(1.5, 2 * b.rms) && Math.hypot(f.u - flat.u, f.v - flat.v) < 1.0;
        let fit = refineBounceBest(c.cam, b.pre, b.post, { t: b.t, u: flat.u, v: flat.v }, zVertex);
        if (accept(fit)) {
          // The vertex height depends on how hard the ball came down; refit
          // once with the height implied by the fitted velocities.
          const z2 = bounceParams(fit.v1, fit.v2).zVertex;
          if (Math.abs(z2 - zVertex) > 0.0015) {
            const again = refineBounceBest(c.cam, b.pre, b.post, { t: fit.t, u: fit.u, v: fit.v }, z2);
            if (accept(again)) { fit = again; zVertex = z2; }
          }
          // Use the 3D fit to find where the ball was in the image at the
          // vertex; the court position then comes from the exact corner
          // mapping, which the idealised camera model deviates from slightly.
          const q = c.cam.project(fit.u, fit.v, zVertex);
          if (q) {
            fit3d = fit;
            court = this.imageToCourt(q[0], q[1], zVertex);
            mark = contactMark(court.u, court.v, fit.v1, fit.v2);
            method = '3d';
          }
        }
      }
      const ok = court.u >= PLAUSIBLE.uMin && court.u <= PLAUSIBLE.uMax && court.v >= PLAUSIBLE.vMin && court.v <= PLAUSIBLE.vMax;
      // Has this ball bounced on this side before, on this same track?
      const landedBefore = !!tr.landed;
      if (ok) tr.landed = true;
      // Where did this arc leave the ground? A ball that came over the net
      // was above the ground there, so its arc, followed back, reaches the
      // ground beyond the net. An arc that may have started on this side
      // can be the ball's second bounce, or some other ball. An arc that
      // runs towards the net belongs to no serve at all.
      // (The ball must have been watched for a while before the bounce:
      // over a few frames its speed along the line of sight cannot be told,
      // and a slow hop can pass for a fast flight.)
      const tb = fit3d ? fit3d.t : b.t;
      const seen = ok ? tr.pts.filter((p) => p.t < tb - 1e-6 && p.t > tb - UNSURE.arcSpan) : [];
      const arc = seen.length && tb - seen[0].t >= UNSURE.arcMin
        ? arcBack(c.cam, fit3d ? [fit3d.u, fit3d.v, zVertex] : [flat.u, flat.v, zVertex], tb, seen) : null;
      const fromFar = !!arc && court.v - arc.near < UNSURE.pastNet;
      if (arc && arc.far <= 0) tr.foreign = true;
      // A serve was lost a moment ago and this track appeared afterwards:
      // the same ball, picked up again.
      const pl0 = this.pendingLost;
      const afterLost = !!pl0 && b.born >= pl0.t - 0.02 && b.t - pl0.t < UNSURE.sameBall;
      // If this bounce is not called: does it belong to a serve, which then
      // goes unjudged? Not when that ball has been reported already, or runs
      // towards the net, or was first seen low over this side. Otherwise
      // yes if this could be a serve's first bounce (the longest arc the
      // samples allow reaches beyond the net), or if the track looked like
      // a serve and the ball is still travelling away from the net (a later
      // bounce of a serve whose first one was missed).
      const own = afterLost || (!tr.foreign && !this._bornPast(tr));
      const possible = !!arc && court.v - arc.far < UNSURE.pastNet && arc.fwd > 1; // (a ball dropped on the spot, or crossing the court, is no serve)
      const onward = !arc || arc.near > 0;
      // (a bounce whose arc clearly began on this side, soon after a report:
      // the reported ball hopping on, not a serve that was missed)
      const hopping = !!arc && court.v - arc.far > UNSURE.pastNet && tb - this.lastEventT < UNSURE.hopping;
      const wasServe = !this._reported(tr) && own && !hopping && (possible || ((!!tr.serveLike || afterLost) && onward));
      // keepOpen: this was no bounce on this court at all; the tracker had
      // closed the track, let it go on looking.
      const reject = (keepOpen) => { if (wasServe) unjudged = b.t; else if (keepOpen) tr.done = false; };
      if (!ok) { reject(true); continue; }
      // A serve is called only at the first bounce of its track, and only
      // when even the shortest arc the samples allow reaches back beyond
      // the net. Without such proof (too few samples included) there is no
      // call.
      if (landedBefore || !fromFar) { reject(false); continue; }
      // No flight fit: the spot is rough. With the ball seen for less than
      // two 30 fps frames after the bounce the kink is too loosely placed to
      // call, and a bounce found late on a long-followed track is not the
      // first one.
      const after = b.post[b.post.length - 1].t - b.post[0].t;
      if (!fit3d && (b.post.length < 3 || after < 0.045 || b.t - b.born > 1.4)) { unjudged = b.t; continue; }
      // The ball was out of sight for several frames just when it bounced.
      if (b.loose) { unjudged = b.t; continue; }
      if (!mark) mark = nominalMark(court.u, court.v);
      const call = judgeMark(mark, court);
      // Without the flight fit the point is rougher: widen the "close" band.
      if (method === '2d') call.near = Math.abs(call.gap) < 2 * NEAR_BAND;
      const { track, ...rest } = b;
      calls.push({ type: 'bounce', ...rest, court, flat, method, fit3d, mark, zVertex, call });
    }
    if (calls.length) {
      // Two tracks can follow one ball (a stray blob beside it); the ball
      // gets one call, from the better-supported reading.
      const rank = (e) => (e.method === '3d' ? 0 : 1000) + (e.fit3d ? e.fit3d.rms : e.rms) - e.samples;
      calls.sort((p, q) => rank(p) - rank(q));
      events.push(calls[0]);
    }
    // Serves that were followed but not judged.
    // (why: which rule spoke, for the test harness and the debug overlay)
    // (Not within two seconds of a report: no other ball can have come over
    // the net and down that soon; it is the reported ball again, back from
    // a high bounce.)
    const flag = (tEvent, why) => {
      this.pendingLost = null;
      if (tEvent - this.lastEventT > UNSURE.second) events.push({ type: 'unsure', t: tEvent, why });
    };
    if (events.length) this.pendingLost = null;
    else if (unjudged !== null) flag(unjudged, 'bounce');
    else {
      // A serve whose track ended without a bounce ...
      for (const tr of this.tracker.ended) {
        if (this._reported(tr) || tr.foreign) continue;
        const tEnd = tr.pts[tr.pts.length - 1].t;
        if (tr.serveLike || this._serveLike(tr)) { this.pendingLost = { t: tEnd, due: t + UNSURE.delay }; break; }
        // ... or a ball lost while still high: stopped by the net, or over
        // the court and out of sight. Remember it for a moment.
        if (this._approach(tr)) this.lostHigh = { t: tEnd };
      }
      // ... is announced after a short wait, in case the ball is picked up
      // again in time for its bounce to be found. Only a track from around
      // the moment of the loss can be that ball; the next serve must not
      // hold the announcement back.
      const pl = this.pendingLost;
      if (pl && t >= pl.due && (t >= pl.t + UNSURE.wait || !this.tracker.busy(pl.t + 0.5))) flag(pl.t, pl.why || 'lost');
      else if (!pl) {
        // A serve still being followed long after it came down over the
        // court: its bounce was not recognised.
        for (const tr of this.tracker.tracks) {
          if (tr.done || !tr.serveLike || tr.foreign || this._reported(tr)) continue;
          if (t - tr.serveT > Math.max(UNSURE.overdue, 20 * this.tracker.period)) { tr.done = true; flag(tr.serveT, 'overdue'); break; }
        }
      }
    }
    if (events.length) {
      // One report per ball: ignore further bounces for a while, and treat
      // every track that was in flight at the time, or appears soon after,
      // as this same ball. (Counted from when the ball bounced or was lost,
      // not from when that is announced, which can be a second later.)
      const last = events[events.length - 1];
      this.tracker.holdUntil((last.type === 'bounce' ? last.t : t) + this.tracker.o.refractory);
      this.lastEventT = Math.max(this.lastEventT, last.t);
    }
    return { events, cands };
  }
}
