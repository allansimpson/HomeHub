# Incidents

What broke, why, and what stops it happening again. Append. Keep each one short — the value is the
root cause and the guard, not the narrative.

---

## 2026-08-30 · Pump haptics, the second time — a real defect, and the alert was mounted inside a screen

**What happened.** Reported again as "vibration on pump switch and ending is not working". The
2026-08-19 entry below was a stale deploy; this one was not.

**Root cause.** `PumpAlert` was mounted inside `CareLogView` — the Baby tab. Leaving the tab
unmounted it, so the boundary passed in silence for anyone who had navigated away. The panel idles
on the Dashboard, so that was most of the time. The mount's own comment argued for its position
against the running *panel* being closed, which it does survive; nobody had asked what happens when
the *tab* is left. A haptic exists for the moment nobody is looking at a screen, so the one place it
cannot live is inside one.

**How it presented.** Intermittent rather than dead — it fires perfectly while the Baby tab is open,
which is exactly when somebody is watching the countdown and least needs it.

**Why no test caught it.** `pumpPhases.test.ts` covers the decision — which moment is due, when, and
what pattern — and passes. The defect was in the *wiring*, and the client has no component-test
setup at all: all 797 tests are pure functions. This class of bug is invisible to that suite.

**Fixed by** lifting the alert to `App`, beside `MicLiveBanner`, which is mounted globally for the
same reason. `BabyProvider` carries the running session; it already polls the care log for the
Dashboard's figures. Exactly one mount, or the pattern replays.

**Guard.** `artifacts/homehub-browser-verification/probe-pump-haptics.js` stubs `navigator.vibrate`
and drives a real session across both boundaries, including the case that failed: arm on the Baby
tab, navigate to the Dashboard, cross the boundary there. Before the fix that case recorded zero
calls; after it, one. **A pure-function test cannot replace it** — if the alert moves again, run
that probe.

**Still true after the fix:** it only alerts while the app is open. A backgrounded PWA runs no
timers, and that needs push notifications rather than a different mount.

## 2026-09-02 · A hazard was fixed in one of two stores that share a key

**What happened.** The write queue and the Care vault are opened for the same profile under the same
key and hold the same rows — the log the household reads, and the operations carrying those rows to
the server. While writing the queue's acceptance test I found that a session holding the *wrong* key
started empty and then sealed that empty state over the rightful owner's blob on its very next write.
I fixed it in `queueStore.ts`, wrote the reasoning down there at length, and did not carry it back to
`careVault.ts`, which had the identical defect. Independent review found it (RR-01).

**How it presented.** It did not. The vault's existing wrong-key test passed, because it asserted
only that the session *reads* empty and then stopped. The queue's equivalent test wrote afterwards,
which is the only reason the same bug was caught there.

**Root cause of the miss.** Two separate mistakes that happened to compound. Treating "cannot read
it" as the whole of the claim, when the claim is two: a wrong key must read nothing **and** destroy
nothing. And fixing a defect at the instance rather than at the class — the second store was never
re-examined, despite being the one most obviously symmetric with the first.

**Guard.** When a store is fixed, ask which other stores share its key, its lifecycle, or its rows,
and check each of them explicitly rather than assuming the fix generalised. A test that only reads
cannot prove a store does not destroy: any test about a wrong key, a wrong owner, or a wrong version
must write, flush, and then reopen with the rightful credential.

## 2026-08-20 · 89 files became root-owned and both builds died

**What happened.** Between 22:00 and 22:05, 89 files across `client/src`, `src/HomeHub.Api` and
`tests/` became `root:root` with mode `rw-rw----`, unreadable to `simpson`. `.git/index` among them.

**How it presented.** Nothing said "permission". TypeScript reported
`error TS6053: File 'src/screens/care/useCareLog.ts' not found` and MSBuild reported
`MSB4025: The project file could not be loaded. Access to the path ... is denied`. Both builds were
dead for roughly seven hours, so no build could ship and the panel stayed on the 17 Aug release.

**Root cause.** The isolated promotion snapshot used a `.git` pointer to the shared repository. Its
Vite build stamp ran `git status` as root, which refreshed and atomically replaced the shared
`.git/index` as root. This was reproduced during the 2026-08-21 21:04Z TEST promotion.

**Fixed by** `sudo chown -R simpson:geist-dev /srv/dev/homehub` (Allan, 2026-08-21).

**Guard.** Never run a build or script as `root` inside `/srv/dev/homehub` — see `OWNERSHIP.md`.
Promotion snapshots use isolated refs/indexes with an object-store alternates pointer, never a direct
`.git` pointer to shared DEV. If a build claims an existing file is missing, check ownership first.

## 2026-08-20 · The client suite reported green while 61 tests did not run

**What happened.** Two test files were among the unreadable ones. vitest counted them as failed
*files* but the summary still read `613 passed` — down from 678, with nothing calling attention to
the drop.

**Guard.** Watch the **file count** as well as the test count; reference figures are in
`ENVIRONMENT.md`. A falling test count with a green summary is the dangerous shape.

## 2026-08-19 · "Vibration isn't working" was a stale deploy, not a bug

**What happened.** Pump-session alerts stopped buzzing. The code was correct in the repo; the panel
was running a build from four days earlier, whose version marked the alert spent *before* calling
`vibrate()` and ignored the return value, so any refusal discarded the buzz permanently.

**Why it took a while.** The obvious reading was a regression in the pump code. It was diagnosed by
reading the minified bundle actually deployed and comparing it with the source.

**Guard.** `STATE.md` now carries the deployed release and its date. When behaviour contradicts the
code, check what is *running* before reading the source again.
