// What gets announced, with ideal detections: node test/events.js
//
// The detector is replaced by the ball's projected position plus a little
// pixel noise, so hundreds of serves run in seconds. This checks the event
// logic (one call per serve, "not judged" instead of silence, nothing for a
// net ball), not how well the ball is found in a picture.

import { Pipeline } from '../src/pipeline.js';
import { CORNERS } from '../src/court.js';
import { makeCamera, boxToWorld, worldToBox, rng, ballAt, markGap, aimServe, flyOn, NET_Y, BALL_R } from './sim.js';
import { makeServes, CONFIGS } from './accuracy.js';

const TARGET = [-2.05, 15.6, 0.3];
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
};

// hide: [from, to] seconds relative to the bounce during which the ball is not detected.
// pmiss: chance that any single detection is missing.
function run({ cfg = 'A25', fps = 30, seed = 21, serves, sigma = 0.25, pmiss = 0, tail = 1.0, idle = 2.8, hide = null }) {
  const W = 1280, H = 720;
  const cam = makeCamera({ pos: CONFIGS[cfg].pos, target: TARGET, W, H, hfov: 66 });
  const pts = CORNERS.map((c) => {
    const [X, Y] = boxToWorld(c.uv[0], c.uv[1]);
    return cam.project([X, Y, 0]).slice(0, 2);
  });
  const pipe = new Pipeline();
  const roi = pipe.setCalibration(pts, W, H).roi;
  let cur = [];
  pipe.detector.process = () => cur;
  const r = rng(seed), rm = rng(seed + 1), rn = rng(seed + 2);
  const dt = 1 / fps, LEAD = 0.55;
  const sx = roi.w / roi.outW, sy = roi.h / roi.outH;
  let k = 0, slotStart = 0.5;
  const out = { n: serves.length, called: 0, wrong: 0, unsure: 0, silent: 0, both: 0, extra: 0, late: 0 };
  for (const s of serves) {
    const tc = s.traj.contact.t, T = s.traj.T;
    const tB = slotStart + LEAD, slotEnd = tB + tail + r() * 0.3, end = slotEnd + idle;
    const got = [];
    for (let tg = k * dt; tg < end; tg = ++k * dt) {
      cur = [];
      const tl = tg - slotStart + (tc - LEAD);
      const hidden = hide && tg - tB > hide[0] && tg - tB < hide[1];
      if (tg < slotEnd && tl >= T[0] && tl <= T[T.length - 1] && !hidden && !(pmiss && rm() < pmiss)) {
        const q = cam.project(ballAt(s.traj, tl));
        if (q && q[0] > roi.x && q[0] < roi.x + roi.w && q[1] > roi.y && q[1] < roi.y + roi.h) {
          cur = [{ x: (q[0] + rn.gauss() * sigma - roi.x) / sx, y: (q[1] + rn.gauss() * sigma - roi.y) / sy, area: 12, w: 4, h: 4, weight: 600 }];
        }
      }
      for (const e of pipe.process(tg, null, roi.outW, roi.outH, { trusted: true }).events) got.push({ e, at: tg });
    }
    const calls = got.filter((x) => x.e.type === 'bounce');
    const call = calls.find((x) => Math.abs(x.e.t - tB) < 0.15);
    const unsure = got.filter((x) => x.e.type === 'unsure');
    out.extra += calls.length - (call ? 1 : 0);
    const gap = markGap(s.traj.contact);
    if (call) {
      out.called++;
      if (call.e.call.in !== (gap <= 0) && Math.abs(gap) > 0.1) out.wrong++;
      if (unsure.length) out.both++;
    } else if (unsure.length) {
      out.unsure++;
      out.late = Math.max(out.late, unsure[0].at - tB);
    } else out.silent++;
    slotStart = end;
  }
  return out;
}

const show = (o) => `called ${o.called}/${o.n}, clear balls wrong ${o.wrong}, "not judged" ${o.unsure}, silent ${o.silent}, call and "not judged" ${o.both}, extra calls ${o.extra}`;

