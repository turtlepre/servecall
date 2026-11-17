// 서브콜 — UI controller: camera, corner calibration, live calls, stats.

import { Pipeline, TimeSource } from './pipeline.js';
import { CORNERS, BOX_W, BOX_L, NEAR_BAND, GUIDE_LINES, label, orderCorners } from './court.js';
import { homography, applyH } from './geometry.js';
import { snapCorners } from './snap.js';
import { Voice } from './voice.js';
import { loadJSON, saveJSON } from './store.js';

const $ = (s) => document.querySelector(s);
const KEYS = { settings: 'servecall.settings.v1', calib: 'servecall.calib.v1', calls: 'servecall.calls.v1' };

const DEFAULTS = { res: '720', fps: 60, voiceMode: 'both', keepAlive: true, rate: 1.1, snap: true, threshold: 30 };
const settings = { ...DEFAULTS, ...loadJSON(KEYS.settings, {}) };
const saveSettings = () => saveJSON(KEYS.settings, settings);

const video = $('#video');
const voice = new Voice({ mode: settings.voiceMode, rate: settings.rate, keepAlive: settings.keepAlive });
const pipe = new Pipeline({ threshold: settings.threshold });
const proc = document.createElement('canvas');
const pctx = proc.getContext('2d', { willReadFrequently: true });

const state = {
  screen: 'home',
  source: null, // 'camera' | 'file'
  stream: null,
  track: null,
  caps: {},
  pts: [null, null, null, null],
  active: 0,
  drag: null,
  orderByHand: false, // the corner numbers were set with the buttons: keep them
  snapResult: null,
  running: false,
  vfc: 0,
  calls: loadJSON(KEYS.calls, []),
  last: null,
  debug: false,
  procMs: 0,
  frames: 0,
  fpsWindow: { t: 0, n: 0, fps: 0 },
  timeSource: '',
  wake: null,
  wantWake: false,
  wakeWarned: false,
  slowSince: 0,
  events: [],
  unsureEvents: [],
  shutter: null,
  since: loadJSON('servecall.since.v1', 0), // stats count from here
  roughSince: 0,
  roughWarned: false,
  wakeSaid: false,
  deviceId: null,
  zoom: null,
  calibSize: null,
};

// ---------------------------------------------------------------- screens --

function show(name) {
  state.screen = name;
  for (const el of document.querySelectorAll('.screen')) el.hidden = el.id !== name;
  const stage = name === 'calib' ? $('#calibStage') : name === 'judge' ? $('#judgeStage') : null;
  if (stage && video.parentElement !== stage) stage.insertBefore(video, stage.firstChild);
  requestAnimationFrame(drawOverlay);
}

// Messages at the bottom of the screen. A new one is added under those still
// showing (up to three), so that a warning is not wiped out by the next note.
const toasts = [];
let toastTimer = 0;
function toast(msg, ms = 3200) {
  const now = performance.now();
  const at = toasts.findIndex((x) => x.msg === msg);
  if (at >= 0) toasts.splice(at, 1);
  toasts.push({ msg, until: now + ms });
  while (toasts.length > 3) toasts.shift();
  showToasts();
}
function showToasts() {
  const now = performance.now();
  while (toasts.length && toasts[0].until <= now) toasts.shift();
  for (let i = toasts.length - 1; i >= 0; i--) if (toasts[i].until <= now) toasts.splice(i, 1);
  const el = $('#toast');
  el.textContent = toasts.map((x) => x.msg).join('\n');
  el.hidden = !toasts.length;
  clearTimeout(toastTimer);
  if (toasts.length) toastTimer = setTimeout(showToasts, Math.max(50, Math.min(...toasts.map((x) => x.until)) - now));
}

// --------------------------------------------------------------- settings --

function bindSettings() {
  const res = $('#setRes'), fps = $('#setFps'), mode = $('#setVoice'), rate = $('#setRate');
  const keep = $('#setKeep'), snap = $('#setSnap');
  res.value = settings.res;
  fps.value = String(settings.fps);
  mode.value = settings.voiceMode;
  rate.value = String(settings.rate);
  $('#rateOut').textContent = `${Number(settings.rate).toFixed(1)}배`;
  keep.checked = settings.keepAlive;
  snap.checked = settings.snap;
  res.onchange = () => { settings.res = res.value; saveSettings(); };
  fps.onchange = () => { settings.fps = Number(fps.value); saveSettings(); };
  mode.onchange = () => { settings.voiceMode = mode.value; voice.mode = mode.value; saveSettings(); };
  rate.oninput = () => {
    settings.rate = Number(rate.value);
    voice.rate = settings.rate;
    $('#rateOut').textContent = `${settings.rate.toFixed(1)}배`;
    saveSettings();
  };
  keep.onchange = () => { settings.keepAlive = keep.checked; voice.setKeepAlive(keep.checked); saveSettings(); };
  snap.onchange = () => { settings.snap = snap.checked; saveSettings(); };

  const sens = $('#sens');
  // Slider reads as sensitivity: right = more sensitive = lower threshold.
  sens.value = String(75 - settings.threshold);
  const applySens = () => {
    settings.threshold = 75 - Number(sens.value);
    pipe.setThreshold(settings.threshold);
    saveSettings();
  };
  sens.oninput = applySens;
}

// ----------------------------------------------------------------- camera --

const RES = { 720: [1280, 720], 1080: [1920, 1080] };

// keepZoom: reopening the same view (the corners stay valid only at the same zoom).
async function openCamera(deviceId, { keepZoom = false } = {}) {
  if (!window.isSecureContext) throw Object.assign(new Error('insecure'), { name: 'InsecureContext' });
  if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('nomedia'), { name: 'NotSupported' });
  stopStream();
  const [w, h] = RES[settings.res] || RES[720];
  const video_ = {
    width: { ideal: w },
    height: { ideal: h },
    frameRate: { ideal: settings.fps },
    zoom: true, // lets Chrome expose the zoom control where the camera has one
  };
  if (deviceId) video_.deviceId = { exact: deviceId };
  else video_.facingMode = { ideal: 'environment' };
  const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: video_ });
  state.stream = stream;
  state.track = stream.getVideoTracks()[0];
  state.caps = state.track.getCapabilities?.() || {};
  video.removeAttribute('src');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  await waitForSize();
  state.source = 'camera';
  const track = state.track;
  track.addEventListener('ended', () => {
    // while judging the watchdog deals with it; here the picture just freezes
    if (state.track === track && state.screen === 'calib') toast('카메라가 꺼졌습니다. [뒤로]를 누르고 다시 시작해 주세요.', 8000);
  });
  state.deviceId = state.track.getSettings?.().deviceId || deviceId || null;
  if (keepZoom && state.zoom !== null) {
    try { await state.track.applyConstraints({ advanced: [{ zoom: state.zoom }] }); } catch { /* zoom not restored */ }
  } else state.zoom = null;
  await fillCameraList();
  setupZoom();
}

function stopStream() {
  if (state.stream) for (const t of state.stream.getTracks()) t.stop();
  state.stream = null;
  state.track = null;
}

function waitForSize() {
  return new Promise((resolve) => {
    if (video.videoWidth) return resolve();
    video.addEventListener('loadedmetadata', () => resolve(), { once: true });
  });
}

