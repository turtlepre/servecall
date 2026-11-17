// Runs simulated serves through the pipeline for several camera placements and
// frame rates, and reports detection rate, landing-point error and call accuracy.
//
//   node test/accuracy.js            full run
//   node test/accuracy.js --quick    fewer serves and configs (used by npm test)
//   node test/accuracy.js --only A25 --fps 30 --n 20

import { Pipeline } from '../src/pipeline.js';
import { CORNERS } from '../src/court.js';
import { snapCorners } from '../src/snap.js';
import {
  makeCamera, renderBackground, FrameRenderer, aimServe, exposurePositions,
  boxToWorld, worldToBox, rng, markGap, setCourt, setDragScale, BALL_R,
} from './sim.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};

const TARGET = [-2.05, 15.6, 0.3];
export const CONFIGS = {
  A25: { name: '맞은편 뒤 코너, 높이 2.5m', pos: [6.5, 25.3, 2.5] },
  A16: { name: '맞은편 뒤 코너, 높이 1.6m', pos: [6.5, 25.3, 1.6] },
  A30: { name: '맞은편 뒤 코너, 높이 3.0m', pos: [6.5, 25.3, 3.0] },
  FENCE: { name: '펜스 코너, 높이 3.0m', pos: [9.0, 29.8, 3.0] },
  SIDE: { name: '옆 (반대 박스 바깥), 2.5m', pos: [7.5, 18.3, 2.5] },
  SIDE16: { name: '옆 (반대 박스 바깥), 1.6m', pos: [7.5, 18.3, 1.6] },
  CENTER: { name: '맞은편 베이스라인 중앙 뒤, 2.5m', pos: [0, 26.0, 2.5] },
  LEFT: { name: '맞은편 반대 코너(공 진행 방향), 2.5m', pos: [-6.5, 25.3, 2.5] },
};

function sampleTarget(r) {
  const W = 4.14, L = 6.4;
  const k = r();
  if (k < 0.4) return [r.range(0.3, W - 0.3), L + r.gauss() * 0.25];
  if (k < 0.65) return [W + r.gauss() * 0.25, r.range(1.5, L - 0.3)];
  if (k < 0.8) return [r.gauss() * 0.25, r.range(1.5, L - 0.3)];
  return [r.range(-0.5, W + 0.5), r.range(1.0, L + 0.8)];
}

// Serves from a beginner's lob (50 km/h) to a fast first serve (180 km/h),
// flat to heavy topspin. Launch speed in m/s; the ball arrives slower.
// tauC: range of the time the ball stays on the court (s); the app assumes 4.5 ms.
// tMax: how long each ball is flown (s); longer includes the second bounce of slow serves.
export function makeServes(n, seed, { speed = [14, 50], tauC = [0.0035, 0.0055], tMax = 2.2 } = {}) {
  const r = rng(seed);
  const serves = [];
  let guard = 0;
  while (serves.length < n && guard++ < 50 * n) {
    const [u, v] = sampleTarget(r);
    const [X, Y] = boxToWorld(u, v);
    const start = [r.range(0.4, 1.1), r.range(-0.2, 0.3), r.range(2.3, 2.75)];
    const v0 = r.range(speed[0], speed[1]);
    const traj = aimServe({
      start, X, Y,
      speed: v0,
      spin: r.range(0, Number(process.env.SPIN_MAX ?? 20)),
      e: r.range(0.7, 0.86),
      mu: r.range(0.55, 0.75),
      tauC: r.range(tauC[0], tauC[1]),
      tMax,
    });
    if (!traj || traj.netClear < 0.02) continue;
    const [tu, tv] = worldToBox(traj.contact.X, traj.contact.Y);
    serves.push({ traj, u: tu, v: tv, phase: r(), speed: v0 });
  }
  return serves;
}

