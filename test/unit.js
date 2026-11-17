// Unit tests: node test/unit.js
import { homography, applyH, invert3, cameraFromHomography } from '../src/geometry.js';
import { judge, judgeMark, boxSignedDistance, phrase, BOX_W, BOX_L, BALL_R, CORNERS } from '../src/court.js';
import { bounceParams, contactMark } from '../src/bounce.js';
import { FrameClock, TimeSource } from '../src/timing.js';
import { Tracker } from '../src/tracker.js';
import { Pipeline } from '../src/pipeline.js';
import { arcBack } from '../src/refine.js';
import { makeCamera, boxToWorld, worldToBox, aimServe, ballAt, rng, NET_Y } from './sim.js';

let failed = 0, passed = 0;
function check(name, cond, detail = '') {
  if (cond) passed++;
  else { failed++; console.error(`✗ ${name} ${detail}`); }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// --- homography round trip
{
  const src = [[0, 0], [4, 0], [4, 6], [0, 6]];
  const dst = [[100, 400], [300, 380], [420, 520], [80, 560]];
  const H = homography(src, dst);
  src.forEach((p, i) => {
    const q = applyH(H, ...p);
    check('homography maps corner', near(q[0], dst[i][0], 1e-6) && near(q[1], dst[i][1], 1e-6), JSON.stringify(q));
  });
  const Hi = invert3(H);
  const back = applyH(Hi, ...applyH(H, 1.3, 2.7));
  check('inverse homography', near(back[0], 1.3, 1e-9) && near(back[1], 2.7, 1e-9));
}

// --- camera recovery from a box homography (sim camera, exact corners)
for (const [pos, label] of [[[6.5, 25.3, 2.5], 'corner 2.5m'], [[7.5, 18.3, 1.6], 'side 1.6m'], [[0, 26, 3], 'centre 3m']]) {
  const cam = makeCamera({ pos, target: [-2.05, 15.6, 0.3], W: 1280, H: 720, hfov: 66 });
  const img = CORNERS.map((c) => cam.project([...boxToWorld(...c.uv), 0]).slice(0, 2));
  const H = homography(CORNERS.map((c) => c.uv), img);
  const c = cameraFromHomography(H, 1280, 720);
  check(`focal length ${label}`, c.estimated && near(c.f, cam.f, cam.f * 0.01), `${c.f} vs ${cam.f}`);
  check(`camera height ${label}`, near(c.height, pos[2], 0.05), `${c.height}`);
  // projecting a raised point matches the sim camera
  const [X, Y] = boxToWorld(2, 3);
  const a = cam.project([X, Y, 1.2]), b = c.project(2, 3, 1.2);
  check(`3D projection ${label}`, near(a[0], b[0], 0.5) && near(a[1], b[1], 0.5), `${a} vs ${b}`);
  const d = c.ray(b[0], b[1]);
  const along = [c.C[0] + d[0] * 5, c.C[1] + d[1] * 5, c.C[2] + d[2] * 5];
  const p2 = c.project(along[0], along[1], along[2]);
  check(`ray reprojects ${label}`, near(p2[0], b[0], 1e-6) && near(p2[1], b[1], 1e-6));
}

// --- ad court: the same named corners on the other box reverse the winding
{
  const adToWorld = (u, v) => [u - 0.025, NET_Y + v];
  for (const [pos, label] of [[[-6.5, 25.3, 2.5], 'ad corner 2.5m'], [[-7.5, 18.3, 1.6], 'ad side 1.6m']]) {
    const cam = makeCamera({ pos, target: [2.05, 15.6, 0.3], W: 1280, H: 720, hfov: 66 });
    const img = CORNERS.map((c) => cam.project([...adToWorld(...c.uv), 0]).slice(0, 2));
    const pipe = new Pipeline();
    const cal = pipe.setCalibration(img, 1280, 720);
    check(`camera height ${label}`, near(cal.cam.height, pos[2], 0.05), `${cal.cam.height}`);
    check(`camera position ${label}`, near(cal.cam.C[0], pos[0] + 0.025, 0.1) && near(cal.cam.C[1], pos[1] - NET_Y, 0.1), `${cal.cam.C}`);
    // a ball centre 2 cm above the court maps back to the point below it
    let worst = 0;
    for (const [u, v] of [[0.5, 6.3], [3.9, 6.5], [4.2, 2.0], [-0.1, 5.0]]) {
      const q = cam.project([...adToWorld(u, v), 0.02]);
      const c = pipe.imageToCourt(q[0], q[1], 0.02);
      worst = Math.max(worst, Math.hypot(c.u - u, c.v - v));
    }
    check(`ball-height correction ${label}`, worst < 0.005, `${(worst * 100).toFixed(2)}cm`);
    // raised point through the recovered camera
    const a = cam.project([...adToWorld(2, 3), 1.2]), b = cal.cam.project(2, 3, 1.2);
    check(`3D projection ${label}`, near(a[0], b[0], 0.5) && near(a[1], b[1], 0.5), `${a} vs ${b}`);
  }
}

// --- judging a landing point
{
  check('centre of box is in', judge(2, 3).in);
  check('touching service line is in', judge(2, BOX_L + 0.015).in);
  check('5 cm long is out', !judge(2, BOX_L + 0.05).in && judge(2, BOX_L + 0.05).dir === 'long');
  check('wide is out', judge(BOX_W + 0.3, 3).dir === 'wide');
  check('wrong box is centre', judge(-0.3, 3).dir === 'center');
  check('near flag', judge(2, BOX_L - 0.03).near && !judge(2, 3).near);
  check('signed distance inside', near(boxSignedDistance(2, 3), -2, 1e-9));
  check('signed distance at a corner is Euclidean', near(boxSignedDistance(BOX_W + 0.03, BOX_L + 0.04), 0.05, 1e-9));
  check('phrase in', phrase(judge(2, 3)) === '인');
  check('phrase near in', phrase(judge(2, BOX_L - 0.03)) === '인. 라인 근처');
  check('phrase long', phrase(judge(2, BOX_L + 0.325)) === '아웃. 길게 30센티', phrase(judge(2, BOX_L + 0.325)));
  check('phrase metres', phrase(judge(BOX_W + 1.325, 3)) === '아웃. 옆으로 1미터 30', phrase(judge(BOX_W + 1.325, 3)));
}

// --- bounce contact model and mark
{
  const v1 = [-3, 30, -7], v2 = [-2, 20, 5.25];
  const b = bounceParams(v1, v2);
  check('restitution from velocities', near(b.e, 0.75, 1e-9));
  check('vertex is below a resting ball', b.zVertex < BALL_R && near(b.zVertex, BALL_R - 7 * 0.0045 * 0.75 / 1.75, 1e-9), `${b.zVertex}`);
  const m = contactMark(2, 6.5, v1, v2);
  // first contact lies tau1 of incoming travel before the vertex
  check('mark starts before the vertex', near(m[0].v, 6.5 - 30 * b.tau1, 1e-9) && near(m[0].u, 2 + 3 * b.tau1, 1e-9));
  const len = Math.hypot(m[m.length - 1].u - m[0].u, m[m.length - 1].v - m[0].v);
  check('skid length is about 11 cm', len > 0.09 && len < 0.13, `${len}`);
  const aMax = Math.max(...m.map((d) => d.a));
  check('contact patch radius about 2 cm', aMax > 0.015 && aMax < 0.03, `${aMax}`);
  // A serve whose vertex is 5 cm past the service line still clipped the line
  // with the start of its mark; one 12 cm past did not.
  check('vertex 5 cm long but mark touches the line: in', judgeMark(contactMark(2, BOX_L + 0.05, v1, v2), { u: 2, v: BOX_L + 0.05 }).in);
  const out = judgeMark(contactMark(2, BOX_L + 0.12, v1, v2), { u: 2, v: BOX_L + 0.12 });
  check('vertex 12 cm long: out, long', !out.in && out.dir === 'long' && out.gap > 0.04 && out.gap < 0.08, JSON.stringify(out));
  // sideways the mark is only as wide as the contact patch
  check('3 cm wide of the sideline: out', !judgeMark(contactMark(BOX_W + 0.03, 4, [0, 30, -7], [0, 20, 5]), { u: 0, v: 0 }).in);
  check('1 cm wide of the sideline: in', judgeMark(contactMark(BOX_W + 0.01, 4, [0, 30, -7], [0, 20, 5]), { u: 0, v: 0 }).in);
}

// --- frame clock removes jitter and survives dropped frames (many seeds)
{
  // 1.5 ms input jitter at 60 fps with 10 % dropped frames.
  let worstFrac = 0, worstMean = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed);
    const clock = new FrameClock();
    let big = 0, n = 0, sum = 0;
    for (let k = 0; k < 900; k++) {
      if (k > 20 && r() < 0.1) continue; // dropped
      const tTrue = 100 + k / 60;
      const out = clock.map(tTrue + r.gauss() * 0.0015);
      if (out === null) continue;
      if (k > 200) {
        n++;
        const e = Math.abs(out - tTrue);
        sum += e;
        if (e > 0.001) big++;
      }
    }
    worstFrac = Math.max(worstFrac, big / n);
    worstMean = Math.max(worstMean, sum / n);
  }
  check('clock: under 3 % of frames off by more than 1 ms, for every seed', worstFrac < 0.03, `${(worstFrac * 100).toFixed(2)}%`);
  check('clock: mean error under 0.4 ms, for every seed', worstMean < 0.0004, `${(worstMean * 1000).toFixed(3)}ms`);
  const c2 = new FrameClock();
  for (let k = 0; k < 30; k++) c2.map(k / 30);
  const t = c2.map(30 / 30 + 5); // long gap: restart
  check('clock restarts after a gap', near(t, 6, 1e-9));
  // A camera that changes pace is followed, never stepped backwards.
  const c3 = new FrameClock();
  let tt = 10, worst3 = 0, prev = -Infinity, back = 0;
  for (let k = 0; k < 400; k++) {
    tt += k < 200 ? 1 / 30 : 1 / 24;
    const out = c3.map(tt);
    if (out <= prev) back++;
    prev = out;
    if (k > 240) worst3 = Math.max(worst3, Math.abs(out - tt));
  }
  check('clock follows a frame-rate change', worst3 < 0.0005 && back === 0, `${(worst3 * 1000).toFixed(2)}ms, backward ${back}`);
  // Accurate timestamps with a real alternating pace are left alone.
  const c4 = new FrameClock();
  let t4 = 5, worst4 = 0;
  for (let k = 0; k < 300; k++) {
    t4 += k % 2 ? 0.030 : 0.0367;
    const out = c4.map(t4);
    if (k > 80) worst4 = Math.max(worst4, Math.abs(out - t4));
  }
  check('clock leaves a truly uneven camera pace alone', worst4 < 0.0002, `${(worst4 * 1000).toFixed(2)}ms`);
}

