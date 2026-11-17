// Writes a synthetic serve video (Y4M, and WebM when ffmpeg is available) plus
// the ground truth, for the browser end-to-end test.
//   node test/make-video.js [outDir]

import { openSync, writeSync, closeSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { CORNERS } from '../src/court.js';
import { makeCamera, renderBackground, FrameRenderer, aimServe, exposurePositions, boxToWorld, worldToBox, markGap } from './sim.js';

const W = 960, H = 540, FPS = 30;
// A serve every 3.6 s: about as fast as anyone can serve from a basket.
const IDLE = 2.0, SLOT = 3.6, LEAD = 0.55;
// Clear-cut targets (box metres): in, long, in, wide, in, centre side.
const TARGETS = [[2.0, 5.6], [1.5, 6.9], [3.6, 4.0], [4.6, 3.5], [0.8, 6.1], [-0.4, 4.5]];

export function makeVideo(outDir) {
  mkdirSync(outDir, { recursive: true });
  const cam = makeCamera({ pos: [6.5, 25.3, 2.5], target: [-2.05, 15.6, 0.3], W, H, hfov: 66 });
  const fr = new FrameRenderer(cam, renderBackground(cam), { seed: 9, chroma: false });
  const corners = CORNERS.map((c) => { const [X, Y] = boxToWorld(...c.uv); return cam.project([X, Y, 0]).slice(0, 2); });
  const serves = TARGETS.map(([u, v], i) => {
    const [X, Y] = boxToWorld(u, v);
    for (const speed of [40, 36, 32, 28]) {
      const traj = aimServe({ start: [0.8, 0, 2.6], X, Y, speed, spin: 6, e: 0.75, mu: 0.65 });
      if (traj && traj.netClear > 0.05) {
        const [tu, tv] = worldToBox(traj.contact.X, traj.contact.Y);
        const tBounce = IDLE + i * SLOT + LEAD;
        return { traj, u: tu, v: tv, in: markGap(traj.contact) <= 0, gap: markGap(traj.contact), tBounce };
      }
    }
    throw new Error(`cannot aim serve ${i}`);
  });
  const total = IDLE + serves.length * SLOT + 0.5;
  const nFrames = Math.round(total * FPS);
  const y4m = join(outDir, 'serves.y4m');
  const fd = openSync(y4m, 'w');
  writeSync(fd, `YUV4MPEG2 W${W} H${H} F${FPS}:1 Ip A1:1 C420\n`);
  const Y = new Uint8Array(W * H), U = new Uint8Array((W / 2) * (H / 2)), V = new Uint8Array((W / 2) * (H / 2));
  const full = { x: 0, y: 0, w: W, h: H };
  for (let k = 0; k < nFrames; k++) {
    const t = k / FPS;
    let pos = [];
    const i = Math.floor((t - IDLE) / SLOT);
    if (i >= 0 && i < serves.length) {
      const s = serves[i];
      const local = t - s.tBounce + s.traj.contact.t;
      pos = exposurePositions(s.traj, local, 1 / 1000);
    }
    const rgba = fr.render(full, pos);
    // BT.601 limited range
    for (let p = 0, j = 0; p < W * H; p++, j += 4) {
      Y[p] = Math.max(16, Math.min(235, 16 + 0.257 * rgba[j] + 0.504 * rgba[j + 1] + 0.098 * rgba[j + 2]));
    }
    for (let by = 0; by < H / 2; by++) {
      for (let bx = 0; bx < W / 2; bx++) {
        let r = 0, g = 0, b = 0;
        for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const j = ((by * 2 + oy) * W + bx * 2 + ox) * 4;
          r += rgba[j]; g += rgba[j + 1]; b += rgba[j + 2];
        }
        r /= 4; g /= 4; b /= 4;
        const q = by * (W / 2) + bx;
        U[q] = Math.max(16, Math.min(240, 128 - 0.148 * r - 0.291 * g + 0.439 * b));
        V[q] = Math.max(16, Math.min(240, 128 + 0.439 * r - 0.368 * g - 0.071 * b));
      }
    }
    writeSync(fd, 'FRAME\n');
    writeSync(fd, Y); writeSync(fd, U); writeSync(fd, V);
  }
  closeSync(fd);
  let webm = null;
  try {
    webm = join(outDir, 'serves.webm');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', y4m, '-c:v', 'libvpx', '-b:v', '8M', '-crf', '4', '-qmin', '0', '-qmax', '20', '-auto-alt-ref', '0', webm]);
  } catch {
    webm = null;
  }
  const truth = {
    W, H, fps: FPS, corners, idle: IDLE, slot: SLOT, frames: nFrames,
    serves: serves.map((s) => ({ u: s.u, v: s.v, in: s.in, gap: s.gap, tBounce: s.tBounce })),
  };
  writeFileSync(join(outDir, 'truth.json'), JSON.stringify(truth, null, 2));
  return { y4m, webm, truth };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2] || new URL('./out/', import.meta.url).pathname;
  const r = makeVideo(out);
  console.log(`wrote ${r.y4m}${r.webm ? ' and ' + r.webm : ''} (${r.truth.frames} frames)`);
  for (const s of r.truth.serves) console.log(`  t=${s.tBounce.toFixed(2)}s (${s.u.toFixed(2)}, ${s.v.toFixed(2)}) ${s.in ? 'IN' : 'OUT'}`);
  if (!existsSync(out)) process.exit(1);
}