async function fillCameraList() {
  const sel = $('#camSelect');
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    sel.innerHTML = '';
    const current = state.track?.getSettings?.().deviceId;
    devs.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `카메라 ${i + 1}`;
      if (d.deviceId === current) o.selected = true;
      sel.append(o);
    });
    sel.parentElement.hidden = devs.length < 2;
  } catch {
    sel.parentElement.hidden = true;
  }
}

function setupZoom() {
  const z = state.caps.zoom;
  const row = $('#zoomRow');
  if (!z || !(z.max > z.min)) { row.hidden = true; return; }
  row.hidden = false;
  const input = $('#zoom');
  input.min = z.min; input.max = z.max; input.step = z.step || 0.1;
  input.value = state.track.getSettings().zoom ?? z.min;
  $('#zoomOut').textContent = `${Number(input.value).toFixed(1)}x`;
}

function cameraInfo() {
  const s = state.track?.getSettings?.() || {};
  const fps = s.frameRate ? `${Math.round(s.frameRate)}fps` : '';
  return `${video.videoWidth}×${video.videoHeight}${fps ? ' · ' + fps : ''}`;
}

function cameraError(err) {
  const name = err?.name;
  if (name === 'InsecureContext') return 'HTTPS 주소에서만 카메라를 쓸 수 있습니다. https:// 로 시작하는 주소로 열어 주세요.';
  if (name === 'NotAllowedError') return '카메라 권한이 거부됐습니다. 주소창의 자물쇠 아이콘 → 권한에서 카메라를 허용한 뒤 다시 시도하세요.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return '사용할 수 있는 카메라를 찾지 못했습니다.';
  if (name === 'NotReadableError') return '다른 앱이 카메라를 쓰고 있습니다. 카메라 앱을 닫고 다시 시도하세요.';
  if (name === 'NotSupported') return '이 브라우저는 카메라를 지원하지 않습니다. 안드로이드 크롬에서 열어 주세요.';
  return `카메라를 열지 못했습니다 (${name || err}).`;
}

// ---------------------------------------------------------- calibration --

function startCalibration({ keepPoints = false } = {}) {
  stopLoop();
  if (!keepPoints) {
    const saved = loadJSON(KEYS.calib, null);
    state.pts = [null, null, null, null];
    state.active = 0;
    state.orderByHand = false;
    $('#loadPrev').hidden = !(saved && saved.vw === video.videoWidth && saved.vh === video.videoHeight);
  }
  state.snapResult = null;
  state.calibSize = [video.videoWidth, video.videoHeight];
  document.body.classList.toggle('file-mode', state.source === 'file');
  $('#camInfo').textContent = state.source === 'file' ? '영상 파일' : cameraInfo();
  $('#scrubRow').hidden = state.source !== 'file';
  if (state.source === 'file') {
    video.pause();
    const s = $('#scrub');
    s.max = String(video.duration || 0);
    s.value = String(video.currentTime || 0);
  }
  show('calib');
  updateCalibUI();
}

function updateCalibUI() {
  const placed = state.pts.filter(Boolean).length;
  const i = state.active;
  $('#stepNum').textContent = `${i + 1}`;
  $('#stepText').textContent = CORNERS[i].label;
  $('#stepHint').textContent = placed === 0
    ? '네트와 센터라인(가운데 라인)이 만나는 모서리부터 찍으세요. 오른쪽 그림은 서버 쪽에서 본 모양이라, 카메라 화면에서는 방향이 다를 수 있습니다.'
    : placed < 4
      ? '서비스 박스의 모서리를 터치하세요(사이드는 안쪽 단식 라인). 손가락 굵기만큼 어긋나도 자동 맞춤이 라인을 찾아 보정합니다.'
      : '박스 둘레의 라인 이름과 흰 점선이 실제 코트와 맞으면 잘 맞은 것입니다. 이름이 다르면 [이름 돌리기]나 [센터↔사이드]를 누르고, 점이 어긋나면 끌어서 고치세요(천천히 움직입니다).';
  $('#calibDone').disabled = placed < 4;
  $('#rotateNames').hidden = $('#flipNames').hidden = placed < 4;
  for (let k = 0; k < 4; k++) {
    const dot = document.querySelector(`#cornerMap [data-corner="${k}"]`);
    if (dot) {
      dot.classList.toggle('active', k === i);
      dot.classList.toggle('placed', !!state.pts[k]);
    }
  }
  requestAnimationFrame(drawOverlay);
}

// Video pixel <-> stage CSS pixel (video is letterboxed with object-fit: contain).
function fit(stage) {
  const r = stage.getBoundingClientRect();
  const vw = video.videoWidth || 1, vh = video.videoHeight || 1;
  const s = Math.min(r.width / vw, r.height / vh);
  return { s, ox: (r.width - vw * s) / 2, oy: (r.height - vh * s) / 2, w: r.width, h: r.height, left: r.left, top: r.top };
}

