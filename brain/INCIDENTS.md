# Incidents

What broke, why, and what stops it happening again. Append. Keep each one short — the value is the
root cause and the guard, not the narrative.

---

## 2026-08-20 · 89 files became root-owned and both builds died

**What happened.** Between 22:00 and 22:05, 89 files across `client/src`, `src/HomeHub.Api` and
`tests/` became `root:root` with mode `rw-rw----`, unreadable to `simpson`. `.git/index` among them.

**How it presented.** Nothing said "permission". TypeScript reported
`error TS6053: File 'src/screens/care/useCareLog.ts' not found` and MSBuild reported
`MSB4025: The project file could not be loaded. Access to the path ... is denied`. Both builds were
dead for roughly seven hours, so no build could ship and the panel stayed on the 17 Aug release.

**Root cause.** Not established. Something ran as `root` inside the working tree — most likely a
build or script under `sudo`. **Worth pinning down: if it was the deploy script, running it again
reproduces this immediately after a fix.**

**Fixed by** `sudo chown -R simpson:geist-dev /srv/dev/homehub` (Allan, 2026-08-21).

**Guard.** Never run a build or script as `root` inside `/srv/dev/homehub` — see `OWNERSHIP.md`. If
a build fails claiming a file is *missing* that plainly exists, check ownership before anything else.

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
