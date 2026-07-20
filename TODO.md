# TODO — HomeHub (Central Home App)

Central instruction file for continuing this repo. Build one stage at a time, in order;
each ends at a running, testable app. Never break an earlier stage (changes must be
additive; re-verify the earlier milestone).

## Current status
**Stage 0 — Foundation & Shell: ✅ COMPLETE.** Exists: HomeHub.slnx (net10.0),
src/HomeHub.Api (ASP.NET Core + EF Core, serves the SPA), client/ (React 19 + TS + Vite,
Meridian Ledger UI), tests/HomeHub.Tests. Design system built as components + CSS
(theme/tokens.css, components/ledger.css, `ml-` classes), self-hosted fonts, 4K portrait
rem-scaling (index.css), inline SVG icon sprite. All screens exist as styled placeholders.
`GET /api/health`, conditional EF/SQL Server, migrations-on-startup (RunMigrationsOnStartup),
SPA fallback. Empty HomeHubDbContext (entities added per stage). Deploy docs under deploy/.

**Stage 1 — Profiles, PIN & Settings: ✅ COMPLETE.** Added: EF entities `Profile`
(opt-in salted-PBKDF2 PIN, `RequirePinWhenIdle`/`StayLoggedIn`/order) and singleton
`HouseholdSettings` (idle timeout, idle dimming, freezer/humidity threshold placeholders,
active profile), seeded with a Viking household (Astrid, Ragnar, Leif) + migration
`Stage1_ProfilesAndSettings`. `ProfilesController` (CRUD, set/clear/verify PIN with
lockout) + `SettingsController` (get/update, active-profile switch). Client: typed API
client, `SessionProvider` lock state machine (unlocked/pinRequired), shared `PinPad`, Lock
screen (spec 06), Settings screen (spec 07: privacy/lock + set-PIN flow, mic ALWAYS-ON row,
threshold steppers, idle dimming, household add/rename/delete), dashboard profile-switcher
badge, idle-reset + night-dim wiring. 10 backend tests green; API boots without a DB
(profiles endpoint 500s gracefully, shell still serves). To run live, set
`ConnectionStrings__HomeHub`.

