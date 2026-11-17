// Scenario checks beyond ordinary serves, on rendered pictures: node test/scenarios.js
//  - serves that stop at the net must stay silent;
//  - serves landing far from the box are either judged or reported as
//    "not judged" (never silent, never a wrong call);
//  - a ball that only rolls or is tossed back must not produce a call;
//  - slow serves, a hidden bounce, balls lying on the court, a slow shutter,
//    the other service box, and a ball that flies and bounces differently
//    from what the app assumes.
import { runConfig, makeServes, summarize, CONFIGS } from './accuracy.js';
import { aimServe, boxToWorld, worldToBox, setDragScale, NET_Y, BALL_R, rng } from './sim.js';

const W = 4.14, L = 6.4;
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
};

function serveTo(u, v, r) {
  const [X, Y] = boxToWorld(u, v);
  for (const speed of [38, 32, 27, 23]) {
    const traj = aimServe({ start: [0.8, 0, 2.6], X, Y, speed, spin: 6 });
    if (traj && traj.netClear > 0.02) {
      const [tu, tv] = worldToBox(traj.contact.X, traj.contact.Y);
      return { traj, u: tu, v: tv, phase: r() };
    }
  }
  throw new Error(`cannot aim at ${u}, ${v}`);
}

const r = rng(41);

// 1. net serves
{
  const serves = [];
  while (serves.length < 8) {
    const s = serveTo(r.range(0.5, 3.6), r.range(3.5, 6.2), r);
    const k = s.traj.P.findIndex((p) => p[1] >= NET_Y);
    serves.push({ ...s, traj: { T: s.traj.T.slice(0, k), P: s.traj.P.slice(0, k), contact: s.traj.contact } });
  }
  for (const key of ['A25', 'SIDE16']) {
    const res = runConfig(CONFIGS[key], { fps: 30, serves, clickSigma: 1 });
    const calls = res.results.filter((x) => x.match).length;
    check(`${key}: serves stopped by the net stay silent`, calls === 0 && res.falseEvents.length === 0 && res.unsureOk === 0, `calls ${calls}, other ${res.falseEvents.length}, unsure ${res.unsureOk}`);
  }
}

// 2. far from the box
{
  const targets = [];
  for (const d of [1, 2, 3, 4]) targets.push([2.0, L + d]);
  for (const d of [1, 2.5]) targets.push([W + d, 4.5]);
  for (const d of [1, 2.5]) targets.push([-d, 4.5]);
  const serves = targets.map(([u, v]) => serveTo(u, v, r));
  for (const key of ['A25', 'SIDE']) {
    const res = runConfig(CONFIGS[key], { fps: 30, serves, clickSigma: 1 });
    const judged = res.results.filter((x) => x.match);
    const wrong = judged.filter((x) => x.match.call.in !== x.truth.in).length;
    check(`${key}: far serves are judged or flagged, never silent`, res.silent === 0 && wrong === 0 && res.falseEvents.length === 0,
      `judged ${judged.length}/${serves.length}, flagged ${res.unsureOk}, silent ${res.silent}, wrong ${wrong}, other ${res.falseEvents.length}`);
  }
}

// 3. a ball rolled slowly through the box, and one lobbed back towards the net
{
  const roll = { T: [], P: [] };
  for (let t = 0; t <= 2.0; t += 0.002) { roll.T.push(t); roll.P.push([-0.5 - 1.5 * t, 17.5 - 1.0 * t, BALL_R]); }
  roll.contact = { t: 0.55, X: 0, Y: 0, mark: [{ X: 99, Y: 99, a: 0 }] };
  const lob = { T: [], P: [] };
  for (let t = 0; t <= 1.6; t += 0.002) { lob.T.push(t); lob.P.push([-2 + 0.5 * t, 19 - 5.5 * t, Math.max(BALL_R, 1.0 + 6 * t - 4.905 * t * t)]); }
  lob.contact = { t: 0.55, X: 0, Y: 0, mark: [{ X: 99, Y: 99, a: 0 }] };
  for (const [name, traj] of [['a rolling ball', roll], ['a ball lobbed back to the net', lob]]) {
    const res = runConfig(CONFIGS.A25, { fps: 30, serves: [{ traj, u: 0, v: 0, phase: 0.3 }], clickSigma: 1 });
    const n = res.results.filter((x) => x.match).length + res.falseEvents.length;
    check(`A25: ${name} gives no call and no "not judged"`, n === 0 && res.unsureOk === 0, `events ${n}, flagged ${res.unsureOk}`);
  }
}