function bindCalibration() {
  const stage = $('#calibStage');
  const canvas = $('#calibOverlay');
  const local = (e) => {
    const r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  canvas.addEventListener('pointerdown', (e) => {
    const f = fit(stage);
    const p = local(e);
    let hit = -1, best = 32;
    state.pts.forEach((q, k) => {
      if (!q) return;
      const d = Math.hypot(f.ox + q[0] * f.s - p.x, f.oy + q[1] * f.s - p.y);
      if (d < best) { best = d; hit = k; }
    });
    let fine = false;
    if (hit < 0 && state.pts.every(Boolean)) {
      // All four are placed: a touch anywhere adjusts the nearest corner
      // rather than throwing one of them across the screen.
      let bestD = Infinity;
      state.pts.forEach((q, k) => {
        const d = Math.hypot(f.ox + q[0] * f.s - p.x, f.oy + q[1] * f.s - p.y);
        if (d < bestD) { bestD = d; hit = k; }
      });
    }
    if (hit >= 0) {
      state.active = hit;
      fine = true; // existing point: move slowly for precision
    } else {
      // A new point goes to the first corner still missing, also after an
      // earlier corner was touched again to adjust it.
      const empty = state.pts.findIndex((q) => !q);
      if (state.pts[state.active] && empty >= 0) state.active = empty;
      state.pts[state.active] = clampPt([(p.x - f.ox) / f.s, (p.y - f.oy) / f.s]);
    }
    state.drag = { id: e.pointerId, start: p, orig: [...state.pts[state.active]], fine, s: f.s };
    canvas.setPointerCapture(e.pointerId);
    updateCalibUI();
  });
  canvas.addEventListener('pointermove', (e) => {
    const d = state.drag;
    if (!d || d.id !== e.pointerId) return;
    const p = local(e);
    const gain = d.fine ? 0.3 : 1;
    state.pts[state.active] = clampPt([d.orig[0] + (p.x - d.start.x) * gain / d.s, d.orig[1] + (p.y - d.start.y) * gain / d.s]);
    requestAnimationFrame(drawOverlay);
  });
  const end = (e) => {
    const d = state.drag;
    if (!d || d.id !== e.pointerId) return;
    state.drag = null;
    if (!d.fine) {
      const next = state.pts.findIndex((q) => !q);
      if (next >= 0) state.active = next;
      else if (!state.orderByHand) checkOrder(); // the fourth corner was just placed
    }
    updateCalibUI();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  $('#calibReset').onclick = () => {
    state.pts = [null, null, null, null];
    state.active = 0;
    state.orderByHand = false;
    updateCalibUI();
  };
  // The names around the box do not match the court: change which point is
  // which corner, without placing the points again.
  $('#rotateNames').onclick = () => { renumberCorners(ROTATE); state.orderByHand = true; updateCalibUI(); };
  $('#flipNames').onclick = () => { renumberCorners(FLIP); state.orderByHand = true; updateCalibUI(); };
  $('#loadPrev').onclick = () => {
    const saved = loadJSON(KEYS.calib, null);
    if (saved?.pts?.length === 4) {
      state.pts = saved.pts.map((p) => [...p]);
      state.active = 0;
      state.orderByHand = false;
      toast('지난번 모서리를 불러왔습니다. 카메라를 옮겼다면 다시 맞추세요.');
      checkOrder(); // (saved by an earlier version, the order may be wrong)
      updateCalibUI();
    }
  };
  $('#calibDone').onclick = finishCalibration;
  $('#calibBack').onclick = () => { stopStream(); video.pause(); releaseWake(); state.last = null; show('home'); };
  $('#camSelect').onchange = async (e) => {
    try {
      await openCamera(e.target.value);
      startCalibration();
    } catch (err) {
      toast(cameraError(err), 6000);
    }
  };
  $('#zoom').oninput = async (e) => {
    const z = Number(e.target.value);
    $('#zoomOut').textContent = `${z.toFixed(1)}x`;
    try {
      await state.track?.applyConstraints({ advanced: [{ zoom: z }] });
      state.zoom = z;
      if (state.pts.some(Boolean)) {
        state.pts = [null, null, null, null];
        state.active = 0;
        state.orderByHand = false;
        updateCalibUI();
        toast('줌을 바꿔서 모서리를 지웠습니다. 다시 맞춰 주세요.');
      }
    } catch { /* zoom not applied */ }
  };
  $('#scrub').oninput = (e) => { video.currentTime = Number(e.target.value); };
  video.addEventListener('seeked', () => requestAnimationFrame(drawOverlay));
}

function clampPt([x, y]) {
  return [Math.min(video.videoWidth, Math.max(0, x)), Math.min(video.videoHeight, Math.max(0, y))];
}

function grabFrame() {
  const c = document.createElement('canvas');
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(video, 0, 0);
  return g.getImageData(0, 0, c.width, c.height);
}

// Which tapped point is which corner. The points stay where they are; only
// their numbers change, and with them the line names around the box.
const ROTATE = [1, 2, 3, 0]; // (1) becomes the point that was (2): every name moves one edge on
const FLIP = [1, 0, 3, 2]; // centre line and sideline change places
function renumberCorners(map) {
  const old = state.pts;
  state.pts = map.map((k) => old[k]);
  state.active = Math.max(0, map.indexOf(state.active));
}

// Started at the wrong corner? Checked as soon as the fourth corner is
// placed, so that the names around the box are right before [완료].
function checkOrder() {
  if (!state.pts.every(Boolean)) return 0;
  const { shift } = orderCorners(state.pts, video.videoWidth, video.videoHeight);
  if (shift) {
    renumberCorners([0, 1, 2, 3].map((i) => (i + shift) % 4));
    toast('모서리를 찍은 순서가 어긋나 있어 바로잡았습니다. 박스 둘레의 라인 이름이 실제 코트와 맞는지 보세요.', 8000);
  }
  return shift;
}

function finishCalibration() {
  let pts = state.pts.map((p) => [...p]);
  // Started at the wrong corner? (Line snapping needs the right order too.)
  // Set with the buttons, the order is the player's: kept as it is.
  const order = state.orderByHand ? { shift: 0 } : orderCorners(pts, video.videoWidth, video.videoHeight);
  if (order.shift) {
    pts = order.pts.map((p) => [...p]);
    state.pts = pts.map((p) => [...p]);
  }
  state.snapResult = null;
  if (settings.snap) {
    try {
      // A finger lands within about 18 screen pixels of where it aims; search
      // that far for the lines, in video pixels.
      const scale = fit($('#calibStage')).s || 1;
      const radius = Math.max(12, Math.min(40, Math.round(18 / scale)));
      const res = snapCorners(grabFrame(), pts, { radius });
      state.snapResult = res;
      pts = res.pts;
    } catch (err) {
      console.warn('line snap failed', err);
    }
  }
  try {
    pipe.setCalibration(pts, video.videoWidth, video.videoHeight);
  } catch (err) {
    toast(err.message || '모서리 위치를 확인해 주세요.', 5000);
    return;
  }
  saveJSON(KEYS.calib, { vw: video.videoWidth, vh: video.videoHeight, pts: state.pts, at: Date.now() });
  const c = pipe.calib;
  const snapMsg = settings.snap ? snapMessage(state.snapResult) : '';
  $('#calibInfo').textContent = `카메라 높이 약 ${c.cam.height.toFixed(1)}m${c.cam.estimated ? '' : ' (추정값)'} · 박스까지 약 ${distanceToBox(c).toFixed(0)}m`;
  const warn = calibrationWarning(c);
  if (order.shift) {
    const msg = '모서리를 찍은 순서가 어긋나 있어 바로잡았습니다. ①은 네트와 센터라인이 만나는 모서리입니다. 박스 둘레에 적힌 라인 이름이 맞는지 확인하세요.';
    toast(warn ? `${msg}\n${warn}` : msg, 10000);
    voice.notice('모서리 순서를 바로잡았어요. 화면의 라인 이름을 확인하세요');
  } else {
    toast(warn || snapMsg || '시작합니다.', warn ? 9000 : 3200);
    if (warn) voice.notice('모서리 위치를 확인해 주세요. 화면에 안내가 있어요');
  }
  startJudging();
}

const LINE_NAMES = { center: '센터라인', side: '사이드라인', service: '서비스라인' };

// What line snapping did, in the player's terms.
function snapMessage(res) {
  if (!res) return '라인 자동 맞춤을 하지 못해 직접 맞춘 위치를 씁니다.';
  const missing = ['center', 'side', 'service'].filter((k) => !res.found.includes(k)).map((k) => LINE_NAMES[k]);
  if (missing.length === 3) return '라인을 찾지 못해 직접 맞춘 위치를 씁니다. 흰 점선이 라인과 겹치는지 확인하세요.';
  if (missing.length) return `${missing.join(', ')}을 찾지 못해 그쪽은 직접 맞춘 위치를 씁니다. 흰 점선이 라인과 겹치는지 확인하세요.`;
  if (res.movedSide) return '사이드라인 쪽 모서리가 복식 라인에 찍혀 있어 단식 라인으로 옮겼습니다.';
  return '라인 3개를 찾아 모서리를 보정했습니다.';
}

// Signs that the corners were not placed as labelled. In/out still follows
// the quadrilateral, but distances and directions would be off.
function calibrationWarning(c) {
  const [, cv, ch] = c.cam.C;
  if (cv < 1) return '모서리를 찍은 순서가 맞지 않는 것 같습니다(카메라가 네트 너머에 있는 것으로 계산됩니다). ①은 네트와 센터라인이 만나는 모서리, 그다음 ②네트·사이드라인 ③서비스라인·사이드라인 ④서비스라인·센터라인 순서입니다. [다시 맞추기]로 확인하세요.';
  if (!c.cam.estimated || ch < 0.4 || ch > 8 || distanceToBox(c) > 40) return '모서리 위치가 코트 모양과 잘 맞지 않습니다. 흰 점선이 실제 라인과 겹치는지 보고, 어긋나면 [다시 맞추기]를 누르세요.';
  if (ch < 1.2) return `카메라 높이가 약 ${ch.toFixed(1)}m로 낮습니다. 라인 근처 판정이 부정확할 수 있으니 가능하면 더 높이 올리세요.`;
  return '';
}

function distanceToBox(c) {
  const [u, v] = c.cam.C;
  return Math.hypot(u - BOX_W / 2, v - BOX_L / 2);
}

// ------------------------------------------------------------- judging --

function startJudging() {
  show('judge');
  renderStats();
  renderCourt();
  renderVerdict(state.last);
  keepAwake();
  if (state.source === 'file') {
    video.playbackRate = Number($('#rateSel').value || 0.5);
    video.play().catch(() => {});
  }
  startLoop();
}

function startLoop() {
  stopLoop();
  state.running = true;
  pipe.resetState();
  timeSource.reset();
  // The camera's stated frame rate tells the clock how long one frame is,
  // also when this phone only manages every other frame.
  const rate = state.source === 'camera' ? Number(state.track?.getSettings?.().frameRate) : 0;
  pipe.clock.nominal = rate > 0 ? 1 / rate : 0;
  state.slowSince = 0;
  state.fpsWindow = { t: 0, n: 0, fps: 0 };
  startWatch();
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    const tick = (now, meta) => {
      if (!state.running) return;
      try { processFrame(now, meta); } catch (err) { console.error(err); }
      state.vfc = video.requestVideoFrameCallback(tick);
    };
    state.vfc = video.requestVideoFrameCallback(tick);
  } else {
    let lastT = -1;
    const tick = (now) => {
      if (!state.running) return;
      if (video.currentTime !== lastT) {
        lastT = video.currentTime;
        try { processFrame(now, null); } catch (err) { console.error(err); }
      }
      state.vfc = requestAnimationFrame(tick);
    };
    state.vfc = requestAnimationFrame(tick);
  }
}

function stopLoop() {
  state.running = false;
  stopWatch();
  if (state.vfc) {
    try { video.cancelVideoFrameCallback?.(state.vfc); } catch { /* ignore */ }
    try { cancelAnimationFrame(state.vfc); } catch { /* ignore */ }
  }
  state.vfc = 0;
}

const timeSource = new TimeSource();
const CLOCK_NAMES = { capture: '촬영 시각', media: '프레임 시각', now: '화면 시각(부정확)' };

// Picks the timestamp for a frame. Returns { t (seconds), trusted, skip }.
function frameTime(now, meta) {
  if (state.source === 'file') {
    // A file's own timestamps are exact, also when its frame rate varies.
    state.timeSource = '영상 시각';
    return { t: meta?.mediaTime ?? video.currentTime, trusted: true };
  }
  // mediaTime is the frame's own timestamp (microseconds); captureTime is
  // rounded by the browser; the callback time follows the display, not the
  // camera, and is the last resort.
  const p = timeSource.pick([
    ['media', meta && meta.mediaTime > 0 ? meta.mediaTime : undefined],
    ['capture', meta && meta.captureTime > 0 ? meta.captureTime / 1000 : undefined],
    ['now', now / 1000],
  ]);
  if (p.switched) pipe.resetState(); // times before and after are not comparable
  state.timeSource = `${CLOCK_NAMES[p.source]}${p.trusted ? '' : ' · 보정'}`;
  // No camera clock on this phone or browser: frame times follow the
  // display and calls near the lines get worse. Say so once.
  if (p.source !== 'now') state.roughSince = 0;
  else if (!state.roughSince) state.roughSince = now;
  else if (!state.roughWarned && now - state.roughSince > 5000) {
    state.roughWarned = true;
    toast('이 브라우저는 프레임 촬영 시각을 알려 주지 않아 라인 근처 판정이 부정확할 수 있습니다. 안드로이드 크롬 최신 버전을 쓰세요.', 9000);
    voice.notice('이 폰에서는 프레임 시각이 부정확해서 라인 근처 판정이 틀릴 수 있어요');
  }
  return p;
}

function processFrame(now, meta) {
  watch.lastFrame = performance.now();
  const c = pipe.calib;
  if (!c || !video.videoWidth) return;
  const ft = frameTime(now, meta);
  if (ft.skip) return; // no usable timestamp for this frame
  const roi = c.roi;
  if (proc.width !== roi.outW || proc.height !== roi.outH) {
    proc.width = roi.outW;
    proc.height = roi.outH;
  }
  const t0 = performance.now();
  pctx.drawImage(video, roi.x, roi.y, roi.w, roi.h, 0, 0, roi.outW, roi.outH);
  const img = pctx.getImageData(0, 0, roi.outW, roi.outH);
  const res = pipe.process(ft.t, img.data, roi.outW, roi.outH, { trusted: ft.trusted });
  const ms = performance.now() - t0;
  state.procMs = state.procMs ? state.procMs * 0.92 + ms * 0.08 : ms;
  state.frames++;
  const w = state.fpsWindow;
  if (!w.t) w.t = now;
  w.n++;
  if (now - w.t > 1000) {
    w.fps = (w.n * 1000) / (now - w.t);
    w.t = now;
    w.n = 0;
    adaptSpeed();
    if (state.source === 'camera') checkShutter();
  }
  for (const ev of res.events) {
    if (ev.type === 'unsure') onUnsure(ev);
    else onCall(ev);
  }
  if (state.debug || res.events.length) requestAnimationFrame(drawOverlay);
}

// Shutter time reported by the camera, in seconds (null if unknown).
// Browsers give it in units of 100 microseconds.
function shutterSeconds() {
  const e = state.track?.getSettings?.().exposureTime;
  return typeof e === 'number' && e > 0 ? e / 10000 : null;
}

// A slow shutter smears the ball into a faint streak that cannot be found.
// The player is at the other end of the court, so the warning is spoken too
// (less often than it is shown).
let lastShutterWarn = 0, lastShutterSaid = 0;
function checkShutter() {
  const sh = shutterSeconds();
  state.shutter = sh;
  if (sh === null || sh <= 1 / 240) return;
  const now = performance.now();
  if (lastShutterWarn && now - lastShutterWarn < 300000) return;
  lastShutterWarn = now;
  toast(`빛이 부족해 셔터가 느립니다(1/${Math.round(1 / sh)}초). 공이 번져서 판정이 안 될 수 있습니다. 밝은 낮에 쓰세요.`, 8000);
  if (!lastShutterSaid || now - lastShutterSaid > 300000) {
    lastShutterSaid = now;
    voice.notice('빛이 부족해서 공이 번져 보여요. 판정이 안 될 수 있어요');
  }
}

// Phones that cannot keep up get a smaller processing region.
function adaptSpeed() {
  const period = 1000 / Math.max(15, Math.min(60, state.track?.getSettings?.().frameRate || 30));
  const slow = state.procMs > period * 0.85;
  const now = performance.now();
  if (!slow) { state.slowSince = 0; return; }
  if (!state.slowSince) { state.slowSince = now; return; }
  if (now - state.slowSince > 3000 && pipe.s.maxPixels > 220000) {
    pipe.s.maxPixels = Math.round(pipe.s.maxPixels * 0.75);
    pipe.setCalibration(pipe.calib.points, pipe.calib.frameW, pipe.calib.frameH);
    state.slowSince = 0;
    toast('처리가 밀려서 분석 해상도를 낮췄습니다.');
  }
}

function onCall(ev) {
  const call = ev.call;
  const rec = { at: Date.now(), u: +ev.court.u.toFixed(3), v: +ev.court.v.toFixed(3), in: call.in, dir: call.dir, gap: +call.gap.toFixed(3), near: call.near };
  state.calls.push(rec);
  if (state.calls.length > 500) state.calls.shift();
  saveJSON(KEYS.calls, state.calls);
  state.last = { ...rec, img: pipe.courtToImage(ev.court.u, ev.court.v), shownAt: performance.now() };
  state.events.push({ t: ev.t, u: ev.court.u, v: ev.court.v, in: call.in, method: ev.method });
  voice.announce(call);
  renderVerdict(state.last);
  renderStats();
  renderCourt();
}

// The ball was followed over the net but its bounce could not be judged.
function onUnsure(ev) {
  state.calls.push({ at: Date.now(), unsure: true });
  if (state.calls.length > 500) state.calls.shift();
  saveJSON(KEYS.calls, state.calls);
  state.last = { unsure: true, shownAt: performance.now() };
  state.unsureEvents.push({ t: ev.t });
  voice.announceUnsure();
  renderVerdict(state.last);
  renderStats();
}

function renderVerdict(rec) {
  const el = $('#verdict');
  if (!rec) {
    el.dataset.state = 'idle';
    $('#verdictMain').textContent = '대기 중';
    $('#verdictSub').textContent = '서브를 넣으면 바로 알려 드립니다';
    return;
  }
  if (rec.unsure) {
    el.dataset.state = 'unsure';
    $('#verdictMain').textContent = '?';
    $('#verdictSub').textContent = '공은 봤지만 판정하지 못했습니다';
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
    return;
  }
  const l = label(rec);
  el.dataset.state = rec.in ? 'in' : 'out';
  $('#verdictMain').textContent = l.main;
  $('#verdictSub').textContent = l.sub || (rec.in ? '박스 안' : '');
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
}

function renderStats() {
  const all = sessionCalls();
  const calls = all.filter((c) => !c.unsure);
  const missed = all.length - calls.length;
  const n = calls.length;
  const ins = calls.filter((c) => c.in).length;
  const outs = calls.filter((c) => !c.in);
  $('#statTotal').textContent = String(n);
  $('#statIn').textContent = n ? `${ins} · ${Math.round((ins / n) * 100)}%` : '0';
  const by = (d) => outs.filter((c) => c.dir === d).length;
  $('#statOut').textContent = `${outs.length}`;
  const parts = [];
  if (outs.length) parts.push(`길게 ${by('long')} · 옆 ${by('wide')} · 센터 ${by('center')}`);
  if (missed) parts.push(`판정 못 함 ${missed}`);
  $('#statOutDetail').textContent = parts.join(' / ');
}

// Today's calls since the stats were last cleared.
function sessionCalls() {
  const since = Math.max(state.since, new Date().setHours(0, 0, 0, 0));
  return state.calls.filter((c) => c.at >= since);
}

// Box from the server's point of view: net at the bottom. For a deuce-side
// setup the centre line is on the right; mirrored for the ad side.
function courtXY(u, v, mirror) {
  return [mirror ? u : BOX_W - u, BOX_L - v];
}

function boxIsAdSide() {
  const p = pipe.calib?.points;
  if (!p) return false;
  const cross = (p[1][0] - p[0][0]) * (p[3][1] - p[0][1]) - (p[1][1] - p[0][1]) * (p[3][0] - p[0][0]);
  return cross < 0;
}

function renderCourt() {
  const svg = $('#court');
  const ad = boxIsAdSide();
  const m = 0.9;
  svg.setAttribute('viewBox', `${-m} ${-m} ${BOX_W + 2 * m} ${BOX_L + 2 * m}`);
  const [cx0] = courtXY(0, 0, ad);
  const sideX = courtXY(BOX_W, 0, ad)[0];
  const calls = sessionCalls().filter((c) => !c.unsure).slice(-40);
  const dots = calls.map((c, i) => {
    const [x, y] = courtXY(c.u, c.v, ad);
    const cx = Math.max(-m + 0.1, Math.min(BOX_W + m - 0.1, x));
    const cy = Math.max(-m + 0.1, Math.min(BOX_L + m - 0.1, y));
    const last = i === calls.length - 1;
    const cls = `dot ${c.in ? 'in' : 'out'}${c.near ? ' near' : ''}${last ? ' last' : ''}`;
    return `<circle class="${cls}" cx="${cx.toFixed(3)}" cy="${cy.toFixed(3)}" r="${last ? 0.2 : 0.13}"/>`;
  }).join('');
  const band = NEAR_BAND;
  svg.innerHTML = `
    <rect class="surface" x="${-m}" y="${-m}" width="${BOX_W + 2 * m}" height="${BOX_L + 2 * m}"/>
    <rect class="nearband" x="${-band}" y="${-band}" width="${BOX_W + 2 * band}" height="${BOX_L + 2 * band}"/>
    <rect class="boxline" x="0" y="0" width="${BOX_W}" height="${BOX_L}"/>
    <line class="net" x1="${-m}" y1="${BOX_L}" x2="${BOX_W + m}" y2="${BOX_L}"/>
    <text class="lbl" x="${BOX_W / 2}" y="${BOX_L + 0.62}">네트</text>
    <text class="lbl" x="${BOX_W / 2}" y="${-0.3}">서비스라인</text>
    <text class="lbl side" x="${cx0 + (ad ? -0.42 : 0.42)}" y="${BOX_L / 2}" transform="rotate(-90 ${cx0 + (ad ? -0.42 : 0.42)} ${BOX_L / 2})">센터</text>
    <text class="lbl side" x="${sideX + (ad ? 0.42 : -0.42)}" y="${BOX_L / 2}" transform="rotate(-90 ${sideX + (ad ? 0.42 : -0.42)} ${BOX_L / 2})">사이드</text>
    ${dots}`;
}

// ---------------------------------------------------------------- overlay --

function sizeCanvas(canvas, stage) {
  const r = stage.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, r.width, r.height);
  return g;
}

