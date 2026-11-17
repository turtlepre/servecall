// Refines the tapped box corners by locating the white lines in the frame.
//
// For the centre service line, the singles sideline and the service line,
// brightness profiles are sampled across the line at many points along it.
// Every bright band in a profile is a candidate; straight lines are then
// fitted through the candidates robustly. The line's centre comes from the
// brightness-weighted centroid, and its outer edge (the side away from the
// box, which is the in/out boundary) lies half a line width (2.5 cm) beyond.
// Corners are intersections of the fitted lines; the net side has no painted
// line, so those two corners are only moved onto their fitted lines.
//
// The singles sideline has a neighbour: the doubles sideline 1.37 m outside
// it, which low cameras see only a few pixels away. Of two parallel lines the
// inner one is taken, and a line found alone is checked for a partner on its
// inner side before it is trusted.

import { homography, invert3, applyH } from './geometry.js';
import { CORNERS, BOX_W, BOX_L } from './court.js';

const LUMA = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

// Bilinear luminance at continuous image coordinates; pixel j covers
// [j, j+1), so its value sits at j + 0.5.
function sampler(img) {
  const { data, width: w, height: h } = img;
  return (xc, yc) => {
    const x = xc - 0.5, y = yc - 0.5;
    if (x < 0 || y < 0 || x > w - 1.001 || y > h - 1.001) return NaN;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const i = (y0 * w + x0) * 4;
    const a = LUMA(data, i), b = LUMA(data, i + 4);
    const c = LUMA(data, i + w * 4), d = LUMA(data, i + w * 4 + 4);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
};

// All bright bands in a brightness profile: [{ pos, width, contrast }], with
// `pos` the brightness-weighted centre in profile steps. Lines are often only
// 1-3 px wide, where edge detectors are biased; the centroid is not.
function bands(profIn) {
  const n = profIn.length;
  const valid = profIn.filter((v) => !Number.isNaN(v));
  if (valid.length < 0.7 * n) return [];
  const fill = median(valid);
  const prof = profIn.map((v) => (Number.isNaN(v) ? fill : v));
  const sorted = [...prof].sort((a, b) => a - b);
  const lo = sorted[Math.floor(n * 0.3)], hi = sorted[n - 1];
  if (hi - lo < 25) return []; // no visible line
  const level = lo + 0.4 * (hi - lo);
  const out = [];
  let i = 0;
  while (i < n) {
    if (prof[i] <= level) { i++; continue; }
    let j = i;
    while (j < n - 1 && prof[j + 1] > level) j++;
    if (i > 3 && j < n - 4) {
      const side = [...prof.slice(Math.max(0, i - 10), i - 3), ...prof.slice(j + 4, Math.min(n, j + 11))];
      const bg = median(side);
      let sw = 0, sp = 0, peak = 0;
      for (let k = i - 3; k <= j + 3; k++) {
        const w = prof[k] - bg;
        if (w > 0) { sw += w; sp += w * k; }
        if (prof[k] - bg > peak) peak = prof[k] - bg;
      }
      if (sw > 0 && peak >= 20) out.push({ pos: sp / sw, width: j - i + 1, contrast: peak });
    }
    i = j + 1;
  }
  return out;
}

// Total-least-squares line through points: { px, py, nx, ny } (unit normal).
function fitLine(pts) {
  let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= pts.length; my /= pts.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pts) {
    const dx = p.x - mx, dy = p.y - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy); // direction of largest spread
  return { px: mx, py: my, nx: -Math.sin(ang), ny: Math.cos(ang) };
}

const dist = (L, x, y) => (x - L.px) * L.nx + (y - L.py) * L.ny;

// Best straight line through candidate points { x, y, i } where i is the
// profile a point came from; each profile supports a line at most once. The
// line must run within about 15 degrees of `dir`.
function bestLine(points, dir, minSupport, tol = 0.8) {
  const closest = (L) => {
    const seen = new Map();
    for (const p of points) {
      const d = Math.abs(dist(L, p.x, p.y));
      if (d > tol) continue;
      const cur = seen.get(p.i);
      if (!cur || d < cur.d) seen.set(p.i, { p, d });
    }
    return seen;
  };
  let best = null;
  for (let a = 0; a < points.length; a++) {
    for (let b = a + 1; b < points.length; b++) {
      const P = points[a], Q = points[b];
      if (P.i === Q.i) continue;
      const dx = Q.x - P.x, dy = Q.y - P.y;
      const len = Math.hypot(dx, dy);
      if (len < 4) continue;
      if (Math.abs((dx * dir[0] + dy * dir[1]) / len) < 0.966) continue;
      const seen = closest({ px: P.x, py: P.y, nx: -dy / len, ny: dx / len });
      if (!best || seen.size > best.size) best = seen;
    }
  }
  if (!best || best.size < minSupport) return null;
  let line = fitLine([...best.values()].map((e) => e.p));
  let inl = closest(line);
  if (inl.size < minSupport) return null;
  line = fitLine([...inl.values()].map((e) => e.p));
  inl = closest(line);
  if (inl.size < minSupport) return null;
  const pts = [...inl.values()].map((e) => e.p);
  const rms = Math.sqrt(pts.reduce((s, p) => s + dist(line, p.x, p.y) ** 2, 0) / pts.length);
  return { line, points: pts, support: pts.length, rms, contrast: median(pts.map((p) => p.contrast)) };
}

