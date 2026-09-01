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
| `sudo` | Normal dev identities prompt. Restricted `geist-deploy` has only allowlisted NOPASSWD helpers; for HomeHub deployment, currently `homehub-test-install <release-id>`. |
| Disk | ~715 GB free |

## The servers

| | |
|---|---|
| Production | `/opt/homehub`, `current` → `releases/<stamp>-<sha>` |
| Test | `/opt/homehub-test` |
| Layout | Timestamped release dirs; `current` is a symlink, flipped atomically |
| Deploy | Geist-owned, documented in `DEPLOYMENT.md`; repository `scripts/deploy.sh` is not the active route |

**Nothing deploys on push.** There is no post-receive hook and `.github/workflows/ci.yml` only
builds, tests and audits. A commit reaching `origin/main` changes nothing on the panel.

## Running the checks

**Use `scripts/check.sh`, and do not hand-assemble the commands below.** It runs each check
regardless of whether an earlier one failed, reports them together, and bakes in the environment
variables the backend suite needs.

```bash
cd /srv/dev/homehub
./scripts/check.sh              # client: typecheck + lint + tests — ~11s
./scripts/check.sh backend      # backend suite — ~47s
./scripts/check.sh all          # both — for API-contract changes and before handing to Hermes
./scripts/check.sh client build # adds the production build; only pre-deploy needs it
```

`cd client && npm run check` is the same client run, for when you are already in there.

### What to run, and when

Tier by **which layer you touched**, not by how many tests exist. The client suite is 872 tests in
under four seconds — it is pure logic in a node environment, nothing is rendered — so narrowing it
saves about three seconds and costs the file-count guard described in the traps below. Never filter
it by file. The expensive check is the 47-second backend suite, and the question worth asking is
whether it is relevant at all.

| Changed | Run | Cost |
|---|---|---|
| CSS or tokens only | `./scripts/check.sh` | ~11s |
| Client TS/TSX | `./scripts/check.sh` | ~11s |
| `src/HomeHub.Api/**`, `tests/**` | `./scripts/check.sh backend` | ~47s |
| API contract — `client/src/api/types.ts` **and** a controller | `./scripts/check.sh all` | ~60s |
| Before a deploy hand-off | `./scripts/check.sh all` then `client build` | ~70s |

A client-only change never needs `dotnet test`; a backend-only change never needs the client suite.

**Run it once, after a batch of edits — not after each file.** The cost that matters is not the
seconds on the clock, it is the round trip: each separate invocation is a turn, and an approval, and
a wait. That is what turned verifying a font-size change into ten minutes of a session.

**Typography changes are not verified by unit tests.** One test file in the repo touches text
sizing (`client/src/app/remScale.test.ts`). A font that grew fails by clipping or overflowing, which
only the render harness below sees.

The client build writes into `src/HomeHub.Api/wwwroot` — the API serves the SPA, one deployable unit.

## Traps, each of which cost someone an afternoon

- **`inotify` limit.** `fs.inotify.max_user_instances` is 128 and every `WebApplicationFactory`
  makes config watchers. Without `DOTNET_hostBuilder__reloadConfigOnChange=false` the backend suite
  fails in the hundreds for reasons that look nothing like the cause.
- **A leaked connection string.** An exported `ConnectionStrings__HomeHub` is inherited by the test
  process and breaks the production-startup tests. Hence `env -u`.
- **…but `dotnet ef` requires one**, which is the exact inverse and easy to trip over straight after
  the line above. `migrations add` builds the `DbContext` at design time and refuses without it; it
  never connects, so any well-formed value does. Pass it per-command, never `export` it:
  `ConnectionStrings__HomeHub="Server=localhost;Database=HomeHub;Trusted_Connection=True;TrustServerCertificate=True" dotnet ef migrations add <Name> --project src/HomeHub.Api/HomeHub.Api.csproj --no-build`
  (verified 2026-08-28 adding `AddWeatherAlertProduct`).
- **vitest reports green while skipping.** An unreadable or unresolvable test file is counted as a
  failed *file*, but the summary line still reads `N passed`. Watch the **file** count, not just the
  test count. This hid 61 missing tests for seven hours.
- **Rendering the panels.** Playwright is installed shared at `/srv/dev/tools/playwright` (see its
  `USAGE.md`). The Kitchen harness is `artifacts/render-kitchen.mjs` + `artifacts/kitchen-fixtures.mjs`
  — it stubs the API in the browser, renders each route at the design canvas of 540 × 1169, writes
  PNGs to `artifacts/kitchen-shots/`, and audits for small tap targets, clipped text and overflow.

  ```bash
  cd client && npm run dev &          # readable stack traces; the built bundle is minified
  BASE=https://127.0.0.1:5173 PLAYWRIGHT_HOME=/srv/dev/tools/playwright \
    PLAYWRIGHT_BROWSERS_PATH=/srv/dev/tools/playwright/browsers node artifacts/render-kitchen.mjs
  ```

  **Match API routes on `pathname.startsWith('/api/')`, never a glob or regex for `/api/`** — the
  latter also catches the app's own `src/api/client.ts` on the dev server, serves it as JSON, and
  renders a blank page whose only symptom is a MIME-type error.
- **Design bundles are gitignored.** `design_handoff_*/` is an input, re-pullable, and the stale
  copy is the dangerous one. Do not commit them.

## Reference counts

So a sudden drop is visible. Update when they legitimately change.

| Suite | Count | As of |
|---|---|---|
| Backend (`dotnet test`) | 1121 | 2026-08-31 |
| Client (`npm run test`) | 872 across 45 files | 2026-08-31 |

**The backend count fell by 65 on 2026-08-30, legitimately.** `HuckleberryCalendarParserTests`,
`HuckleberryProviderTests` and `HuckleberryWriteTests` were deleted with the integration they
covered. That is the entire delta — no other test file lost a case. This note exists because the
table above is here precisely so a drop gets questioned.
