# Panel updates and APPLY NOW — diagnosis

**Date:** 2026-08-19
**Reported:** "the updates and apply now are still failing"
**Verdict:** Not a code defect. **The update mechanism has never been deployed.** Production is
running a release that predates the entire feature — worker, plate and all.
**Fix:** deploy the current build. No source change is required — see §7 for the TEST deploy, staged and waiting on root.
**Status 2026-08-19, later:** §5 resolved (§6). Deployed to TEST and verified (§8) — https://192.168.5.15:5181/. Production untouched. Nothing is blocked on
investigation. Build 2 is staged (§9) and is the distinct build the real-device APPLY NOW test needs.

---

## 1. What is actually running

| | Production (`:5080` / `:5081`) | Repo working tree |
|---|---|---|
| Release | `/opt/homehub/releases/20260817T193508Z-0bded247023e` | — |
| `current` symlink set | 2026-08-17 16:41 | — |
| `wwwroot/sw.js` | 11,717 bytes | 14,017 bytes |
| `sw.js` cache key | `const CACHE = 'homehub-shell-v1'` | `const BUILD = '__BUILD_STAMP__'`, `CACHE = homehub-shell-${BUILD}` |
| `sw.js` calls `skipWaiting()` in `install` | **yes** | no — waiting *is* the signal |
| `sw.js` `message` listener | **absent** | handles `SKIP_WAITING` and `VERSION` |
| `wwwroot/build.json` | **absent** | present |
| App bundle contains update code | **no** (see below) | yes |

The deployed app bundle is `/assets/index-DJZLQok2.js` (764,766 bytes). None of the following
appear in it, at all:

```
homehub.update.handoff   0 hits
APPLY NOW                0 hits
SKIP_WAITING             0 hits
build.json               0 hits
controllerchange         0 hits
```

There is no update plate in production. Nothing on the deployed panel can offer an update or apply
one.

### Reproduce

```bash
curl -sS http://127.0.0.1:5080/sw.js | grep -n "CACHE\s*=\|skipWaiting\|addEventListener('message'"
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5080/build.json     # 401
curl -sS http://127.0.0.1:5080/index.html | grep -o '/assets/[^"]*\.js'
curl -sS http://127.0.0.1:5080/assets/index-DJZLQok2.js | grep -c SKIP_WAITING  # 0
ls -la /opt/homehub/current/wwwroot/ | grep -E 'sw\.js|build\.json'
```

---

## 2. Why each symptom follows

The client code in the repo (`client/src/app/UpdateProvider.tsx`) is correct. It fails against the
*deployed worker* for four independent reasons, any one of which is sufficient.

**a. No device ever notices a new build.** A browser re-installs a worker only when the worker's own
bytes change. The deployed `sw.js` has no build stamp in it — it is byte-identical in every release,
and its cache key is the hand-bumped `homehub-shell-v1` that `client/public/sw.js`'s own comments say
nobody ever bumps. `install` has run exactly once per device, on the day that device first opened the
panel. This is precisely the failure the current source was written to end.

**b. A worker never sits in `waiting`.** The deployed worker calls `self.skipWaiting()` inside
`install`. `UpdateProvider` watches `reg.waiting` and the `updatefound` → `installed` transition as
its *only* signal on service-worker devices, so `offer()` is never called and `status` stays `'none'`.

**c. The no-worker fallback is dead too.** A phone reaching the panel over plain `http://` has no
secure context, so no worker at all — `UpdateProvider` falls back to `askServer()`, which fetches
`/build.json`. That file is not in the deployed release, the request 401s, `res.ok` is false, and the
function returns `null`. No offer. **This is the path the household's phones are on.**

**d. APPLY NOW times out.** `apply()` posts `{type:'SKIP_WAITING'}` to the waiting worker and waits
for `controllerchange`, failing after `APPLY_TIMEOUT_MS` (20 s). The deployed worker registers no
`message` listener whatsoever, so the message is discarded, no hand-over occurs, the timeout elapses
and the plate reports failure. Likewise `askVersion()`'s `VERSION` probe times out at 3 s, so the
plate cannot name the build even when one is offered.

Given (a)–(c), a household should not be seeing an APPLY NOW button on the deployed panel at all —
so wherever it is being pressed is **not** `:5080`/`:5081`. Worth confirming which host the failing
device is pointed at before anything else; if it is a dev server or a side instance, that changes
where to look.

