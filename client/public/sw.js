/*
 * The app shell, kept on the device, so the panel opens with no server.
 *
 * <b>Why there is a service worker here at all, when there was not before.</b> Everything the app
 * does offline it does inside a tab that is already open — the write queue, the last-known values,
 * the care log's own store. None of that helps the case it was actually built for: somebody picking
 * up a phone at 3am, in a house whose server is down or a room the Wi-Fi does not reach, and
 * finding the browser's dinosaur instead of the app. An installed panel that cannot launch is
 * indistinguishable from an app that is gone.
 *
 * The rules below are three, and the reasoning matters more than the code:
 *
 *   1. <b>/api is never cached, under any circumstances.</b> Not the reads, and emphatically not
 *      `/api/health` — that endpoint is how `ConnectionProvider` decides whether the server is
 *      there, and answering it from a cache would have the panel cheerfully report itself online
 *      while nothing it wrote could leave the device. Stale care data would be worse still: a log
 *      that is confidently four hours out of date is how a baby gets fed twice. Requests here pass
 *      straight through and are allowed to fail, because failing is what the app is built to handle.
 *
 *   2. <b>Navigations go to the network first.</b> A panel installed to a home screen and never
 *      deliberately reloaded is exactly the device that would sit on a cached shell for months, and
 *      the project has been bitten by that before — see the build stamp in `vite.config.ts`, which
 *      exists because "which code is this thing running" turned out to be unanswerable. Network
 *      first means a device that can reach the server always gets the current app; the cache is
 *      only ever consulted when the network could not answer at all.
 *
 *   3. <b>Everything under /assets is cache-first, because its name is its hash.</b> A file whose
 *      URL changes whenever its bytes do cannot go stale, which is the same fact the server's
 *      year-long `immutable` header states. Fetching one from the cache is not a compromise.
 *
 * Nothing here is precached from a build manifest. One successful visit populates the shell and the
 * assets it needs, together, and that is what a device has by the time it is ever offline. The cost
 * of that choice is honest: a device that has *never* reached this server cannot open the app, and
 * no amount of caching would change that.
 */

/**
 * Which build this worker belongs to, written in at build time by `vite.config.ts`.
 *
 * <b>The placeholder is the entire update mechanism, and it is worth saying why.</b> A browser
 * re-installs a worker only when the worker's own bytes change. This file used to be byte-identical
 * in every release — so `install` ran exactly once on each device, the day it was first opened, and
 * `activate`'s purge below has never in its life had anything to delete. A panel could sit on a
 * shell from months ago with no mechanism able to notice, which is precisely the state that made
 * "clear the browser's site data" the only known cure. One changing constant per build ends that:
 * every deploy is a new worker, every new worker installs, and installing is what fetches the
 * current app.
 */
const BUILD = '__BUILD_STAMP__'

/**
 * One cache per build, so retiring the last one is not a thing anybody has to remember.
 *
 * The name was `homehub-shell-v1` and was meant to be bumped by hand when the rules changed. Nobody
 * ever bumped it, which is the expected outcome for a constant that must be edited on a schedule
 * nothing enforces. Keyed by build, `activate` deletes the previous release's cache as a matter of
 * course.
 */
const CACHE = `homehub-shell-${BUILD}`

/** What a navigation falls back to when the network cannot answer. */
const SHELL = '/index.html'

/**
 * How many hashed assets to keep.
 *
 * Old builds leave their files behind — the names change with the bytes, so nothing overwrites
 * anything — and without a bound the cache grows by a whole app on every deploy. Trimmed oldest-out
 * after each write, which is approximate and does not need to be better: the entries that matter
 * are the ones the current shell just asked for, and those are the newest by construction.
 */
const MAX_ASSETS = 120

/**
 * How long a launch waits for the server before falling back to what is stored.
 *
 * Three seconds, which is long enough that a slow-but-present connection still delivers the current
 * app and short enough that a phone off the home network opens rather than appearing to hang. It
 * sits just under `ConnectionProvider`'s 4s probe timeout on purpose: the shell should already be
 * painting by the time the app forms its own opinion about the connection.
 */
const NAVIGATION_TIMEOUT_MS = 3000

self.addEventListener('install', (event) => {
  event.waitUntil(warm().catch(() => undefined))
})

/**
 * The app's side of the update, and the reason this worker no longer calls `skipWaiting` itself.
 *
 * It used to, on the argument that a wall panel is never closed and the default would hold a new
 * worker back indefinitely. That argument was right about the problem and wrong about the cure:
 * taking over unannounced means a page carries on running the old build's JavaScript while the new
 * worker underneath it deletes the cache that build was loading from — and the household is never
 * told a thing. Waiting is now the *signal*. A worker sitting in `waiting` has already downloaded
 * and warmed the whole of the next build, which is exactly the "downloaded and verified" the update
 * plate stands for, and the household presses APPLY NOW when it suits them.
 *
 * `VERSION` lets the page ask a worker which build it is, so the plate can name the one coming
 * rather than saying "an update".
 */
self.addEventListener('message', (event) => {
  const type = event.data?.type
  if (type === 'SKIP_WAITING') {
    void self.skipWaiting()
    return
  }
  if (type === 'VERSION') {
    // Answered down the port the asker opened, rather than broadcast: the reply belongs to one
    // question, and a client that never asked has no use for it.
    event.ports?.[0]?.postMessage({ build: BUILD })
  }
})

