# Deployment

**Owned by Geist (Hermes). Claude records observations and hands deployment work over.**

_Last verified: 2026-09-01T22:15Z by Geist. Sources: live restricted-SSH probes,
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

Verified at 2026-09-01T22:15Z:

- TEST runs release `20260901T221511Z-52b1222e8e04`, source-tree SHA-256
  `52b1222e8e044dc83956a02ad355fb53389ab370325fc342d89c7ddd0a3d1941`, artifact SHA-256
  `e6e11090036dfc2bc68ddfd5b82dcc2d3183a998de2ef80e48a27c2a96cd819f`.
- TEST is active; trusted HTTPS and deep health return 200; database `ok`; pending migrations `0`;
  migration head `20260901164422_AddProfileSecurityVersion`; build
  `c14717c+ · 2026-09-01 22:15Z`; SPA bundle `index-Bl4dmmRv.js`. The live bundle and service worker
  exactly match the immutable artifact.
- TEST's legacy `Mcp:ApiKey` is absent, its named Barnaby credential remains present, and its explicit
  household CA plus four required SANs are configured. Deliberate live startup probes proved refusal
  for missing SAN configuration, missing CA, and a non-empty legacy key; valid configuration was then
  restored and deep health reverified.
- Production remains unchanged on release `20260831T105206Z-09cfd47e8477`; service active; HTTPS and
  deep health 200; database `ok`; pending migrations `0`; migration head
  `20260827205336_AddWeatherAlertProduct`; build `a66e80a+ · 2026-08-31 10:52Z`.
- The new archive remains TEST-only and production-ineligible. Production still requires its own
  legacy-key rotation/configuration check, a fresh exact-candidate source review with zero
  Critical/High findings, and Allan's explicit approval.

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