---

## 3. The `/build.json` 401 is absence, not authorisation

Worth stating because it looks like an auth bug and is not. Unknown paths at the site root fall
through the static-file middleware into the authenticated pipeline; existing files are served:

| Path | Code | Exists in deployed `wwwroot`? |
|---|---|---|
| `/sw.js` | 200 | yes |
| `/index.html` | 200 | yes |
| `/favicon.ico` | 200 | yes |
| `/icons/manifest.webmanifest` | 200 | yes |
| `/build.json` | **401** | **no** |
| `/nonexistent-abc.js` | 401 | no (control) |
| `/assets/nope.css` | 404 | no — `/assets` has its own handling |

So `build.json` should serve normally once it is in the release. That was an inference from
black-box probing when written; §6 confirms it against the pipeline source.

No reverse proxy is involved: nginx runs but serves only `default` and `hermes`, and nothing in
`/etc/nginx` references homehub or 5080.

---

## 4. What to do

1. Deploy the current build per `deploy/updating.md`. That ships the new `sw.js` (bytes differ:
   11,717 → ~14,017, so every device will install it), `build.json`, and an app bundle that contains
   the plate.
2. **Expect one manual reload per device on this deploy only.** Devices are running a page whose
   JavaScript has no APPLY NOW in it. The new worker will install and sit in `waiting`, and there is
   nothing on screen able to promote it. The wall panel is never closed, so it will sit there
   indefinitely — it needs one deliberate reload (or close/reopen) to pick up the new bundle. From
   the *next* deploy onwards the mechanism carries itself.
3. Re-verify with the probes in §1. `/build.json` should return 200 and the stamp should match
   `const BUILD` in `/sw.js` and `__BUILD__` in the bundle. All three come from one value in
   `client/vite.config.ts`; if they ever disagree, the update check is comparing a build against
   itself.

### Incidental: `deploy/updating.md` verifies against the wrong port

The quick-reference block ends with

```bash
curl -s "http://127.0.0.1:5000/api/health?deep=true"
```

but the service binds 5080/5081 (`Server__HttpPort` in `/etc/homehub/homehub.env`). Port 5000 is a
*different* listener on this box and it answers `/api/health` with 200 — so this line reports success
regardless of whether the deploy worked. `server-systemd.md` already warns about exactly this class
of mistake in the other direction ("a good deploy still reported failure"); this is the dangerous
direction. Should read 5080.

---

## 5. Questions for Hermes — these need root

**Q1. Confirm the static-file / auth pipeline in `src/HomeHub.Api/Program.cs`.**
The file is `root:root`, mode `0640`; the `simpson` account cannot read it, so §3 is inference from
probing only. Specifically:

- Does `UseStaticFiles` run before the authentication/authorisation middleware for *all* files under
  `wwwroot`, or is there an allowlist of paths/filenames? If there is an allowlist, `build.json`
  needs adding to it or the fallback path stays broken after the deploy for every phone on plain HTTP.
- Is `build.json` given `Cache-Control: no-cache` like `sw.js` and `index.html`? It is fetched with
  `{cache: 'no-store'}` client-side, which covers it, but a long-lived header here would be a trap.
- Does the SPA fallback rewrite unknown root paths to `index.html` before or after auth? The 401 on
  `/nonexistent-abc.js` suggests after, which is fine, but confirm.

**Q2. Fix repository file ownership.**
Several source files under `/srv/dev/homehub` are `root`-owned and unreadable to the account that
does the work, which blocks review and will block the next diagnosis too:

```
src/HomeHub.Api/Program.cs
src/HomeHub.Api/Meals/MealModels.cs
src/HomeHub.Api/Controllers/RecipesController.cs
tests/HomeHub.Tests/HubAppFactory.cs
tests/HomeHub.Tests/MealNotificationTests.cs
```

Everything else in the tree is `simpson:geist-dev`. These five are the odd ones out — most likely a
tool run under `sudo` at some point. `chown simpson:geist-dev` on them, and worth a sweep for others.

---

## 6. Resolution of §5 — Hermes, 2026-08-19

