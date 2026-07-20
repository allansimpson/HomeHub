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

**Stage 3 — Weather & NWS Severe Alerts: ✅ COMPLETE.** Added the `IWeatherProvider` seam
with `NwsWeatherProvider` (api.weather.gov: points→forecast/hourly + active alerts, key-free,
identifying User-Agent); `WeatherRefresher` caches the snapshot in SQL (`WeatherCache`) and
folds NWS alerts into the **shared alert engine** via new `AlertEngine.ReconcileAsync` +
`ActiveAlert.ExpiresAtUtc` (no new banner code); `WeatherPollingService` (10 min).
`WeatherController` serves cached current+hourly+daily; alerts continue through `/api/alerts`.
Migration `Stage3_Weather`. Client: `WeatherProvider` context, Weather screen (spec 05:
current, tonight/hourly strip, week-ahead rows with amber severe labels), dashboard header
conditions now real, banner reused on both screens. Config `Weather:*` (default Minneapolis
44.98,-93.27; set your real lat/long). 24 backend tests green. **Verified live against NWS**:
real current conditions (73°F, hi 94/lo 69, humidity/wind), hourly + 7-day forecast rendered;
weather-alert raise/clear/expiry covered by tests (no active NWS alert for the area at test
time; banner is the same component proven live in Stage 2).

**Fix:** `WeatherCache.Id` set `ValueGeneratedNever` (singleton row inserted with fixed id 1;
SQL Server rejected the explicit identity insert otherwise).

**Stage 4 — Google Calendar (shared household): ✅ COMPLETE (local provider; Google behind
the seam, awaiting OAuth).** Added `ICalendarProvider` seam with `SqlCalendarProvider` (local
store, default — full CRUD persists offline) and `GoogleCalendarProvider` (real Calendar v3:
silent OAuth refresh + events list/insert/patch/delete, local table as offline cache;
config-gated on `Google:*`). `CalendarEvent` entity + migration `Stage4_Calendar`;
`CalendarSeeder` seeds sample events on first run (local only). `CalendarController`
range/upcoming/get/create/update/delete. Client: `CalendarProvider` context, Calendar screen
(month grid with today-block + event dashes + agenda), touch-friendly Event editor (day/time
steppers 15-min, WHO chips, where/notes, delete — no dropdowns), dashboard NEXT now real
(hero + compact + collapse), routes `/calendar/new` + `/calendar/edit/:id`. Owner tagging is
local per the decision. 28 backend tests green. **Verified live on LocalDB**: seeded events on
NEXT/agenda; create/update/delete round-trip.

**Note:** the milestone's "appears in Google / vice-versa" needs the OAuth client + refresh
token; that path is implemented in `GoogleCalendarProvider` but untested until creds are set
(`Google:ClientId/ClientSecret/RefreshToken`, optional `Google:CalendarId`). DI fix: calendar
provider is DB-gated (needs `HomeHubDbContext`), matching the pollers.

**Stage 5 — Microsoft To Do (per-profile): ✅ COMPLETE (local provider; Graph behind the
seam, awaiting per-profile OAuth).** Added `ITaskProvider` seam with `SqlTaskProvider` (local
per-profile store, default — add/complete/delete persist offline) and `MicrosoftTodoProvider`
(real Graph To Do: per-profile refresh tokens via `MicrosoftAccountLink`, silent token
refresh, list/create/complete/delete + list-id resolution, local table as offline cache,
"everyone" aggregates linked profiles; config-gated on `Microsoft:*`). `TaskItem` +
`MicrosoftAccountLink` entities + migration `Stage5_Tasks`; `TaskSeeder` seeds sample tasks per
profile (local only). `TasksController` list (optional `profileId`) / create / complete /
delete. Client: `TasksProvider` context, To-Do screen (owner filter tabs, 30px checkboxes with
brass fill + strike + dimmed row, inline New Task with owner chips), dashboard TASKS section
(owner chips, "N of M done", collapse). Active profile is the default owner for new tasks. 33
backend tests green. **Verified live on LocalDB**: seeded per-profile tasks, owner filtering,
create/complete/delete round-trip.

**Note:** the milestone's per-member account linking + "round-trips to Microsoft To Do / verify
on another device" needs the Azure app registration + per-profile refresh tokens; that path is
implemented in `MicrosoftTodoProvider` but untested until creds are set (`Microsoft:ClientId`/
`ClientSecret` + a stored per-profile refresh token in `MicrosoftAccountLink`). No consent UI on
the kiosk yet — the token would be provisioned out-of-band for now.

**Next: Stage 6.**

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
- ✅ **3 Weather & NWS Severe Alerts** — current/forecast + NWS alerts on the reused engine.
  Milestone: live weather; a severe alert renders the banner.
- ✅ **4 Google Calendar** — shared household calendar; display + add/edit/delete. (Local
  provider done + verified; Google round-trip implemented behind the seam, awaiting OAuth creds.)
  Milestone: events round-trip to Google.
- ✅ **5 Microsoft To Do** — per-profile tasks; add/complete/delete. (Local provider done +
  verified; Graph round-trip + per-profile linking implemented behind the seam, awaiting creds.)
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
Start Stage 6 (`stage-6-home-assistant-climate.md`): confirm its Decisions-to-confirm with the
human (Home Assistant URL + long-lived token + climate-entity→zone map + scene mapping). Build
the `IClimateProvider` seam + multi-zone mini-split control via HA (WebSocket live state), plus
the optional HA-backed sensor provider (Govee). As with Stages 2–5, build behind the seam with a
local/simulated fallback so it's demoable without HA; drop in creds later. Build to the milestone
(adjust a unit from the panel; live state reconciles), verify, tick the roadmap, then Stage 7.

Config to go live later: sensors `SensorPush:Email`/`Password` (+ sensor→zone map); weather
`Weather:Latitude`/`Longitude` (default Minneapolis); calendar `Google:ClientId`/`ClientSecret`/
`RefreshToken` (+ optional `CalendarId`); tasks `Microsoft:ClientId`/`ClientSecret` (+ per-profile
refresh tokens). Run live with a SQL Server / LocalDB connection string in `ConnectionStrings__HomeHub`.