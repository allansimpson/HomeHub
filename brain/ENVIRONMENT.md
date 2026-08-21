# Environment

The machine, the servers, and the traps. Every line here was measured rather than assumed; the date
says when.

_Last verified: 2026-08-21._

## The dev box

| | |
|---|---|
| OS | Ubuntu 24.04.4 LTS, x86_64 |
| Repo | `/srv/dev/homehub`, owned `simpson:geist-dev` |
| Node / npm | v24.19.0 / 11.17.0 |
| `sudo` | **Prompts for a password.** No agent can use it. |
| Disk | ~715 GB free |

## The servers

| | |
|---|---|
| Production | `/opt/homehub`, `current` → `releases/<stamp>-<sha>` |
| Test | `/opt/homehub-test` |
| Layout | Timestamped release dirs; `current` is a symlink, flipped atomically |
| Deploy | **See `DEPLOYMENT.md` — `scripts/deploy.sh` is not the route in use** |

**Nothing deploys on push.** There is no post-receive hook and `.github/workflows/ci.yml` only
builds, tests and audits. A commit reaching `origin/main` changes nothing on the panel.

## Running the checks

```bash
# Backend — the env vars are not optional, see the traps below
cd /srv/dev/homehub
env -u ConnectionStrings__HomeHub DOTNET_hostBuilder__reloadConfigOnChange=false \
  dotnet test HomeHub.slnx

# Client
cd client && npx tsc -b && npx oxlint src/ && npm run test && npm run build
```

The client build writes into `src/HomeHub.Api/wwwroot` — the API serves the SPA, one deployable unit.

## Traps, each of which cost someone an afternoon

- **`inotify` limit.** `fs.inotify.max_user_instances` is 128 and every `WebApplicationFactory`
  makes config watchers. Without `DOTNET_hostBuilder__reloadConfigOnChange=false` the backend suite
  fails in the hundreds for reasons that look nothing like the cause.
- **A leaked connection string.** An exported `ConnectionStrings__HomeHub` is inherited by the test
  process and breaks the production-startup tests. Hence `env -u`.
- **vitest reports green while skipping.** An unreadable or unresolvable test file is counted as a
  failed *file*, but the summary line still reads `N passed`. Watch the **file** count, not just the
  test count. This hid 61 missing tests for seven hours.
- **No headless browser.** Nothing has ever been rendered. Playwright needs no `sudo` here — every
  Chromium shared library is already present — but it has not been installed. See
  `.hermes/2026-08-20-headless-browser-for-kitchen-verification.md`.
- **Design bundles are gitignored.** `design_handoff_*/` is an input, re-pullable, and the stale
  copy is the dangerous one. Do not commit them.

## Reference counts

So a sudden drop is visible. Update when they legitimately change.

| Suite | Count | As of |
|---|---|---|
| Backend (`dotnet test`) | 1169 | 2026-08-21 |
| Client (`npm run test`) | 678 across 40 files | 2026-08-21 |