// The names of the box's edges, written just outside each edge, so that a
// corner order that does not match the court shows at a glance.
const EDGE_NAMES = ['네트', '사이드라인', '서비스라인', '센터라인']; // edges after corners 0-1, 1-2, 2-3, 3-0
function drawEdgeNames(g, corners) {
  const cx = corners.reduce((a, p) => a + p[0], 0) / 4, cy = corners.reduce((a, p) => a + p[1], 0) / 4;
  g.save();
  g.font = '600 12px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  corners.forEach((p, k) => {
    const q = corners[(k + 1) % 4];
    let mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
    const d = Math.hypot(mx - cx, my - cy) || 1;
    mx += (mx - cx) / d * 14; my += (my - cy) / d * 14;
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(0,0,0,0.75)';
    g.strokeText(EDGE_NAMES[k], mx, my);
    g.fillStyle = '#ffffff';
    g.fillText(EDGE_NAMES[k], mx, my);
  });
  g.restore();
}

// Dashed outlines of the other painted lines, predicted from the box corners.
// If they sit on the real lines, the corners are right.
function drawGuideLines(g, toStage, map) {
  g.save();
  // keep them inside the picture (the stage is wider than the video)
  const [x0, y0] = toStage(0, 0), [x1, y1] = toStage(video.videoWidth, video.videoHeight);
  g.beginPath();
  g.rect(x0, y0, x1 - x0, y1 - y0);
  g.clip();
  g.lineWidth = 1.5;
  g.setLineDash([7, 6]);
  g.strokeStyle = 'rgba(255,255,255,0.7)';
  g.beginPath();
  for (const [a, b] of GUIDE_LINES) {
    const N = 8;
    let pen = false;
    for (let i = 0; i <= N; i++) {
      const q = map(a[0] + (b[0] - a[0]) * i / N, a[1] + (b[1] - a[1]) * i / N);
      if (!q || !Number.isFinite(q[0]) || !Number.isFinite(q[1]) || Math.abs(q[0]) > 1e5 || Math.abs(q[1]) > 1e5) { pen = false; continue; }
      const [x, y] = toStage(q[0], q[1]);
      if (pen) g.lineTo(x, y); else { g.moveTo(x, y); pen = true; }
    }
  }
  g.stroke();
  g.restore();
}