**Stage 2 — Sensors, History & Alert Engine: ✅ COMPLETE.** Added the mandatory
`ISensorProvider` seam with `SimulatedSensorProvider` (deterministic, auto-selected when no
creds) + `SensorPushProvider` (real cloud client, config-driven via `SensorPush:*`);
`SensorPollingService` (BackgroundService) writes every reading to SQL (60s) + one-time 24h
backfill for empty zones; the general **AlertEngine** (sustained-breach rule, type-agnostic
raise/clear). Entities `SensorZone`/`SensorReading`/`AlertThreshold`/`ActiveAlert` +
migration `Stage2_SensorsAndAlerts`, seeded 5 zones (Freezer, Fridge, Living Room, Kitchen,
Bedroom) + default thresholds. `SensorsController` (zones-with-latest, bucketed history) +
`AlertsController` (active alerts, threshold config that re-evaluates immediately). Client:
`SensorsProvider` polling zones+alerts, dashboard THE HOUSE widget + collapse + alert banner,
Sensor History screen (chips, current reading, 12-bar temp chart, humidity meters), Settings
alert-threshold editors wired to the engine. Dropped the Stage 1 placeholder °C settings
columns (per-zone thresholds are now the engine's source of truth). 19 backend tests green.
**Verified live on LocalDB**: readings flow, 24h chart renders, a forced freezer breach
raises the Severe banner and clears on recovery.

**⚠️ Foundation fix applied:** `Directory.Build.props` `InvariantGlobalization` flipped
`true`→`false` — `Microsoft.Data.SqlClient` refuses to connect in invariant mode (latent
since Stage 0; first surfaced here). On the Pi (Linux) this needs `libicu` installed.

**Next: Stage 3.**

## Sources of truth
- Stage specs: `CentralHome_ClaudeCode_BuildPackage/central-home-build/stages/stage-N-*.md`
  plus that package's `00-architecture.md` and `01-design-system.md`.
- Design: `HomeHub_ClaudeDesign/` — `design-tokens.json`, `icons.svg`, `specs/*.md` + `screens/*.png`.
  When building a screen, open its spec and match the render.
- Repo conventions: `docs/build-conventions.md`. Hybrid AI design: `docs/hybrid-ai-routing.md`.

## ⚠️ Naming reconciliation
The build package uses the placeholder name **CentralHome**. This repo is **HomeHub**.
Translate: `CentralHome.Api`→`HomeHub.Api`; solution→`HomeHub.slnx`; connection string
`CentralHome`→`HomeHub` (env `ConnectionStrings__HomeHub`). Tokens already exist as CSS
custom properties in `client/src/theme/tokens.css` — consume `var(--…)`, don't hardcode hex,
and don't recreate the design system that's already built.

## Cross-cutting rules
- **Provider seams are mandatory** and depend-on-interface only (no vendor SDK in UI/logic):
  `ISensorProvider` (Stage 2), `IClimateProvider` (Stage 6), `IAssistantProvider` + router (Stage 7).
  Suggested homes: src/HomeHub.Api/Sensors, /Climate, /Ai.
- **Alert engine built once (Stage 2), reused** (Stage 3 weather, future sensors). General
  shape: (type, severity, message, source, expiry) → dashboard banner + screen banner.
- **Offline:** cached reads + honest "reconnecting" state everywhere (Stage 9a);
  optimistic write-queue + conflict resolution is Stage 9b only (higher-risk, last).
- **Secrets never committed** — user-secrets in dev, env vars for the systemd service in prod,
  following the existing `ConnectionStrings__HomeHub` pattern.
- Real-time: prefer push (SignalR backend→client; HA WebSocket→backend). Match existing
  code style (file-scoped namespaces, Directory.Build.props centralizes net10.0/nullable).

## Stage roadmap  (✅ done · ⬜ todo)
- ✅ **0 Foundation & Shell**
- ✅ **1 Profiles, PIN & Settings** — profiles, conditional per-user PIN lock, Lock screen,
  Settings scaffold. Milestone: switch profiles, PIN lock/unlock, settings persist.
- ✅ **2 Sensors, History & Alert Engine** — `ISensorProvider` seam, SensorPush poller→SQL,
  house widget, history charts, configurable threshold alert engine + banner.
  Milestone: real readings, charts render, a threshold breach fires the banner.
- ⬜ **3 Weather & NWS Severe Alerts** — current/forecast + NWS alerts on the reused engine.
  Milestone: live weather; a severe alert renders the banner.
- ⬜ **4 Google Calendar** — shared household calendar; display + add/edit/delete.
  Milestone: events round-trip to Google.
- ⬜ **5 Microsoft To Do** — per-profile tasks; add/complete/delete.
  Milestone: tasks tied to active profile round-trip.
- ⬜ **6 Home Assistant & Climate** — `IClimateProvider` seam, multi-zone mini-split control
  via HA (WebSocket live state); optional HA-backed sensor provider (Govee).
  Milestone: adjust a unit from the panel; live state reconciles.
- ⬜ **7 AI Assistant (hybrid local/cloud)** — `IAssistantProvider` seam + router; text +
  image. See `docs/hybrid-ai-routing.md`. Task-based routing (commands/conversions/quick
  lookups→local; recipes/open-ended→cloud) + confidence fallback (weak local→cloud);
  LOCAL/CLOUD indicator on each turn. Local model runs on the SERVER, not the Pi.
  Milestone: local-routed answers local, cloud-routed answers cloud, low-confidence escalates.
- ⬜ **8 Voice** — push-to-talk, 5s trailing-silence auto-stop (resets on speech) + manual
  stop; STT (prefer local/Whisper on the server) → Stage 7 router → TTS; global mic-live
  banner whenever mic is open (privacy-forward, cannot be disabled).
  Milestone: tap→speak→spoken reply; banner shows on any screen when mic is live.
- ⬜ **9 Offline Hardening** — 9a cached reads + reconnecting state everywhere; 9b optimistic
  write-queue + conflict resolution (explicit, last). Milestone: disconnect → cached data +
  chip, recovers cleanly.

## Inputs needed from the human (line up before the stage)
- S2 SensorPush creds + sensor→zone map + thresholds/durations
- S3 US location for NWS + a proper NWS User-Agent string
- S4 Google OAuth client + household account (calendar WRITE scope)
- S5 Microsoft/Azure app reg (Graph To Do) + per-profile account linking
- S6 Home Assistant URL + long-lived token + climate-entity→zone map + scene mapping
- S7 OpenAI key + model; SERVER SPECS to choose the local model + routing thresholds (or cloud-only)
- S8 confirmed mic/speaker on the Pi (OS audio working) + STT/TTS choice

## Out of scope (don't build unless a stage says so)
Camera systems / camera-image→AI, shared shopping list, message board, meal planning,
lighting/lock/leak control, local-vision AI. If a task seems to need one, stop and confirm.

## Immediate next action
Start Stage 3 (`stage-3-weather.md`): confirm its Decisions-to-confirm with the human (US
location for NWS + a proper NWS User-Agent string), build current/forecast + NWS severe alerts
**on the reused Stage 2 alert engine** (no new alert mechanism), to the milestone, verify, then
tick the roadmap above before Stage 4.

To plug in real sensors later: set `SensorPush:Email` / `SensorPush:Password` (user-secrets in
dev, env vars in prod) and map sensor ids to zones; the app switches off the simulated provider
automatically. To run live now, use a SQL Server / LocalDB connection string in
`ConnectionStrings__HomeHub`.