// --- time source picks the steadier camera clock, never the display clock
{
  const r = rng(8);
  const ts = new TimeSource();
  let last = null, switches = 0;
  for (let k = 0; k < 200; k++) {
    const t = 5 + k / 60;
    // callback time looks perfectly regular (display-synced) but is not the capture time
    last = ts.pick([['media', 1000 + t + r.gauss() * 0.002], ['capture', t], ['now', 2000 + Math.round(t * 60) / 60]]);
    if (last.switched) switches++;
  }
  check('time source moves to the clean camera clock', last.source === 'capture' && last.trusted && switches === 1, JSON.stringify(last));
  const ts2 = new TimeSource();
  for (let k = 0; k < 200; k++) last = ts2.pick([['media', 0], ['capture', undefined], ['now', 7 + k / 30 + r.gauss() * 0.003]]);
  check('time source falls back to callback time, untrusted', last.source === 'now' && !last.trusted);
  const ts3 = new TimeSource();
  for (let k = 0; k < 200; k++) last = ts3.pick([['media', k / 30 + 0.001], ['capture', 9 + k / 30], ['now', 20 + Math.round(k / 30 * 60) / 60]]);
  check('time source keeps a clean first choice', last.source === 'media' && last.trusted);
  const ts4 = new TimeSource();
  for (let k = 0; k < 200; k++) last = ts4.pick([['media', 3 + k / 30 + r.gauss() * 0.002], ['capture', 9 + k / 30 + r.gauss() * 0.002], ['now', 20 + Math.round(k / 30 * 60) / 60]]);
  check('jittery camera clocks are used but not trusted', last.source !== 'now' && !last.trusted, JSON.stringify(last));
  // A minority of late frames, or rounding to whole milliseconds, must not pass for a steady clock.
  const ts5 = new TimeSource();
  for (let k = 0; k < 300; k++) last = ts5.pick([['media', 10 + k / 30 + (r() < 0.25 ? 0.008 : 0)], ['capture', undefined], ['now', 30 + k / 30]]);
  check('a clock that stamps one frame in four late is not trusted', last.source === 'media' && !last.trusted, JSON.stringify(last));
  const ts6 = new TimeSource();
  for (let k = 0; k < 300; k++) last = ts6.pick([['media', Math.round((10 + k / 30) * 1000) / 1000], ['capture', undefined], ['now', 30 + k / 30]]);
  check('a clock rounded to milliseconds is not trusted', last.source === 'media' && !last.trusted, JSON.stringify(last));
  // One frame without a value: the frame is skipped, the clock is kept.
  const ts7 = new TimeSource();
  let switches7 = 0, skips7 = 0;
  for (let k = 0; k < 1200; k++) {
    const p = ts7.pick([['media', k % 97 === 50 ? undefined : 10 + k / 30], ['capture', undefined], ['now', 30 + k / 30]]);
    if (p.switched) switches7++;
    if (p.skip) skips7++;
    last = p;
  }
  check('a missing timestamp skips one frame and keeps the clock', switches7 === 0 && skips7 === 12 && last.source === 'media', `${switches7} switches, ${skips7} skips`);
  // A clock that freezes is dropped quickly and taken back soon after it recovers.
  const ts8 = new TimeSource();
  let dropAt = -1, backAt = -1;
  for (let k = 0; k < 700; k++) {
    const frozen = k >= 100 && k < 400;
    const p = ts8.pick([['media', frozen ? 10 + 100 / 30 : 10 + k / 30], ['capture', undefined], ['now', 30 + k / 30]]);
    if (dropAt < 0 && p.source === 'now') dropAt = k;
    if (dropAt >= 0 && backAt < 0 && k >= 400 && p.source === 'media') backAt = k;
  }
  check('a frozen clock is given up after half a second and taken back within 2 s', dropAt >= 110 && dropAt <= 116 && backAt > 0 && backAt <= 460, `dropped at ${dropAt}, back at ${backAt}`);
  // ... but at once when another camera clock is working
  const ts9 = new TimeSource();
  let altAt = -1, last9 = null;
  for (let k = 0; k < 300; k++) {
    last9 = ts9.pick([['media', k >= 100 ? 10 + 100 / 30 : 10 + k / 30], ['capture', 20 + k / 30], ['now', 30 + k / 30]]);
    if (altAt < 0 && last9.source === 'capture') altAt = k;
  }
  check('a frozen clock is replaced by the other camera clock within 6 frames', altAt >= 100 && altAt <= 106 && last9.source === 'capture', `at ${altAt}, ends on ${last9.source}`);
}