function drawOverlay() {
  if (state.screen === 'calib') drawCalib();
  else if (state.screen === 'judge') drawJudge();
}

function drawCalib() {
  const stage = $('#calibStage');
  const g = sizeCanvas($('#calibOverlay'), stage);
  const f = fit(stage);
  const P = (q) => [f.ox + q[0] * f.s, f.oy + q[1] * f.s];
  const pts = state.pts;
  g.lineWidth = 2;
  g.strokeStyle = 'rgba(214,240,0,0.95)';
  g.beginPath();
  let started = false;
  for (let k = 0; k <= 4; k++) {
    const q = pts[k % 4];
    if (!q) { started = false; continue; }
    const [x, y] = P(q);
    if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
  }
  g.stroke();
  if (pts.every(Boolean)) {
    const H = homography(CORNERS.map((c) => c.uv), pts);
    if (H) {
      // Points behind the camera map to nonsense; keep those in front.
      const map = (u, v) => (H[6] * u + H[7] * v + H[8] > 1e-6 ? applyH(H, u, v) : null);
      drawGuideLines(g, (x, y) => [f.ox + x * f.s, f.oy + y * f.s], map);
    }
    drawEdgeNames(g, pts.map((q) => P(q)));
  }
  // The instruction panel lies over the picture: fade it while a corner is
  // being moved or sits underneath it.
  {
    const panel = $('#calibPanel');
    const q = pts[state.active];
    let under = false;
    if (q) {
      const r = panel.getBoundingClientRect();
      const x = f.left + f.ox + q[0] * f.s, y = f.top + f.oy + q[1] * f.s;
      under = x > r.left - 28 && x < r.right + 28 && y > r.top - 28 && y < r.bottom + 28;
    }
    panel.classList.toggle('faded', !!state.drag || under);
  }
  pts.forEach((q, k) => {
    if (!q) return;
    const [x, y] = P(q);
    const active = k === state.active;
    g.beginPath();
    g.arc(x, y, active ? 13 : 10, 0, Math.PI * 2);
    g.fillStyle = active ? 'rgba(214,240,0,0.28)' : 'rgba(0,0,0,0.35)';
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = active ? '#d6f000' : '#ffffff';
    g.stroke();
    g.beginPath();
    g.moveTo(x - 4, y); g.lineTo(x + 4, y); g.moveTo(x, y - 4); g.lineTo(x, y + 4);
    g.stroke();
    g.font = '600 13px system-ui, sans-serif';
    g.fillStyle = '#ffffff';
    g.fillText(String(k + 1), x + 14, y - 12);
  });
  drawLoupe(f);
}

