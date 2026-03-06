/**
 * IronLog — Service Worker
 *
 * Cache name: "ironlog-v1"
 *
 * Strategy:
 *  • Cache-first  for all app shell assets (HTML, CSS, JS, manifest, icons)
 *  • Network-first for Google API calls (sheets.googleapis.com,
 *    accounts.google.com)  — falls back to a JSON error if offline
 *
 * To bust the cache when shipping updates, increment CACHE_NAME.
 */

const CACHE_NAME = 'ironlog-v1';

// ─────────────────────────────────────────────────────────────────────────────
// App shell assets to pre-cache on install
// ─────────────────────────────────────────────────────────────────────────────

const APP_SHELL = [
  '.',                        // alias for index.html at the start_url
  'index.html',
  'manifest.json',
  'css/style.css',
  'js/db.js',
  'js/sheets.js',
  'js/sync.js',
  'js/auth.js',
  'js/workout-engine.js',
  'js/app.js',
];

// CDN resources to pre-cache (pinned versions for determinism)
const CDN_RESOURCES = [
  'https://cdn.jsdelivr.net/npm/idb@8/build/umd.js',
  'https://accounts.google.com/gsi/client',
];

const ALL_PRECACHE = [...APP_SHELL, ...CDN_RESOURCES];

// ─────────────────────────────────────────────────────────────────────────────
// Network-first origins — never serve from cache
// ─────────────────────────────────────────────────────────────────────────────

const NETWORK_FIRST_PATTERNS = [
  /^https:\/\/sheets\.googleapis\.com\//,
  /^https:\/\/oauth2\.googleapis\.com\//,
  /^https:\/\/accounts\.google\.com\/o\/oauth2\//,
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if the URL matches any network-first pattern.
 * @param {string} url
 * @returns {boolean}
 */
function isNetworkFirst(url) {
  return NETWORK_FIRST_PATTERNS.some(re => re.test(url));
}

// ─────────────────────────────────────────────────────────────────────────────
// Install — pre-cache app shell
// ─────────────────────────────────────────────────────────────────────────────

self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);

      // Cache app shell; skip CDN resources that may fail in certain envs
      const results = await Promise.allSettled(
        ALL_PRECACHE.map(url => cache.add(url))
      );

      results.forEach((result, i) => {
        if (result.status === 'rejected') {
          console.warn(`[SW] Pre-cache miss for: ${ALL_PRECACHE[i]}`, result.reason);
        }
      });

      // Immediately activate without waiting for old tabs to close
      await self.skipWaiting();
    })()
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Activate — prune old caches
// ─────────────────────────────────────────────────────────────────────────────

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      );
      // Take control of all open clients immediately
      await self.clients.claim();
    })()
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Fetch — routing
// ─────────────────────────────────────────────────────────────────────────────

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = request.url;

  // Skip non-GET requests (POST / PUT to Sheets, etc.)
  if (request.method !== 'GET') return;

  // Skip Chrome extension and blob URLs
  if (!url.startsWith('http')) return;

  if (isNetworkFirst(url)) {
    // ── Network-first strategy ───────────────────────────────────────────────
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          // Cache successful API responses for offline debugging (optional)
          // We intentionally skip caching Sheets API responses here.
          return response;
        } catch (_) {
          // Offline — return a minimal JSON error so the app can handle it
          return new Response(
            JSON.stringify({ error: 'offline', message: 'No network connection.' }),
            {
              status:  503,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }
      })()
    );
  } else {
    // ── Cache-first strategy (app shell + CDN) ───────────────────────────────
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;

        // Not in cache — fetch and cache dynamically
        try {
          const networkResponse = await fetch(request);
          if (networkResponse.ok) {
            const cache = await caches.open(CACHE_NAME);
            // Clone because the response body can only be consumed once
            cache.put(request, networkResponse.clone());
          }
          return networkResponse;
        } catch (_) {
          // Completely offline and not cached
          return new Response(
            '<h1>IronLog is offline</h1><p>This resource is not available offline yet.</p>',
            {
              status:  503,
              headers: { 'Content-Type': 'text/html' },
            }
          );
        }
      })()
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Background Sync (if supported)
// ─────────────────────────────────────────────────────────────────────────────

self.addEventListener('sync', event => {
  if (event.tag === 'ironlog-sync') {
    // The main app handles the actual sync via sync.js.
    // This event can be used as a wake-up signal for deferred posts.
    event.waitUntil(Promise.resolve());
  }
});