// --- frame clock when the phone cannot keep up, and when the camera changes pace
{
  const r = rng(77);
  // every other frame processed, now and then one more or one less (2 ms jitter)
  const c5 = new FrameClock();
  let keep = 0, worst5 = 0, n5 = 0, big5 = 0;
  for (let k = 0; k < 3000; k++) {
    if (r() < 0.1) keep ^= 1;
    if (k % 2 !== keep) continue;
    const tTrue = 5 + k / 30;
    const out = c5.map(tTrue + r.gauss() * 0.002);
    if (k > 300) { n5++; const e = Math.abs(out - tTrue); worst5 = Math.max(worst5, e); if (e > 0.003) big5++; }
  }
  check('clock stays on the camera period when most frames are skipped', big5 / n5 < 0.02, `${(100 * big5 / n5).toFixed(1)}% over 3 ms, worst ${(worst5 * 1000).toFixed(1)}ms`);
  // all frames two periods apart at first: the stated camera rate gives the slot length
  const c6 = new FrameClock();
  c6.nominal = 1 / 60;
  let worst6 = 0;
  for (let k = 0; k < 400; k++) {
    if (k < 200 ? k % 2 : k % 2 === 0) continue; // even frames, then odd frames
    const tTrue = 9 + k / 60;
    const out = c6.map(tTrue + r.gauss() * 0.0008);
    if (k > 40) worst6 = Math.max(worst6, Math.abs(out - tTrue));
  }
  check('clock uses the stated camera rate for the slot length', near(c6.b, 1 / 60, 2e-4) && worst6 < 0.0015, `b ${(c6.b * 1000).toFixed(2)}ms, worst ${(worst6 * 1000).toFixed(2)}ms`);
  // 30 -> 25 fps with 2 ms jitter: off for a frame or two, raw timestamps
  // while the grid is rebuilt, accurate again within half a second
  const early7 = [];
  let late7 = 0, back7 = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const rr = rng(seed);
    const c7 = new FrameClock();
    let t = 5, worst = 0, prev = -Infinity;
    for (let k = 0; k < 340; k++) {
      t += k < 300 ? 1 / 30 : 0.040;
      const out = c7.map(t + rr.gauss() * 0.002);
      if (out === null) continue;
      if (out <= prev) back7++;
      prev = out;
      if (k >= 302 && k < 312) worst = Math.max(worst, Math.abs(out - t));
      if (k >= 312) late7 = Math.max(late7, Math.abs(out - t));
    }
    early7.push(worst);
  }
  early7.sort((p, q) => p - q);
  check('clock recovers from a frame-rate change', early7[20] < 0.0065 && early7[39] < 0.015 && late7 < 0.004 && back7 === 0,
    `frames 3-12: typically ${(early7[20] * 1000).toFixed(1)}ms, at worst ${(early7[39] * 1000).toFixed(1)}ms; later: ${(late7 * 1000).toFixed(1)}ms; steps back ${back7}`);
  // one frame in sixty stamped 13 ms late (30 fps) or 7 ms late (60 fps): it gets its slot's time
  for (const [fps, late] of [[30, 0.013], [60, 0.007]]) {
    const rr = rng(8);
    const c8 = new FrameClock();
    c8.nominal = 1 / fps;
    let worstLate = 0, worstOther = 0, restarts = 0, prev = -Infinity, back = 0;
    const r0 = c8._restart.bind(c8);
    c8._restart = (x) => { restarts++; return r0(x); };
    for (let k = 0; k < 20 * fps; k++) {
      const tTrue = 7 + k / fps, isLate = k % 60 === 59;
      const out = c8.map(tTrue + rr.gauss() * 0.0003 + (isLate ? late : 0));
      if (out === null) continue;
      if (out <= prev) back++;
      prev = out;
      if (k < 100) continue;
      if (isLate) worstLate = Math.max(worstLate, Math.abs(out - tTrue));
      else worstOther = Math.max(worstOther, Math.abs(out - tTrue));
    }
    check(`clock gives a late-stamped frame its slot's time (${fps} fps)`, worstLate < 0.0015 && worstOther < 0.0015 && restarts === 1 && back === 0,
      `late frames ${(worstLate * 1000).toFixed(2)}ms, others ${(worstOther * 1000).toFixed(2)}ms, restarts ${restarts}, steps back ${back}`);
  }
}