function drawLoupe(f) {
  const loupe = $('#loupe');
  const q = state.pts[state.active];
  if (!q || !video.videoWidth) { loupe.hidden = true; return; }
  loupe.hidden = false;
  const stage = $('#calibStage');
  const r = stage.getBoundingClientRect();
  // Keep the loupe away from the point being placed.
  const onLeft = f.ox + q[0] * f.s > r.width / 2;
  loupe.classList.toggle('left', onLeft);
  const size = loupe.clientWidth || 168;
  const dpr = window.devicePixelRatio || 1;
  if (loupe.width !== size * dpr) { loupe.width = size * dpr; loupe.height = size * dpr; }
  const g = loupe.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const span = 36; // video pixels across the loupe
  const k = size / span;
  g.imageSmoothingEnabled = false;
  g.fillStyle = '#000';
  g.fillRect(0, 0, size, size);
  g.drawImage(video, q[0] - span / 2, q[1] - span / 2, span, span, 0, 0, size, size);
  // neighbouring edges of the box
  g.strokeStyle = 'rgba(214,240,0,0.9)';
  g.lineWidth = 1.5;
  const L = (p) => [(p[0] - q[0]) * k + size / 2, (p[1] - q[1]) * k + size / 2];
  for (const nb of [(state.active + 1) % 4, (state.active + 3) % 4]) {
    const o = state.pts[nb];
    if (!o) continue;
    const a = L(q), b = L(o);
    g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
  }
  g.strokeStyle = '#ff3b6b';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(size / 2, 0); g.lineTo(size / 2, size);
  g.moveTo(0, size / 2); g.lineTo(size, size / 2);
  g.stroke();
}

