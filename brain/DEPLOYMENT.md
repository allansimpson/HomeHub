# Deployment

**Owned by Geist (Hermes). Claude records observations and hands deployment work over.**

_Last verified: 2026-09-02T14:25Z by Geist. Sources: live restricted-SSH probes,
`systemctl show`, deep-health responses, the active sudo policy, and the canonical HomeHub promotion
workflow._

## Authority and boundary

- Claude owns application code, tests, and development verification in `/srv/dev/homehub`.
- Geist owns TEST/production artifact creation, release qualification, installation, rollback, and
  live verification. Deployment work must not rewrite or build as root in the shared DEV checkout.
- Production requires Allan's explicit approval. TEST publication does not imply production
  eligibility.
- `scripts/deploy.sh` is not the active deployment route. Do not invoke it as a substitute.

## Active TEST route

1. Geist preflights the shared checkout, including readable source/test inventory and repository
   coordination files. Unexpected root-owned or unreadable inputs stop the deployment.
2. Geist captures the requested DEV state into an isolated snapshot without resetting, cleaning,
   staging, committing, or building in `/srv/dev/homehub`.
3. The client and API are built in isolation. Test discovery counts must reconcile with the source
   inventory; a green summary with missing tests is a failure.
4. Geist packages an immutable, release-ID-specific archive and records its SHA-256 checksum and
   provenance. A dirty DEV snapshot is marked TEST-only and production-ineligible.
5. The archive and manifest are staged through the restricted `geist-deploy` identity. The only
   HomeHub deployment sudo capability currently granted to that identity is:
   `/usr/local/sbin/homehub-test-install <release-id>`.
6. The root-owned installer validates the staged artifact, flips `/opt/homehub-test/current`, restarts
   `homehub-test.service`, checks readiness, and rolls back the application pointer on failure.
7. Geist independently verifies service state, deep database health, pending migrations, HTTPS, the
   exact health-reported SPA bundle, and service-worker bytes when present. Production health is
   checked without changing production.

The canonical implementation is Geist's packaged HomeHub promotion workflow, not a repository deploy
script. Its execution copy is refreshed from the packaged source before each run and is run outside
the shared checkout.

## Production route

- Start from a clean authoritative source candidate, or an owner-directed exact TEST-byte exception
  that is explicitly labeled as such.
- Complete full qualification and independent fail-closed source/privileged-installer review.
  Known Critical or High findings block production.
- Build/package once, deploy those exact qualified bytes to TEST, and verify them live.
- After Allan explicitly approves production, promote the exact pinned artifact without rebuilding.
- Preserve the prior release/configuration for rollback and verify production service, deep database
  health, migrations, HTTPS, live bundle identity, and production isolation.
- Any released fix must exist in authoritative DEV/Git; an isolated hotfix is not release-closeout.

## Current live observation

Verified at 2026-09-02T17:55Z:

- Clean authoritative DEV at exact pushed commit `f961a0a87541ecd96fb1b3ddca83814ecd861abc` was promoted to TEST as release `20260902T175515Z-079f8643db9b`.
- Source-tree SHA-256: `079f8643db9b291007d2367a0262c0da44ba462359ed9f172976f095c190326b`.
- Artifact SHA-256: `caded0f466a56cb185a261d0a82fe2b007b579ebe43a6830246916d789a7b474`.
- TEST is active; HTTPS and deep health return 200; database `ok`; pending migrations `0`; migration head `20260901164422_AddProfileSecurityVersion`; build `f961a0a+ · 2026-09-02 17:55Z`; SPA bundle `index-BWovjJC4.js`.
- The live bundle returned 200 and the service worker exactly matched the artifact at SHA-256 `f7fd97f0900e49e43eff565cd207039ea5a9ffc9354a5f3bb86e94a8818a3c94`.
- Fresh Chromium sessions at 540×1169 verified the normal dashboard and a forced browser-storage refusal. Both rendered without horizontal overflow or page errors; every observed application API response returned 200; the private-storage warning was visible in the failure path. Both configured Hermes agents were reachable through the deployed application. The expected development-CA service-worker certificate console message remains.
- Production remains unchanged on release `20260831T105206Z-09cfd47e8477`; service active; HTTPS and deep health 200; database `ok`; pending migrations `0`; build `a66e80a+ · 2026-08-31 10:52Z`; bundle `index-D3pqF7Ee.js`.
- This artifact is TEST-only and production-ineligible. Exact `f961a0a` still requires fresh zero-Critical/High qualification before production.

## Observation from Claude, 2026-08-30 — deployment docs still describe Huckleberry

**Source:** Allan, this date: *"there is no Huckleberry anymore, it was slowly phased out in favour
of the in-built systems which are now in place."* The application code was removed to match
(`STATE.md`), including the `Huckleberry` section of `appsettings.json`.

Two files under `deploy/` still document it, and they are Geist's rather than mine to edit:

- `deploy/home-assistant-core.md` — line 8 lists it as one of two HomeHub features depending on the
  HA instance; lines 145–170 cover installing `Woyken/huckleberry-homeassistant v0.4.3` via HACS and
  where its credentials live. **Climate and the Litter-Robot still depend on that HA instance**, so
  only the Huckleberry-specific parts have gone stale, not the document.
- `deploy/server-systemd.md` line 303 — a comment saying three features ride the HA token. Two do
  now.

Questions rather than instructions: is the HACS integration still installed on the HA box, and
should it be removed there as well as here? And does anything else on that instance depend on it?
I have not touched either file, or anything on a server.

## Claude's observation rule

Claude may add measured observations or questions here, clearly labeled with date and source. Claude
does not change this procedure or deploy. Geist corrects deployment facts in place so this file has
one current account rather than competing versions.