// 4. slow, high serves: steep bounce, and a second bounce inside the watched area
{
  const serves = [];
  while (serves.length < 8) {
    const [X, Y] = boxToWorld(r.range(0.6, 3.5), r.range(3.0, 5.5));
    const traj = aimServe({ start: [0.8, 0, 2.5], X, Y, speed: r.range(12, 19), spin: r.range(0, 6), tauC: 0.0045, tMax: 3.6 });
    if (!traj || traj.netClear < 0.02) continue;
    const [tu, tv] = worldToBox(traj.contact.X, traj.contact.Y);
    serves.push({ traj, u: tu, v: tv, phase: r() });
  }
  for (const key of ['A25', 'SIDE16']) {
    const res = runConfig(CONFIGS[key], { fps: 30, serves, clickSigma: 1, tail: 2.2 });
    const judged = res.results.filter((x) => x.match);
    const worst = Math.max(0, ...judged.map((x) => Math.hypot(x.match.court.u - x.u, x.match.court.v - x.v)));
    check(`${key}: slow high serves are judged once, at the first bounce`, judged.length === serves.length && res.falseEvents.length === 0 && worst < 0.06,
      `judged ${judged.length}/${serves.length}, extra events ${res.falseEvents.length}, worst error ${(worst * 100).toFixed(1)} cm`);
  }

  // the same serves with the ball hidden around the first bounce: the second
  // bounce must not be reported as the landing
  const hidden = serves.map((s) => {
    const tc = s.traj.contact.t;
    const P = s.traj.P.map((p, i) => (Math.abs(s.traj.T[i] - tc) < 0.13 ? [p[0], p[1], -60] : p));
    return { ...s, traj: { ...s.traj, P } };
  });
  const res = runConfig(CONFIGS.A25, { fps: 30, serves: hidden, clickSigma: 1, tail: 2.2 });
  const calls = res.results.filter((x) => x.match).length + res.falseEvents.filter((f) => f.e.type !== 'unsure').length;
  check('A25: first bounce hidden -> no call from the second bounce', calls === 0, `calls ${calls}, flagged ${res.unsureOk}, silent ${res.silent}`);
}

// 4b. ordinary serves with the ball out of sight for three frames just when
// it bounces: the spot cannot be given, so "not judged" -- never a guess,
// never silence
{
  const serves = makeServes(8, 77).map((s) => {
    const tc = s.traj.contact.t;
    return { ...s, traj: { ...s.traj, P: s.traj.P.map((p, i) => (Math.abs(s.traj.T[i] - tc) < 0.045 ? [p[0], p[1], -60] : p)) } };
  });
  for (const [key, fps] of [['A25', 30], ['SIDE16', 60]]) {
    const res = runConfig(CONFIGS[key], { fps, serves, clickSigma: 1 });
    const judged = res.results.filter((x) => x.match);
    const wrong = judged.filter((x) => x.match.call.in !== x.truth.in).length;
    check(`${key} ${fps} fps: bounce out of sight for three frames -> "not judged"`, res.silent === 0 && wrong === 0 && res.falseEvents.length === 0,
      `judged ${judged.length}/${serves.length}, flagged ${res.unsureOk}, silent ${res.silent}, wrong ${wrong}, other ${res.falseEvents.length}`);
  }
}

// 5. serve practice as it really looks: balls lying all over the far court and
// a tripod that trembles a little
{
  for (const [key, court] of [['A25', 'blue'], ['SIDE16', 'clay']]) {
    const res = runConfig(CONFIGS[key], { fps: 30, n: 10, clickSigma: 1, staticBalls: 30, shake: 0.5, court });
    const judged = res.results.filter((x) => x.match);
    const wrong = judged.filter((x) => x.match.call.in !== x.truth.in && Math.abs(x.truth.gap) > 0.1).length;
    check(`${key} (${court}): 30 balls on the court and a trembling camera`, judged.length >= 9 && res.falseEvents.length === 0 && wrong === 0,
      `judged ${judged.length}/10, extra events ${res.falseEvents.length}, clear balls wrong ${wrong}`);
  }
}

// 6. the slowest shutter the app accepts without a warning
{
  const res = runConfig(CONFIGS.A25, { fps: 30, n: 10, clickSigma: 1, exposure: 1 / 250 });
  const s = summarize(res);
  check('A25: shutter 1/250 s', s.detected >= 9 && s.falseEvents === 0 && s.clearAcc === 1 && s.err90 < 0.08,
    `judged ${s.detected}/10, extra events ${s.falseEvents}, position error ${(s.errMedian * 100).toFixed(1)} / ${(s.err90 * 100).toFixed(1)} cm`);
}

// 7. the other (ad) service box: the same pictures mirrored left to right
{
  for (const key of ['A25', 'SIDE16']) {
    const res = runConfig(CONFIGS[key], { fps: 30, n: 10, clickSigma: 1.5, snap: true, mirror: true });
    const s = summarize(res);
    check(`${key}: mirrored (ad court)`, s.detected >= 9 && s.falseEvents === 0 && s.clearAcc === 1 && s.errMedian < 0.04,
      `judged ${s.detected}/10, extra events ${s.falseEvents}, position error ${(s.errMedian * 100).toFixed(1)} / ${(s.err90 * 100).toFixed(1)} cm, line snap ${res.snapInfo.found.join(',')}`);
  }
}

// 8. a ball that does not behave as the app assumes: thinner or thicker air
// (drag x0.8 / x1.2) and a shorter or longer stay on the court (3.5 / 5.5 ms
// against the assumed 4.5)
{
  for (const [name, drag, tauC] of [['less drag, short contact', 0.8, 0.0035], ['more drag, long contact', 1.2, 0.0055]]) {
    setDragScale(drag);
    const serves = makeServes(10, 14, { tauC: [tauC, tauC] });
    setDragScale(1);
    const res = runConfig(CONFIGS.A25, { fps: 30, serves, clickSigma: 1 });
    const s = summarize(res);
    check(`A25: ${name}`, s.detected >= 9 && s.falseEvents === 0 && s.clearAcc === 1 && Math.abs(s.gapBias) < 0.05,
      `judged ${s.detected}/10, extra events ${s.falseEvents}, distance-to-line error on average ${(s.gapBias * 100).toFixed(1)} cm`);
  }
}

console.log(failed ? `\n${failed} scenario check(s) FAILED` : '\nall scenario checks passed');
process.exit(failed ? 1 : 0);