function drawJudge() {
  const stage = $('#judgeStage');
  const g = sizeCanvas($('#judgeOverlay'), stage);
  const c = pipe.calib;
  if (!c) return;
  const f = fit(stage);
  const P = (x, y) => [f.ox + x * f.s, f.oy + y * f.s];
  // box outline from the box model (after line snapping)
  g.lineWidth = 2;
  g.strokeStyle = 'rgba(214,240,0,0.9)';
  g.beginPath();
  CORNERS.forEach((cn, k) => {
    const [x, y] = P(...pipe.courtToImage(cn.uv[0], cn.uv[1]));
    if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
  });
  g.closePath();
  g.stroke();
  {
    const H = c.H;
    const map = (u, v) => (H[6] * u + H[7] * v + H[8] > 1e-6 ? applyH(H, u, v) : null);
    drawGuideLines(g, P, map);
    drawEdgeNames(g, CORNERS.map((cn) => P(...pipe.courtToImage(cn.uv[0], cn.uv[1]))));
  }
  if (state.debug) {
    const roi = c.roi;
    const [x0, y0] = P(roi.x, roi.y);
    g.setLineDash([6, 5]);
    g.strokeStyle = 'rgba(255,255,255,0.7)';
    g.strokeRect(x0, y0, roi.w * f.s, roi.h * f.s);
    g.setLineDash([]);
    g.strokeStyle = '#4fd8ff';
    for (const cd of pipe.lastCands) {
      const [x, y] = P(cd.x, cd.y);
      g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.stroke();
    }
    g.strokeStyle = '#ff5fd2';
    for (const tr of pipe.tracker.tracks) {
      if (tr.pts.length < 2) continue;
      g.beginPath();
      tr.pts.forEach((p, k) => { const [x, y] = P(p.x, p.y); if (k) g.lineTo(x, y); else g.moveTo(x, y); });
      g.stroke();
    }
    g.font = '12px ui-monospace, monospace';
    g.fillStyle = '#ffffff';
    const s = pipe.stats;
    const sh = state.shutter ? ` · 셔터 1/${Math.round(1 / state.shutter)}초` : '';
    g.fillText(`처리 ${state.procMs.toFixed(1)}ms · ${state.fpsWindow.fps.toFixed(0)}fps · ${state.timeSource}${sh} · 후보 ${pipe.lastCands.length} · 흔들림 건너뜀 ${s.skipped}`, 10, f.h - 12);
  }
  const last = state.last;
  if (last && last.img) {
    const age = (performance.now() - last.shownAt) / 1000;
    if (age < 4) {
      const [x, y] = P(last.img[0], last.img[1]);
      g.globalAlpha = Math.max(0, 1 - age / 4);
      g.lineWidth = 3;
      g.strokeStyle = last.in ? '#2fd27a' : '#ff5a4a';
      g.beginPath(); g.arc(x, y, 16, 0, Math.PI * 2); g.stroke();
      g.globalAlpha = 1;
      requestAnimationFrame(drawOverlay);
    }
  }
}

// -------------------------------------------------------------- sound test --

const soundTest = { timer: 0, sayTimer: 0, n: 0 };
function startSoundTest() {
  voice.unlock();
  keepAwake(); // the player walks away from the phone; the screen must not sleep
  $('#soundtest').hidden = false;
  soundTest.n = 0;
  const step = () => {
    soundTest.n++;
    $('#soundCount').textContent = String(soundTest.n);
    voice.beep('test');
    soundTest.sayTimer = setTimeout(() => voice.say(voice.countWord(soundTest.n)), 120);
    if (soundTest.n >= 60) { soundTest.timer = setTimeout(stopSoundTest, 1500); return; }
    soundTest.timer = setTimeout(step, 2000);
  };
  step();
}
function stopSoundTest() {
  clearTimeout(soundTest.timer);
  clearTimeout(soundTest.sayTimer);
  voice.hush();
  $('#soundtest').hidden = true;
  if (state.screen !== 'judge') releaseWake();
}

// ------------------------------------------------------------ wake lock --

async function keepAwake() {
  state.wantWake = true;
  try {
    if (!('wakeLock' in navigator)) throw new Error('unsupported');
    if (state.wake) return;
    const lock = await navigator.wakeLock.request('screen');
    // the request takes a moment; the screen may have been left meanwhile
    if (!state.wantWake || state.wake) { lock.release().catch(() => {}); return; }
    state.wake = lock;
    lock.addEventListener?.('release', () => { if (state.wake === lock) state.wake = null; });
  } catch {
    // Refused (battery saver, or the page is not showing) or not supported:
    // the screen will switch off by itself and the judging stops with it.
    // (Not when a video file is being played back: the player is at the phone.)
    const away = !(state.source === 'file' && state.screen === 'judge');
    if (!away || !state.wantWake || document.visibilityState !== 'visible') return;
    if (!state.wakeWarned) {
      state.wakeWarned = true;
      toast('화면 꺼짐 방지를 켜지 못했습니다. 화면이 꺼지면 판정도 멈추니, 휴대폰 설정에서 화면 자동 꺼짐 시간을 길게(10분 이상) 바꿔 주세요.', 10000);
    }
    // Spoken when judging starts (during the sound test the counting would cut it off).
    if (!state.wakeSaid && state.screen === 'judge') {
      state.wakeSaid = true;
      voice.notice('화면 꺼짐 방지를 켜지 못했어요. 화면 자동 꺼짐 시간을 길게 바꿔 주세요');
    }
  }
}

function releaseWake() {
  state.wantWake = false;
  state.wake?.release?.().catch?.(() => {});
  state.wake = null;
}

document.addEventListener('visibilitychange', () => {
  // Say at once that the judging has stopped, or resumed. Coming back, the
  // camera gets a moment before a missing picture counts as frozen.
  if (document.visibilityState === 'visible') watch.lastFrame = performance.now();
  if (state.running) checkWatch();
  if (document.visibilityState !== 'visible') return;
  // The lock is dropped whenever the page is hidden; take it again.
  if (state.screen === 'judge' || !$('#soundtest').hidden) keepAwake();
});

// ------------------------------------------------------------- attention --
// Judging has stopped and only the player can put it right, but the player
// is not at the phone: keep saying so until the phone is touched.

const attention = { timer: 0 };
function callForAttention(text) {
  stopAttention();
  voice.alert(text);
  attention.timer = setInterval(() => voice.alert(text), 20000);
}
function stopAttention() {
  if (!attention.timer) return;
  clearInterval(attention.timer);
  attention.timer = 0;
  voice.hush();
}
document.addEventListener('pointerdown', stopAttention, true);

// --------------------------------------------------------------- watchdog --
// The player stands at the far end of the court and cannot see the phone.
// When the judging stops (screen off, another app in front, camera lost or
// frozen) they must hear about it, or they would take silence for "net".

const watch = { timer: 0, lastFrame: 0, problem: '', saidAt: 0, reopening: false };
const PROBLEMS = {
  hidden: { text: '화면이 꺼졌거나 다른 앱이 떠 있어 판정이 멈췄습니다.', say: '화면이 꺼져서 판정이 멈췄어요' },
  ended: { text: '카메라가 꺼졌습니다. 다시 켜는 중입니다. 계속 이 상태면 [끝내기] 후 다시 시작하세요.', say: '카메라가 꺼졌어요. 휴대폰을 확인하세요' },
  stalled: { text: '카메라 화면이 멈췄습니다. 휴대폰을 확인하세요.', say: '카메라 화면이 멈췄어요. 휴대폰을 확인하세요' },
};

function startWatch() {
  stopWatch();
  if (state.source !== 'camera') return;
  watch.lastFrame = performance.now();
  watch.timer = setInterval(checkWatch, 1000);
}

function stopWatch() {
  clearInterval(watch.timer);
  watch.timer = 0;
  watch.problem = '';
  showAlert('');
}

function showAlert(text) {
  const el = $('#alertBar');
  el.textContent = text;
  el.hidden = !text;
}

