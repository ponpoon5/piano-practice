// 一度開けば電波がなくても動くようにする。
// つながっているときは毎回いちばん新しい版を取りに行き(新旧の混ざりを防ぐ)、つながらないときだけ手元の控えを使う。
const CACHE = 'piano-practice-v8';
const FILES = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'logic.js',
  'store.js',
  'notes.js',
  'phrase.js',
  'midi.js',
  'synth.js',
  'clock.js',
  'manifest.webmanifest',
  'icon-180.png',
  'icon-192.png',
  'icon-512.png',
];

self.addEventListener('install', (e) => {
  // ブラウザの控え(数分前の古い版)を使わず、必ず取り直す
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(FILES.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      try {
        const res = await fetch(req, { cache: 'no-cache' });
        if (res.ok) c.put(req, res.clone());
        return res;
      } catch (err) {
        const hit = await c.match(req, { ignoreSearch: true });
        if (hit) return hit;
        throw err;
      }
    })
  );
});