/**
 * Cache the shell *and the files it actually needs to run*, at install.
 *
 * <b>The shell on its own is not a working app, and caching only the shell is a trap.</b> The page
 * load that installs this worker is not itself controlled by it, so nothing that load fetched —
 * every script and stylesheet — passes through the `fetch` handler to be cached on the way past. An
 * install that stored `index.html` alone would leave a device holding a document whose first
 * `<script>` is unreachable: the launch gets further than before and still ends in nothing, which
 * is harder to diagnose than plainly failing.
 *
 * The asset names are read out of the document itself rather than from a build manifest. Vite
 * content-addresses them, so their names are unknowable when this file is written but perfectly
 * knowable from the HTML that references them — which makes this correct across every future build
 * with no plugin and no generated file to keep in step.
 */
async function warm() {
  const cache = await caches.open(CACHE)
  // `reload` so the shell is taken from the network, not from whatever the HTTP cache is holding.
  const response = await fetch(new Request(SHELL, { cache: 'reload' }))
  if (!response.ok) return
  const html = await response.clone().text()
  await cache.put(SHELL, response)

  // Both halves of the pair: `src`/`href` on scripts, stylesheets, and the modulepreloads Vite
  // emits. Deduplicated, because the preload and the tag that uses it name the same file.
  const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]))]
  // Individually, not `addAll`: that rejects the whole batch if any single file 404s, and losing
  // the entire warm-up over one stale preload hint is the wrong trade.
  await Promise.all(assets.map((url) => cache.add(url).catch(() => undefined)))

  /*
   * The fonts, which the HTML never mentions.
   *
   * They are named in `url(...)` inside the stylesheet, one level below anything the document
   * links, so the pass above cannot see them — and a first offline launch would come up in the
   * system font. On a panel whose whole visual language is Marcellus numerals against Josefin
   * labels, that is not a cosmetic difference; it is a screen the household does not recognise at
   * 3am, in the dark, which is precisely when the offline launch has to inspire confidence.
   */
  const sheets = assets.filter((url) => url.endsWith('.css'))
  await Promise.all(sheets.map(async (sheet) => {
    const css = await cache.match(sheet).then((r) => r?.text()).catch(() => null)
    if (!css) return
    const fonts = [...new Set([...css.matchAll(/url\((\/assets\/[^)"']+)\)/g)].map((m) => m[1]))]
    await Promise.all(fonts.map((url) => cache.add(url).catch(() => undefined)))
  }))
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event

  // Only GET is cacheable, and a mutation must never be replayed by this layer — the app has its
  // own queue for that, which knows about idempotency keys and conflicts. This one does not.
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // Rule 1. Never, under any circumstances — see the note above.
  if (url.pathname.startsWith('/api/')) return

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, event))
    return
  }

  event.respondWith(cacheFirst(request))
})

/**
 * The current app if the server can be reached, the last one it served if it cannot.
 *
 * The cached copy is refreshed on every success, so "the last one" is never older than the last
 * time this device had a connection.
 */
async function networkFirst(request, event) {
  const network = fetch(request).then(async (response) => {
    if (response.ok) {
      const cache = await caches.open(CACHE)
      // Stored under the shell's own name rather than the requested path: every route in a SPA is
      // served the same document, and keying by URL would fill the cache with identical copies —
      // and leave a deep link uncached until somebody had visited that exact route offline.
      await cache.put(SHELL, response.clone())
    }
    return response
  })

  const cached = await caches.match(SHELL)

  /*
   * Give up on the network long before the network gives up on itself.
   *
   * <b>"Offline" almost never means the browser knows it is offline.</b> The case this is for is a
   * phone that has left the house: it has full 5G, so nothing reports a fault — it simply has no
   * route to a server on the home LAN, and the connection attempt sits in SYN retransmit until the
   * operating system times it out, which can be the better part of a minute. `fetch` does not
   * reject in that window, it just waits, and an installed app waits on its launch screen with it.
   * The household reads that as the app being broken, which is exactly the outcome the offline work
   * was meant to remove.
   *
   * So the cached shell wins after a short pause, and the request is left running to refresh it.
   * The same reasoning and nearly the same figure as `ConnectionProvider`'s probe timeout — that
   * one learned it first, against the same network.
   */
  if (cached) {
    try {
      return await Promise.race([network, rejectAfter(NAVIGATION_TIMEOUT_MS)])
    } catch {
      // Not abandoned — kept alive past this response so a slow-but-working connection still
      // updates the shell for next time.
      event?.waitUntil(network.catch(() => undefined))
      return cached
    }
  }

  try {
    return await network
  } catch {
    // Nothing to serve. Better a plain sentence than the browser's own error, which on an installed
    // panel is a full-screen dinosaur with no indication of which app it belongs to.
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>Central Home</title>'
      + '<body style="background:#141210;color:#C9B896;font:16px system-ui;padding:2rem">'
      + 'Central Home has not been opened on this device yet, so there is nothing stored to show. '
      + 'Connect to the house network once and it will work offline from then on.',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    )
  }
}

/** Hashed assets, and anything else static. Its name is its version, so the cache cannot be wrong. */
async function cacheFirst(request) {
  const cached = await caches.match(request)
  if (cached) return cached

  const response = await fetch(request)
  // `basic` excludes opaque cross-origin responses, whose status is always 0 — caching one stores a
  // result nobody can read back.
  if (response.ok && response.type === 'basic') {
    const cache = await caches.open(CACHE)
    await cache.put(request, response.clone())
    void trim(cache)
  }
  return response
}

/** A promise that fails once the wait is up, for racing against one that may never settle. */
function rejectAfter(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
}

async function trim(cache) {
  const keys = await cache.keys()
  const assets = keys.filter((r) => new URL(r.url).pathname.startsWith('/assets/'))
  // Oldest first — `keys()` returns insertion order, so the front of the list is the least recently
  // added. The shell is never in this list and so is never evicted.
  await Promise.all(assets.slice(0, Math.max(0, assets.length - MAX_ASSETS)).map((r) => cache.delete(r)))
}