const serves = makeServes(80, 24);
const slow = makeServes(40, 31, { speed: [14, 19], tMax: 3.6 }); // flown on through the second bounce
// stopped by the net, and stopped by it and dropping straight down
const cutAtNet = (s) => s.traj.P.findIndex((p) => p[1] >= NET_Y - 0.05);
const netted = serves.map((s) => {
  const k = cutAtNet(s);
  return { ...s, traj: { T: s.traj.T.slice(0, k), P: s.traj.P.slice(0, k), contact: s.traj.contact } };
});
const dropped = serves.map((s) => {
  const k = cutAtNet(s);
  const T = s.traj.T.slice(0, k), P = s.traj.P.slice(0, k);
  const p0 = P[k - 1], t0 = T[k - 1];
  for (let t = 0.002; t < 1; t += 0.002) {
    const z = p0[2] - 4.905 * t * t;
    if (z < BALL_R) break;
    T.push(t0 + t);
    P.push([p0[0], p0[1] - 0.05 - 0.3 * t, z]);
  }
  return { ...s, traj: { T, P, contact: s.traj.contact } };
});

// 1. every ordinary serve gets exactly one call
for (const c of [{}, { fps: 60 }, { cfg: 'SIDE16', fps: 60 }, { cfg: 'A16', fps: 60, sigma: 0.5 }, { cfg: 'CENTER' }]) {
  const o = run({ serves, ...c });
  check(`one call per serve ${JSON.stringify(c)}`, o.called === o.n && o.wrong === 0 && o.unsure === 0 && o.extra === 0, show(o));
}

// 2. slow serves whose second bounce stays in view, with the ball lost for a
// while after the first bounce: still one call, and no "not judged" after it
for (const c of [{ tail: 2.5 }, { tail: 2.5, hide: [0.2, 0.5] }, { tail: 2.5, hide: [0.3, 0.8] }, { tail: 2.5, hide: [0.15, 0.4], cfg: 'SIDE16', fps: 60 }]) {
  const o = run({ serves: slow, ...c });
  check(`slow serve, second bounce in view ${JSON.stringify(c)}`, o.called === o.n && o.wrong === 0 && o.both === 0 && o.extra === 0, show(o));
}

// ... and with the first bounce out of sight altogether, the second bounce
// must not be called as the landing
for (const c of [{ tail: 2.5, hide: [-0.13, 0.13] }, { tail: 2.5, hide: [-0.13, 0.13], cfg: 'SIDE16', fps: 60 }, { tail: 2.5, hide: [-0.3, 0.2], cfg: 'CENTER' }]) {
  const o = run({ serves: slow, ...c });
  check(`slow serve, first bounce out of sight ${JSON.stringify(c)}`, o.called === 0 && o.extra === 0, show(o));
}

// 3. the ball is not detected for three frames around the bounce: the spot
// cannot be given, so the serve is announced as not judged, and soon
for (const c of [{ hide: [-0.05, 0.05] }, { hide: [-0.05, 0.05], fps: 60 }, { hide: [-0.05, 0.05], cfg: 'SIDE16' }, { hide: [0.03, 0.4] }]) {
  const o = run({ serves, ...c });
  check(`bounce out of sight ${JSON.stringify(c)}`, o.called === 0 && o.unsure === o.n && o.extra === 0 && o.late < 0.6, `${show(o)}, latest after ${o.late.toFixed(2)} s`);
}

// 4. detections missing at random: fewer calls, but hardly ever silence
for (const c of [{ pmiss: 0.15 }, { pmiss: 0.15, cfg: 'A16', fps: 60 }, { pmiss: 0.15, cfg: 'SIDE16' }]) {
  const o = run({ serves, ...c });
  check(`15 % of detections missing ${JSON.stringify(c)}`, o.silent <= 1 && o.wrong === 0 && o.both === 0 && o.extra === 0 && o.called >= 0.75 * o.n, show(o));
}

// 5. serves that end at the net say nothing
for (const [name, set] of [['stopped by the net', netted], ['dropping at the net', dropped]]) {
  for (const c of [{}, { cfg: 'SIDE16', fps: 60 }, { cfg: 'A16', fps: 60, sigma: 0.5 }]) {
    const o = run({ serves: set, ...c });
    check(`${name} ${JSON.stringify(c)}`, o.silent === o.n && o.extra === 0, show(o));
  }
}

// ---------------------------------------------------------------------------
// Scenes: several balls at once, each flown on realistically (later bounces,
// rolling, coming back from the back fence).

