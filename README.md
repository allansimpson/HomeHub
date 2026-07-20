# Central Home App (HomeHub)

A wall-mounted household hub for a Raspberry Pi 5 driving a 4K portrait touch panel, served
from an always-on Ubuntu home server. Shared calendar, per-person to-dos, room sensors with
history, mini-split climate control, weather with severe alerts, an AI assistant, and
PIN-locked profiles. Visual design: **Meridian Ledger** (see the build package).

Built in ordered, independently-testable stages — see
[`CentralHome_ClaudeCode_BuildPackage/central-home-build/`](CentralHome_ClaudeCode_BuildPackage/central-home-build/).
This repository is currently at **Stage 0 — Foundation & Shell**.

## Layout

```
HomeHub.slnx                     .NET solution (net10.0)
src/HomeHub.Api/                 ASP.NET Core Web API + EF Core; serves the built SPA
client/                          React + TypeScript SPA (Vite) — the Meridian Ledger UI
tests/HomeHub.Tests/             xUnit integration tests
deploy/                          server (systemd) + Pi kiosk setup docs
CentralHome_ClaudeCode_BuildPackage/   build stages + design handoff (source of truth)
HomeHub_ClaudeDesign/            original Claude Design handoff (reference)
```

## Prerequisites

- .NET SDK **10.x**
- Node **20+** (built with Node 25 / npm 11)
- SQL Server reachable (existing instance; the app creates/migrates its own `HomeHub` DB)

## Develop

Two terminals — API (Kestrel) and the Vite dev server (which proxies `/api` to Kestrel):

```bash
# terminal 1 — API on http://localhost:5220
cd src/HomeHub.Api
dotnet user-secrets set "ConnectionStrings:HomeHub" "Server=…;Database=HomeHub;…"   # once
dotnet run

# terminal 2 — SPA on http://localhost:5173 (hot reload)
cd client
npm install
npm run dev
```

Open http://localhost:5173. The API runs without a connection string too (the shell boots and
shows a reconnecting state), so UI work needs no database.

> To preview at the real panel geometry, size a Chromium window to 2160×3840 (or use the
> device toolbar). The layout is viewport-relative, so it scales to any window while keeping
> hairlines crisp.

## Build one deployable unit

```bash
cd client && npm run build          # SPA → src/HomeHub.Api/wwwroot
cd ../src/HomeHub.Api && dotnet run  # serves API + SPA from one origin
```

Health check: `GET /api/health` → `{"status":"ok",...}`.

## Test

```bash
dotnet test
```

## Deploy

See [`deploy/server-systemd.md`](deploy/server-systemd.md) (server service) and
[`deploy/pi-kiosk.md`](deploy/pi-kiosk.md) (Pi kiosk). Secrets are never committed — the
connection string is supplied via user-secrets in dev and an environment variable
(`ConnectionStrings__HomeHub`) for the systemd service in prod.
