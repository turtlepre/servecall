// Lets the app open at the court without a connection. Network first, so a
// connected phone gets the current version; the stored copy is used when the
// network does not answer within a few seconds.
//
// The stored copy is always one complete version of the app. It is written
// only as a whole - when this worker installs, and again in the background
// after the app was opened with a working connection - never file by file,
// and a page opened from the store gets all its files from that one copy.
// So a weak signal during an update cannot leave a mix of two versions.

const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest', 'icon.svg',
  'src/app.js', 'src/pipeline.js', 'src/detector.js', 'src/tracker.js', 'src/refine.js',
  'src/bounce.js', 'src/timing.js', 'src/snap.js', 'src/geometry.js', 'src/court.js',
  'src/voice.js', 'src/store.js',
];
const WAIT = 2500; // ms to wait for the network when a stored copy exists

const ROOT = new URL('./', self.location).href;
// Names of this copy of the app (one host can serve several).
const NS = `servecall ${new URL(ROOT).pathname}`;
const META = `${NS} meta`;
const SET = `${NS} set `; // + a number: one complete copy
const POINTER = `${ROOT}__store__`; // in META: which copy is in use, and the one before
const OLD = /^servecall-v\d+$/; // stores of earlier versions of this worker

// Stored under the address without its query part, so that ?anything does
// not need another copy.
const keyOf = (url) => { const u = new URL(url); return u.origin + u.pathname; };

// The copy in use and the one before it (a page may still be loading from
// that). Kept in the store, as the browser can stop this worker and start
// it again at any time.
let sets = null;
async function getSets() {
  if (!sets) {
    let s = null;
    try {
      const r = await caches.match(POINTER, { cacheName: META });
      if (r) s = await r.json();
    } catch { /* nothing stored yet */ }
    s = s || { current: null, previous: null };
    // (a copy can be gone, cleared by the browser)
    if (s.current && !(await caches.has(s.current))) s.current = s.previous && (await caches.has(s.previous)) ? s.previous : null;
    sets = s;
  }
  return sets;
}

async function useSet(name) {
  const { current } = await getSets();
  const next = { current: name, previous: current };
  await (await caches.open(META)).put(POINTER, new Response(JSON.stringify(next)));
  sets = next;
  // copies older than the one before
  for (const k of await caches.keys()) {
    if (k.startsWith(SET) && k !== next.current && k !== next.previous) await caches.delete(k);
  }
}

// Downloads the whole app as a new copy. All or nothing: a copy with a file
// missing would start a broken app. Each answer is read to the end at once;
// left unread, they would hold the few connections a browser allows and
// the rest would never start. Only the type is kept of the headers: what
// the host said about compression and length no longer applies to the
// stored body (and a redirected answer could not open a page later).
async function download() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60000);
  try {
    const got = await Promise.all(SHELL.map(async (path) => {
      const url = new URL(path, ROOT).href;
      const res = await fetch(url, { cache: 'no-cache', signal: ctl.signal });
      if (!res.ok) throw new Error(`${path}: ${res.status}`);
      const body = await res.blob();
      return [keyOf(url), new Response(body, { headers: { 'content-type': res.headers.get('content-type') || body.type } })];
    }));
    const name = SET + Date.now();
    const cache = await caches.open(name);
    try {
      await Promise.all(got.map(([k, r]) => cache.put(k, r)));
    } catch (err) {
      await caches.delete(name);
      throw err;
    }
    return name;
  } finally {
    clearTimeout(timer);
    ctl.abort(); // (after a failure: stop what is still loading)
  }
}

// After the app was opened with a working connection, the stored copy is
// renewed in the background - once the page has loaded its own files.
let renewing = null;
function renew() {
  if (!renewing) {
    renewing = (async () => {
      await new Promise((r) => { setTimeout(r, 4000); });
      try { await useSet(await download()); } catch { /* keep the copy there is */ }
      renewing = null;
    })();
  }
  return renewing;
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    await useSet(await download());
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (OLD.test(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

// Pages that were opened from the store, and the copy each came from.
const fromStore = new Map();
function opened(id, name) {
  if (!id || !name) return;
  fromStore.set(id, name);
  if (fromStore.size > 20) fromStore.delete(fromStore.keys().next().value);
}
// A page that came from the network but then could not get one of its
// scripts in time is opened again, this time from the store (once).
let reopenAt = 0, reopenUntil = 0;

// An answer that came too late, or was not used: let its connection go.
const drop = (p) => { p.then((r) => r && r.body && r.body.cancel()).catch(() => {}); };

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(answer(e));
});

async function answer(e) {
  const req = e.request, key = keyOf(req.url);
  const page = req.mode === 'navigate';
  if (page) sets = null; // (a newer worker may have changed it meanwhile)
  const { current } = await getSets();
  // A page opened from the store gets all its files from that same copy.
  const own = page ? null : fromStore.get(e.clientId);
  if (own) {
    const r = await caches.match(key, { cacheName: own });
    if (r) return r;
  }
  const stored = current ? await caches.match(key, { cacheName: current }) : undefined;
  if (!stored) {
    // Not part of the app (or nothing stored yet): only the network can answer.
    try {
      return await fetch(req);
    } catch (err) {
      // An address the app does not know, opened without a connection: go
      // to the app itself (its own address, so that its files are found).
      if (page && key !== keyOf(ROOT) && current && await caches.match(keyOf(ROOT), { cacheName: current })) return Response.redirect(ROOT, 302);
      throw err;
    }
  }
  if (page && Date.now() < reopenUntil) {
    reopenUntil = 0;
    opened(e.resultingClientId, current);
    return stored;
  }
  // At the court the signal is often too weak to answer but strong enough
  // to keep a request hanging: do not wait long for it.
  const fresh = fetch(req);
  const res = await Promise.race([fresh.catch(() => null), new Promise((r) => { setTimeout(() => r(null), WAIT); })]);
  if (res && res.ok) {
    if (page) e.waitUntil(renew());
    return res;
  }
  drop(fresh);
  if (page) {
    opened(e.resultingClientId, current);
    return stored;
  }
  // A file of a page that came from the network did not come, or came with
  // an error. Its stored copy may be of another version. A script or style
  // sheet of another version can break the page: open the page again, all
  // from the store. Anything else (icon, manifest) is simply taken from it.
  const needed = req.destination === 'script' || req.destination === 'style';
  if (needed && e.clientId && Date.now() - reopenAt > 10000) {
    reopenAt = Date.now();
    reopenUntil = reopenAt + 10000;
    opened(e.clientId, current); // (its remaining files: from the store too)
    const client = await self.clients.get(e.clientId);
    if (client && client.navigate) client.navigate(client.url).catch(() => {});
  }
  return stored;
}
