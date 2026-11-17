// Finds small, newly-appeared yellow blobs (the ball) in a region of the frame.
//
// Feature: yellowness = max(0, min(R, G) - B). An optic-yellow ball scores
// ~140; white lines ~0; blue/green hard courts and the sky 0-50; clay ~30.
// A pixel is "new" when its yellowness exceeds the larger of the two previous
// frames by the threshold. Comparing against both previous frames removes
// the ball's trailing ghost and one-frame flicker.
//
// A camera on a tripod still trembles by a fraction of a pixel, and the far
// court fills up with balls during serve practice. Each tremble makes the
// rim of every resting ball look "newly yellow". So a pixel only counts if
// it is also new compared with its neighbourhood in the previous frames:
// something that merely shifted by a pixel or two is not new.

export class Detector {
  constructor() {
    this.w = 0;
    this.h = 0;
    this.frames = 0;
    this.cur = 0;
    this.threshold = 30;
    this.maxChangeFrac = 0.03;
    this.minArea = 2;
    this.maxArea = 400;
    this.maxSpan = 40;
    this.maxCands = 12;
    this.shakeRadius = 2; // px of image shift tolerated between frames
    this.lastChangeFrac = 0;
    this.lastSkipped = false;
  }

  configure(o) {
    for (const k of ['threshold', 'maxChangeFrac', 'minArea', 'maxArea', 'maxSpan', 'maxCands', 'shakeRadius']) {
      if (o[k] !== undefined) this[k] = o[k];
    }
  }

  reset() {
    this.frames = 0;
  }

  _alloc(w, h) {
    const n = w * h;
    this.w = w;
    this.h = h;
    this.feat = [new Uint8Array(n), new Uint8Array(n), new Uint8Array(n)];
    this.raw = [new Int16Array(n), new Int16Array(n), new Int16Array(n)]; // signed min(R,G) - B
    this.diff = new Uint8Array(n);
    this.wbuf = new Uint8Array(n);
    this.stack = new Int32Array(n);
    this.frames = 0;
    this.cur = 0;
  }