// --- time source: a late minority must not make it hop between clocks
{
  const r = rng(12);
  for (const fps of [30, 60]) {
    const ts = new TimeSource();
    let switches = 0, flips = 0, lastTrust = null, last = null;
    for (let k = 0; k < fps * 300; k++) {
      const t = k / fps;
      const p = ts.pick([['media', 10 + t + r.gauss() * 0.00005 + (r() < 0.05 ? 0.004 : 0)], ['capture', Math.round((20 + t) * 1000) / 1000], ['now', 40 + t]]);
      if (p.switched) switches++;
      if (lastTrust !== null && p.trusted !== lastTrust) flips++;
      lastTrust = p.trusted;
      last = p;
    }
    check(`time source stays on one clock (${fps} fps, 5 % of frames late)`, switches <= 1 && flips <= 2 && !last.trusted, `${switches} switches, ${flips} changes of trust, ends on ${last.source}`);
  }
  // frames stamped 12 ms late (more than a third of a period) are seen, and the clock is not trusted
  const ts2 = new TimeSource();
  let last2 = null;
  for (let k = 0; k < 900; k++) last2 = ts2.pick([['media', 10 + k / 30 + (r() < 0.3 ? 0.012 : 0)], ['capture', undefined], ['now', 40 + k / 30]]);
  check('time source sees frames stamped a third of a period late', last2.source === 'media' && !last2.trusted, JSON.stringify(last2));
  // five frames without a value: one change of clock, not two a frame apart
  const ts3 = new TimeSource();
  let sw3 = 0;
  for (let k = 0; k < 600; k++) {
    const gone = k % 60 >= 30 && k % 60 < 35;
    if (ts3.pick([['media', gone ? undefined : 10 + k / 30], ['capture', undefined], ['now', 40 + k / 30]]).switched) sw3++;
  }
  check('short drop-outs do not change the clock', sw3 === 0, `${sw3} switches`);
}

