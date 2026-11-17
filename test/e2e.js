// End-to-end test in Chromium: the synthetic serve video is fed in as a fake
// camera (and separately as a video file); the app must call each serve.
// Also: placing the corners by touch, recovering when the camera is taken
// away, and starting without a connection.
//   node test/make-video.js && node test/e2e.js [--shots dir]

import { createRequire } from 'node:module';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './serve.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const outDir = new URL('./out/', import.meta.url).pathname;
const args = process.argv.slice(2);
const shotsDir = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });

if (!existsSync(join(outDir, 'truth.json')) || !existsSync(join(outDir, 'serves.y4m'))) {
  console.error('run "node test/make-video.js" first');
  process.exit(1);
}
const truth = JSON.parse(readFileSync(join(outDir, 'truth.json'), 'utf8'));
const PORT = Number(process.env.PORT || 8124);

function compare(name, events, spoken) {
  const want = truth.serves;
  const got = events.slice(0, want.length);
  let ok = got.length === want.length;
  const lines = want.map((s, i) => {
    const e = got[i];
    if (!e) { ok = false; return `  #${i + 1} 실제 ${s.in ? 'IN ' : 'OUT'} (${s.u.toFixed(2)}, ${s.v.toFixed(2)})  ->  판정 없음`; }
    const err = Math.hypot(e.u - s.u, e.v - s.v);
    const good = e.in === s.in && err < 0.15;
    if (!good) ok = false;
    return `  #${i + 1} 실제 ${s.in ? 'IN ' : 'OUT'} (${s.u.toFixed(2)}, ${s.v.toFixed(2)})  ->  ${e.in ? 'IN ' : 'OUT'} (${e.u.toFixed(2)}, ${e.v.toFixed(2)}) 오차 ${(err * 100).toFixed(1)}cm ${e.method}${good ? '' : '  ✗'}`;
  });
  console.log(`\n[${name}] 판정 ${events.length}개 (기대 ${want.length}개)`);
  console.log(lines.join('\n'));
  console.log(`  음성: ${spoken.map((s) => s.text).join(' | ')}`);
  return ok;
}

async function runCamera(browser) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 420 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://localhost:${PORT}/`);
  await page.click('#startCam');
  await page.waitForSelector('#calib:not([hidden])', { timeout: 15000 });
  const t0 = Date.now();
  // Tap the four corners roughly (2 px off), then let line snapping refine.
  const taps = truth.corners.map(([x, y], i) => [x + [2, -2, 1.5, -1.5][i], y + [-1.5, 2, 2, -2][i]]);
  await page.evaluate((pts) => window.__servecall.setPoints(pts), taps);
  if (shotsDir) await page.screenshot({ path: join(shotsDir, 'calib.png') });
  await page.evaluate(() => window.__servecall.finish());
  await page.waitForSelector('#judge:not([hidden])');
  const snapped = await page.evaluate(() => window.__servecall.state.snapResult?.found || []);
  // The fake camera loops the file; watch one pass.
  const loopMs = (truth.frames / truth.fps) * 1000;
  await page.waitForTimeout(Math.max(1000, loopMs - (Date.now() - t0) + 600));
  const events = await page.evaluate(() => window.__servecall.state.events);
  const spoken = await page.evaluate(() => window.__servecall.voice.spoken);
  const info = await page.evaluate(() => ({
    procMs: window.__servecall.state.procMs,
    fps: window.__servecall.state.fpsWindow.fps,
    timeSource: window.__servecall.state.timeSource,
    size: [document.querySelector('#video').videoWidth, document.querySelector('#video').videoHeight],
  }));
  if (shotsDir) {
    await page.click('#debugBtn');
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shotsDir, 'judge.png') });
  }
  // The camera is taken away: the player must hear about it, and the app
  // must pick the camera up again by itself.
  await page.evaluate(() => window.__servecall.state.track.stop());
  let lost = null;
  try {
    await page.waitForFunction(() => window.__servecall.voice.spoken.some((x) => x.text.includes('카메라가 다시 켜졌어요')), null, { timeout: 12000 });
    lost = await page.evaluate(() => ({
      said: window.__servecall.voice.alerts.map((x) => x.text),
      running: window.__servecall.state.running,
      live: window.__servecall.state.track?.readyState,
      alertHidden: document.querySelector('#alertBar').hidden,
    }));
  } catch { /* reported below */ }
  if (shotsDir) await page.screenshot({ path: join(shotsDir, 'judge-after-reopen.png') });
  await ctx.close();
  console.log(`\n카메라: ${info.size.join('×')} · 처리 ${info.procMs.toFixed(1)}ms · ${info.fps.toFixed(0)}fps · 시간 ${info.timeSource} · 라인 맞춤 ${snapped.join(',') || '없음'}`);
  if (errors.length) console.log('page errors:', errors);
  const lostOk = !!lost && lost.said.some((x) => x.includes('카메라가 꺼졌어요')) && lost.running && lost.live === 'live' && lost.alertHidden;
  console.log(`[카메라가 꺼졌을 때] 음성 알림 후 자동으로 다시 켜짐: ${lostOk ? '예' : '아니오  ✗'}`);
  const noMiss = !spoken.some((x) => x.text.includes('놓쳤어요'));
  if (!noMiss) console.log('  "놓쳤어요"가 잘못 나왔습니다  ✗');
  // The camera pass may start mid-way into the first idle second; compare in order.
  return compare('가짜 카메라', events, spoken) && !errors.length && lostOk && noMiss;
}

