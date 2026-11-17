// Service box model and in/out judgement.
//
// Box coordinates (metres):
//   u = 0 on the far edge of the centre service line, u = BOX_W on the outer
//   edge of the singles sideline; v = 0 at the net, v = BOX_L on the outer
//   edge of the service line. A ball touching any line is in, so the box
//   boundary is the outer edge of each line. The centre service line (5 cm)
//   belongs to both boxes, which is why BOX_W includes its full width.

import { homography, cameraFromHomography } from './geometry.js';

export const BOX_W = 4.115 + 0.025;
export const BOX_L = 6.40;
export const BALL_R = 0.0335;

// Radius of the contact patch of a ball pressed onto the court; used when
// only the landing point is known. (The ball's overhang does not count; only
// what touches the ground does.)
export const CONTACT_RADIUS = 0.025;

// Within this distance of a line the call is reported as close.
export const NEAR_BAND = 0.10;

// Order the user taps the corners in, matched to box coordinates.
export const CORNERS = [
  { key: 'netCenter', label: '네트 쪽 · 센터라인', uv: [0, 0] },
  { key: 'netSide', label: '네트 쪽 · 사이드라인', uv: [BOX_W, 0] },
  { key: 'serviceSide', label: '서비스라인 · 사이드라인', uv: [BOX_W, BOX_L] },
  { key: 'serviceCenter', label: '서비스라인 · 센터라인', uv: [0, BOX_L] },
];

// Could a player have set this camera up for the app? Standing on the
// receiver's side of the net, as the app tells them to, at a tripod's
// height, with a phone's lens.
function plausibleCamera(cam) {
  return !!cam && cam.estimated && cam.C[1] > 2 && cam.height > 0.4 && cam.height < 8 && cam.hfov > 25 && cam.hfov < 120;
}

// No camera could have taken the picture this way: behind the net, the
// corners matching no lens, or not at a tripod's height.
function impossibleCamera(cam) {
  return !cam || !cam.estimated || cam.C[1] < 1 || cam.height < 0.3 || cam.height > 10;
}

// The corners are tapped in CORNERS order. Starting at the wrong corner
// while going round the right way is an easy slip (the corner nearest the
// camera is the obvious place to begin). The four points still outline the
// box, so in or out comes out the same, but everything that needs to know
// which edge is the net goes wrong: the camera works out behind the net or
// with a lens no phone has, serves are not recognised, and directions and
// distances are spoken for the wrong lines. So: if the taps, taken as they
// were made, describe no possible camera, and starting at exactly one of
// the other corners gives a plausible one, that is what the player meant.
// (Taps that describe some possible camera are left as they are, even an
// odd one: a zoomed or wide lens must not be "corrected".)
// pts: 4 image points as tapped; W, H: picture size.
// Returns { pts (in CORNERS order), shift (0 = as tapped) }.
// NOT USED any more: with a finger's error in the taps it also renumbered
// right orders (the app now shows the line names and lets the player
// renumber with two buttons). Kept for one release so that a phone still
// holding the previous app.js, which imports it, can start with this file.
export function orderCorners(pts, W, H) {
  const uv = CORNERS.map((c) => c.uv);
  const camFor = (shift) => {
    const q = [0, 1, 2, 3].map((i) => pts[(i + shift) % 4]);
    const Hm = homography(uv, q);
    return { q, cam: Hm ? cameraFromHomography(Hm, W, H) : null };
  };
  if (!impossibleCamera(camFor(0).cam)) return { pts, shift: 0 };
  const ok = [1, 2, 3].map((shift) => ({ shift, ...camFor(shift) })).filter((c) => plausibleCamera(c.cam));
  if (ok.length !== 1) return { pts, shift: 0 };
  return { pts: ok[0].q, shift: ok[0].shift };
}

// Centre lines of the painted lines around the box, as segments in box
// coordinates. Drawn over the camera picture so the player can see at a
// glance whether the corners were placed on the right lines.
const BASE = 11.885; // net to the outer edge of the baseline
export const GUIDE_LINES = [
  [[BOX_W + 1.345, 0], [BOX_W + 1.345, BASE]], // doubles sideline, this side
  [[BOX_W - 0.025, BOX_L], [BOX_W - 0.025, BASE]], // singles sideline beyond the box
  [[-4.065, 0], [-4.065, BASE]], // singles sideline of the other box
  [[-5.435, 0], [-5.435, BASE]], // doubles sideline, other side
  [[-4.065, BOX_L - 0.025], [0, BOX_L - 0.025]], // service line across the other box
  [[-5.46, BASE - 0.05], [BOX_W + 1.37, BASE - 0.05]], // baseline
];

// Signed distance (m) from the box: negative inside, positive outside.
export function boxSignedDistance(u, v) {
  const du = Math.max(-u, u - BOX_W), dv = Math.max(-v, v - BOX_L);
  if (du <= 0 && dv <= 0) return Math.max(du, dv);
  return Math.hypot(Math.max(du, 0), Math.max(dv, 0));
}

// Judges a contact mark given as discs { u, v, a } (centre and radius, m).
// The ball is in when any disc touches the box (lines included).
// Returns { in, dir, gap, near, u, v }:
//   gap: metres between the mark and the box (> 0 = out by that much)
//   dir: 'long' | 'wide' | 'center' | 'net' | null (the side it missed on)
//   u, v: the reference point passed in (where the call is drawn)
export function judgeMark(mark, ref = mark[mark.length >> 1]) {
  let gap = Infinity, at = mark[0];
  for (const m of mark) {
    const g = boxSignedDistance(m.u, m.v) - m.a;
    if (g < gap) { gap = g; at = m; }
  }
  const isIn = gap <= 0;
  let dir = null;
  if (!isIn) {
    const sides = [['long', at.v - BOX_L], ['wide', at.u - BOX_W], ['center', -at.u], ['net', -at.v]];
    let worst = -Infinity;
    for (const [d, val] of sides) if (val > worst) { worst = val; dir = d; }
  }
  return { in: isIn, dir, gap, near: Math.abs(gap) < NEAR_BAND, u: ref.u, v: ref.v };
}

// Judges a single landing point.
export function judge(u, v) {
  return judgeMark([{ u, v, a: CONTACT_RADIUS }]);
}

function distanceWords(m) {
  const cm = Math.max(5, Math.round(m * 100 / 5) * 5);
  if (cm < 100) return `${cm}센티`;
  if (m >= 3) return '3미터 이상';
  const dm = Math.round(m * 10);
  const whole = Math.floor(dm / 10), rest = dm % 10;
  return rest ? `${whole}미터 ${rest * 10}` : `${whole}미터`;
}

const DIR_WORDS = { long: '길게', wide: '옆으로', center: '센터 쪽', net: '네트 앞' };

// Short phrase spoken in the earphones.
export function phrase(j) {
  if (j.in) return j.near ? '인. 라인 근처' : '인';
  return `아웃. ${DIR_WORDS[j.dir]} ${distanceWords(j.gap)}`;
}

// Short label for the screen.
export function label(j) {
  if (j.in) return { main: 'IN', sub: j.near ? '라인 근처' : '' };
  return { main: 'OUT', sub: `${DIR_WORDS[j.dir]} ${distanceWords(j.gap)}` };
}