// --- clocks that start again, and frames stamped late now and then
{
  const r = rng(21);
  // the camera clock restarts from zero: one change is reported (the caller
  // forgets what it was following), one frame is left out, the clock is kept
  for (const jitter of [0.00005, 0.0008]) {
    const ts = new TimeSource();
    const fc = new FrameClock();
    fc.nominal = 1 / 30;
    let sw = 0, skips = 0, nulls = 0, src = '';
    for (let k = 0; k < 900; k++) {
      const p = ts.pick([['media', (k < 600 ? 50 + k / 30 : (k - 599) / 30) + r.gauss() * jitter], ['capture', undefined], ['now', 90 + k / 30]]);
      if (k < 300) continue;
      if (p.switched) { sw++; fc.reset(); }
      if (p.skip) { skips++; continue; }
      if (!p.trusted && fc.map(p.t) === null) nulls++;
      src = p.source;
    }
    check(`a camera clock that starts again is followed (jitter ${jitter * 1000} ms)`, sw === 1 && skips === 1 && nulls === 0 && src === 'media', `${sw} changes, ${skips} skipped, ${nulls} without a time, on ${src}`);
  }
  // one that keeps stepping back is given up
  const ts2 = new TimeSource();
  let last2 = null, sw2 = 0;
  for (let k = 0; k < 900; k++) {
    last2 = ts2.pick([['media', 50 + (k % 40) / 30], ['capture', 20 + k / 30], ['now', 90 + k / 30]]);
    if (last2.switched) sw2++;
  }
  check('a clock that keeps stepping back is given up', last2.source === 'capture' && sw2 <= 3, `ends on ${last2.source}, ${sw2} changes`);
  // the frame clock alone: after a step back it gives times again at once
  const fc3 = new FrameClock();
  let nulls3 = 0, worst3 = 0;
  for (let k = 0; k < 600; k++) {
    const tTrue = k < 300 ? 1000 + k / 30 : (k - 299) / 30;
    const out = fc3.map(tTrue + ((k * 7) % 5) * 0.0002);
    if (k < 300) continue;
    if (out === null) nulls3++;
    else if (k > 320) worst3 = Math.max(worst3, Math.abs(out - tTrue - 0.0004));
  }
  check('frame clock goes on after its input steps back', nulls3 === 0 && worst3 < 0.001, `${nulls3} frames without a time, worst ${(worst3 * 1000).toFixed(2)}ms`);
  // one frame in a hundred stamped 3 ms late: the average hardly moves, the clock is still not used as is
  for (const fps of [30, 60]) {
    const ts = new TimeSource();
    let trusted = 0, n = 0, flips = 0, lastTrust = null;
    for (let k = 0; k < fps * 120; k++) {
      const p = ts.pick([['media', 10 + k / fps + r.gauss() * 0.00005 + (r() < 0.01 ? 0.003 : 0)], ['capture', undefined], ['now', 40 + k / fps]]);
      if (k < 300) continue;
      n++;
      if (p.trusted) trusted++;
      if (lastTrust !== null && p.trusted !== lastTrust) flips++;
      lastTrust = p.trusted;
    }
    check(`a clock with rare late frames is not trusted (${fps} fps)`, trusted / n < 0.05 && flips <= 1, `trusted ${(100 * trusted / n).toFixed(0)}% of the time, ${flips} changes`);
  }
  // two frames in a row stamped late: both get their slots' times, the grid is kept
  for (const [fps, late] of [[30, 0.006], [30, 0.011], [60, 0.003], [60, 0.006]]) {
    const fc = new FrameClock();
    fc.nominal = 1 / fps;
    let restarts = 0, worst = 0;
    const r0 = fc._restart.bind(fc);
    fc._restart = (...a) => { restarts++; return r0(...a); };
    for (let k = 0; k < 400; k++) {
      const tTrue = 100 + k / fps;
      const out = fc.map(tTrue + ((k * 7) % 5 - 2) * 0.00005 + (k === 200 || k === 201 ? late : 0));
      if (k >= 190 && k < 230) worst = Math.max(worst, out === null ? Infinity : Math.abs(out - tTrue));
    }
    check(`two late-stamped frames in a row keep the grid (${fps} fps, ${late * 1000} ms)`, restarts === 1 && worst < 0.001, `restarts ${restarts}, worst ${(worst * 1000).toFixed(2)}ms`);
  }
  // large jitter both ways: a frame that comes out early gets its own slot, not the one before
  let off8 = 0, n8 = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const rr = rng(seed * 31);
    const fc = new FrameClock();
    fc.nominal = 1 / 30;
    for (let k = 0; k < 600; k++) {
      const tTrue = 3 + k / 30;
      const out = fc.map(tTrue + rr.gauss() * 0.004);
      if (k < 60 || out === null) continue;
      n8++;
      if (Math.abs(out - tTrue) > 0.008) off8++;
    }
  }
  check('frame clock with 4 ms jitter: hardly a frame more than 8 ms off', off8 <= 2, `${off8} of ${n8}`);
}