Both questions answered. Recorded here by Claude: Hermes reported these in conversation but its own
append to this file hit a protected-file approval prompt that timed out, so the write never landed.

### Q1 — answered, and independently re-verified

No pipeline source change is required. Hermes' findings, each confirmed by reading
`src/HomeHub.Api/Program.cs` directly now that it is readable:

| Claim | Confirmed at |
|---|---|
| `UseDefaultFiles()` / `UseStaticFiles()` run before auth | `Program.cs:974`, `:996` vs `UseAuthentication()` `:1026`, `UseAuthorization()` `:1027` |
| No filename allowlist for existing `wwwroot` files | `StaticFileOptions` at `:996` carries `OnPrepareResponse` and nothing else |
| An existing `/build.json` is served publicly, before authorisation | follows from the two above |
| Everything outside `/assets/*` gets `Cache-Control: no-cache`, `build.json` included | `:998–1005` — the ternary keys on `path.StartsWith("/assets/")` |
| The SPA fallback does not rewrite a missing `.js`/`.json`, hence the 401 | `MapFallbackToFile` at `:1118`; the anonymous-404 shim at `:1008` covers only `/favicon.ico`, `/icons`, `/assets` |

That shim also explains the last unexplained probe in §3: `/assets/nope.css` returned 404 rather
than 401 because it is one of the three prefixes short-circuited there. The table in §3 is now
accounted for line by line.

**So `/build.json` will serve 200 with `no-cache` the moment it is in a release.** The §3 inference
was correct.

### Q2 — completed

- The five files named in §5 are now `simpson:geist-dev` (1000:989). Verified.
- Hermes found and corrected a sixth that the §5 list missed: `tests/HomeHub.Tests/RecipesApiTests.cs`.
- Eight root-owned files and two directories under `.hermes/` were corrected as well.
- A sweep over `src`, `tests` and `client/src` now returns no file not owned by `simpson`. Verified.
- No file contents and no git state were touched by the repair.

### Outstanding

Only the deploy, which needs explicit approval — plus the one-time manual panel reload described in
§4, and the `updating.md` port correction, which is a documentation fix nobody has made yet.

---

## 7. TEST deploy — staging (superseded by §8, kept as the record)

Following `deploy/test-deploy-from-server.md`. Approved scope: **test instance only.** Production is
not to be touched without a separate decision.

### Done and verified (Claude, 2026-08-19 20:22Z)

| Step | Result |
|---|---|
| 1 · ownership | `find src tests -name '*.cs' ! -readable` → empty. Hermes' repair holds |
| 2 · `npm ci && npm run build` | ok |
| 3 · `dotnet publish … -o artifacts/publish-test` | ok, 130 MB |

The staged artifact is at **`/srv/dev/homehub/artifacts/publish-test`**, and unlike the release now
in production it passes every content check the runbook makes — plus the two that caught the
original fault:

```
build.json                 {"build": "3fc6323+ · 2026-08-19 20:22:16Z"}
sw.js   const BUILD =      '3fc6323+ · 2026-08-19 20:22:16Z'    (stamps match)
sw.js   SKIP_WAITING       1 hit    (deployed release: absent)
bundle  SKIP_WAITING       1 hit    (deployed release: 0)
bundle  homehub.update.handoff  1 hit    (deployed release: 0)
```

**Note:** this build is from a dirty tree (`3fc6323+`) and carries the 2026-08-19 UI work —
Huckleberry pull moved to Config → Baby settings, day blocks on the entries list, the pager widened
to six rows, care tiles trimmed 98 → 88 px. That is understood and approved for the test instance.

### Blocked

`sudo` on this box requires a password, and `/opt/homehub-test` is not readable by `simpson`. Steps
0, 4, 5 and 6 cannot be run from the agent session.

Two of the three values step 0 asks for are already known:

| Value | |
|---|---|
| `TEST_GROUP` | `homehub-test` — from `systemctl show homehub-test -p Group` |
| `TEST_PORT` | ~~`:5000` is the likely one~~ — **this guess was wrong.** The real ports are **5180 / 5181**, read from `/etc/homehub-test/homehub-test.env`. `:5000` is a third, unrelated listener that answers `/api/health` with `Ok`; treating it as the test instance would have verified the deploy against a process that never received it. This is the same trap §4 flags in `updating.md`, and the runbook's insistence on *reading* the port rather than inferring it is what caught it |
| `PREVIOUS` | `readlink -f /opt/homehub-test/current` — needed for the rollback |

