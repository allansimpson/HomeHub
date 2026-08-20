import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
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

/**
 * What this build is, in a form a person can read off a panel.
 *
 * <b>Because "which code is this thing running" turned out to be unanswerable.</b> A panel installed
 * to a home screen keeps serving whatever it cached until something makes it ask again, so two
 * devices on one deploy can be running different apps — and the only way to tell them apart was to
 * read the server's logs and infer it from behaviour. That is a day of somebody's life for a
 * question the app can simply answer.
 *
 * The commit, whether the tree was dirty when it was built, and the date. Dirty matters most: a
 * build made from uncommitted work is the one nobody else can reproduce, and it is exactly what gets
 * pushed to a test box at eight in the morning.
 *
 * Falls back to `dev` rather than failing the build. A checkout without git — an unpacked tarball,
 * a CI image without history — should still produce a working panel; it just cannot say much about
 * itself.
 */
function buildStamp(): string {
  // UTC, and said so. A stamp read off a panel is compared against a deploy log and a journal, both
  // of which are UTC, and a bare local time turns that comparison into arithmetic somebody gets
  // wrong at the exact moment they are already confused about which build is where.
  //
  // <b>Taken first, and never conditional on anything.</b> The commit is the better answer and the
  // clock is the one that cannot fail — so the clock is the floor and git only ever improves on it.
  // The first version of this had it the other way round: any stumble in git and the whole stamp
  // collapsed to the word `dev`, which is indistinguishable from every other build that ever
  // stumbled. A stamp that says nothing is worse than no stamp, because it looks like an answer.
  //
  // <b>To the second, since the worker started depending on it.</b> This was minutes, which is all a
  // person reading it off a panel needs. But the stamp is now what makes each release's `sw.js` a
  // different file, and two builds of the same dirty tree inside one minute produced byte-identical
  // workers — so the second deploy would be invisible to every device that had taken the first. That
  // is precisely the workflow this is for: pushing to test twice while chasing something down.
  const when = `${new Date().toISOString().slice(0, 19).replace('T', ' ')}Z`

  try {
    const git = (args: string) => execSync(`git ${args}`, { cwd: here, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    const sha = git('rev-parse --short HEAD')
    const dirty = git('status --porcelain').length > 0 ? '+' : ''
    return `${sha}${dirty} · ${when}`
  } catch (cause) {
    // Said out loud, at the moment it happens, in the log of whoever is deploying. Silence here is
    // what let a panel ship saying `dev` with nobody the wiser — and the usual cause is mundane and
    // fixable: a build run by a different user than owns the checkout, which git refuses as
    // `dubious ownership`, or a source tree copied without its `.git`.
    console.warn(`[build stamp] no commit id: ${cause instanceof Error ? cause.message.split('\n')[0] : cause}`)
    return when
  }
}

/**
 * Write the build into the two files that have to say it out loud.
 *
 * <b>`sw.js`</b> ships from `public/`, which Vite copies verbatim — so the stamp cannot be a
 * `define`, and the file is rewritten in place after the copy instead. Its placeholder is what makes
 * every release a new worker: identical bytes are how a browser decides there is nothing to install,
 * and identical bytes are what left panels sitting on months-old shells.
 *
 * <b>`build.json`</b> is for the devices that have no worker at all. A service worker needs a secure
 * context, and a phone opening the panel over plain `http://<server>:5000` on the house LAN gets
 * none — so the whole mechanism above is simply absent there. A four-line JSON file, served
 * `no-cache` like the rest of the shell, gives that phone the same answer by the plainest means
 * available: the app asks what the server is serving and compares it to what it is running.
 *
 * `closeBundle` rather than `writeBundle`, so this lands after the public directory has been copied
 * rather than racing it.
 */
function stampBuild(stamp: string): Plugin {
  let outDir = ''
  return {
    name: 'homehub-build-stamp',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      const worker = resolve(outDir, 'sw.js')
      if (existsSync(worker)) {
        const source = readFileSync(worker, 'utf8')
        // Said out loud if it ever stops matching: a worker that shipped with its placeholder intact
        // is one every device would consider unchanged for the rest of time, and it would fail
        // silently and permanently.
        if (!source.includes('__BUILD_STAMP__')) {
          throw new Error('sw.js has no __BUILD_STAMP__ placeholder — every build would look identical to a browser')
        }
        writeFileSync(worker, source.replaceAll('__BUILD_STAMP__', stamp))
      }
      writeFileSync(resolve(outDir, 'build.json'), `${JSON.stringify({ build: stamp }, null, 2)}\n`)
    },
  }
}

const BUILD = buildStamp()

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), stampBuild(BUILD)],
  // Frozen into the bundle at build time, so it describes the file it is in rather than whatever the
  // panel happens to be talking to. That is the distinction the whole thing exists to make.
  // Taken once, above, and shared with the worker and `build.json` — three files that disagreed
  // about which build they belonged to would make the update check compare a build against itself.
  define: { __BUILD__: JSON.stringify(BUILD) },
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