// --- spoken distances
{
  const say = (m) => phrase(judge(2, BOX_L + 0.025 + m));
  check('97 cm is spoken as 95 or 1 metre, never "100 centimetres"', !/100센티/.test(say(0.97)) && !/100센티/.test(say(0.99)), `${say(0.97)} / ${say(0.99)}`);
  check('1.0 m', say(1.0) === '아웃. 길게 1미터', say(1.0));
  check('over 3 m', say(3.4) === '아웃. 길게 3미터 이상', say(3.4));
}

// --- tracker: the picture may be rotated; "up" comes from the calibration
{
  const f = 1 / 30;
  const path = (t) => { const tb = 0.31; return [100 + 1500 * t, t < tb ? 100 + 1200 * t : 100 + 1200 * tb - 400 * (t - tb)]; };
  for (const [name, rot, up] of [['upright', (x, y) => [x, y], [0, -1]], ['rotated 90 deg', (x, y) => [-y, x], [1, 0]], ['rotated 180 deg', (x, y) => [-x, -y], [0, 1]], ['rotated 270 deg', (x, y) => [y, -x], [-1, 0]]]) {
    const tr = new Tracker({ up });
    let ev = [];
    for (let k = 0; k < 20; k++) {
      const [x, y] = rot(...path(k * f));
      ev = ev.concat(tr.update(k * f, [{ x, y, area: 20 }]));
    }
    const [bx, by] = rot(...path(0.31));
    check(`bounce found, picture ${name}`, ev.length === 1 && near(ev[0].t, 0.31, 0.002) && near(ev[0].x, bx, 0.5) && near(ev[0].y, by, 0.5), `${ev.length}`);
    // with the wrong idea of "up" nothing may be reported
    const wrong = new Tracker({ up: [-up[0], -up[1]] });
    let n = 0;
    for (let k = 0; k < 20; k++) { const [x, y] = rot(...path(k * f)); n += wrong.update(k * f, [{ x, y, area: 20 }]).length; }
    check(`no bounce when "up" is reversed, picture ${name}`, n === 0, `${n}`);
  }
}

