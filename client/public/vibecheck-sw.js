/*
 * A worker that exists, and nothing more.
 *
 * Android Chrome has no `new Notification()` — it throws — so posting a notification at all
 * requires a `ServiceWorkerRegistration`. The diagnostic used to borrow the app's, which made the
 * test conditional on somebody having opened HomeHub on that phone first, and on that phone that
 * turned out to be false: `navigator.serviceWorker.ready` never settled and test 5 never ran.
 *
 * So it gets its own. There is deliberately <b>no fetch handler</b> here: a worker without one
 * never intercepts a request, so this cannot cache, stale, or shadow anything the app serves.
 *
 * <b>Registered under a scope that controls nothing.</b> `/sw.js` owns `/`, and a second worker
 * registered at the same scope would take the app's place as controller and cost that phone the
 * offline launch — a real regression traded for a test. `showNotification` is called on the
 * registration object directly and never needs the page to be controlled, so the scope is pointed
 * at a path that does not exist and the app's worker is left entirely alone.
 *
 * Delete this with `vibecheck.html`; it is a diagnostic, not a feature.
 */

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

/* Tapping the test notification should dismiss it rather than do nothing at all. */
self.addEventListener('notificationclick', (event) => event.notification.close())
