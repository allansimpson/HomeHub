# Deployment

**Owned by Hermes. Claude does not know how this works and should not assume.**

This file is a placeholder with observations in it, not a description of the process. Hermes fills
in the process; until then the only honest state of this page is "unknown".

_Observations recorded 2026-08-21 by Claude. Confirmed by Allan: `scripts/deploy.sh` has not been
used to deploy in a good while._

## Known

- `scripts/deploy.sh` is **not** the route in use, and has not been for some time. The release
  names date the change: `/opt/homehub/releases` holds four `20260809-…` entries in `deploy.sh`'s
  format, then `20260812T…` and `20260817T…` in another. The method changed between 9 and 12 Aug.
- **The setup works.** It has been deploying successfully all along; Allan's read is that it may
  want fine tuning, not repair.
- Production is `/opt/homehub`, with `current` a symlink into `releases/`. Test is
  `/opt/homehub-test`.
- Nothing deploys on push: no post-receive hook, and `.github/workflows/ci.yml` only builds, tests
  and audits.

## Unknown — for Hermes to fill in

- **What actually deploys.** Which script or sequence, run from where, by whom.
- Whether `deploy/test-deploy-from-server.md` and `scripts/deploy.sh` are still meant to be in the
  repo, or are stale descriptions that should be marked or removed.
- What the process already verifies before a release goes live.
- Whether production and test are deployed the same way.

## Observations Claude made while looking at the server

Raw, and offered as data rather than as conclusions. Some may be intentional, already handled, or
irrelevant — Hermes is the one who can tell.

1. **The release stamp does not match `deploy.sh`.** The running release is
   `20260817T193508Z-0bded247023e`. `deploy.sh` stamps `date +%Y%m%d-%H%M%S` →
   `20260817-193508`. The UTC-plus-git-sha form appears in the repo only in
   `deploy/test-deploy-from-server.md`.
2. **The stamp suffix is not an object in this repository** — neither `0bded247023e` (17 Aug) nor
   `2b9980de24a5` (12 Aug). It is systematic across both releases made by the current method, not a
   one-off.

   Claude first read this as "the running build cannot be traced to a commit". **That was an
   assumption, not a finding.** It rested on the suffix being `git rev-parse --short HEAD`, which is
   only true of the runbook Allan says is not the route in use. The suffix could be a build id, a
   content digest, or a sha from a source location that is not this clone. Hermes knows which; until
   then this is a question, not a problem.
3. **`/opt/homehub/current/wwwroot/build.json` does not exist.** The client build emits one
   (`client/vite.config.ts`, `stampBuild`); the deployed release predates it.
4. **The deployed bundle is from 17 Aug** and does not contain the pump-vibration fix — confirmed by
   reading the minified bundle, not inferred.

## Ground rule

Claude records observations here and asks. **Claude does not change deployment, write a deployment
procedure, or decide what the process ought to verify.** That is Hermes's call.