// --- tracker: steep, slow serve that almost reverses at the bounce
{
  const f = 1 / 30;
  const tr = new Tracker();
  let ev = [];
  for (let k = 0; k < 22; k++) {
    const t = k * f, tb = 0.345;
    const x = 300 + 500 * t - (t > tb ? 200 * (t - tb) : 0);
    const y = t < tb ? 100 + 900 * t : 100 + 900 * tb - 720 * (t - tb);
    ev = ev.concat(tr.update(t, [{ x, y, area: 20 }]));
  }
  check('steep bounce is followed and found once', ev.length === 1 && !ev[0].loose && near(ev[0].t, 0.345, 0.003), `${ev.length} ${ev[0] && ev[0].t}`);
}

// --- tracker: a bounce that cannot be pinned down is not reported
{
  const f = 1 / 30;
  // the ball is lost one sample after the bounce
  for (const frac of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    const tr = new Tracker();
    let n = 0;
    const tb = (9 + frac) * f;
    for (let k = 0; k <= 10; k++) {
      const t = k * f;
      n += tr.update(t, [{ x: 100 + 1500 * t, y: t < tb ? 100 + 1200 * t : 100 + 1200 * tb - 400 * (t - tb), area: 20 }]).length;
    }
    for (let k = 11; k < 20; k++) n += tr.update(k * f, []).length;
    check(`no call when only one sample follows the bounce (${frac})`, n === 0, `${n}`);
  }
  // a two-frame hole right across the bounce: the bounce is seen, but marked
  // as too loosely placed to call
  const tr = new Tracker();
  let ev = [];
  for (let k = 0; k < 22; k++) {
    const t = k * f, tb = 9.4 * f;
    const cands = k === 10 || k === 11 ? [] : [{ x: 100 + 1500 * t, y: t < tb ? 100 + 1200 * t : 100 + 1200 * tb - 400 * (t - tb), area: 20 }];
    ev = ev.concat(tr.update(t, cands));
  }
  check('a bounce inside a two-frame hole is reported as loose', ev.length === 1 && ev[0].loose === true, `${ev.length} ${ev[0] && ev[0].loose}`);
}

