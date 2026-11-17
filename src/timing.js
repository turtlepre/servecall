// Frame timestamps.
//
// Bounce timing needs frame times good to a fraction of a millisecond: at
// serve speed the ball moves 3 cm per millisecond. A browser offers several
// clocks for a camera frame (capture time, media time, callback time) and
// which of them is clean differs between devices, so TimeSource measures
// them and uses the steadiest. FrameClock then removes what jitter is left,
// on the assumption that the camera delivers frames on a fixed period.

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
};

// Chooses between the clocks a browser reports for a camera frame.
//
// Candidates are given in order of preference; the last one is the fallback
// (the time the frame callback ran). The fallback is tied to the display's
// refresh, not to the camera, so it is used only when nothing else is valid,
// however regular it looks. Among the others the steadier one wins.
export class TimeSource {
  constructor({ window = 300, trustBelow = 0.0004, distrustAbove = 0.0006, spikeBelow = 0.001, spikeAbove = 0.0015, hold = 1800 } = {}) {
    this.window = window; // intervals remembered: long enough to hold a few of even rare late frames
    // seconds of interval jitter (see jitterOf): trusted below the first,
    // not trusted above the second, unchanged in between
    this.trustBelow = trustBelow;
    this.distrustAbove = distrustAbove;
    // the same for the single worst interval remembered: one frame in a few
    // hundred stamped late hardly moves the average, but its own time is
    // wrong by milliseconds
    this.spikeBelow = spikeBelow;
    this.spikeAbove = spikeAbove;
    this.hold = hold; // frames a clock must stay clean after such a frame
    this.reset();
  }

  reset() {
    this.src = new Map();
    this.frames = 0;
    this.best = null;
    this.nextEval = 20;
    this.challenger = null;
    this.trusted = false;
    this.jitter = null;
    this.jitterAt = -Infinity;
    this.spikeAt = -Infinity;
  }

  // Interval jitter of a clock in seconds: the root-mean-square distance of
  // its frame intervals from whole numbers of frame periods. Every interval
  // counts, so that neither a minority of late frames, nor rounding to whole
  // milliseconds, nor a frame stamped half a period late can hide. The frame
  // period is the usual interval, or a half or a third of it when the phone
  // only processes every second or third frame.
  jitterOf(name) {
    const st = this._stats(name);
    return st ? st.rms : null;
  }

  // { rms, max }: that jitter, and the largest single distance among the
  // intervals of a few periods (over a long gap the period itself is not
  // known well enough to say).
  _stats(name) {
    const s = this.src.get(name);
    if (!s || s.iv.length < 12) return null;
    const m = median(s.iv);
    if (!(m > 0)) return null;
    let first = null;
    for (let k = 1; k <= 3; k++) {
      const P = m / k;
      let sum = 0, max = 0;
      for (const d of s.iv) {
        const e = Math.abs(d - Math.max(1, Math.round(d / P)) * P);
        sum += e * e;
        if (e > max && d < 6.5 * P) max = e;
      }
      const st = { rms: Math.sqrt(sum / s.iv.length), max };
      if (k === 1) first = st;
      if (st.rms < 0.1 * P) return st;
    }
    return first;
  }