function resample(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return src;
  const out = new Uint8ClampedArray(dw * dh * 4);
  const kx = sw / dw, ky = sh / dh;
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(sh - 1.001, Math.max(0, (y + 0.5) * ky - 0.5));
    const y0 = Math.floor(fy), wy = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(sw - 1.001, Math.max(0, (x + 0.5) * kx - 0.5));
      const x0 = Math.floor(fx), wx = fx - x0;
      for (let c = 0; c < 4; c++) {
        const a = src[(y0 * sw + x0) * 4 + c], b = src[(y0 * sw + x0 + 1) * 4 + c];
        const d = src[((y0 + 1) * sw + x0) * 4 + c], e = src[((y0 + 1) * sw + x0 + 1) * 4 + c];
        out[(y * dw + x) * 4 + c] = (a * (1 - wx) + b * wx) * (1 - wy) + (d * (1 - wx) + e * wx) * wy;
      }
    }
  }
  return out;
}

// Mirrors a rendered region left to right, in place.
function flipRows(rgba, w, h) {
  for (let y = 0; y < h; y++) {
    for (let a = y * w * 4, b = (y * w + w - 1) * 4; a < b; a += 4, b -= 4) {
      for (let c = 0; c < 4; c++) { const t = rgba[a + c]; rgba[a + c] = rgba[b + c]; rgba[b + c] = t; }
    }
  }
  return rgba;
}

// Returns per-serve outcomes plus calibration info for one configuration.
// mirror: the whole picture is flipped left to right before the pipeline
// sees it, which is exactly the view of the other (ad) service box from the
// mirrored camera position.
export function runConfig(cfg, { fps, n, seed = 11, clickSigma = 1.0, exposure = 1 / 1000, W = 1280, H = 720, hfov = 66, serves, jitter = 0, drop = 0, snap = false, tail = 1.0, idle = 2.6, court = 'blue', noise = 2.5, shake = 0, staticBalls = 0, mirror = false, settings = {}, onFrame = null } = {}) {
  const cam = makeCamera({ pos: cfg.pos, target: cfg.target || TARGET, W, H, hfov });
  setCourt(court);
  const bg = renderBackground(cam);
  setCourt('blue');
  const fr = new FrameRenderer(cam, bg, { seed: seed + 1, noise });
  if (staticBalls) {
    // balls left lying around the far court, as during serve practice
    const rb = rng(seed + 9);
    const pts = [];
    for (let i = 0; i < staticBalls; i++) pts.push([...boxToWorld(rb.range(-3.5, 6.0), rb.range(1.0, 10.5)), BALL_R]);
    fr.bakeBalls(pts);
  }
  const rs = rng(seed + 7);
  const r = rng(seed + 2);
  const rj = rng(seed + 5);
  // what the pipeline is shown: the region as rendered, or its mirror image
  const view = (roi, pos, shift) => (mirror
    ? flipRows(fr.render({ ...roi, x: W - roi.x - roi.w }, pos, shift ? [-shift[0], shift[1]] : null), roi.w, roi.h)
    : fr.render(roi, pos, shift));
  const truePts = CORNERS.map((c) => {
    const [X, Y] = boxToWorld(c.uv[0], c.uv[1]);
    const [x, y] = cam.project([X, Y, 0]);
    return [mirror ? W - x : x, y];
  });
  const inView = truePts.every(([x, y]) => x >= 0 && x <= W && y >= 0 && y <= H);
  let clicks = truePts.map(([x, y]) => [x + r.gauss() * clickSigma, y + r.gauss() * clickSigma]);
  let snapInfo = null;
  if (snap) {
    const img = { data: view({ x: 0, y: 0, w: W, h: H }, [], null), width: W, height: H };
    snapInfo = snapCorners(img, clicks);
    clicks = snapInfo.pts;
  }
  const pipe = new Pipeline(settings);
  const calib = pipe.setCalibration(clicks, W, H);
  const roi = calib.roi;
  serves = serves || makeServes(n, seed + 3);
  const results = [];
  const falseEvents = [];
  let unsureOk = 0, silent = 0;
  // One continuous frame stream, as from a real camera. Each serve gets a
  // slot of random length; its bounce happens LEAD seconds into the slot.
  // Between serves the server needs a few seconds for the next ball; of that
  // idle time only a frame every half second is processed (to the pipeline
  // the rest look like dropped frames), which keeps the runs short.
  const LEAD = 0.55;
  const dtf = 1 / fps;
  const phase0 = r() * dtf;
  const stride = Math.max(1, Math.floor(0.45 / dtf));
  let slotStart = 0.5, k = 0;
  serves.forEach((s, i) => {
    const tc = s.traj.contact.t;
    // `tail` seconds of video follow the bounce (longer to include a second bounce)
    const slotEnd = slotStart + LEAD + tail + r() * 0.3;
    const idleEnd = slotEnd + idle;
    const tBounce = slotStart + LEAD;
    const got = [];
    let idleFrames = 0;
    for (let tg = k * dtf + phase0; tg < idleEnd; tg = ++k * dtf + phase0) {
      const tl = tg - slotStart + (tc - LEAD);
      if (tg >= slotEnd) { if (idleFrames++ % stride) continue; } else if (drop && rj() < drop) { if (onFrame) onFrame({ i, tg, tl, tc, dropped: true }); continue; }
      const pos = exposurePositions(s.traj, tl, exposure);
      const rgbaFull = view(roi, pos, shake ? [rs.gauss() * shake, rs.gauss() * shake] : null);
      const rgba = resample(rgbaFull, roi.w, roi.h, roi.outW, roi.outH);
      const { events, cands } = pipe.process(tg + (jitter ? rj.gauss() * jitter : 0), rgba, roi.outW, roi.outH);
      for (const e of events) got.push(e);
      if (onFrame) onFrame({ i, tg, tl, tc, cam, pos, cands, events, traj: s.traj });
    }
    let match = null, unsure = 0;
    for (const e of got) {
      if (e.type === 'unsure') unsure++;
      else if (Math.abs(e.t - tBounce) < 0.15 && !match) match = e;
      else falseEvents.push({ serve: i, e });
    }
    // "unsure" is right when the serve was not judged, wrong when it was.
    if (match && unsure) falseEvents.push({ serve: i, e: { type: 'unsure' } });
    if (!match && unsure) unsureOk++;
    if (!match && !unsure) silent++;
    // Truth: the ball is in when its contact mark touches the box.
    const gap = markGap(s.traj.contact);
    const truth = { in: gap <= 0, gap };
    results.push({ i, u: s.u, v: s.v, truth, match });
    slotStart = idleEnd;
  });
  return { cam, calib, inView, results, falseEvents, snapInfo, unsureOk, silent };
}

