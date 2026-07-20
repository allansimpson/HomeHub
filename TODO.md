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

**Stage 6 — Home Assistant & Climate: ✅ COMPLETE (simulated provider; HA behind the seam,
awaiting URL+token).** Added `IClimateProvider` seam with `SimulatedClimateProvider` (local
store, default — zones drift toward set point, full control persists) and
`HomeAssistantClimateProvider` (real HA REST: reads `climate.*` states, calls
`climate/set_temperature` + `set_hvac_mode` + `scene/turn_on`, local table as offline cache,
mode-string mapping; config-gated on `HomeAssistant:*`). `ClimateMode` enum + `ClimateZone`
entity + migration `Stage6_Climate`, seeded 5 mini-split zones (Living Room, Bedroom, Kitchen,
Study, Loft). `ClimateController` zones / setpoint / mode / scene. Client: `ClimateProvider`
context (optimistic set-point, debounced writes, poll reconciliation held off mid-adjust),
Climate screen (spec 08: zone rows, in-place expand with 76px ± block + 5 mode chips + status
footer, ALL OFF / EVENING SCENE), dashboard climate strip driving the Living Room zone. 39
backend tests green. **Verified live on LocalDB**: seeded zones, set-point/mode changes, drift
toward set point, EVENING (all Cool@70) + ALL OFF scenes. Govee-via-HA sensors deferred per the
decision default (the seam makes it additive later).

**Note:** live mini-split control + WebSocket live state need the HA URL + long-lived token
(`HomeAssistant:BaseUrl`/`Token`, optional `EveningScene`/`ZoneNames`); the HA path is
implemented (REST + polling) but untested until configured. WebSocket push is a later
enhancement (currently poll-based, like sensors/weather).

**Stage 7 — AI Assistant (hybrid local/cloud, text + image): ✅ COMPLETE (simulated fallback;
OpenAI/local behind the seam, awaiting keys).** Added `IAssistantProvider` seam +
`AssistantRouter` (task-based routing via tunable hint lists, low-confidence escalation
local→cloud, force override, image→cloud) per `docs/hybrid-ai-routing.md`. Providers:
`LocalAssistantProvider` (Ollama `/api/chat`, `Ai:LocalEndpoint`), `OpenAIAssistantProvider`
(chat completions + vision, `Ai:OpenAiApiKey`), `SimulatedAssistantProvider` (built-in
on-device fallback, always available). Response carries origin (Local/Cloud) + escalated flag;
keyed DI so the router depends only on the seam. `AssistantController` POST /chat (text+image,
session context passed per turn — nothing persisted). Assistant needs no DB (works even without
a connection string). Client: Assistant screen (spec 09: idle emblem + TRY ASKING suggestions,
conversation transcript with user/assistant left-rules, per-turn LOCAL/CLOUD tag, text input,
image upload). Scope: Q&A + image analysis (action-wiring deferred, seams make it additive);
transcript session-only. 48 backend tests green (7 router + 2 endpoint). **Verified live
(no DB)**: task routing (conversion/command→local, open-ended→cloud), force, history passthrough,
simulated fallback. Router unit tests cover cloud routing + escalation with provider fakes.

**Note:** real answers + the CLOUD indicator need `Ai:OpenAiApiKey` (+ model) and/or a local
model at `Ai:LocalEndpoint`; those providers are implemented but untested until configured.
**Privacy:** cloud-routed turns leave the LAN; local/simulated stay on-LAN. Camera→AI stays out
of scope (only deliberate uploads go out).

**Stage 8 — Voice: ✅ COMPLETE (browser STT+TTS, demoable; server Whisper behind the seam).**
Push-to-talk voice on the assistant. Frontend: swappable `speech.ts` engine (browser Web Speech
API recognizer + on-device `speechSynthesis`), `VoiceProvider` global mic state (micLive,
listening, live partial transcript) with **5s trailing-silence auto-stop that resets on speech**
+ manual stop, push-to-talk only (no wake word / always-listening). The global verdigris
**mic-live banner** now shows on ANY screen whenever the mic is open (App reads `useVoice().micLive`).
Assistant screen: functional emblem (tap to speak), Listening state (HEARING… partial +
animated waveform + square stop + "stops after 5s of quiet"), mic button in the input bar;
transcript flows through the **Stage 7 router** (inheriting LOCAL/CLOUD routing) and replies are
**spoken**. Backend: `ISpeechToText` seam + `OpenAISpeechToText` (Whisper) + `VoiceController`
(`/capabilities`, `/transcribe`) — server STT path used when configured, else the client uses the
browser recognizer. 50 backend tests green. **Verified**: voice endpoints (capabilities=serverStt
false without key, transcribe→501); client builds; graceful degrade to text when the browser has
no recognizer.

**Note:** the spoken end-to-end loop (tap→banner→speak→auto-stop→spoken reply) is browser-runtime
and needs a real mic/speaker in the kiosk's Chromium — implemented against the Web Speech API, not
driveable in headless CI. Server Whisper STT awaits `Ai:OpenAiApiKey`. Requires Pi mic/speaker +
Chromium mic-permission/autoplay flags per the stage decisions.