// balls: [{ traj, t0, hide?: (seconds into the flight) => boolean }]
function scene({ cfg = 'A25', fps = 30, sigma = 0.5, pmiss = 0, seed = 5, balls, tEnd }) {
  const W = 1280, H = 720;
  const cam = makeCamera({ pos: CONFIGS[cfg].pos, target: TARGET, W, H, hfov: 66 });
  const pts = CORNERS.map((c) => {
    const [X, Y] = boxToWorld(c.uv[0], c.uv[1]);
    return cam.project([X, Y, 0]).slice(0, 2);
  });
  const pipe = new Pipeline();
  const roi = pipe.setCalibration(pts, W, H).roi;
  let cur = [];
  pipe.detector.process = () => cur;
  const rm = rng(seed + 1), rn = rng(seed + 2);
  const dt = 1 / fps, sx = roi.w / roi.outW, sy = roi.h / roi.outH;
  const ev = [];
  for (let k = 0; k * dt < tEnd; k++) {
    const tg = k * dt;
    cur = [];
    for (const b of balls) {
      const tl = tg - b.t0, T = b.traj.T;
      if (tl < T[0] || tl > T[T.length - 1]) continue;
      if (b.hide && b.hide(tl)) continue;
      if (pmiss && rm() < pmiss) continue;
      const q = cam.project(ballAt(b.traj, tl));
      if (q && q[0] > roi.x && q[0] < roi.x + roi.w && q[1] > roi.y && q[1] < roi.y + roi.h) {
        cur.push({ x: (q[0] + rn.gauss() * sigma - roi.x) / sx, y: (q[1] + rn.gauss() * sigma - roi.y) / sy, area: 12, w: 4, h: 4, weight: 600 });
      }
    }
    for (const e of pipe.process(tg, null, roi.outW, roi.outH, { trusted: true }).events) {
      ev.push({ type: e.type, t: e.t, at: tg, u: e.court?.u, v: e.court?.v, in: e.call?.in });
    }
  }
  return ev;
}

// Serves with a long flight. kind: where they land and how they are hit.
const KINDS = {
  normal: (r) => ({ z: r.range(2.3, 2.75), u: r.range(0.2, 3.9), v: r.range(2.5, 6.3), speed: r.range(14, 50), spin: r.range(0, 20) }),
  flat: (r) => ({ z: r.range(2.7, 3.0), u: r.range(0.3, 3.8), v: r.range(5.2, 6.8), speed: r.range(42, 52), spin: r.range(0, 3) }),
  kick: (r) => ({ z: r.range(2.3, 2.75), u: r.range(0.3, 3.8), v: r.range(3, 6.3), speed: r.range(30, 45), spin: 20 }),
  lob: (r) => ({ z: r.range(0.8, 1.0), u: r.range(0.3, 3.8), v: r.range(2, 6.5), speed: r.range(12.5, 17), spin: r.range(0, 5) }),
  short: (r) => ({ z: r() < 0.5 ? r.range(0.8, 1.0) : r.range(2.4, 2.8), u: r.range(0.3, 3.8), v: r.range(0.6, 1.4), speed: r.range(11.5, 16), spin: r.range(0, 6) }),
};
function longServes(kind, n, seed) {
  const r = rng(seed), out = [];
  for (let guard = 0; out.length < n && guard < 40 * n; guard++) {
    const q = KINDS[kind](r);
    const start = [r.range(0.4, 1.1), r.range(-0.2, 0.3), q.z];
    const e = r.range(0.7, 0.86), mu = r.range(0.55, 0.75), eFence = r.range(0.15, 0.45);
    const [X, Y] = boxToWorld(q.u, q.v);
    const aim = aimServe({ start, X, Y, speed: q.speed, spin: q.spin, e, mu, tauC: 0 });
    if (!aim || aim.netClear < 0.02) continue;
    const traj = flyOn(start, aim.launch, { spin: q.spin, e, mu, eFence, tMax: 6.5 });
    if (!traj.bounces.length || traj.bounces[0].Y < NET_Y + 0.1) continue;
    const [u, v] = worldToBox(traj.bounces[0].X, traj.bounces[0].Y);
    out.push({ traj, u, v, tb: traj.bounces[0].t });
  }
  return out;
}