  // rgba: Uint8ClampedArray (w*h*4). Returns candidates in region pixels,
  // centroids at pixel centres: { x, y, area, w, h, weight }.
  process(rgba, w, h) {
    if (w !== this.w || h !== this.h || !this.feat) this._alloc(w, h);
    const n = w * h;
    const F = this.feat[this.cur], R = this.raw[this.cur];
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const r = rgba[j], g = rgba[j + 1], b = rgba[j + 2];
      const m = (r < g ? r : g) - b;
      R[i] = m;
      F[i] = m > 0 ? m : 0;
    }
    this.frames++;
    let cands = [];
    this.lastSkipped = false;
    if (this.frames >= 3) {
      const P1 = this.feat[(this.cur + 2) % 3];
      const P2 = this.feat[(this.cur + 1) % 3];
      const D = this.diff;
      const thr = this.threshold;
      let changed = 0;
      for (let i = 0; i < n; i++) {
        const p1 = P1[i], p2 = P2[i];
        const d = F[i] - (p1 > p2 ? p1 : p2);
        if (d > thr) { D[i] = d; changed++; } else D[i] = 0;
      }
      this.lastChangeFrac = changed / n;
      if (changed > this.maxChangeFrac * n) this.lastSkipped = true; // big shake, exposure jump
      else if (changed > 0) {
        if (this.shakeRadius > 0) this._dropShifted(F, P1, P2, thr);
        cands = this._components();
        const R1 = this.raw[(this.cur + 2) % 3];
        for (const c of cands) this._refineCentre(c, R, R1);
      }
    }
    this.cur = (this.cur + 1) % 3;
    return cands;
  }

  // Clears mask pixels that are not new compared with the neighbourhood of
  // the previous frames. Only the (few) masked pixels are examined.
  _dropShifted(F, P1, P2, thr) {
    const { w, h, diff: D } = this;
    const r = this.shakeRadius;
    const n = w * h;
    for (let i = 0; i < n; i++) {
      if (!D[i]) continue;
      const y = (i / w) | 0, x = i - y * w;
      const y0 = y > r ? y - r : 0, y1 = y < h - 1 - r ? y + r : h - 1;
      const x0 = x > r ? x - r : 0, x1 = x < w - 1 - r ? x + r : w - 1;
      const limit = F[i] - thr; // any neighbour above this makes the pixel "not new"
      let isNew = true;
      for (let yy = y0; yy <= y1 && isNew; yy++) {
        const row = yy * w;
        for (let xx = x0; xx <= x1; xx++) {
          if (P1[row + xx] >= limit || P2[row + xx] >= limit) { isNew = false; break; }
        }
      }
      if (!isNew) D[i] = 0;
    }
  }

  // Re-centres a blob by how much of each pixel the ball covers.
  //
  // The yellowness of a pixel that the ball only partly covers depends on
  // what is behind it: over a blue court it drops below zero and is clipped
  // away, over a white line it stays positive. Centred on the clipped
  // values, a ball straddling a line is pulled towards the line -- exactly
  // where calls are close. Coverage, (pixel - background) / (ball -
  // background) with the previous frame as background, has no such pull.
  _refineCentre(c, R, R1) {
    const { w, h } = this;
    const x0 = Math.max(0, Math.floor(c.x - 0.5 - c.w / 2) - 2), x1 = Math.min(w - 1, Math.ceil(c.x - 0.5 + c.w / 2) + 2);
    const y0 = Math.max(0, Math.floor(c.y - 0.5 - c.h / 2) - 2), y1 = Math.min(h - 1, Math.ceil(c.y - 0.5 + c.h / 2) + 2);
    let ball = -Infinity;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (R[y * w + x] > ball) ball = R[y * w + x];
    let sw = 0, sx = 0, sy = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * w + x;
        const span = ball - R1[i];
        if (span < 25) continue;
        const cov = (R[i] - R1[i]) / span;
        if (cov < 0.12) continue;
        const wgt = cov > 1 ? 1 : cov;
        sw += wgt; sx += wgt * x; sy += wgt * y;
      }
    }
    if (sw < 1) return; // keep the plain centroid
    c.x = sx / sw + 0.5;
    c.y = sy / sw + 0.5;
    c.cover = sw; // ball size in pixels
  }

  // 8-connected components over the diff mask (destructive).
  _components() {
    const { w, h, diff: D, wbuf: W, stack } = this;
    const out = [];
    const n = w * h;
    for (let i0 = 0; i0 < n; i0++) {
      if (!D[i0]) continue;
      let sp = 0;
      W[i0] = D[i0];
      D[i0] = 0;
      stack[sp++] = i0;
      let area = 0, sw = 0, sx = 0, sy = 0;
      let minx = w, maxx = -1, miny = h, maxy = -1;
      while (sp > 0) {
        const i = stack[--sp];
        const y = (i / w) | 0, x = i - y * w;
        const wt = W[i];
        area++;
        sw += wt; sx += wt * x; sy += wt * y;
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y < miny) miny = y;
        if (y > maxy) maxy = y;
        const y0 = y > 0 ? y - 1 : 0, y1 = y < h - 1 ? y + 1 : h - 1;
        const x0 = x > 0 ? x - 1 : 0, x1 = x < w - 1 ? x + 1 : w - 1;
        for (let yy = y0; yy <= y1; yy++) {
          const row = yy * w;
          for (let xx = x0; xx <= x1; xx++) {
            const k = row + xx;
            const v = D[k];
            if (v) {
              W[k] = v;
              D[k] = 0;
              stack[sp++] = k;
            }
          }
        }
      }
      const bw = maxx - minx + 1, bh = maxy - miny + 1;
      if (area >= this.minArea && area <= this.maxArea && Math.max(bw, bh) <= this.maxSpan) {
        out.push({ x: sx / sw + 0.5, y: sy / sw + 0.5, area, w: bw, h: bh, weight: sw });
      }
    }
    out.sort((a, b) => b.weight - a.weight);
    return out.length > this.maxCands ? out.slice(0, this.maxCands) : out;
  }
}
