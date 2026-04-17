/// <reference lib="webworker" />
import {
  precacheAndRoute,
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
} from "workbox-precaching";
import { registerRoute, NavigationRoute } from "workbox-routing";
import {
  NetworkFirst,
  CacheFirst,
  StaleWhileRevalidate,
} from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";

declare const self: ServiceWorkerGlobalScope;

// ─── Precache the app shell ───────────────────────────────────────────────────
// vite-plugin-pwa injects the precache manifest here at build time
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// ─── SPA navigation fallback ─────────────────────────────────────────────────
// All navigation requests (except API and the share target) serve index.html
const navigationHandler = createHandlerBoundToURL("/index.html");
const navigationRoute = new NavigationRoute(navigationHandler, {
  denylist: [/^\/api\//, /^\/share-target/],
});
registerRoute(navigationRoute);

// ─── Runtime caching strategies ──────────────────────────────────────────────

// API: always try the network first, fall back to a short-lived cache
registerRoute(
  ({ url }) => url.pathname.startsWith("/api/"),
  new NetworkFirst({
    cacheName: "api-responses",
    networkTimeoutSeconds: 10,
    plugins: [
      new ExpirationPlugin({ maxEntries: 50, maxAgeSeconds: 60 }),
    ],
  })
);

// Azure Blob Storage photos: cache-first with 30-day expiry (large assets, rarely change)
registerRoute(
  ({ url }) => url.hostname.includes(".blob.core.windows.net"),
  new CacheFirst({
    cacheName: "blob-photos",
    plugins: [
      new ExpirationPlugin({
        maxEntries: 300,
        maxAgeSeconds: 30 * 24 * 60 * 60,
      }),
    ],
  })
);

// Google Fonts: stale-while-revalidate
registerRoute(
  ({ url }) =>
    url.hostname === "fonts.googleapis.com" ||
    url.hostname === "fonts.gstatic.com",
  new StaleWhileRevalidate({ cacheName: "google-fonts" })
);

// ─── Web Share Target ─────────────────────────────────────────────────────────
// The manifest declares share_target with action "/share-target" (POST,
// multipart/form-data). When the user shares photos from their gallery app,
// Android/iOS routes the POST here. We:
//   1. Read the files from FormData
//   2. Persist them to IndexedDB (same DB the React app reads from)
//   3. Redirect to the app with ?shared=1 so the upload modal auto-opens

const DB_NAME = "aphoto-pwa";
const SHARE_STORE = "share-queue";

function openShareDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(SHARE_STORE)) {
        req.result.createObjectStore(SHARE_STORE, { autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

self.addEventListener("fetch", (event: FetchEvent) => {
  const url = new URL(event.request.url);
  if (url.pathname === "/share-target" && event.request.method === "POST") {
    event.respondWith(
      (async () => {
        const formData = await event.request.formData();
        const items = formData.getAll("photos");

        const entries: {
          name: string;
          type: string;
          data: ArrayBuffer;
          lastModified: number;
        }[] = [];

        for (const item of items) {
          if (item instanceof File) {
            entries.push({
              name: item.name,
              type: item.type,
              data: await item.arrayBuffer(),
              lastModified: item.lastModified,
            });
          }
        }

        if (entries.length > 0) {
          const db = await openShareDB();
          await new Promise<void>((res, rej) => {
            const tx = db.transaction(SHARE_STORE, "readwrite");
            const store = tx.objectStore(SHARE_STORE);
            for (const entry of entries) store.add(entry);
            tx.oncomplete = () => {
              db.close();
              res();
            };
            tx.onerror = () => {
              db.close();
              rej(tx.error);
            };
          });
        }

        // 303 See Other → browser performs a GET to the app
        return Response.redirect("/?shared=1", 303);
      })()
    );
  }
});