  // cands: array of [name, seconds or undefined], preferred first, fallback last.
  // Returns { t, skip, source, jitter, trusted, switched }.
  //   skip: the chosen clock has no usable value for this frame (missing, or
  //     not later than the frame before); leave the frame out.
  //   trusted: the clock is steady enough to use as is.
  //   switched: the clock changed, or stepped back (it started again), so
  //     times are not comparable with earlier frames.
  pick(cands) {
    this.frames++;
    const ok = (t) => typeof t === 'number' && Number.isFinite(t) && t > 0;
    // time since the last frame by the callback clock, as a sanity check
    const fb = cands[cands.length - 1];
    const fbLast = this.src.get(fb[0])?.last;
    const wall = ok(fb[1]) && fbLast !== undefined ? fb[1] - fbLast : NaN;
    for (const [name, t] of cands) {
      let s = this.src.get(name);
      if (!s) { s = { last: undefined, iv: [], seen: false, good: false, back: false, backs: [], badRun: 0, goodRun: 0, out: false, need: 25 }; this.src.set(name, s); }
      let good = false;
      s.back = false;
      if (ok(t)) {
        const d = s.last === undefined ? Infinity : t - s.last;
        if (d < 0) {
          // The clock stepped back: it has started again. One that keeps
          // doing so is not a clock; it is left alone for a good while.
          s.back = true;
          s.backs = s.backs.filter((f) => this.frames - f < 600);
          s.backs.push(this.frames);
          if (s.backs.length >= 3) { s.out = true; s.need = 600; }
        }
        // later than the frame before, and not absurdly later (a clock in
        // the wrong unit would say seconds where the callbacks say frames)
        if (d > 0 && !(d >= 1 && d < Infinity && wall > 0 && wall < 0.5 && d > 20 * wall)) {
          good = true;
          // a gap of a second or more is a pause, not a frame interval
          if (d < 1) {
            s.iv.push(d);
            if (s.iv.length > this.window) s.iv.shift();
          }
        }
        s.last = t;
        s.seen = true;
      }
      s.good = good;
      // A clock that fails for half a second is given up, and taken back
      // only after it has worked for about a second.
      if (good) {
        s.goodRun++;
        s.badRun = 0;
        if (s.out && s.goodRun >= s.need) { s.out = false; s.need = 25; }
      } else {
        s.badRun++;
        s.goodRun = 0;
        if (s.badRun >= 15) s.out = true;
      }
    }
    const fallback = cands[cands.length - 1][0];
    // A few frames without a value are not a reason to change clocks: a
    // change makes every time before it useless, and those frames are
    // simply left out. After five such frames another camera clock is
    // taken if one is working; the display clock only after fifteen.
    const usable = (name) => { const s = this.src.get(name); return s.seen && !s.out; };
    const proper = cands.slice(0, -1).map((c) => c[0]).filter(usable);
    const before = this.best;
    if (!proper.length) this.best = fallback;
    else if (!this.best || this.best === fallback || !proper.includes(this.best)) this.best = proper[0];
    else if (this.src.get(this.best).badRun >= 5) {
      const alt = proper.find((name) => name !== this.best && this.src.get(name).good);
      if (alt) this.best = alt;
    }
    if (proper.length > 1 && this.frames >= this.nextEval) {
      const early = this.frames < 200;
      this.nextEval = this.frames + (early ? 40 : 300);
      const pj = this.jitterOf(this.best);
      let cand = null, cj = Infinity;
      for (const name of proper) {
        if (name === this.best) continue;
        const j = this.jitterOf(name);
        if (j !== null && j < cj) { cand = name; cj = j; }
      }
      // Move only for a clear improvement. Once judging is under way, also
      // only away from a clock that is really poor (the frame clock copes
      // with a couple of milliseconds), and only when the other clock is
      // better twice in a row.
      const better = cand !== null && (pj === null || (cj < 0.5 * pj && pj > (early ? 0.0002 : 0.002)));
      if (better && (early || this.challenger === cand)) { this.best = cand; this.challenger = null; }
      else this.challenger = better ? cand : null;
    }
    if (this.best !== before) { this.jitterAt = -Infinity; this.trusted = false; this.spikeAt = -Infinity; }
    if (this.frames - this.jitterAt >= 15) {
      this.jitterAt = this.frames;
      const st = this._stats(this.best);
      this.jitter = st ? st.rms : null;
      if (st && st.max > this.spikeAbove) this.spikeAt = this.frames;
      if (this.best === fallback || !st || st.rms > this.distrustAbove || st.max > this.spikeAbove) this.trusted = false;
      else if (st.rms < this.trustBelow && st.max < this.spikeBelow && this.frames - this.spikeAt > this.hold) this.trusted = true;
    }
    const chosen = this.src.get(this.best);
    return {
      t: cands.find((x) => x[0] === this.best)[1],
      skip: !chosen.good,
      source: this.best,
      jitter: this.jitter,
      trusted: this.trusted,
      switched: before !== null && (before !== this.best || chosen.back),
    };
  }
}

