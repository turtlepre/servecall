// Checks line snapping against the true corners in simulated frames.
//   node test/snap-check.js
import { snapCorners } from '../src/snap.js';
import { CORNERS, BOX_W, BOX_L } from '../src/court.js';
import { homography, invert3, applyH } from '../src/geometry.js';
import { makeCamera, renderBackground, FrameRenderer, boxToWorld, rng } from './sim.js';
import { CONFIGS } from './accuracy.js';

const W = 1280, H = 720;
let failed = false;

function scene(pos) {
  const cam = makeCamera({ pos, target: [-2.05, 15.6, 0.3], W, H, hfov: 66 });
  const fr = new FrameRenderer(cam, renderBackground(cam), { seed: 5 });
  const img = { data: fr.render({ x: 0, y: 0, w: W, h: H }, []), width: W, height: H };
  const truth = CORNERS.map((c) => { const [X, Y] = boxToWorld(...c.uv); return cam.project([X, Y, 0]).slice(0, 2); });
  return { img, truth, cam };
}

// 1. Corner accuracy for the standard placements, taps 3 px off.
let worst = 0, worstNet = -Infinity;
for (const key of ['A25', 'A16', 'FENCE', 'SIDE', 'CENTER']) {
  const { img, truth } = scene(CONFIGS[key].pos);
  const r = rng(21);
  for (let trial = 0; trial < 5; trial++) {
    const taps = truth.map(([x, y]) => [x + r.gauss() * 3, y + r.gauss() * 3]);
    const res = snapCorners(img, taps);
    const before = taps.map((p, i) => Math.hypot(p[0] - truth[i][0], p[1] - truth[i][1]));
    const after = res.pts.map((p, i) => Math.hypot(p[0] - truth[i][0], p[1] - truth[i][1]));
    // Corners 3 and 4 are fully determined by lines; 1 and 2 keep the tap along their line.
    worst = Math.max(worst, after[2], after[3]);
    worstNet = Math.max(worstNet, after[0] - before[0], after[1] - before[1]);
    console.log(`${key.padEnd(6)} found=${res.found.join(',').padEnd(19)} tap err ${before.map((d) => d.toFixed(1)).join('/')}px -> ${after.map((d) => d.toFixed(2)).join('/')}px`);
  }
}
console.log(`\nworst service-line corner error after snapping: ${worst.toFixed(2)}px; net-side corners never worse than the tap by more than ${worstNet.toFixed(2)}px`);
if (worst > 2.0 || worstNet > 0.5) failed = true;