// One serve every `gap` seconds; what was announced for each?
function tally(serves, ev, gap) {
  const o = { n: serves.length, ok: 0, wrong: 0, late: 0, far: 0, unsure: 0, silent: 0, both: 0, many: 0 };
  serves.forEach((s, i) => {
    const mine = ev.filter((x) => x.at >= s.t0 && x.at < s.t0 + gap);
    const calls = mine.filter((x) => x.type === 'bounce'), unsure = mine.filter((x) => x.type === 'unsure');
    const onTime = calls.filter((c) => Math.abs(c.t - (s.t0 + s.tb)) < 0.12);
    const good = onTime.filter((c) => Math.hypot(c.u - s.u, c.v - s.v) < 0.5).length;
    if (calls.length > good) o.wrong++;
    if (calls.length > onTime.length) o.late++; // another bounce than the first was called
    else if (calls.length === 1 && !good) o.far++; // the first bounce, but the spot more than 0.5 m off
    if (calls.length + unsure.length > 1) o.many++;
    if (good && unsure.length) o.both++;
    if (good === 1 && calls.length === 1 && !unsure.length) o.ok++;
    else if (!calls.length && unsure.length) o.unsure++;
    else if (!calls.length) o.silent++;
  });
  return o;
}
const show2 = (o) => `one correct call ${o.ok}/${o.n}, call at a wrong time or place ${o.wrong} (of which another bounce ${o.late}, spot over 0.5 m off ${o.far}), "not judged" ${o.unsure}, silent ${o.silent}, more than one announcement ${o.many}`;
const spaced = (list, gap) => list.map((s, i) => ({ ...s, t0: 0.5 + i * gap }));

// 6. each serve flies on, bounces again, hits the back fence and comes
// hopping back: one call, at the first bounce, and nothing else -- also
// at a fast practice pace, with the previous ball still in view
for (const kind of ['normal', 'flat', 'kick', 'lob']) {
  const list = longServes(kind, 24, 77);
  for (const [cfg, gap] of [['A25', 7], ['SIDE16', 7], ['CENTER', 3.3], ['A16', 4]]) {
    const serves = spaced(list, gap);
    const o = tally(serves, scene({ cfg, balls: serves, tEnd: 0.5 + serves.length * gap + 4 }), gap);
    check(`${kind} serves flown on, ${cfg}, one every ${gap} s`, o.ok === o.n && o.wrong === 0 && o.many === 0, show2(o));
  }
}

// 7. a fast pace and the ball out of sight right after it bounced: every
// serve is still announced as not judged (the previous ball must not make
// the next one count as "the same ball")
{
  const list = longServes('normal', 24, 78);
  for (const [cfg, gap] of [['A25', 3.3], ['SIDE16', 3.3], ['CENTER', 6]]) {
    const serves = spaced(list, gap).map((s) => ({ ...s, hide: (tl) => tl > s.tb + 0.03 && tl < s.tb + 0.4 }));
    const o = tally(serves, scene({ cfg, balls: serves, tEnd: 0.5 + serves.length * gap + 3 }), gap);
    check(`ball lost right after the bounce, ${cfg}, one serve every ${gap} s`, o.unsure === o.n && o.wrong === 0 && o.many === 0, show2(o));
  }
}

// 8. balls that are no serves: nothing may be called, and "not judged"
// should stay rare
{
  const r = rng(91);
  const W3 = (u, v, z) => [...boxToWorld(u, v), z];
  const makers = {
    // only the way back from the fence is seen (the serve itself was not)
    'coming back from the fence': () => {
      const s = longServes('normal', 1, 100 + Math.floor(r() * 1e6))[0];
      return { traj: s.traj, hide: (tl) => tl < s.tb + 2.2 };
    },
    'rolling across the box': () => {
      const a = r.range(0, 6.28), sp = r.range(2, 6);
      return { traj: flyOn(W3(r.range(0, 4), r.range(1, 6), 0.04), [sp * Math.cos(a), sp * Math.sin(a), 0], { tMax: 3 }) };
    },
    'fed back low from the baseline': () => ({ traj: flyOn(W3(r.range(0, 4), r.range(10, 11.5), r.range(0.5, 1.0)), [r.range(-1, 1), -r.range(5, 10), r.range(0, 2)], { tMax: 4 }) }),
    'hopping across from the next court': () => {
      const side = r() < 0.5 ? 1 : -1, sp = r.range(4, 9);
      return { traj: flyOn(W3(2 - side * 7, r.range(2, 7), r.range(0.3, 1.0)), [side * sp * -1, r.range(-1, 1), r.range(0, 2.5)].map((x, i) => (i === 0 ? -x : x)), { tMax: 4 }) };
    },
  };
  for (const [name, make] of Object.entries(makers)) {
    for (const cfg of ['A25', 'SIDE16']) {
      const balls = [];
      for (let i = 0; i < 30; i++) balls.push({ ...make(), t0: 0.5 + i * 7 });
      const ev = scene({ cfg, balls, tEnd: 0.5 + balls.length * 7 });
      const calls = ev.filter((x) => x.type === 'bounce').length, unsure = ev.filter((x) => x.type === 'unsure').length;
      check(`a ball ${name}, ${cfg}`, calls === 0 && unsure <= 3, `called ${calls}, "not judged" ${unsure}, of ${balls.length}`);
    }
  }
}