### The remaining block, ready to run

```bash
TEST_PORT=<read from /etc/homehub-test/homehub-test.env>
TEST_GROUP=homehub-test
PREVIOUS="$(readlink -f /opt/homehub-test/current)"

# 4 · stage
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$(git -C /srv/dev/homehub rev-parse --short HEAD)"
REL="/opt/homehub-test/releases/$STAMP"
sudo mkdir -p "$REL"
sudo cp -a /srv/dev/homehub/artifacts/publish-test/. "$REL"/
sudo chmod +x "$REL/HomeHub.Api"
sudo chgrp -R "$TEST_GROUP" "$REL"
sudo chmod -R g+rX "$REL"
sudo -u homehub-test test -x "$REL/HomeHub.Api" && echo "executable by the service account"

# 5 · flip
sudo ln -sfn "$REL" /opt/homehub-test/current.tmp
sudo mv -Tf /opt/homehub-test/current.tmp /opt/homehub-test/current
readlink -f /opt/homehub-test/current      # must equal $REL

# 6 · restart and prove it serves
sudo systemctl restart homehub-test
sleep 3
curl -fsS "http://127.0.0.1:$TEST_PORT/api/health?deep=true"   # need "database":"ok", "pendingMigrations":0

# 7 · prove the update path — the point of the exercise
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$TEST_PORT/build.json"   # 200, not 401
curl -s "http://127.0.0.1:$TEST_PORT/build.json"
curl -s "http://127.0.0.1:$TEST_PORT/sw.js" | grep -o "const BUILD = '[^']*'"       # same stamp
curl -s "http://127.0.0.1:$TEST_PORT/sw.js" | grep -c SKIP_WAITING                  # ≥ 1
```

`chgrp` in step 4 is not housekeeping — a release carrying the wrong group is one systemd cannot
execute, and it presents as a unit that will not start over files that look perfectly fine.

Rollback if step 6 fails:

```bash
sudo ln -sfn "$PREVIOUS" /opt/homehub-test/current.tmp
sudo mv -Tf /opt/homehub-test/current.tmp /opt/homehub-test/current
sudo systemctl restart homehub-test
```

### Then

Step 8 is the real proof and needs a phone: background the app two minutes, reopen (that is the
`visibilitychange` check, throttled to once every two minutes — otherwise it is up to thirty). The
plate should name the new build, and APPLY NOW should return on it rather than reporting "still
on …". Only after that is the production deploy worth proposing.

---

## 8. TEST deploy — done, 2026-08-19

Hermes installed Claude's staged artifact to the TEST instance through the constrained installer.
Recorded here by Claude; Hermes' own append hit the protected-file approval timeout a second time.

**TEST URL: https://192.168.5.15:5181/**

| | |
|---|---|
| Release | `20260819T202559Z-0243553b95df` |
| Artifact SHA-256 | `7e72e55c2bf99f11b8c6e0fb9802667a2dfc87a32e0d30b93c5c670b39996d99` |
| TEST ports | **HTTP 5180, HTTPS 5181** — not 5000 (see §7) |
| Service | active · database OK · pendingMigrations 0 |
| Production | untouched, still `20260817T193508Z-0bded247023e`, active and healthy |

### Verified twice — Hermes, then independently by Claude off the live instance

```
GET /build.json   200  application/json  Cache-Control: no-cache
                  {"build": "3fc6323+ · 2026-08-19 20:22:16Z"}
GET /sw.js        200  text/javascript   Cache-Control: no-cache
                  const BUILD = '3fc6323+ · 2026-08-19 20:22:16Z'      ← stamps match
                  SKIP_WAITING branch present, message handler present
                  sha256 3a7f4f969a42aa6991ad2781572554754afd5b6c322c0d75724ce6d5b2221757
                         — byte-identical to the staged artifact's worker
GET /assets/index-BUlCNg86.js
                  SKIP_WAITING 1 · homehub.update.handoff 1 · controllerchange 1
```

Every one of the four failure conditions in §2 is now absent on TEST. For contrast, production still
answers `/build.json` with 401 and its bundle still contains none of the three markers — the two
instances make a clean A/B.