function intersect(A, B) {
  // A: nx*x + ny*y = nx*px + ny*py
  const ca = A.nx * A.px + A.ny * A.py, cb = B.nx * B.px + B.ny * B.py;
  const det = A.nx * B.ny - A.ny * B.nx;
  if (Math.abs(det) < 1e-9) return null;
  return [(ca * B.ny - A.ny * cb) / det, (A.nx * cb - ca * B.nx) / det];
}

function lineThrough(p, q) {
  const dx = q[0] - p[0], dy = q[1] - p[1];
  const len = Math.hypot(dx, dy);
  return { px: p[0], py: p[1], nx: -dy / len, ny: dx / len };
}

// Line geometry in box coordinates: each line's outer edge is the boundary;
// the line itself is 5 cm wide and lies inside it.
const LINE_HALF = 0.025;
const DOUBLES_GAP = 1.37; // singles to doubles sideline, metres
// Where the singles sideline lies in a box whose sideline corners were tapped
// on the doubles sideline: that box is stretched by (BOX_W + gap) / BOX_W.
const SINGLES_IN = BOX_W * BOX_W / (BOX_W + DOUBLES_GAP);

// pts: 4 tapped corners in CORNERS order (net-centre, net-side, service-side,
// service-centre). radius: how far (video px) a line may be from the taps.
// Returns { pts, found, snapped, movedSide, moved }:
//   found:     which of 'center' | 'side' | 'service' were located
//   snapped:   per corner, whether it now sits on fitted lines
//   movedSide: the sideline corners were tapped on the doubles sideline and
//              have been moved in to the singles sideline
export function snapCorners(img, pts, { radius = 14, samples = 28 } = {}) {
  const get = sampler(img);
  const inside = [(pts[0][0] + pts[1][0] + pts[2][0] + pts[3][0]) / 4, (pts[0][1] + pts[1][1] + pts[2][1] + pts[3][1]) / 4];
  const H0 = homography(CORNERS.map((c) => c.uv), pts);
  const H0inv = H0 && invert3(H0);
  if (!H0inv) return { pts: pts.map((p) => [...p]), found: [], snapped: [false, false, false, false], movedSide: false, moved: [0, 0, 0, 0] };
  const step = 0.5;

  // Candidate edge points for the line from p to q: band centres shifted out
  // by half a line width. `outSign`/`axis` say which way is outwards in box
  // coordinates for that line.
  function candidates(p, q, axis, outSign, R) {
    const dx = q[0] - p[0], dy = q[1] - p[1];
    const len = Math.hypot(dx, dy);
    if (len < 20) return null;
    let nx = -dy / len, ny = dx / len;
    const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
    if ((inside[0] - mx) * nx + (inside[1] - my) * ny > 0) { nx = -nx; ny = -ny; } // outwards
    const nS = Math.round((2 * R) / step) + 1;
    const points = [];
    for (let k = 0; k < samples; k++) {
      const f = 0.12 + 0.76 * k / (samples - 1);
      const cx = p[0] + dx * f, cy = p[1] + dy * f;
      const prof = new Array(nS);
      for (let i = 0; i < nS; i++) {
        const s = -R + i * step;
        prof[i] = get(cx + nx * s, cy + ny * s);
      }
      for (const b of bands(prof)) {
        const sc = -R + b.pos * step;
        const ex = cx + nx * sc, ey = cy + ny * sc;
        // half a line width towards the outer edge, in pixels along the normal
        const [u, v] = applyH(H0inv, ex, ey);
        const [x2, y2] = axis === 'u' ? applyH(H0, u + outSign * LINE_HALF, v) : applyH(H0, u, v + outSign * LINE_HALF);
        const hw = (x2 - ex) * nx + (y2 - ey) * ny;
        if (!(hw > 0 && hw < 10)) continue;
        points.push({ x: ex + nx * hw, y: ey + ny * hw, i: k, contrast: b.contrast });
      }
    }
    return { points, dir: [dx / len, dy / len], n: [nx, ny], mid: [mx, my] };
  }

  const minSupport = Math.max(6, Math.round(samples * 0.45));

  function single(p, q, axis, outSign) {
    const c = candidates(p, q, axis, outSign, radius);
    if (!c) return null;
    const fit = bestLine(c.points, c.dir, minSupport);
    return fit && fit.rms <= 1.0 ? fit : null;
  }

  // Sideline: the inner of two parallel lines when both are in reach.
  function sideline() {
    const c = candidates(pts[1], pts[2], 'u', +1, radius);
    if (!c) return null;
    const first = bestLine(c.points, c.dir, minSupport);
    if (!first || first.rms > 1.0) return null;
    const used = new Set(first.points);
    const second = bestLine(c.points.filter((p) => !used.has(p)), c.dir, minSupport);
    const outPos = (fit) => dist(fit.line, c.mid[0], c.mid[1]) * (fit.line.nx * c.n[0] + fit.line.ny * c.n[1]);
    // dist(line, mid) is the midpoint's offset from the line along the line's
    // normal; flip to the outward normal and negate to get the line's offset
    // from the midpoint (positive = further out).
    if (second && second.rms <= 1.0 && second.contrast >= 0.4 * first.contrast) {
      return -outPos(first) <= -outPos(second) ? first : second;
    }
    return first;
  }

  // Is there a parallel painted line where the singles sideline would be if
  // `fit` were the doubles sideline? If so, return the fit of that line.
  function innerPartner(fit) {
    const a = fit.points[0], b = fit.points[fit.points.length - 1];
    const along = Math.hypot(b.x - a.x, b.y - a.y);
    if (along < 20) return null;
    // outward normal of the fitted line
    let nx = fit.line.nx, ny = fit.line.ny;
    if ((inside[0] - fit.line.px) * nx + (inside[1] - fit.line.py) * ny > 0) { nx = -nx; ny = -ny; }
    const points = [];
    let tried = 0;
    for (let k = 0; k < samples; k++) {
      const f = k / (samples - 1);
      const x = a.x + (b.x - a.x) * f, y = a.y + (b.y - a.y) * f;
      const [u, v] = applyH(H0inv, x, y);
      // The tapped box is stretched if its side is the doubles line, so the
      // partner lies between 0.9 and 1.5 "box metres" in. Look across that
      // zone at right angles to the fitted line.
      const far = applyH(H0, u - 1.5, v), near = applyH(H0, u - 0.9, v);
      const sFar = (far[0] - x) * nx + (far[1] - y) * ny, sNear = (near[0] - x) * nx + (near[1] - y) * ny;
      if (!(sFar < sNear && sNear < -2 && sFar > -400)) continue;
      tried++;
      const pad = Math.max(6, 0.4 * (sNear - sFar));
      const s0 = sFar - pad, s1 = Math.min(-1.5, sNear + pad);
      const nS = Math.round((s1 - s0) / step) + 1;
      const prof = new Array(nS);
      for (let i = 0; i < nS; i++) {
        const sv = s0 + i * step;
        prof[i] = get(x + nx * sv, y + ny * sv);
      }
      for (const bd of bands(prof)) {
        if (bd.contrast < 0.4 * fit.contrast) continue;
        const sv = s0 + bd.pos * step;
        if (sv < sFar - 1 || sv > sNear + 1) continue;
        const ex = x + nx * sv, ey = y + ny * sv;
        const [eu, ev] = applyH(H0inv, ex, ey);
        const [x2, y2] = applyH(H0, eu + LINE_HALF, ev);
        const hw = (x2 - ex) * nx + (y2 - ey) * ny;
        if (!(hw > 0 && hw < 10)) continue;
        points.push({ x: ex + nx * hw, y: ey + ny * hw, i: k, contrast: bd.contrast });
      }
    }
    if (tried < minSupport) return null;
    const dir = [(b.x - a.x) / along, (b.y - a.y) / along];
    const partner = bestLine(points, dir, Math.max(6, Math.round(tried * 0.55)));
    return partner && partner.rms <= 1.0 ? partner : null;
  }

  const fits = {
    center: single(pts[0], pts[3], 'u', -1),
    side: sideline(),
    service: single(pts[3], pts[2], 'v', +1),
  };
  // How far this player's taps are off (per axis): the tap where two fitted
  // lines cross, and the distance of taps from lines they lie on whichever
  // sideline was tapped. (No such evidence: a few pixels, a careful tap.)
  function tapError() {
    const offs = [];
    if (fits.center) offs.push(dist(fits.center.line, pts[0][0], pts[0][1]));
    if (fits.service) offs.push(dist(fits.service.line, pts[2][0], pts[2][1]));
    const c4 = fits.center && fits.service ? intersect(fits.center.line, fits.service.line) : null;
    if (c4) offs.push(c4[0] - pts[3][0], c4[1] - pts[3][1]);
    return offs.length ? Math.max(3, Math.sqrt(offs.reduce((a, x) => a + x * x, 0) / offs.length)) : 6;
  }

  // Were the sideline corners tapped on the doubles sideline? The evidence is
  // weighed against this player's tap error (log odds, each part capped: a
  // finger can land far off now and then):
  //   corner 3, where two fitted lines cross: is the crossing nearer the tap
  //     (singles) or where a tap on the doubles line puts the singles corner,
  //     an alley along the service line? This is the strong part.
  //   corner 2: a tap on the doubles line lies an alley outside the fitted
  //     sideline. Weak: from low down or from beside the court that is a few
  //     pixels, no more than a finger's error.
  // Without clear evidence the singles line the player was asked to tap is
  // assumed.
  const alley2 = applyH(H0, SINGLES_IN, 0), alley3 = applyH(H0, SINGLES_IN, BOX_L);
  let movedSide = false;
  if (fits.side) {
    const partner = innerPartner(fits.side);
    if (partner) fits.side = partner;
    const sigma = Math.max(4, tapError()), twoVar = 2 * sigma * sigma;
    const cap = (x, m) => Math.max(-m, Math.min(m, x));
    const outward = -Math.sign(dist(fits.side.line, inside[0], inside[1])) || 1;
    const sq = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
    const c3 = intersect(fits.side.line, fits.service ? fits.service.line : lineThrough(pts[3], pts[2]));
    const e3 = c3 ? cap((sq(c3, pts[2]) - sq(c3, alley3)) / twoVar, 4) : 0;
    const d2 = outward * dist(fits.side.line, pts[1][0], pts[1][1]);
    const da = outward * dist(fits.side.line, alley2[0], alley2[1]);
    const e2 = cap((d2 * d2 - da * da) / twoVar, 1);
    movedSide = e2 + e3 > Math.log(9); // (9 to 1 for the singles line)
  }

  const L = {
    center: fits.center ? fits.center.line : lineThrough(pts[0], pts[3]),
    side: fits.side ? fits.side.line : lineThrough(pts[1], pts[2]),
    service: fits.service ? fits.service.line : lineThrough(pts[3], pts[2]),
  };
  // Net-side corners have no crossing line. Slide each tap onto its fitted
  // line instead of intersecting with the tapped net line, which would
  // magnify tap error where the lines meet at a shallow angle. A net-side
  // tap on the doubles line first goes an alley along the tapped net edge.
  const project = (Ln, p) => {
    const d = dist(Ln, p[0], p[1]);
    return [p[0] - d * Ln.nx, p[1] - d * Ln.ny];
  };
  const from2 = movedSide ? alley2 : pts[1];
  const cand = [
    fits.center ? project(L.center, pts[0]) : null,
    fits.side ? project(L.side, from2) : null,
    fits.side || fits.service ? intersect(L.side, L.service) : null,
    fits.center || fits.service ? intersect(L.center, L.service) : null,
  ];
  // A corner fixed by two fitted lines is trusted as far as lines can be
  // found; one that still leans on a tapped line may only move a little.
  // After a tap on the doubles line: an alley's width more.
  const far = (a, p) => Math.hypot(a[0] - p[0], a[1] - p[1]);
  const reach = [radius, movedSide ? far(alley2, pts[1]) + radius : radius, movedSide ? far(alley3, pts[2]) + 2 * radius : 2 * radius, 2 * radius];
  const both = [true, true, !!(fits.side && fits.service), !!(fits.center && fits.service)];
  const snapped = [false, false, false, false];
  const took = [false, false, false, false];
  const out = pts.map((p, i) => {
    const c = cand[i];
    if (!c) return [p[0], p[1]];
    const limit = both[i] ? reach[i] : Math.min(reach[i], radius);
    if (far(c, p) > limit) return [p[0], p[1]];
    snapped[i] = both[i];
    took[i] = true;
    return c;
  });
  // One end of the sideline (or centre line) on the fitted line and the other
  // still on its tap would skew the box: the net-side corner follows the
  // service-line corner onto the line, or, far off, both keep their taps.
  for (const [n, sv, key, src] of [[1, 2, 'side', from2], [0, 3, 'center', pts[0]]]) {
    if (!took[sv] || took[n] || !fits[key]) continue;
    const c = project(L[key], src);
    if (far(c, pts[n]) <= reach[n] + 2 * radius) {
      out[n] = c;
      snapped[n] = took[n] = true;
    } else {
      out[sv] = [pts[sv][0], pts[sv][1]];
      snapped[sv] = took[sv] = false;
    }
  }
  return {
    pts: out,
    found: ['center', 'side', 'service'].filter((k) => fits[k]),
    snapped,
    movedSide,
    moved: out.map((c, i) => Math.hypot(c[0] - pts[i][0], c[1] - pts[i][1])),
  };
}