// 2. Low cameras: the doubles sideline comes within the search window of the
// singles sideline. Snapping must stay on the singles line (1.37 m apart).
console.log('');
for (const [name, pos] of [['side 1.6m', [7.5, 18.3, 1.6]], ['side 1.3m', [7.5, 18.3, 1.3]], ['side 1.0m', [7.5, 18.3, 1.0]], ['corner 1.3m', [6.5, 25.3, 1.3]]]) {
  const { img, truth } = scene(pos);
  const Hinv = invert3(homography(CORNERS.map((c) => c.uv), truth));
  const r = rng(31);
  let worstU = 0;
  for (let t = 0; t < 12; t++) {
    const taps = truth.map(([x, y]) => [x + r.gauss() * 3, y + r.gauss() * 3]);
    const res = snapCorners(img, taps);
    worstU = Math.max(worstU, ...[1, 2].map((i) => Math.abs(applyH(Hinv, ...res.pts[i])[0] - BOX_W)));
  }
  console.log(`${name.padEnd(12)} sideline placed within ${(worstU * 100).toFixed(0)} cm of the true line in 12 trials`);
  if (worstU > 0.15) failed = true;
}
// 3. Rough taps (a finger, not a stylus) with the wider search the app uses,
// and sideline corners tapped on the doubles sideline by mistake.
console.log('');
const boundaryError = (Hinv, pts) => {
  const b = pts.map((q) => applyH(Hinv, ...q));
  return Math.max(Math.abs(b[1][0] - BOX_W), Math.abs(b[2][0] - BOX_W), Math.abs(b[0][0]), Math.abs(b[3][0]), Math.abs(b[2][1] - BOX_L), Math.abs(b[3][1] - BOX_L));
};
for (const key of ['A25', 'A16', 'SIDE', 'SIDE16', 'FENCE']) {
  const { img, truth, cam } = scene(CONFIGS[key].pos);
  const Hinv = invert3(homography(CORNERS.map((c) => c.uv), truth));
  const P = (u, v) => { const [X, Y] = boxToWorld(u, v); return cam.project([X, Y, 0]).slice(0, 2); };
  const r = rng(77);
  let bad = 0, worst = 0;
  for (let t = 0; t < 20; t++) {
    const res = snapCorners(img, truth.map(([x, y]) => [x + r.gauss() * 6, y + r.gauss() * 6]), { radius: 24 });
    const e = boundaryError(Hinv, res.pts);
    worst = Math.max(worst, e);
    if (e > 0.10) bad++;
  }
  let badD = 0, worstD = 0, movedD = 0;
  const onDoubles = [P(0, 0), P(BOX_W + 1.37, 0), P(BOX_W + 1.37, BOX_L), P(0, BOX_L)];
  for (let t = 0; t < 10; t++) {
    const res = snapCorners(img, onDoubles.map(([x, y]) => [x + r.gauss() * 2, y + r.gauss() * 2]), { radius: 24 });
    const e = boundaryError(Hinv, res.pts);
    worstD = Math.max(worstD, e);
    if (e > 0.10) badD++;
    if (res.movedSide) movedD++;
  }
  console.log(`${key.padEnd(7)} taps 6 px off: box boundary within ${(worst * 100).toFixed(0)} cm (${bad}/20 over 10 cm) | taps on the doubles sideline: within ${(worstD * 100).toFixed(0)} cm, moved to singles ${movedD}/10`);
  if (bad > 0 || badD > 0 || movedD < 10) failed = true;
}
// 4. A finger, not a careful drag: taps about 8 px off (per axis) from a low
// tripod, where the two sidelines are only a few pixels apart on screen.
// Snapping must never leave a corner far from where it belongs: a tap that
// looks like one on the doubles line but is only off must not be "moved in".
console.log('');
for (const [name, pos] of [['corner 1.3m', [6.5, 25.3, 1.3]], ['corner 1.6m', [6.5, 25.3, 1.6]], ['side 1.3m', [7.5, 18.3, 1.3]], ['side 1.6m', [7.5, 18.3, 1.6]]]) {
  const { img, truth } = scene(pos);
  const r = rng(99 + 8);
  let far = 0, worse = 0;
  for (let t = 0; t < 40; t++) {
    const taps = truth.map(([x, y]) => [x + r.gauss() * 8, y + r.gauss() * 8]);
    const res = snapCorners(img, taps, { radius: 26 });
    const before = taps.map((p, i) => Math.hypot(p[0] - truth[i][0], p[1] - truth[i][1]));
    const after = res.pts.map((p, i) => Math.hypot(p[0] - truth[i][0], p[1] - truth[i][1]));
    if (Math.max(...after) > 40) far++;
    if (after.some((d, i) => d > before[i] + 10)) worse++;
  }
  console.log(`${name.padEnd(12)} finger taps (8 px): a corner over 40 px off ${far}/40, a corner made 10 px worse than its tap ${worse}/40`);
  if (far > 0 || worse > 1) failed = true;
}
// 5. The same finger on the doubles sideline, from beside the court, where
// the alley is a few pixels: the corners may stay on the singles line's
// assumption, but the box must never be skewed (one sideline corner moved in,
// the other left out on the doubles line).
console.log('');
for (const [name, pos] of [['side 2.5m', [7.5, 18.3, 2.5]], ['side 1.6m', [7.5, 18.3, 1.6]], ['side 1.3m', [7.5, 18.3, 1.3]]]) {
  const { img, truth, cam } = scene(pos);
  const Hinv = invert3(homography(CORNERS.map((c) => c.uv), truth));
  const P = (u, v) => { const [X, Y] = boxToWorld(u, v); return cam.project([X, Y, 0]).slice(0, 2); };
  const onDoubles = [P(0, 0), P(BOX_W + 1.37, 0), P(BOX_W + 1.37, BOX_L), P(0, BOX_L)];
  const r = rng(500 + 8);
  let skew = 0, worst = 0;
  for (let t = 0; t < 30; t++) {
    const res = snapCorners(img, onDoubles.map(([x, y]) => [x + r.gauss() * 8, y + r.gauss() * 8]), { radius: 26 });
    const b = res.pts.map((q) => applyH(Hinv, ...q));
    const off = Math.max(Math.abs(b[1][0] - BOX_W), Math.abs(b[2][0] - BOX_W));
    worst = Math.max(worst, off);
    if (off > 0.3) skew++;
  }
  console.log(`${name.padEnd(12)} finger taps (8 px) on the doubles sideline: sideline over 30 cm off ${skew}/30 (worst ${(worst * 100).toFixed(0)} cm)`);
  if (skew > 0) failed = true;
}
if (failed) { console.error('\nSNAP CHECK FAILED'); process.exit(1); }
console.log('\nsnap check passed');