**Stage 9a — Offline read resilience & honest state: ✅ COMPLETE.** Added `ConnectionProvider`
(app-wide `online`/`stale` from a 10s `/api/health` probe with a 4s timeout; `stale` = offline
> 5 min per the default). App-wide **reconnecting bar** on non-dashboard screens; the dashboard
header **offline chip** (built Stage 0) now driven by real connection state. Every provider
already retained last-known data on failure (only flips its `offline` flag) — so cached reads
stay visible on every screen and there are **no blocking error screens**. Prominent live values
(dashboard house temps + climate strip, and the current readings on Sensor/Weather/Climate
screens) **grey to disabled** via `ml-stale` once past the 5-min threshold. Recovery is
automatic: the next successful probe clears `online`/`stale` and the providers' own polls refresh
data. 50 backend tests green (no backend change); client builds. Offline/recovery is
browser-runtime (probe against a stopped server) — logic is deterministic + typechecked.

**Stage 9b — optimistic write-queue: ⬜ deliberately deferred (confirm before building).** Per the
spec it's the riskiest piece and should not destabilize a working app; it also only has meaning
against **real** external integrations (Google/Microsoft/HA), which aren't wired here — the local
providers write straight to SQL. Recommended to build it once real creds are configured, with a
conservative surface-conflicts policy (default). Ask to proceed when ready.

**Build complete: Stages 0–9a shipped (9b optional follow-on).**

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
- ✅ **6 Home Assistant & Climate** — `IClimateProvider` seam, multi-zone mini-split control
  via HA (WebSocket live state); optional HA-backed sensor provider (Govee). (Simulated provider
  done + verified; HA REST control implemented behind the seam, awaiting URL+token. WebSocket
  live push + Govee sensors deferred.)
  Milestone: adjust a unit from the panel; live state reconciles.
- ✅ **7 AI Assistant (hybrid local/cloud)** — `IAssistantProvider` seam + router; text +
  image. See `docs/hybrid-ai-routing.md`. Task-based routing (commands/conversions/quick
  lookups→local; recipes/open-ended→cloud) + confidence fallback (weak local→cloud);
  LOCAL/CLOUD indicator on each turn. Local model runs on the SERVER, not the Pi. (Routing +
  simulated fallback done + verified; OpenAI/local providers implemented behind the seam,
  awaiting keys. Action-wiring deferred.)
  Milestone: local-routed answers local, cloud-routed answers cloud, low-confidence escalates.
- ✅ **8 Voice** — push-to-talk, 5s trailing-silence auto-stop (resets on speech) + manual
  stop; STT (prefer local/Whisper on the server) → Stage 7 router → TTS; global mic-live
  banner whenever mic is open (privacy-forward, cannot be disabled). (Browser STT+TTS done +
  builds; server Whisper behind the seam, awaiting key. Spoken loop needs a real mic/speaker.)
  Milestone: tap→speak→spoken reply; banner shows on any screen when mic is live.
- ✅ **9a Offline Hardening (reads)** — cached reads + reconnecting state everywhere; grey stale
  values after 5 min. Milestone: disconnect → cached data + chip, recovers cleanly.
- ⬜ **9b Offline write-queue** — optimistic write-queue + conflict resolution (explicit, last;
  deferred pending confirmation + real integrations).

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
**Core build complete (Stages 0–9a).** Optional remaining work:
- **Stage 9b** (offline write-queue + conflict resolution) — build once real integration creds are
  configured; confirm the conflict policy first (default: surface conflicts, don't overwrite).
- **Go-live wiring** — drop in the config secrets below and run against SQL Server to activate the
  real providers, replacing the simulated/local fallbacks. Then re-verify each real integration.
- Out-of-scope future workstreams (per the roadmap): cameras/camera-AI, shopping list, message
  board, lighting/locks/leak sensors, local-vision.

Config to go live: sensors `SensorPush:Email`/`Password` (+ sensor→zone map); weather
`Weather:Latitude`/`Longitude` (default Minneapolis); calendar `Google:ClientId`/`ClientSecret`/
`RefreshToken` (+ optional `CalendarId`); tasks `Microsoft:ClientId`/`ClientSecret` (+ per-profile
refresh tokens); climate `HomeAssistant:BaseUrl`/`Token` (+ optional `EveningScene`/`ZoneNames`);
assistant `Ai:OpenAiApiKey`/`OpenAiModel` and/or `Ai:LocalEndpoint`/`LocalModel` (+ `Ai:Routing:*`).
Run live with a SQL Server / LocalDB connection string in `ConnectionStrings__HomeHub` (Linux/Pi
needs `libicu`). Deploy per `README.md`, `deploy/server-systemd.md`, `deploy/pi-kiosk.md`.

Config to go live later: sensors `SensorPush:Email`/`Password` (+ sensor→zone map); weather
`Weather:Latitude`/`Longitude` (default Minneapolis); calendar `Google:ClientId`/`ClientSecret`/
`RefreshToken` (+ optional `CalendarId`); tasks `Microsoft:ClientId`/`ClientSecret` (+ per-profile
refresh tokens); climate `HomeAssistant:BaseUrl`/`Token` (+ optional `EveningScene`/`ZoneNames`);
assistant `Ai:OpenAiApiKey`/`OpenAiModel` and/or `Ai:LocalEndpoint`/`LocalModel` (+ `Ai:Routing:*`).
Run live with a SQL Server / LocalDB connection string in `ConnectionStrings__HomeHub`.