// Places the corners with real pointer input: a rough tap for each corner,
// then a slow drag on one of them, then the Done button.
async function runTouchCalibration(browser) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 420 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/`);
  await page.click('#startCam');
  await page.waitForSelector('#calib:not([hidden])', { timeout: 15000 });
  const fitInfo = await page.evaluate(() => {
    const st = document.querySelector('#calibStage').getBoundingClientRect();
    const v = document.querySelector('#video');
    const s = Math.min(st.width / v.videoWidth, st.height / v.videoHeight);
    return { left: st.left, top: st.top, s, ox: (st.width - v.videoWidth * s) / 2, oy: (st.height - v.videoHeight * s) / 2 };
  });
  const toScreen = ([x, y]) => [fitInfo.left + fitInfo.ox + x * fitInfo.s, fitInfo.top + fitInfo.oy + y * fitInfo.s];
  // rough taps, ~3 video px off
  const offsets = [[3, -2], [-3, 2], [2, 3], [-2, -3]];
  for (let i = 0; i < 4; i++) {
    const [x, y] = toScreen([truth.corners[i][0] + offsets[i][0], truth.corners[i][1] + offsets[i][1]]);
    await page.mouse.click(x, y);
    if (i === 1) {
      // touch corner 1 again before going on: the next tap must still place
      // corner 3, not move corner 1 across the screen
      const [x0, y0] = toScreen([truth.corners[0][0] + offsets[0][0], truth.corners[0][1] + offsets[0][1]]);
      await page.mouse.click(x0, y0);
    }
  }
  const placed = await page.evaluate(() => window.__servecall.state.pts.map((p) => (p ? p.slice() : null)));
  const order = placed.every(Boolean) && placed.every((p, i) => Math.hypot(p[0] - truth.corners[i][0], p[1] - truth.corners[i][1]) < 8);
  // slow-drag corner 3 by 20 screen px right: should move only ~0.3x as far
  const before = await page.evaluate(() => window.__servecall.state.pts[2].slice());
  const [sx, sy] = toScreen(before);
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 20, sy, { steps: 4 });
  await page.mouse.up();
  const after = await page.evaluate(() => window.__servecall.state.pts[2].slice());
  const moved = (after[0] - before[0]) * fitInfo.s; // in screen px
  const done = await page.isEnabled('#calibDone');
  await page.click('#calibDone');
  await page.waitForSelector('#judge:not([hidden])');
  const res = await page.evaluate(() => ({
    pts: window.__servecall.pipe.calib.points,
    found: window.__servecall.state.snapResult?.found || [],
  }));
  await ctx.close();
  const errs = res.pts.map((p, i) => Math.hypot(p[0] - truth.corners[i][0], p[1] - truth.corners[i][1]));
  // Corners 3 and 4 are set by the fitted lines; 1 and 2 keep the tap along their line.
  const ok = done && order && Math.abs(moved - 6) < 1.5 && errs[2] < 1 && errs[3] < 1 && res.found.length === 3 && !errors.length;
  console.log(`\n[터치로 모서리 맞추기] 4번 터치 후 완료 버튼 ${done ? '활성' : '비활성'} · 모서리 순서 ${order ? '맞음' : '틀림'} · 천천히 끌기 20px → ${moved.toFixed(1)}px 이동`);
  console.log(`  라인 맞춤 ${res.found.join(',')} · 모서리 오차 ${errs.map((e) => e.toFixed(2)).join(' / ')}px${ok ? '' : '  ✗'}`);
  if (errors.length) console.log('page errors:', errors);
  return ok;
}

// The corners tapped starting at the wrong corner, as on a real court: the
// order must be put right as soon as the fourth corner is placed (before
// [완료]), the name buttons must renumber the points without moving them,
// and corners saved in the wrong order by an earlier version are put right
// when loaded.
async function runWrongOrder(browser) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 420 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/`);
  await page.click('#startCam');
  await page.waitForSelector('#calib:not([hidden])', { timeout: 15000 });
  const fitInfo = await page.evaluate(() => {
    const st = document.querySelector('#calibStage').getBoundingClientRect();
    const v = document.querySelector('#video');
    const s = Math.min(st.width / v.videoWidth, st.height / v.videoHeight);
    return { left: st.left, top: st.top, s, ox: (st.width - v.videoWidth * s) / 2, oy: (st.height - v.videoHeight * s) / 2 };
  });
  const toScreen = ([x, y]) => [fitInfo.left + fitInfo.ox + x * fitInfo.s, fitInfo.top + fitInfo.oy + y * fitInfo.s];
  const pts = () => page.evaluate(() => window.__servecall.state.pts.map((p) => (p ? p.slice() : null)));
  // got[i] is at truth corner map[i]
  const near = (got, map, tol = 3) => got.every((p, i) => p && Math.hypot(p[0] - truth.corners[map[i]][0], p[1] - truth.corners[map[i]][1]) < tol);
  const hiddenBefore = await page.isHidden('#rotateNames');
  // started at the service line / centre line corner, then went round
  for (const i of [3, 0, 1, 2]) {
    const [x, y] = toScreen(truth.corners[i]);
    await page.mouse.click(x, y);
  }
  const fixed = near(await pts(), [0, 1, 2, 3]);
  const told = (await page.textContent('#toast')).includes('바로잡았습니다');
  const shown = hiddenBefore && (await page.isVisible('#rotateNames')) && (await page.isVisible('#flipNames'));
  await page.click('#rotateNames');
  const rotated = near(await pts(), [1, 2, 3, 0]);
  await page.click('#flipNames');
  const flipped = near(await pts(), [2, 1, 0, 3]);
  await page.click('#flipNames');
  for (let k = 0; k < 3; k++) await page.click('#rotateNames');
  const back = near(await pts(), [0, 1, 2, 3]);
  await page.click('#calibDone');
  await page.waitForSelector('#judge:not([hidden])');
  const calibOk = await page.evaluate(() => window.__servecall.pipe.calib.points.map((p) => p.slice()));
  const finished = near(calibOk, [0, 1, 2, 3], 4);
  // corners saved in the wrong order (as the earlier version did), then loaded
  await page.click('#recalib');
  await page.waitForSelector('#calib:not([hidden])');
  await page.click('#calibBack');
  await page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => /calib/.test(x));
    const saved = JSON.parse(localStorage.getItem(k));
    saved.pts = [saved.pts[3], saved.pts[0], saved.pts[1], saved.pts[2]];
    localStorage.setItem(k, JSON.stringify(saved));
  });
  await page.click('#startCam');
  await page.waitForSelector('#calib:not([hidden])', { timeout: 15000 });
  await page.click('#loadPrev');
  const loaded = near(await pts(), [0, 1, 2, 3], 4);
  await ctx.close();
  const ok = fixed && told && shown && rotated && flipped && back && finished && loaded && !errors.length;
  console.log(`\n[모서리를 다른 순서로 찍었을 때] 네 번째 점에서 바로잡음 ${fixed && told ? '예' : '아니오'} · 이름 버튼 ${shown && rotated && flipped && back ? '정상' : '이상'} · [완료] 후 ${finished ? '맞음' : '틀림'} · 잘못 저장된 지난 위치 ${loaded ? '바로잡음' : '그대로'}${ok ? '' : '  ✗'}`);
  if (errors.length) console.log('page errors:', errors);
  return ok;
}