// 9. another ball rolls through the landing spot just as the serve lands:
// the call must still be the serve's
{
  const list = longServes('normal', 30, 79);
  for (const cfg of ['A25', 'SIDE16', 'CENTER']) {
    const r = rng(42);
    const serves = spaced(list, 6.5);
    const others = serves.map((s) => {
      const sp = r.range(2, 6), a = r.range(0, 6.28), T = r.range(0.3, 1.0);
      const [X, Y] = boxToWorld(s.u, s.v);
      const traj = flyOn([X - sp * T * Math.cos(a) + r.range(-0.5, 0.5), Y - sp * T * Math.sin(a) + r.range(-0.5, 0.5), 0.04], [sp * Math.cos(a), sp * Math.sin(a), 0], { tMax: 3 });
      return { traj, t0: s.t0 + s.tb - T };
    });
    const o = tally(serves, scene({ cfg, balls: [...serves, ...others], tEnd: 0.5 + serves.length * 6.5 }), 6.5);
    check(`a ball rolling through the landing spot, ${cfg}`, o.wrong === 0 && o.ok >= o.n - 3, show2(o));
  }
}

// 10. serves that drop just past the net and hop on through the box: the
// second bounce, in the middle of the box, must never be called
{
  const list = longServes('short', 30, 80);
  for (const [cfg, sigma] of [['A25', 0.5], ['FENCE', 1], ['SIDE16', 1]]) {
    const serves = spaced(list, 7);
    const o = tally(serves, scene({ cfg, sigma, balls: serves, tEnd: 0.5 + serves.length * 7 }), 7);
    check(`serves landing just past the net, ${cfg}, ${sigma} px noise`, o.wrong === 0 && o.many === 0, show2(o));
  }
}

// 11. 60 frames a second must not be worse than 30 at telling a serve
{
  const list = longServes('lob', 30, 81);
  for (const cfg of ['FENCE', 'A16']) {
    const serves = spaced(list, 7);
    const o = tally(serves, scene({ cfg, fps: 60, sigma: 1, balls: serves, tEnd: 0.5 + serves.length * 7 }), 7);
    check(`slow underarm serves at 60 fps, 1 px noise, ${cfg}`, o.wrong === 0 && o.many === 0 && o.ok >= 0.8 * o.n, show2(o));
  }
}

// 12. 60 frames a second with noisy detections: the bounce test looks at the
// same stretch of flight as at 30 (not the same number of frames), and a
// ball picked up again shortly before a later bounce is not "proved" to come
// from beyond the net by a few frames of flight. (How far off the spot can
// be at this much noise from a far camera is for accuracy.js to measure;
// here it is the right bounce, announced once.)
{
  for (const kind of ['normal', 'flat']) {
    const list = longServes(kind, 24, 82);
    for (const cfg of ['FENCE', 'SIDE']) {
      const serves = spaced(list, 4);
      const o = tally(serves, scene({ cfg, fps: 60, sigma: 1.5, balls: serves, tEnd: 0.5 + serves.length * 4 + 4 }), 4);
      check(`${kind} serves at 60 fps, 1.5 px noise, ${cfg}`, o.late === 0 && o.many === 0 && o.ok + o.far >= o.n - 1, show2(o));
    }
  }
}

console.log(failed ? `\n${failed} event check(s) FAILED` : '\nall event checks passed');
process.exit(failed ? 1 : 0);