function checkWatch() {
  if (!state.running || state.source !== 'camera') return;
  const now = performance.now();
  let problem = '';
  if (document.visibilityState !== 'visible') problem = 'hidden';
  else if (!state.track || state.track.readyState === 'ended') problem = 'ended';
  else if (state.track.muted || now - watch.lastFrame > 2500) problem = 'stalled';
  if (problem === 'ended') reopenCamera();
  if (problem === watch.problem) {
    // still wrong: say it again now and then
    if (problem && now - watch.saidAt > 20000) { watch.saidAt = now; voice.alert(PROBLEMS[problem].say, problem === 'hidden'); }
    return;
  }
  watch.problem = problem;
  if (problem) {
    watch.saidAt = now;
    showAlert(PROBLEMS[problem].text);
    voice.alert(PROBLEMS[problem].say, problem === 'hidden');
  } else {
    showAlert('');
    pipe.resetState();
    timeSource.reset();
    voice.hush();
    voice.say('다시 판정합니다');
  }
}

// The camera was taken away (another app used it, or the system closed it):
// open it again with the same view and carry on.
async function reopenCamera() {
  if (watch.reopening) return;
  watch.reopening = true;
  try {
    await openCamera(state.deviceId, { keepZoom: true });
    // the player may have left meanwhile: no camera on the home screen
    if (state.screen === 'home') { stopStream(); video.pause(); return; }
    if (state.screen !== 'judge') return;
    if (pipe.calib && video.videoWidth === pipe.calib.frameW && video.videoHeight === pipe.calib.frameH) {
      startLoop();
      showAlert('');
      voice.hush(); // the warning may not have been spoken yet; the news is better now
      voice.say('카메라가 다시 켜졌어요. 카메라가 움직였으면 모서리를 다시 맞추세요');
    } else {
      toast('카메라가 다시 켜졌지만 화면 크기가 달라져 모서리를 다시 맞춰야 합니다.', 6000);
      startCalibration();
      callForAttention('카메라 화면이 바뀌어서 판정이 멈췄어요. 휴대폰에서 모서리를 다시 맞춰 주세요');
    }
  } catch { /* still not available; the next check tries again */ } finally {
    watch.reopening = false;
  }
}

// ------------------------------------------------------------------ wiring --

function bindHome() {
  $('#startCam').onclick = async () => {
    voice.unlock();
    $('#startCam').disabled = true;
    try {
      await openCamera(null);
      startCalibration();
      if (!voice.hasSpeech) toast('이 브라우저는 음성 합성을 지원하지 않아 효과음만 냅니다.', 5000);
      else {
        // Voices load asynchronously; only warn when a list exists without Korean.
        setTimeout(() => {
          if (voice.voiceCount > 0 && !voice.hasKoreanVoice) toast('한국어 음성이 없어 기본 음성으로 읽습니다. 휴대폰 설정 → 텍스트 음성 변환에서 한국어를 추가하세요.', 6000);
        }, 2000);
      }
    } catch (err) {
      toast(cameraError(err), 7000);
    } finally {
      $('#startCam').disabled = false;
    }
  };
  $('#fileInput').onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    voice.unlock();
    stopStream();
    video.srcObject = null;
    video.src = URL.createObjectURL(file);
    video.muted = true;
    video.playsInline = true;
    state.source = 'file';
    e.target.value = '';
    const opened = await new Promise((resolve) => {
      const done = (ok) => { video.removeEventListener('loadedmetadata', onOk); video.removeEventListener('error', onErr); resolve(ok); };
      const onOk = () => done(true), onErr = () => done(false);
      video.addEventListener('loadedmetadata', onOk);
      video.addEventListener('error', onErr);
    });
    if (!opened || !video.videoWidth) {
      toast('이 영상은 열 수 없습니다. 폰으로 찍은 MP4나 WebM 영상을 골라 주세요.', 6000);
      state.source = null;
      return;
    }
    await new Promise((r) => { video.currentTime = Math.min(0.5, (video.duration || 1) / 2); video.addEventListener('seeked', r, { once: true }); });
    startCalibration();
  };
  $('#soundTestBtn').onclick = startSoundTest;
  $('#soundStop').onclick = stopSoundTest;
}

function bindJudge() {
  $('#recalib').onclick = () => {
    stopLoop();
    if (state.source === 'file') video.pause();
    state.pts = pipe.calib ? pipe.calib.points.map((p) => [...p]) : [null, null, null, null];
    state.active = 0;
    startCalibration({ keepPoints: true });
  };
  $('#clearStats').onclick = () => {
    state.since = Date.now(); // kept in memory too: storage can be unavailable
    saveJSON('servecall.since.v1', state.since);
    state.last = null;
    renderStats();
    renderCourt();
    renderVerdict(null);
    toast('기록을 지웠습니다.');
  };
  $('#debugBtn').onclick = () => {
    state.debug = !state.debug;
    $('#debugBtn').setAttribute('aria-pressed', String(state.debug));
    requestAnimationFrame(drawOverlay);
  };
  $('#judgeSound').onclick = () => { voice.unlock(); voice.say('소리 확인'); };
  $('#stopBtn').onclick = () => {
    stopLoop();
    stopStream();
    video.pause();
    releaseWake();
    voice.hush();
    state.last = null; // the next session starts from "waiting", not from the last call
    show('home');
  };
  $('#dimBtn').onclick = () => { $('#dim').hidden = false; };
  $('#dim').onclick = () => { $('#dim').hidden = true; };
  $('#rateSel').onchange = (e) => { video.playbackRate = Number(e.target.value); };
  video.addEventListener('seeking', () => pipe.resetState());
  video.addEventListener('ended', () => { if (state.source === 'file') toast('영상이 끝났습니다.'); });
  video.addEventListener('resize', () => {
    if (!video.videoWidth) return;
    if (state.screen === 'judge' && pipe.calib && (video.videoWidth !== pipe.calib.frameW || video.videoHeight !== pipe.calib.frameH)) {
      const away = state.source === 'camera';
      toast('화면 방향이나 해상도가 바뀌어 모서리를 다시 맞춰야 합니다.', 5000);
      startCalibration();
      // the player is at the other end of the court and would hear nothing more
      if (away) callForAttention('카메라 화면이 바뀌어서 판정이 멈췄어요. 휴대폰에서 모서리를 다시 맞춰 주세요');
    } else if (state.screen === 'calib' && state.calibSize && (video.videoWidth !== state.calibSize[0] || video.videoHeight !== state.calibSize[1])) {
      // the points placed so far belong to the old picture
      const had = state.pts.some(Boolean);
      startCalibration();
      if (had) toast('화면 방향이나 해상도가 바뀌어 모서리를 지웠습니다. 다시 맞춰 주세요.', 5000);
    }
  });
  window.addEventListener('resize', () => requestAnimationFrame(drawOverlay));
}

bindSettings();
bindHome();
bindCalibration();
bindJudge();
renderStats();

// Offline support: keep a copy of the app for courts without reception.
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* optional */ });
}

// Test hook (used by the automated browser test).
window.__servecall = {
  pipe,
  voice,
  state,
  watch,
  setPoints(pts) {
    state.pts = pts.map((p) => [...p]);
    updateCalibUI();
  },
  finish: () => finishCalibration(),
};