async function runFile(browser) {
  const webm = join(outDir, 'serves.webm');
  if (!existsSync(webm)) { console.log('\n[영상 파일] WebM 없음, 건너뜀'); return true; }
  const ctx = await browser.newContext({ viewport: { width: 900, height: 420 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/`);
  await page.setInputFiles('#fileInput', webm);
  await page.waitForSelector('#calib:not([hidden])', { timeout: 15000 });
  await page.evaluate((pts) => window.__servecall.setPoints(pts), truth.corners);
  // start from the beginning of the clip
  await page.evaluate(() => new Promise((r) => { const v = document.querySelector('#video'); v.currentTime = 0; v.addEventListener('seeked', r, { once: true }); }));
  await page.evaluate(() => window.__servecall.finish());
  await page.waitForSelector('#judge:not([hidden])');
  await page.evaluate(() => new Promise((r) => document.querySelector('#video').addEventListener('ended', r, { once: true })));
  const events = await page.evaluate(() => window.__servecall.state.events);
  const spoken = await page.evaluate(() => window.__servecall.voice.spoken);
  if (shotsDir) await page.screenshot({ path: join(shotsDir, 'judge-file.png') });
  await ctx.close();
  if (errors.length) console.log('page errors:', errors);
  return compare('영상 파일 (0.5배속)', events, spoken) && !errors.length;
}

// The stored copy: the app must start without a connection, and without a
// long wait on a connection that accepts requests but does not answer.
async function runOffline(browser, server) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 420 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/`);
  await page.evaluate(() => navigator.serviceWorker.ready);
  // (the stored copy is one cache among a few: count the largest)
  const files = await page.waitForFunction(async () => {
    let n = 0;
    for (const k of await caches.keys()) n = Math.max(n, (await (await caches.open(k)).keys()).length);
    return n >= 17 ? n : 0;
  }, null, { timeout: 15000 }).then((h) => h.jsonValue()).catch(() => 0);
  await page.reload(); // now served through the worker
  const started = async (limit) => {
    const t0 = Date.now();
    try {
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => !!window.__servecall, null, { timeout: limit });
      return Date.now() - t0;
    } catch {
      return Infinity;
    }
  };
  await ctx.setOffline(true);
  const offlineMs = await started(8000);
  await ctx.setOffline(false);
  server.delayMs = 8000;
  const hangingMs = await started(20000);
  server.delayMs = 0;
  await ctx.close();
  const ok = files >= 17 && offlineMs < 3000 && hangingMs < 4500 && !errors.length;
  console.log(`\n[인터넷 없이 열기] 저장된 파일 ${files}개 · 오프라인에서 ${offlineMs}ms · 응답 없는 연결에서 ${hangingMs}ms 만에 시작${ok ? '' : '  ✗'}`);
  if (errors.length) console.log('page errors:', errors);
  return ok;
}

const server = await startServer(PORT);
const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${join(outDir, 'serves.y4m')}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});
let ok = false;
try {
  const a = await runCamera(browser);
  const t = await runTouchCalibration(browser);
  const w = await runWrongOrder(browser);
  const b = await runFile(browser);
  const o = await runOffline(browser, server);
  ok = a && t && w && b && o;
} finally {
  await browser.close();
  server.close();
}
console.log(ok ? '\nE2E PASSED' : '\nE2E FAILED');
process.exit(ok ? 0 : 1);