// Removes timestamp jitter, on the assumption that the camera delivers frames
// on a fixed period. A straight line t = a + b*n is kept through recent
// (frame index, time) pairs; each new frame is assigned the nearest slot on
// that line and reports the line's time for it. Dropped frames simply skip
// slots. A frame far from every slot, after frames that were on theirs, was
// stamped late: it gets the time of the slot before it. Frames of a stream
// that does not look like a regular grid (the frame rate is changing, or the
// jitter is too large to tell slots apart) keep their own timestamps; when
// that goes on, the line is rebuilt. map() returns null for a frame whose
// time cannot be told apart from the frame before it: leave that frame out.
// Times given out only step back when the clock itself did (it started
// again): nothing before that can be compared with what follows.
export class FrameClock {
  constructor(size = 120) {
    this.size = size;
    this.nominal = 0; // the camera's frame period (s) if known, as a hint
    this.reset();
  }

  reset() {
    this.hist = [];
    this.a = 0;
    this.b = 0; // slot length (s) once fitted
    this.res2 = 0; // smoothed squared residual: is the stream a regular grid right now?
    this.jit2 = 0; // the clock's usual jitter (squared): slow, and deaf to bursts
    this.res = []; // recent residuals, to tell jitter from a real pattern
    this.offGrid = 0;
    this.farRun = 0; // frames in a row that were far from every slot
    this.lastT = undefined;
    this.lastN = -Infinity; // last slot given out
    this.step = 1; // slots between the last two frames on the line
    this.lastRes = 0; // how far the last of them was from its slot (s)
    this.farRes = 0; // how late the last frame far from every slot was (s)
    this.farGap = 0; // the interval before the first of a run of such frames (s)
    this.lastOut = -Infinity; // last time given out
    this.iv = []; // the last eight frame intervals
    this.slow = 0; // did those eight average longer (+1) or shorter (-1) than a slot at the last frame?
  }

  // Jitter is random from frame to frame. Residuals that follow a pattern
  // (alternating, or drifting) mean the camera's own pace varies and the
  // timestamps are telling the truth.
  _structured() {
    const r = this.res;
    if (r.length < 24) return false;
    // (No residual counts for much more than the clock's usual jitter: two
    // frames stamped late are not a pattern.)
    const cap = 6 * Math.sqrt(this.jit2);
    let s0 = 0, s1 = 0, prev = 0;
    for (let i = 0; i < r.length; i++) {
      const v = Math.max(-cap, Math.min(cap, r[i]));
      s0 += v * v;
      s1 += v * prev;
      prev = v;
    }
    if (Math.sqrt(s0 / r.length) < 0.0003) return false; // too small to matter
    return Math.abs(s1 / s0) > 0.5;
  }

  _fit() {
    const h = this.hist;
    const t0 = h[0].t, n0 = h[0].n;
    let sn = 0, st = 0;
    for (const p of h) { sn += p.n - n0; st += p.t - t0; }
    sn /= h.length; st /= h.length;
    let snn = 0, snt = 0;
    for (const p of h) { snn += (p.n - n0 - sn) ** 2; snt += (p.n - n0 - sn) * (p.t - t0 - st); }
    if (!(snn > 0)) return false;
    const b = snt / snn;
    if (!(b > 0)) return false;
    this.b = b;
    this.a = t0 + st - b * (n0 + sn);
    return true;
  }

