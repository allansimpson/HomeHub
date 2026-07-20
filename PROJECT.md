# HomeHub — Project Knowledge Base

Reference for the **HomeHub** household panel (product name **Central Home**; visual design
**Meridian Ledger**). This is the single source of project knowledge: architecture, conventions,
the provider-seam model, key decisions, and the go-live checklist. Build/run/deploy commands live
in [`README.md`](README.md).

**Status: build complete — Stages 0–9 shipped.** The app runs end-to-end on simulated/local
providers today; each real integration activates by adding config (see [Go-live](#go-live)).

---

## 1 · What it is

A wall-mounted household hub: a **Raspberry Pi 5** driving a **4K portrait touch panel**, served
from an always-on **Ubuntu home server**. Features: shared calendar, per-person to-dos, room
sensors with owned history, mini-split climate control, weather with severe alerts, a hybrid
(local/cloud) AI assistant with voice, and PIN-locked household profiles.

**Stack:** ASP.NET Core + EF Core (`net10.0`) serving a React 19 + TypeScript + Vite SPA, backed
by SQL Server. One deployable unit in prod (SPA built into `wwwroot`, served by Kestrel).

## 2 · Repo layout

```
HomeHub.slnx                 .NET solution (net10.0)
Directory.Build.props        shared MSBuild (net10.0, nullable, implicit usings, globalization ON)
src/HomeHub.Api/             Web API + EF Core; serves the built SPA. Domains grouped by folder:
  Profiles/ Settings/ Sensors/ Alerts/ Weather/ Calendar/ Tasks/ Climate/ Ai/ Controllers/ Data/ Migrations/
client/                      React + TS SPA (Vite) — the Meridian Ledger UI
  src/app/ (providers, hooks, routing)  src/screens/  src/components/  src/icons/  src/theme/  src/api/  src/fonts/
tests/HomeHub.Tests/         xUnit integration/unit tests (WebApplicationFactory + EF InMemory)
deploy/                      server (systemd) + Pi kiosk setup docs
README.md                    build / run / deploy commands
PROJECT.md                   this file
```

## 3 · Architecture & conventions

- **Names:** product/display name is "Central Home"; **code name is `HomeHub`**. Root namespace
  `HomeHub.Api`, **file-scoped namespaces** with `using`s after the namespace line.
- **Shared MSBuild** (`Directory.Build.props`): `TargetFramework=net10.0`, `Nullable=enable`,
  `ImplicitUsings=enable`, `InvariantGlobalization=false` (see [Decisions](#8--key-decisions-fixes--gotchas)).
  Don't re-declare per-project.
- **Where new code goes:** provider seams grouped by domain under the API project (e.g.
  `Sensors/`, `Climate/`, `Ai/`); EF entities configured in `HomeHubDbContext.OnModelCreating`
  (one migration per stage; keep the design-time factory working); background services as
  `IHostedService`/`BackgroundService` registered in `Program.cs`; controllers `[ApiController]`
  route `api/[controller]`.
- **DI gating:** anything that needs the database (calendar/task providers, pollers, seeders) is
  registered **only when a connection string is present**, so the shell still boots without a DB
  (data endpoints 500 gracefully). The assistant/voice need no DB and are always registered.
- **Design system (already built — consume, don't recreate):** tokens are **CSS custom
  properties** in `client/src/theme/tokens.css` (dark theme + `:root[data-ambient='bright']`
  daylight boost). Component styles use the **`ml-` class prefix** in `client/src/components/ledger.css`
  — no Tailwind, no border-radius, no shadows. 4K portrait **rem scaling** in `client/src/index.css`.
  Self-hosted fonts (Marcellus for numerals/titles, Josefin Sans for body/labels). Inline SVG icon
  sprite (`icons/IconSprite.tsx`, `<Icon id="ico-…"/>`). Never hardcode hex — use `var(--…)`.
- **Runtime:** dev = two processes (Kestrel `:5220` + Vite `:5173` proxying `/api`); prod = one
  unit. No HTTPS redirect / no CORS (same-origin in prod, Vite proxy in dev). Migrations run on
  startup when a connection string is present; failure is logged non-fatally (offline-first).
- **Real-time:** currently poll-based everywhere. Preferred future direction is push (SignalR
  backend→client; HA WebSocket→backend) — the seams make this swappable with no UI change.

## 4 · Provider-seam model (the core pattern)

**Every external integration sits behind a mandatory interface; UI/logic depend on the seam, never
a vendor SDK.** Each seam ships with a **local/simulated fallback** (so the whole app is demoable
with zero credentials) and a **real implementation** that activates purely by adding config. This
is why the build is fully functional now and "go-live" is a config exercise, not a code change.

| Domain | Seam | Default (no creds) | Real provider | Config section | Live status |
|---|---|---|---|---|---|
| Sensors | `ISensorProvider` | `SimulatedSensorProvider` (deterministic readings + 24h backfill) | `SensorPushProvider` (cloud API) | `SensorPush:*` | seam verified; real untested |
| Weather | `IWeatherProvider` | — (NWS is key-free) | `NwsWeatherProvider` (api.weather.gov) | `Weather:*` | **verified live vs NWS** |
| Calendar | `ICalendarProvider` | `SqlCalendarProvider` (local store) | `GoogleCalendarProvider` (Calendar v3 + OAuth) | `Google:*` | local verified; Google untested |
| Tasks | `ITaskProvider` | `SqlTaskProvider` (local, per-profile) | `MicrosoftTodoProvider` (Graph, per-profile tokens) | `Microsoft:*` | local verified; Graph untested |
| Climate | `IClimateProvider` | `SimulatedClimateProvider` (drifts to set point) | `HomeAssistantClimateProvider` (HA REST) | `HomeAssistant:*` | simulated verified; HA untested |
| Assistant | `IAssistantProvider` + `AssistantRouter` | `SimulatedAssistantProvider` (on-device canned) | `LocalAssistantProvider` (Ollama) / `OpenAIAssistantProvider` | `Ai:*` | routing verified; models untested |
| Voice STT | `ISpeechToText` | browser Web Speech API (client) | `OpenAISpeechToText` (Whisper) | `Ai:OpenAiApiKey` | endpoints verified; browser loop needs a mic |

"Untested" = the real client is implemented and compiles, but can't be exercised without
credentials/hardware; the seam + fallback are proven.

## 5 · The shared alert engine

Built once (Stage 2), reused by weather (Stage 3) and any future source. An alert is
type-agnostic: **(type, severity, message, source, expiry)** → the dashboard banner + the relevant
screen banner (amber, hazard stripe when severe). Two entry points on `AlertEngine`:

- `EvaluateAsync` — the **sustained-breach** rule for sensor thresholds (a breach must hold
  continuously for the threshold's duration before raising; auto-clears on recovery).
- `ReconcileAsync` — for **externally-sourced** alerts (NWS weather): raise new / clear gone /
  refresh existing, with an explicit `ExpiresAtUtc`.

Thresholds are per-zone `AlertThreshold` rows (the engine's source of truth), edited on the
Settings screen. Alerts surface via `GET /api/alerts` (excludes cleared + expired).

## 6 · Hybrid AI routing

The assistant is **hybrid**: routine requests answered by a **local model on the home server**
(free, private, on-LAN); demanding requests go to **cloud (OpenAI)**. All access goes through
`AssistantRouter` (behind the seam), so switching a provider or tuning rules needs no UI change.

- **Route by task** (deterministic, tunable via `Ai:Routing:*` hint lists): control/action
  commands, conversions, timers, quick household lookups, short factual answers → **local**;
  recipes, open-ended explanations, world knowledge, long-form/reasoning, image analysis → **cloud**.
- **Confidence fallback:** a weak local answer (empty/too-short, hedging/refusal, or low
  self-reported confidence — a tuned blend) **escalates to cloud**; the response reports the final
  origin.
- **Override:** a request may force `local`/`cloud`.
- **Indicator (required):** every turn shows a small **LOCAL / CLOUD** tag; an escalated turn shows
  the final origin (CLOUD). Voice inherits this automatically (STT → same router → TTS).
- **Placement:** the local model runs on the **server**, never the Pi. With no local model
  configured the router degrades to cloud-only (or the simulated fallback) with no architecture
  change. **Privacy:** local/simulated turns stay on-LAN; only cloud-routed turns leave it.
  Camera→AI is out of scope — only deliberate image uploads go out.
- Optional later: token-budget awareness (bias harder toward local as a monthly cloud budget is
  approached).

## 7 · Offline model

- **9a — reads:** `ConnectionProvider` gives app-wide `online`/`stale` from a 10s `/api/health`
  probe (`stale` = offline > 5 min). Every provider keeps last-known data on failure, so **cached
  reads stay visible on every screen — never a blocking error**. A reconnecting bar shows app-wide
  (dashboard uses its header offline chip); prominent live values grey out (`ml-stale`) once stale;
  recovery is automatic on the next good probe.
- **9b — writes:** optimistic-concurrency `Version` on `CalendarEvent` + `TaskItem` (bumped per
  write); conditional writes send `?baseVersion=` → **409** on mismatch (with current server
  state), **404** on missing, last-write-wins when omitted. Client `writeQueue` (localStorage)
  applies mutations **optimistically**, **queues** when the server is unreachable, and **replays
  in order on reconnect** (fires `homehub:sync` so providers reconcile). A 409 surfaces a
  **conflict strip** — *Keep mine* (force overwrite) or *Use server* (discard) — never a silent
  overwrite (conservative policy). Climate set-points are last-write-wins (transient).

## 8 · Key decisions, fixes & gotchas

- **`InvariantGlobalization` must stay `false`** — `Microsoft.Data.SqlClient` refuses to connect in
  invariant mode. Latent since Stage 0; first surfaced at Stage 2. On Linux/Pi this needs **`libicu`**
  installed.
- **Singleton rows use `ValueGeneratedNever()`** (e.g. `WeatherCache.Id = 1`) — SQL Server rejects
  an explicit value into an identity column otherwise.
- **Seeded household is Viking-themed** (Astrid / Ragnar / Leif); the design specs illustrate with
  Eleanor / James / Theo — both are placeholder mock data, renamed at runtime.
- **Daylight boost** (`data-ambient="bright"`) and **night-dim** (`data-nightdim`) are orthogonal,
  both driven from `client/src/app/` hooks; the boost mode is a household setting (auto/on/off).
- **`homehub:sync`** is a window event the write-queue fires after replay/resolve so the calendar/
  task/climate providers refetch.
- **Enums serialize as strings** (global `JsonStringEnumConverter`); the client mirrors the unions.
- **Owner tagging on calendar events is local-only** (not pushed to Google), per the Stage 4 decision.

## 9 · Tests

`tests/HomeHub.Tests` — **55 passing**, 0 warnings. Boots the real app via `WebApplicationFactory<Program>`
with an isolated **EF InMemory** database per factory (seeded via `EnsureCreated`). Coverage: health,
profiles + PIN lockout, settings, sensors + alert engine (raise/clear/duration), weather refresh +
alert reconcile + expiry, calendar CRUD/range/upcoming, tasks CRUD/filter/ordering, climate
zones/setpoint/mode/scene, assistant router (task routing, escalation, force, image→cloud, fallback),
voice capabilities/transcribe, and 9b optimistic-concurrency (409/404). Run with `dotnet test`.

## 10 · Go-live

The app runs on fallbacks now. To activate the real integrations, supply config (user-secrets in
dev, env vars / protected config for the systemd service in prod — **secrets are never committed**),
then run against SQL Server and re-verify each integration end-to-end.

| Integration | Config keys |
|---|---|
| Database | `ConnectionStrings__HomeHub` (Linux/Pi also needs `libicu`) |
| Sensors | `SensorPush:Email`, `SensorPush:Password` (+ sensor→zone map) |
| Weather | `Weather:Latitude`, `Weather:Longitude` (default Minneapolis 44.98,-93.27), `Weather:UserAgent` |
| Calendar | `Google:ClientId`, `Google:ClientSecret`, `Google:RefreshToken` (+ optional `Google:CalendarId`) |
| Tasks | `Microsoft:ClientId`, `Microsoft:ClientSecret` (+ a per-profile refresh token in `MicrosoftAccountLink`) |
| Climate | `HomeAssistant:BaseUrl`, `HomeAssistant:Token` (+ optional `EveningScene`, `ZoneNames`) |
| Assistant | `Ai:OpenAiApiKey` (+ `Ai:OpenAiModel`) and/or `Ai:LocalEndpoint` (+ `Ai:LocalModel`), tune `Ai:Routing:*` |
| Voice | server Whisper reuses `Ai:OpenAiApiKey`; on the Pi, confirm mic/speaker + Chromium mic-permission/autoplay flags |

Re-verify after wiring: SensorPush readings, Google round-trip (edit reflects on another device),
MS To Do round-trip, HA unit control + live state reconcile, OpenAI answers with the CLOUD tag,
and the spoken voice loop on the Pi. Deploy per [`deploy/server-systemd.md`](deploy/server-systemd.md)
and [`deploy/pi-kiosk.md`](deploy/pi-kiosk.md).

## 11 · Out of scope (future workstreams)

Not built unless explicitly scoped: camera systems / camera-image→AI, shared shopping list,
message board, meal planning, lighting/lock/leak control, local-vision AI. Also deferred but
additive behind existing seams: Govee-via-HA sensors (`ISensorProvider`), assistant *actions*
(wiring the assistant to the calendar/todo/climate seams), HA WebSocket live push, and SignalR
backend→client push.

## 12 · Build history (condensed)

0 Foundation & shell · 1 Profiles/PIN/settings · 2 Sensors + alert engine (**live-verified**) ·
3 Weather/NWS (**live-verified**) · 4 Google Calendar (local live) · 5 Microsoft To Do (local live) ·
6 Home Assistant climate (simulated live) · 7 Hybrid AI assistant (routing live) · 8 Voice (browser
STT/TTS) · 9a Offline reads · 9b Offline write-queue (**live-verified**). Plus a post-build design
audit: daylight boost wired, bottom-nav active-section fix, deterministic back-buttons, weather
"Tonight" amber note. Full commit history on `main`.