### The remaining gate: the real-device test

Two steps, and the second is the one people skip.

1. **Reload TEST deliberately** — or fully close and reopen it. The client currently on the device
   predates this mechanism and has no APPLY NOW to promote the new worker with. This is the one-time
   cost §4 predicted; it does not recur.
2. **Then deploy a *second*, distinct TEST build.** After step 1 the device is running the new
   mechanism, but there is nothing newer for it to detect — the update it would have announced is
   the one it just became. Only a second build gives it something to find, and that is the only way
   to exercise APPLY NOW end to end: plate appears → names the build → press → hand-over →
   `controllerchange` → reload → "Applied at …" rather than "still on …".

   No source change is needed to produce one. `buildStamp()` in `client/vite.config.ts` is
   second-resolution, so any rebuild yields a new stamp, new `sw.js` bytes, and therefore a worker
   every device will install. Stage it in a *separate* directory (`artifacts/publish-test2`) so the
   artifact whose SHA is recorded above is not overwritten.

Only after APPLY NOW is seen working on a real device is the production deploy worth proposing —
and that is a separate decision, with §4's one-time manual reload applying to every household device.

---

## 9. Second TEST build — staged, awaiting install

The device has taken build 1 (confirmed from a screenshot of the TEST app showing the new entries
day-blocks), so §8's step 1 is done. This is the second, distinct build that step 2 asks for — and
it is not a throwaway: it carries a real fix.

**Fix in this build.** The sticky day heading sits inside the entries scroller's own height, so six
rows in a six-row box left the sixth cut in half. `--care-dayhead: 1.75rem` is now added to both the
pager floor and `.ml-carelist`, and `.ml-careday` is sized *from* that token, so the two cannot
drift. The block goes 355 → 383 px; the LOG tiles are untouched at 88 px and simply move down, into
slack the page already had. SINCE and TODAY end one heading short of the floor, which is deliberate
— see the comment on `.ml-sincepager`.

| | Build 1 (live on TEST) | Build 2 (staged) |
|---|---|---|
| Stamp | `3fc6323+ · 2026-08-19 20:22:16Z` | `3fc6323+ · 2026-08-19 21:10:20Z` |
| `sw.js` sha256 | `3a7f4f96…2221757` | `d23269f1…62d45e16` |
| Bundle | `index-BUlCNg86.js` | `index-DlCN_VX3.js` |

Staged at **`/srv/dev/homehub/artifacts/publish-test2`** (130 MB) — a separate directory, so build
1's recorded artifact is intact for comparison or rollback. `tsc -b` clean, 524 tests pass.

Install per §7's block with `REL` taken from `artifacts/publish-test2` instead. The worker bytes
differ from build 1's, which is the whole point: a device sitting on build 1 will install this one,
hold it in `waiting`, and finally have something for the plate to announce.

### What to watch on the device

This is the end-to-end test the whole exercise has been driving at:

1. Background the TEST app two minutes, reopen — that is the `visibilitychange` check, throttled to
   once every two minutes; otherwise up to thirty.
2. The plate should appear and **name the build** (`3fc6323+`) rather than saying "an update". If it
   says "an update", `askVersion()`'s `VERSION` probe timed out at 3 s and the worker is not
   answering — a different fault from the one this file is about.
3. Press APPLY NOW. Expect a hand-over inside 20 s and a reload; the plate should come back reading
   **"Applied at …"**, not "still on …". A "still on" means `outcomeOf` found the build unchanged
   after the reload, i.e. the shell was served from cache rather than the network.

---

## 10. Files referenced

| File | Role |
|---|---|
| `client/public/sw.js` | The worker. `__BUILD_STAMP__` placeholder is the whole mechanism |
| `client/vite.config.ts` | `buildStamp()`, and `stampBuild()` which writes the stamp into `sw.js` and `build.json` |
| `client/src/app/UpdateProvider.tsx` | Watches for a waiting worker; `apply()` and its 20 s timeout |
| `client/src/app/appUpdate.ts` | The handoff note across the reload, and `outcomeOf` |
| `client/src/app/registerServiceWorker.ts` | Registration, prod-only, `updateViaCache: 'none'` |
| `deploy/updating.md` | The deploy routine (and the port bug in §4) |