  // Finds the slot length from the first frames and numbers them. When the
  // phone cannot keep up, frames arrive two or three camera periods apart;
  // the slot must then be the camera's period, not the usual spacing, or
  // every odd frame would fall half-way between slots. The camera's stated
  // period is taken when the frames fit it; otherwise the largest period of
  // which all intervals are whole multiples.
  _start() {
    const h = this.hist;
    const d = [];
    for (let i = 1; i < h.length; i++) d.push(h[i].t - h[i - 1].t);
    const P1 = median(d);
    if (!(P1 > 0)) return false;
    const cand = [];
    for (let k = 1; k <= 4; k++) {
      const P = P1 / k;
      let s = 0;
      for (const x of d) s += (x - Math.max(1, Math.round(x / P)) * P) ** 2;
      cand.push({ P, misfit: Math.sqrt(s / d.length) / P });
    }
    let c = this.nominal > 0 ? cand.find((q) => Math.abs(q.P - this.nominal) < 0.2 * this.nominal && q.misfit < 0.3) : null;
    if (!c) {
      // One frame per slot is the usual case and is taken even when jitter
      // makes the fit loose. A shorter slot needs clear evidence: intervals
      // that fit it well and the usual spacing badly.
      const fine = cand[0].misfit > 0.25 ? cand.slice(1).find((q) => q.misfit < 0.1) : null;
      c = fine || (cand[0].misfit < 0.3 ? cand[0] : null);
    }
    if (!c) return false;
    let n = 0;
    h[0].n = 0;
    for (let i = 1; i < h.length; i++) { n += Math.max(1, Math.round(d[i - 1] / c.P)); h[i].n = n; }
    if (!this._fit()) return false;
    // This clock's jitter, as far as these few frames show it; not trusted
    // to be small until more frames have been seen.
    let s2 = 0;
    for (const q of h) s2 += (q.t - (this.a + this.b * q.n)) ** 2;
    this.jit2 = Math.max(s2 / Math.max(1, h.length - 2), (0.1 * this.b) ** 2);
    this.res2 = this.jit2;
    return true;
  }

  // back: the clock itself stepped back, so the times given out start again too
  _restart(t, back = false) {
    const out = back ? -Infinity : this.lastOut;
    this.reset();
    this.hist.push({ n: 0, t });
    this.lastT = t;
    return this._out(t, out);
  }

  // Times given out do not step back or repeat: such a frame is left out.
  _out(t, prev = this.lastOut) {
    if (!(t > prev)) { this.lastOut = prev; return null; }
    this.lastOut = t;
    return t;
  }

  // The frame keeps its own time; too many of these and the line is rebuilt.
  _off(t) {
    this.offGrid += 1;
    if (this.offGrid > 12) return this._restart(t);
    return this._out(t);
  }

