/**
 * Install the app-shell worker, so the panel can be opened without a server.
 *
 * <b>Production only, and that is not caution — it is correctness.</b> In development the app is
 * served by Vite with hot module replacement, and a worker sitting in front of it would answer
 * module requests from a cache that HMR has just invalidated: edits stop appearing, and the reason
 * why is invisible. The check is on `import.meta.env.PROD` rather than on the hostname so a
 * production build served from a laptop for testing behaves exactly as the panel will.
 *
 * The unregister branch matters as much as the register one. A developer who has run a production
 * build once has a worker installed on `localhost`, and it will go on serving that build's shell
 * over every future `npm run dev` on the same port — which presents as the dev server silently
 * having no effect. Clearing it here means that state cannot outlive one page load.
 *
 * See `public/sw.js` for what the worker does and, more importantly, what it refuses to cache.
 */
let announce: (registration: ServiceWorkerRegistration | null) => void = () => undefined

/**
 * The registration, once there is one — and `null` on every device that will never have one.
 *
 * <b>Resolved either way, deliberately.</b> `UpdateProvider` waits on this to decide how it watches
 * for new builds, and a promise that simply never settles on a phone reaching the panel over plain
 * HTTP would leave that phone with no update path at all and no way to tell. A service worker needs
 * a secure context; `null` says so, and the provider falls back to asking the server directly.
 */
export const workerRegistration = new Promise<ServiceWorkerRegistration | null>((resolve) => {
  announce = resolve
})

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) {
    announce(null)
    return
  }

  if (!import.meta.env.PROD) {
    announce(null)
    void navigator.serviceWorker.getRegistrations()
      .then((regs) => regs.forEach((r) => void r.unregister()))
      .catch(() => undefined)
    return
  }

  /*
   * After load, deliberately.
   *
   * Registering during startup puts the worker's own fetch — and the shell warm-up it triggers — in
   * competition with the requests that paint the first screen, on a panel where first paint is
   * something this project measures (`firstPaint.ts`). The worker is for the *next* launch; there
   * is nothing to gain by having it fight the current one.
   */
  window.addEventListener('load', () => {
    // `updateViaCache: 'none'` so the script itself is never answered from the HTTP cache. Current
    // browsers do this anyway, and the server sends `no-cache` on it besides — but this file is the
    // one thing that must be fetched honestly for an update to be noticed at all, and three belts
    // on that particular pair of trousers is the right number.
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
      .then(announce)
      .catch(() => {
        // An unavailable worker costs the household the offline launch and nothing else — everything
        // in an already-open tab still works. Not worth a message on a wall panel.
        announce(null)
      })
  })
}
