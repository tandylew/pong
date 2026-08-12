/* karaoke-sw.js — service worker for karaoke sites (installed by karaoke-pwa.js).
 *
 * NETWORK-FIRST, cache as fallback:
 *   • online  → always the current file, so voice-building never sees a stale page
 *   • offline → the last copy that was fetched successfully
 *
 * /api/ and data/ requests are never cached — that's live data, a stale answer
 * there would be worse than an error, and the cache is shared by everyone who
 * uses this browser, so a signed-in user's data must never land in it.
 */
const CACHE = "karaoke-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => (k !== CACHE && k.startsWith("karaoke-") ? caches.delete(k) : null)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf("/api/") !== -1) return;
  if (/(^|\/)data\//.test(url.pathname)) return;

  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const hit = await caches.match(req);
      if (hit) return hit;
      if (req.mode === "navigate") {
        const index = await caches.match("index.html") || await caches.match("./");
        if (index) return index;
      }
      throw err;
    }
  })());
});
