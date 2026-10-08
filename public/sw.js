// Service worker for herdr web ui. Policy: navigations are network-first (so a
// fresh build always wins when online) falling back to the cached shell when
// offline; static assets (hashed bundles, icons, favicons) are cache-first since
// they are content-addressed or rarely change. The web manifest is not: its URL
// never changes and the browser rereads it to update the installed app, so a
// cached copy would pin every install to its first manifest. API and websocket
// traffic is never intercepted so live workspace data is always fresh.
// Nothing is precached. The typefaces are /assets/ files too (src/fonts/fonts.css): Pretendard
// comes as 92 chunks split by unicode-range and the browser asks only for those whose characters
// a page draws, so each is cached as it is first fetched and a phone that has shown Korean once
// draws it offline. Never list them for install: that would download all 3 MB on every device.
// A new CACHE_NAME starts empty for the same reason, so the cache of the name before it is kept
// until this one holds a shell: the page that brought this worker was loaded through the old
// one, and its shell, bundles and font chunks are all there. Deleted at activation, the first
// reload without a network would find no shell at all. Nothing is copied across, so no hashed
// file of an old build outlives the first navigation that reaches the server.
const CACHE_NAME = "herdr-web-ui-v4-ram";

const CACHE_FIRST_PATHS = new Set([
  "/favicon.png",
  "/favicon.ico",
  "/apple-touch-icon.png",
]);

function isCacheFirst(pathname) {
  if (pathname.startsWith("/assets/") || pathname.startsWith("/icons/")) return true;
  return CACHE_FIRST_PATHS.has(pathname);
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // no cache is deleted here: see CACHE_NAME
  event.waitUntil(self.clients.claim());
});

/** The shell just fetched is this cache's "/", and only then do the caches of other names go. */
async function keepShell(response) {
  const cache = await caches.open(CACHE_NAME);
  await cache.put("/", response);
  const names = await caches.keys();
  await Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)));
}

/** The shell to start from offline: this cache's, else the one a cache not yet deleted holds. */
async function cachedShell() {
  const cache = await caches.open(CACHE_NAME);
  return (await cache.match("/")) || (await caches.match("/"));
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/ws") return;

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        let response;
        try {
          response = await fetch(request);
        } catch (err) {
          return (await cachedShell()) || Response.error();
        }
        if (response.ok) {
          // not awaited: the page gets its shell as it comes, and the worker lives until the
          // copy is kept (a put reads the whole body). A bundle asked for meanwhile may still
          // be answered by the old cache: a hashed file is the same file in either, and only
          // what the network gave is put in this one. A cache that cannot be written does not
          // cost the page.
          event.waitUntil(keepShell(response.clone()).catch(() => undefined));
        }
        return response;
      })(),
    );
    return;
  }

  if (isCacheFirst(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const own = await cache.match(request);
        if (own) return own;
        const older = await caches.match(request);
        if (older) {
          // a file only the cache of the name before still holds, asked for while the new shell's
          // copy is being kept: it is kept here too, so keepShell's retirement of that cache does
          // not take the only copy of a file the new shell uses
          event.waitUntil(cache.put(request, older.clone()).catch(() => undefined));
          return older;
        }
        const response = await fetch(request);
        if (response.ok && response.type === "basic") {
          const cache = await caches.open(CACHE_NAME);
          cache.put(request, response.clone());
        }
        return response;
      })(),
    );
  }
});

// Web push (server/push.ts sends, shared/protocol.ts PushPayload is the JSON). Every
// push shows a notification: Safari revokes a subscription whose pushes stay silent.
// A window of the app that is visible right now already shows the change in its
// sidebar, so the notification then arrives without sound or vibration.
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (err) {
    payload = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const watching = windows.some((client) => client.visibilityState === "visible");
      await self.registration.showNotification(payload.title || "herdr", {
        body: payload.body || "",
        tag: payload.tag || "herdr",
        renotify: !watching,
        silent: watching,
        data: { pane_id: payload.pane_id || null, machine_id: payload.machine_id || "local" },
        icon: "/icons/icon-192.png?v=ram1",
        // Android's status bar and small icon: white on transparent, or Chrome's bell
        badge: "/icons/badge-96.png?v=ram1",
      });
    })(),
  );
});

// Tap: bring the app forward on that pane - an open window is told which pane
// (App listens), a closed app opens on /?pane=<id>.
let latestNotificationClick = 0;
let latestNotificationSelection = null;
self.addEventListener("notificationclick", (event) => {
  const click = ++latestNotificationClick;
  event.notification.close();
  const paneId = event.notification.data ? event.notification.data.pane_id : null;
  const machineId = event.notification.data?.machine_id || "local";
  // Remember the intent before any lookup: an older focus can finish while this one
  // is still finding its window.
  latestNotificationSelection = paneId ? { type: "select-pane", pane_id: paneId, machine_id: machineId, view: "chat" } : null;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (click !== latestNotificationClick) return;
      const url = paneId ? `/?machine=${encodeURIComponent(machineId)}&pane=${encodeURIComponent(paneId)}&view=chat` : "/";
      const selectLatest = (client) => { if (client && latestNotificationSelection) client.postMessage(latestNotificationSelection); };
      const open = async () => {
        // An opening can also finish after a newer tap. Repair that returned
        // window, while its URL still selects the original pane on a cold start.
        selectLatest(await self.clients.openWindow(url));
      };
      const target = windows.find((client) => client.focused) || windows[0];
      if (target) {
        const select = () => { if (paneId) target.postMessage({ type: "select-pane", pane_id: paneId, machine_id: machineId, view: "chat" }); };
        // Name the pane before focus(): a focus() that iOS refuses or resolves late must not
        // swallow it. A page frozen in the background may need the selection again
        // once its focus completes.
        select();
        try {
          await target.focus();
        } catch (err) {
          // that window cannot be brought forward: open the app on the pane instead
          if (click === latestNotificationClick) await open();
          return;
        }
        // Different windows finish focus independently. A late older focus can put
        // its window in front after a newer tap focused another one. Give whichever
        // window just came forward the latest selection, without another focus loop.
        selectLatest(target);
        return;
      }
      await open();
    })(),
  );
});

// The browser rotated the subscription (Firefox does; Chrome rarely): hand the server
// the new endpoint and drop the old one, or pushes stop until the app is next opened.
self.addEventListener("pushsubscriptionchange", (event) => {
  const post = (method, body) =>
    fetch("/api/push/subscribe", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  event.waitUntil(
    (async () => {
      const previous = event.oldSubscription;
      let fresh = event.newSubscription;
      if (!fresh) {
        const key = previous && previous.options.applicationServerKey
          ? previous.options.applicationServerKey
          : (await (await fetch("/api/push")).json()).public_key;
        fresh = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      }
      await post("POST", { subscription: fresh.toJSON() });
      if (previous) await post("DELETE", { endpoint: previous.endpoint });
    })(),
  );
});