// --- tracker finds a clean V-shaped kink
{
  const tr = new Tracker();
  const f = 1 / 30;
  let ev = [];
  for (let k = 0; k < 20; k++) {
    const t = k * f;
    const tb = 0.31; // bounce between frames 9 and 10
    const x = 100 + 1500 * t;
    const y = t < tb ? 100 + 1200 * t : 100 + 1200 * tb - 400 * (t - tb);
    ev = ev.concat(tr.update(t, [{ x, y, area: 20 }]));
  }
  check('tracker finds one bounce', ev.length === 1, `${ev.length}`);
  if (ev[0]) {
    check('bounce time', near(ev[0].t, 0.31, 0.002), `${ev[0].t}`);
    check('bounce position', near(ev[0].x, 100 + 1500 * 0.31, 0.5) && near(ev[0].y, 100 + 1200 * 0.31, 0.5));
  }
  // straight fast motion: no bounce
  const tr2 = new Tracker();
  let n2 = 0;
  for (let k = 0; k < 20; k++) n2 += tr2.update(k * f, [{ x: 100 + 1500 * k * f, y: 100 + 900 * k * f, area: 20 }]).length;
  check('no bounce on a straight path', n2 === 0);
}

// --- following an arc back from its bounce: over the net, or from this side?
{
  const r = rng(5);
  let farOk = 0, nearOk = 0, inside = 0, n = 0;
  for (const pos of [[6.5, 25.3, 2.5], [7.5, 18.3, 1.6], [0, 26.0, 2.5]]) {
    const W = 1280, H = 720;
    const cam = makeCamera({ pos, target: [-2.05, 15.6, 0.3], W, H, hfov: 66 });
    const pipe = new Pipeline();
    const c = pipe.setCalibration(CORNERS.map((cn) => cam.project([...boxToWorld(cn.uv[0], cn.uv[1]), 0]).slice(0, 2)), W, H);
    for (let k = 0; k < 6; k++) {
      // a slow serve, flown on through its second bounce
      const [X, Y] = boxToWorld(r.range(0.6, 3.5), r.range(2.0, 4.5));
      const traj = aimServe({ start: [0.8, 0, 2.5], X, Y, speed: r.range(13, 18), spin: r.range(0, 8), tMax: 3.6 });
      if (!traj || !traj.contact.second) continue;
      const sample = (tEnd, count) => {
        const pts = [];
        for (let i = count; i >= 1; i--) {
          const t = tEnd - i / 30;
          const q = cam.project(ballAt(traj, t));
          pts.push({ t, x: q[0] + r.gauss() * 0.3, y: q[1] + r.gauss() * 0.3 });
        }
        return pts;
      };
      n++;
      // the serve itself: even the shortest arc must reach back beyond the net
      const [u1, v1] = worldToBox(traj.contact.X, traj.contact.Y);
      const a1 = arcBack(c.cam, [u1, v1, 0.02], traj.contact.t, sample(traj.contact.t, 9));
      if (a1 && v1 - a1.near < 0.5) farOk++;
      // the arc into the second bounce started at the first bounce
      const [u2, v2] = worldToBox(traj.contact.second.X, traj.contact.second.Y);
      const a2 = arcBack(c.cam, [u2, v2, 0.02], traj.contact.second.t, sample(traj.contact.second.t, 12));
      if (a2 && v2 - a2.near >= 0.5) nearOk++;
      if (a2 && a2.near <= v2 - v1 && v2 - v1 <= a2.far) inside++;
    }
  }
  check('arc of a serve reaches back beyond the net', n >= 12 && farOk === n, `${farOk}/${n}`);
  check('arc into a second bounce is not taken for a serve', nearOk === n, `${nearOk}/${n}`);
  check('true hop length lies in the estimated range', inside >= n - 1, `${inside}/${n}`);
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