function pct(a, p) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
}

export function summarize(res) {
  const det = res.results.filter((r) => r.match);
  const eu = det.map((r) => r.match.court.u - r.u), ev = det.map((r) => r.match.court.v - r.v);
  const err = det.map((r, k) => Math.hypot(eu[k], ev[k]));
  const rawErr = det.map((r) => Math.hypot(r.match.flat.u - r.u, r.match.flat.v - r.v));
  const n3d = det.filter((r) => r.match.method === '3d').length;
  const gapErr = det.map((r) => Math.abs(r.match.call.gap - r.truth.gap));
  const gapBias = det.map((r) => r.match.call.gap - r.truth.gap);
  const correct = det.filter((r) => r.match.call.in === r.truth.in);
  const close = det.filter((r) => Math.abs(r.truth.gap) < 0.10);
  const closeOk = close.filter((r) => r.match.call.in === r.truth.in);
  const clear = det.filter((r) => Math.abs(r.truth.gap) >= 0.10);
  const clearOk = clear.filter((r) => r.match.call.in === r.truth.in);
  return {
    n: res.results.length,
    detected: det.length,
    unsureOk: res.unsureOk,
    silent: res.silent,
    falseEvents: res.falseEvents.length,
    errMedian: pct(err, 0.5),
    err90: pct(err, 0.9),
    rawMedian: pct(rawErr, 0.5),
    raw90: pct(rawErr, 0.9),
    n3d,
    gapMedian: pct(gapErr, 0.5),
    gap90: pct(gapErr, 0.9),
    gapBias: gapBias.reduce((a, b) => a + b, 0) / (gapBias.length || 1),
    biasU: eu.reduce((a, b) => a + b, 0) / (eu.length || 1),
    biasV: ev.reduce((a, b) => a + b, 0) / (ev.length || 1),
    callAcc: correct.length / (det.length || 1),
    clearAcc: clearOk.length / (clear.length || 1),
    clearN: clear.length,
    closeAcc: closeOk.length / (close.length || 1),
    closeN: close.length,
  };
}