  map(t) {
    const h = this.hist;
    if (h.length && t === this.lastT) return null; // the same stamp twice
    if (!h.length || !(t > this.lastT) || t - this.lastT > 0.5) return this._restart(t, h.length > 0 && t < this.lastT);
    const d = t - this.lastT;
    this.lastT = t;
    if (!this.b) {
      // Start-up: collect a few frames, then lay the grid through them.
      h.push({ n: 0, t });
      if (h.length >= 8) {
        if (!this._start()) return this._restart(t);
        this.lastN = h[h.length - 1].n;
      }
      return this._out(t);
    }
    // Jitter makes one interval long and the next short, so over three
    // frames it nearly cancels. When three intervals in a row are all
    // longer, or all shorter, than a slot by more than jitter can explain,
    // the camera has changed its frame rate: start again. (One frame
    // stamped late makes one long interval, not three.)
    const iv = this.iv;
    iv.push(d);
    if (iv.length > 8) iv.shift();
    const single = (q) => q > 0.5 * this.b && q < 1.5 * this.b;
    const jit = Math.sqrt(this.jit2);
    if (iv.length >= 3 && iv.slice(-3).every(single)) {
      const tol = Math.max(0.04 * this.b, 2.6 * jit);
      const e = iv.slice(-3).map((q) => q - this.b);
      const mean = (e[0] + e[1] + e[2]) / 3;
      if (Math.abs(mean) > tol && e.every((q) => q * mean > 0 && Math.abs(q) > 0.5 * tol)) return this._restart(t);
    }
    // A small change of rate shows only over more frames. The average of
    // eight intervals depends on the first and the last frame only, and
    // either may have been stamped late: a late newest frame looks like a
    // slower camera, a late oldest one like a faster camera. A real change
    // is in all the intervals, so it must also show in the five older ones
    // (slower) or the five newer ones (faster), and twice running.
    let slow = 0;
    if (iv.length === 8 && iv.every(single)) {
      const mean = iv.reduce((p, q) => p + q, 0) / 8 - this.b;
      const tol = Math.max(0.02 * this.b, 1.2 * jit);
      if (Math.abs(mean) > tol) {
        const sg = Math.sign(mean);
        let part = -5 * this.b;
        for (let i = sg > 0 ? 0 : 3, e = i + 5; i < e; i++) part += iv[i];
        if (part * sg > 2 * tol) slow = sg;
      }
    }
    if (slow !== 0 && slow === this.slow) return this._restart(t);
    this.slow = slow;
    // Two equal intervals in a row that are not a whole number of slots
    // (one and a half, say): the camera now runs at another rate.
    if (iv.length >= 2) {
      const p = iv[iv.length - 2];
      const off = Math.abs(d - Math.max(1, Math.round(d / this.b)) * this.b);
      if (Math.abs(d - p) < Math.max(0.1 * this.b, 3 * jit) && off > Math.max(0.3 * this.b, 4 * jit)) return this._restart(t);
    }
    const x = (t - this.a) / this.b;
    const n = Math.round(x);
    const far = Math.min(0.45 * this.b, Math.max(0.25 * this.b, 3.5 * Math.sqrt(this.jit2)));
    if (Math.abs(t - (this.a + this.b * n)) > far) {
      // Far from every slot (measured against this clock's usual jitter).
      // If the frame before was already off its slot, or this is the second
      // such frame and further off than the first, the camera's pace is
      // changing and the frames tell the truth: they keep their own times.
      // The same after a pause (the camera may come back in another step),
      // and when this goes on. Otherwise the frame was stamped late (that
      // is how timestamps err) and belongs to the slot before its time -
      // unless that slot is taken, or frames have been coming every second
      // or third slot and the nearest slot is the next in that pattern:
      // then it is an early frame of the nearest slot, if this clock's
      // jitter can explain that. It is kept out of the line.
      this.farRun++;
      if (this.farRun === 1) this.farGap = d;
      const drift = Math.max(0.1 * this.b, 1.5 * jit);
      if (this.farRun >= 3 || this.farGap > 3.5 * this.b || Math.abs(this.lastRes) > drift) return this._off(t);
      let nf = Math.floor(x);
      const early = (n - x) * this.b < Math.min(0.45 * this.b, 4.5 * jit);
      if (nf < n && early && (nf <= this.lastN || (this.step > 1 && n - this.lastN === this.step))) nf = n;
      if (nf <= this.lastN) return this._off(t);
      const late = t - (this.a + this.b * nf);
      if (this.farRun === 2 && late - this.farRes > drift) return this._off(t);
      this.farRes = late;
      this.offGrid += 1;
      this.lastN = nf;
      return this._out(this.a + this.b * nf);
    }
    this.farRun = 0;
    // on a slot that is already taken
    if (n <= this.lastN) return this._off(t);
    this.step = n - this.lastN;
    this.lastN = n;
    h.push({ n, t });
    if (h.length > this.size) h.shift();
    if (!this._fit()) return this._restart(t);
    const fit = this.a + this.b * n;
    const r = t - fit;
    this.lastRes = r;
    this.res2 = 0.92 * this.res2 + 0.08 * r * r;
    // (a burst of large residuals must not pass for the usual jitter, or the
    // tolerances above would widen just when the frame rate changes)
    this.jit2 += 0.02 * (Math.min(r * r, 4 * this.jit2) - this.jit2);
    this.res.push(r);
    if (this.res.length > 40) this.res.shift();
    // Not a regular grid at the moment.
    if (Math.sqrt(this.res2) > 0.2 * this.b) return this._off(t);
    this.offGrid = Math.max(0, this.offGrid - 0.25);
    if (this._structured()) return this._out(t);
    return this._out(fit);
  }
}
