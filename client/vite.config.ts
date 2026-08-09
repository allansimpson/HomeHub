import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const here = dirname(fileURLToPath(import.meta.url))
const certDir = resolve(here, '..', 'certs')
const certFile = resolve(certDir, 'homehub-dev.crt')
const keyFile = resolve(certDir, 'homehub-dev.key')

/**
 * Development HTTPS, enabled by the certificate simply being there.
 *
 * The phone scan screen needs `getUserMedia`, and browsers refuse it outside a secure context — so
 * a phone at `http://<dev-machine>:5173` gets no camera at all, only the "NO CAMERA HERE" fallback.
 * `scripts/make-dev-certs.sh` writes the pair; a checkout without them serves plain HTTP exactly as
 * before, so nothing here is a prerequisite for ordinary work.
 */
const https = existsSync(certFile) && existsSync(keyFile)
  ? { cert: readFileSync(certFile), key: readFileSync(keyFile) }
  : undefined

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Listen on every interface, not just loopback, so a tablet or phone on the same LAN can
    // reach the dev server at https://<dev-machine-ip>:5173 for real touchscreen testing.
    host: true,
    // Fail loudly instead of silently hopping to 5174 — a kiosk/tablet bookmark that
    // quietly points at the wrong port is worse than a startup error.
    strictPort: true,
    https,
    // Hostnames permitted in the Host header (IPs and localhost are always allowed).
    // Covers reaching the panel by mDNS name from the tablet.
    allowedHosts: ['.local'],
    // In dev, forward API calls to the ASP.NET Core Kestrel host so the browser sees a
    // single same-origin app (no CORS). This proxy hop happens on the dev machine, so it
    // stays on localhost even when the browser is a tablet across the LAN — which is why
    // no CORS config is needed on Kestrel. The kiosk in prod hits the published SPA served
    // by Kestrel directly, so these routes resolve without a proxy there.
    proxy: {
      '/api': {
        // Match the scheme the browser is using. Mixed content is the reason: a page served over
        // HTTPS may not have its own dev server relay to a plain-HTTP upstream without the
        // handshake being pointless, and keeping both hops encrypted means the dev topology is the
        // same shape as prod's single-origin TLS.
        target: https ? 'https://localhost:7288' : 'http://localhost:5220',
        // The upstream presents our own local CA, which Node does not know about. This hop never
        // leaves the machine, and the alternative — teaching Node the CA — buys nothing here.
        secure: false,
      },
    },
  },
  build: {
    // The API serves the built SPA from wwwroot as one deployable unit.
    outDir: '../src/HomeHub.Api/wwwroot',
    emptyOutDir: true,
  },
})