const cm = (m) => (Number.isFinite(m) ? `${(m * 100).toFixed(1)}cm` : '-');
const p100 = (x) => `${Math.round(x * 100)}%`;

async function main() {
  const quick = flag('--quick');
  const only = opt('--only', null);
  const fpsList = opt('--fps', null) ? [Number(opt('--fps'))] : [30, 60];
  const n = Number(opt('--n', quick ? 10 : 40));
  const keys = only ? only.split(',') : quick ? ['A25'] : Object.keys(CONFIGS);
  const exposure = 1 / Number(opt('--shutter', 1000));
  const clickSigma = Number(opt('--click', 1.0));
  const jitter = Number(opt('--jitter', 0)) / 1000;
  const drop = Number(opt('--drop', 0));
  const snap = flag('--snap');
  // model checks: the simulated ball differs from what the app assumes
  const tauc = opt('--tauc', null); // contact time in ms, fixed (default: 3.5-5.5 at random)
  const drag = Number(opt('--drag', 1)); // air drag relative to the app's value
  const mirror = flag('--mirror'); // the other (ad) service box
  const court = opt('--court', 'blue');
  const seed = Number(opt('--seed', 11));
  console.log(`serves per run: ${n}, shutter 1/${Math.round(1 / exposure)}s, click noise ${clickSigma}px, time jitter ${jitter * 1000}ms, dropped frames ${drop * 100}%${snap ? ', line snapping on' : ''}` +
    `${tauc ? `, contact time ${tauc}ms` : ''}${drag !== 1 ? `, drag x${drag}` : ''}${mirror ? ', mirrored (ad court)' : ''}${court !== 'blue' ? `, ${court} court` : ''}\n`);
  setDragScale(drag);
  const serves = makeServes(n, seed + 3, tauc ? { tauC: [Number(tauc) / 1000, Number(tauc) / 1000] } : {});
  setDragScale(1);
  const rows = [];
  for (const key of keys) {
    const cfg = CONFIGS[key];
    for (const fps of fpsList) {
      const t0 = Date.now();
      const res = runConfig(cfg, { fps, n, seed, serves, exposure, clickSigma, jitter, drop, snap, mirror, court });
      const s = summarize(res);
      const c = res.calib;
      rows.push({ key, fps, s });
      console.log(
        `${key.padEnd(6)} ${String(fps).padStart(2)}fps | 검출 ${s.detected}/${s.n} (놓쳤다고 알림 ${s.unsureOk}, 무반응 ${s.silent}) 오검출 ${s.falseEvents} | ` +
        `위치 오차 중앙 ${cm(s.errMedian)} 90% ${cm(s.err90)} (2D만: ${cm(s.rawMedian)}/${cm(s.raw90)}, 3D 채택 ${s.n3d}) 편향 u ${cm(s.biasU)} v ${cm(s.biasV)} | ` +
        `라인까지 거리 오차 중앙 ${cm(s.gapMedian)} 90% ${cm(s.gap90)} 편향 ${cm(s.gapBias)} | ` +
        `판정 ${p100(s.callAcc)} (확실한 공 ${p100(s.clearAcc)}/${s.clearN}, 라인 10cm 이내 ${p100(s.closeAcc)}/${s.closeN}) | ` +
        `f ${c.f.toFixed(0)}/${res.cam.f.toFixed(0)} 높이 ${c.cam.height.toFixed(2)}m${c.cam.estimated ? '' : '(가정)'} ROI ${c.roi.w}x${c.roi.h}@${c.roi.scale.toFixed(2)}` +
        `${res.inView ? '' : ' [코너가 화면 밖]'} ${((Date.now() - t0) / 1000).toFixed(0)}s`,
      );
    }
  }
  if (quick) {
    const bad = rows.filter((r) => r.s.detected < r.s.n * 0.8 || r.s.clearAcc < 0.95 || r.s.falseEvents > 0 || Math.abs(r.s.gapBias) > 0.03);
    if (bad.length) {
      console.error('\nQUICK ACCURACY CHECK FAILED');
      process.exit(1);
    }
    console.log('\nquick accuracy check passed');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
