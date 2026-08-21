# HomeHub — Project Knowledge Base

Reference for the **HomeHub** household panel (product name **Central Home**; visual design
**Meridian Ledger**). This is the single source of project knowledge: architecture, conventions,
the provider-seam model, key decisions, and the go-live checklist. Build/run/deploy commands live
in [`README.md`](README.md).

**Agents start in [`brain/`](brain/)** — shared working memory between Claude and Hermes, holding
what is deployed, who owns what, and what has already gone wrong. This file is the project's
knowledge; `brain/` is the agents' knowledge of each other and of the machine.

**Status: build complete — Stages 0–9 shipped.** The app runs end-to-end on simulated/local
providers today; each real integration activates by adding config (see [Go-live](#10--go-live)).

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
| Climate units | `IClimateProvider` | `SimulatedClimateProvider` (drifts to set point) | `HomeAssistantClimateProvider` (HA REST) | `HomeAssistant:*` | simulated verified; HA untested |
| Assistant | `IAssistantProvider` + `AssistantRouter` | `SimulatedAssistantProvider` (on-device canned) | `LocalAssistantProvider` (Ollama) / `OpenAIAssistantProvider` | `Ai:*` | routing verified; models untested |
| Voice STT | `ISpeechToText` + `SttRouter` | browser Web Speech API (client) | `LocalWhisperSpeechToText` (faster-whisper) → `OpenAISpeechToText` (Whisper) fallback | `Voice:Stt:*` (+ `Ai:OpenAiApiKey` for fallback) | router verified; sidecar untested |

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

`EvaluateAsync` returns a `SensorAlertPass` — the open **count** and, separately, the alerts this
pass **raised**. `SensorPollingService` notifies from the raised set only: an alert says "this is
true now" and a notification says "this happened at 7:41 PM", so announcing from the open set would
re-tell the household the same thing every thirty seconds for as long as it stayed true.

## 5a · Climate: the control loop

**The probe is the truth; the set point is the machine's business.** A mini-split holds its own
return-air temperature — the air beside the unit, not the temperature of the room — so HomeHub reads
the room's SensorPush probe and moves the Sensibo set point itself, through Home Assistant, until the
*probe* reads what the household asked for. That splits one number into two, and the whole section
follows from keeping them apart:

| | What it is | Who owns it | Where it appears |
|---|---|---|---|
| **Target** | What the household wants the room to be | A person | The row, in brass |
| **Set point** | What the unit is currently told to do | The loop | Drill-in only, as a fact |

**Zones are rooms; units are machines.** `ClimateZone` is a room the household names (probe + unit +
standing target + class); `ClimateUnit` is the mini-split cache that used to be called `ClimateZone`.
`/api/climate/zones` serves the panel and every write on it moves a target; `/api/climate/units` is
the machine surface, and nothing on the Climate screen calls it.

**Every probe gets a row.** `ClimateBinder` matches unbound rooms to probes and units by name, then
adopts any probe no room has claimed as a new `Watched` room named after the sensor. Without that
last step the panel could only ever show the six seeded room names, and a real SensorPush sensor the
vendor called "Basement" would report into SQL every minute with nowhere on Climate to appear.
Adopted rows are `Watched`, never `ColdStorage`: an in-range band has to be a decision, and guessing
34–40° for something called "Garage" is a guess the panel would then alarm on.

- **The loop** (`ClimateLoop`, one tick a minute) corrects by 1/2/3° at most once every 20/10/6 min
  by correction strength. That interval is compressor protection, not a preference, so it is not on
  the panel — and it holds under *every* combination of override, promotion and quiet-hours
  transition, including a person's own writes.
- **Everything degrades to the unit's own thermostat, never to nothing.** A probe silent 15 minutes
  hands the room back with the target written *as* the set point; an unreachable unit retries for 30
  minutes and says so; a paused room is left exactly as it stands.
- **`LoopWrite` is not optional.** Every attempt is recorded, failures included. Every sentence the
  row speaks is a read of it, and it is the only way to answer "why was the bedroom cold last night".
- **No schedules.** One standing target per room; a two-hour loan covers "it's too warm *now*", and
  the repeat-offer is how a schedule can later earn its way in from evidence.
- `ClimateBinder` re-ties rooms to probes and units by name, and drops the seeded simulated units
  once Home Assistant is live — the same move `SensorPollingService` makes for demo sensor zones.

## 6 · Hybrid AI routing

> **Rewritten at stage A5.** `ai-assistant.md` (rev. 2) owns the workstream and its stages; this
> section stays authoritative for the seam's shape. The hint-scored two-tier router described here
> until 2026-08-04 is gone — `Ai:Routing:LocalHints`/`CloudHints`/`DefaultOrigin` no longer exist.

The assistant is **two paths, not tiers**, all behind `AssistantRouter` so swapping a backend needs
no UI change:

- **Reflex** — `AssistantActions` first, then the small on-server model (`Ai:LocalModel`). Fast,
  on-LAN, always available. **Every spoken turn goes here**, regardless of what else is configured.
- **Deliberate** — an agent process on the server (`Ai:Agent:*`; Hermes) with its own memory,
  persona and toolset, reaching the house through the **MCP seam** (`Mcp:*`) rather than through
  this config. Slower and better, so it takes turns that can afford to wait.
- **Cloud** — OpenAI, for world knowledge and images. The only origin that leaves the LAN.

Routing is four facts, none of them a guess about what the prompt *means*:

1. **Override** — a request may force `local` / `cloud` / `agent`. It beats every rule below.
2. **Images → cloud**, the only provider with a vision path.
3. **Spoken → reflex, always.** A spoken reply has a couple of seconds before the silence *is* the
   answer, and an agent loop is several model round-trips. Set by the panel's push-to-talk and
   hard-coded by the Pi bridge.
4. **Otherwise, the best thing configured** — agent, else cloud, else local.

- **Actions-first:** `AssistantActions.TryHandleCommandAsync` runs **before** the router. A
  recognised command executes deterministically, offline, with no model, returning `Model: "actions"`
  having never touched an LLM. Everything above sits behind this, not in front.
- **Confidence fallback:** a weak reflex answer (empty/too-short, hedging/refusal, low
  self-reported confidence) **escalates to cloud**; the response reports the final origin. Kept
  because a 4B model saying "I don't know" is worth a second opinion.
- **Indicator (required):** every turn shows a **LOCAL / CLOUD / AGENT** tag — `--brass-dim`,
  `--live-text`, `--brass` respectively. The distinction it draws is *did this leave the house*.
  Voice inherits it automatically. *Known defect: the simulated fallback still reports `Local`.*
- **Degrade ladder:** agent → reflex → simulated, and cloud → local → simulated, swallowing provider
  failures (429, outage) but never cancellation. `SimulatedAssistantProvider` is the floor, so a
  dead agent or a dead network never takes the panel with it.
- **Placement:** models run on the **server**, never the Pi. **Privacy:** local/agent/simulated turns
  stay on-LAN; only cloud-routed turns leave it. **Camera *systems*→AI remain out of scope** — a
  camera the panel watches by itself is outside this line and always will be. A photograph a person
  deliberately attaches is inside it, and `event-capture.md` now scopes exactly that: an image
  attached in Assist is read for an engagement by a **tool-less, schema-constrained call** (never the
  tool-bearing agent — a flyer is untrusted text), and a person confirms every field before anything
  is written. Images have no on-LAN path: the local and agent models have no vision, so this is the
  one input that cannot degrade to a local read and must not pretend to.

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
  overwrite (conservative policy). Climate writes are last-write-wins and answer with the whole next
  panel, so a row re-renders from one response rather than from a merge the client invented — except
  the press-and-slide gesture, which is **disabled** after five minutes of failed polls: sliding
  against a target that may already have changed is worse than not sliding, and a gesture cannot
  meaningfully queue.
- **9c — the Care log goes further, and is the only domain that does.** 9a/9b degrade gracefully;
  Care is expected to *work*, because the moment somebody needs it most is 3am with the server down,
  and "log it later" does not happen. Three additions, all Care-specific:
  - **Entries are replay-safe by key, not by hope.** `CareEntryInput.ClientKey` is stored as
    `CareEntry.ExternalKey` under a `panel:` prefix, reusing the unique filtered index the
    Huckleberry import already had (`hb:`). A second write of the same key **returns the first row**
    instead of creating a second, so the one failure a queue cannot diagnose — row landed, response
    lost — cannot duplicate a feed. `clientKey` comes back on the DTO so the client can match its
    own unsent rows against the server's; `mergeEntries` (`careOffline.ts`) is the only thing
    allowed to decide two rows are one feed, and it matches on that key alone.
  - **Reads are cached to localStorage** (`careOffline.ts`), so a cold open with no server shows the
    log rather than a blank page — a blank page at 4am reads as "nothing was logged tonight".
  - **Timers run on the device and never sync as timers.** A session started offline is a local
    stopwatch; on COMPLETE it writes an ordinary keyed entry carrying its duration. There is no
    half-finished session to reconcile on reconnect, and nothing that can be counted twice.
  - Care `PUT`/`DELETE` accept `?baseVersion=` like the rest of 9b, so a correction queued for hours
    cannot silently overwrite one made on the panel since.
- **9d — the session, so offline is usable rather than merely possible.** Three findings, all from
  actually running the app off the network:
  - **The banner distinguishes the two states.** `ConnectionProvider.offline` turns true after
    `OFFLINE_AFTER_MS` (20s), and the banner switches from *Reconnecting* (alert palette) to
    *Offline — saved here, will sync when you're back* (brass). 20s so a deploy restart, which is
    back in a few seconds, never flashes "offline" across every panel in the house. The dashboard's
    `OfflineChip` reads the same flag — it is the one screen with no banner, so the two would
    otherwise disagree.
  - **The panel no longer idle-locks while the server is unreachable.** Locking is client-side and
    instant; unlocking calls `signIn`, which is the server's to answer. Offline those disagreed, and
    a phone would lock itself into a state with no exit — putting the care log behind a keypad that
    rejects every correct PIN. `lockNow` is now a no-op while offline and resumes on the next good
    probe. `LockScreen` also distinguishes *wrong PIN* from *could not check it*; it previously
    cleared the digits and said nothing, which reads exactly like being told you are wrong.
  - **A 12-hour trusted-unlock window** (`app/sessionTrust.ts`), keyed to the profile, cleared on
    sign-out and profile switch. **It is not a credential** — no PIN and no hash of one is stored,
    the HttpOnly cookie is still the only thing that authorises a request, and the server still
    decides. It is a note about when somebody last proved themselves *on this device*, used to
    decide whether to ask again. `shouldAskForPin` is the single rule; the boot path and the idle
    timer both go through it so they cannot drift.
  - The last confirmed identity and roster are cached so an offline launch comes up as that person
    rather than anonymous and empty. **`isAdmin` is deliberately not cached** — that is an
    authorisation answer and the server's alone to give.
- **Service worker (`client/public/sw.js`)** — the app shell is cached so an installed panel or
  phone can *launch* offline, which nothing in 9a/9b provided. Three rules: **`/api` is never
  cached** (a cached `/api/health` would have `ConnectionProvider` report itself online while
  nothing could leave the device, and stale care data is how a baby gets fed twice); navigations are
  **network-first** so a reachable server always wins and no device is stranded on a stale build;
  `/assets/*` is **cache-first** because its name is its hash. Registered in `main.tsx` and
  **unregistered in dev** — a worker in front of Vite silently breaks HMR. A device that has never
  reached this server still cannot open the app; no caching changes that.

## 8 · Key decisions, fixes & gotchas

- **A PIN can be changed, and changing your own asks for the one in force — signed in or not.**
  There used to be no change at all: the toggle in Privacy & Lock collected a PIN when there was
  none, and after that the only route to different digits was Household → Clear PIN and back on
  again. Neither half asked for the PIN being replaced, so anybody at the already-unlocked wall
  panel — which holds a *persistent* session by design — could set a member's PIN to four digits
  only they knew. `ProfilesController.RefuseWithoutCurrentPin` now gates both `PUT` and `DELETE`
  on `{id}/pin`; removing your own asks too, or clear-then-set would be the same bypass with two
  taps. Wrong attempts count against the **same `PinLockout` as sign-in**, so it is not a quieter
  door to guess at. An **administrator resetting somebody else's** is deliberately exempt — that is
  the household's only recovery path for a forgotten PIN. The client mirrors the rule in
  `screens/pinChange.ts` (current → new → confirm) and reads "is this my own PIN" from the
  *session's* profile id, never `settings.activeProfileId`, which is a shared display value anyone
  can change. There is still **no verify-PIN endpoint** and there must not be (AUDIT A1): the
  current PIN is proved by the write that uses it, which is why a mistyped one is only reported
  after the confirm.
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
- **The app has no swipe-between-tabs gesture, and reports of one are the platform's back gesture.**
  Found in user testing on the Care tab, **on Android Chrome as an installed PWA**: paging the
  SINCE/TODAY/ENTRIES panels landed people on another tab. Android gesture navigation delivers an
  edge swipe to Chrome as a *system back command* — it never reaches the page as a touch — so it
  pops history and the entry underneath is whichever tab was open before.
  **Do not try to block the gesture. Two attempts were shipped and neither could have worked.**
  Nothing in the web platform intercepts a system back: not `preventDefault` on `touchmove` or
  `touchstart`, not `touch-action`, not `overscroll-behavior` (which governs scroll chaining, and is
  already `none` on `body`). The first attempt was also written against the wrong platform — iOS,
  inferred from an earlier screenshot rather than asked about.
  The fix is two things that act on what back *reaches*, not on the gesture:
  1. `BottomNav` navigates with `{ replace: true }` — tab switches leave no entry to pop.
  2. `app/backGuard.ts` refuses a `popstate` that would leave a tab root, restoring the URL *and*
     React Router's own state object so its index cannot drift. It is installed in `main.tsx`
     **before the router mounts**, so it runs ahead of the router's listener and corrects history
     before anything renders — otherwise an absorbed swipe flashes the wrong tab for a frame.
  It decides on the route (`guardsBackFrom`), not on a flag callers set, so the ~10 `navigate(-1)`
  back buttons need no co-operation and cannot forget to give it. Drill-ins keep a working back, by
  button and by swipe; only tab roots refuse.
- **Enums serialize as strings** (global `JsonStringEnumConverter`); the client mirrors the unions.
- **Owner tagging on calendar events is local-only** (not pushed to Google), per the Stage 4 decision.

## 9 · Tests

`tests/HomeHub.Tests` — **634 passing** (the long-quoted "294" was stale by several stages). Boots the real app via `WebApplicationFactory<Program>`
with an isolated **EF InMemory** database per factory (seeded via `EnsureCreated`). Coverage: health,
profiles + PIN lockout + household role, settings, sensors + alert engine (raise/clear/duration), weather refresh +
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
| Weather | `Weather:UserAgent`; `Weather:Latitude` / `Weather:Longitude` are now the *fallback* location (default Minneapolis 44.98,-93.27) — the household sets its own in `Config › Devices › Weather location` |
| Calendar | `Google:ClientId`, `Google:ClientSecret`, `Google:RefreshToken` (+ optional `Google:CalendarId`) |
| Tasks | `Microsoft:ClientId`, `Microsoft:ClientSecret` (+ a per-profile refresh token in `MicrosoftAccountLink`) |
| Climate | `HomeAssistant:BaseUrl`, `HomeAssistant:Token` (+ optional `EveningScene`, `ZoneNames`) |
| Assistant | `Ai:OpenAiApiKey` (+ `Ai:OpenAiModel`) and/or `Ai:LocalEndpoint` (+ `Ai:LocalModel`, default `gemma3:4b` — the reflex model), tune `Ai:Routing:*` until A5 removes it. Stage A5 adds `Ai:Agent:*` for Hermes Agent (endpoint, key) — see `deploy/ai-stack.md`. |
| Voice | local STT via `Voice:Stt:LocalEndpoint` (faster-whisper sidecar), cloud fallback reuses `Ai:OpenAiApiKey`; on the Pi, confirm mic/speaker + Chromium mic-permission/autoplay flags |

Re-verify after wiring: SensorPush readings, Google round-trip (edit reflects on another device),
MS To Do round-trip, HA unit control + live state reconcile, OpenAI answers with the CLOUD tag,
and the spoken voice loop on the Pi. Deploy per [`deploy/server-systemd.md`](deploy/server-systemd.md)
and [`deploy/pi-kiosk.md`](deploy/pi-kiosk.md).

## 11 · Out of scope (future workstreams)

Not built unless explicitly scoped: camera systems, message board,
lighting/lock/leak control, local-vision AI. Also deferred but
additive behind existing seams: Govee-via-HA sensors (`ISensorProvider`), assistant *actions*
(wiring the assistant to the calendar/todo/climate seams), HA WebSocket live push, and SignalR
backend→client push.

**Now scoped, with their own authoritative design docs** (this file stays authoritative for
architecture, seams and conventions; each doc owns its workstream's stages):

- **`event-capture.md`** — photo → calendar event. Takes **camera-image→AI** out of the list above
  and narrows §6's camera sentence: a photograph somebody deliberately attaches in Assist is read
  for an engagement, a camera system the panel watches by itself is not. Stages **E1–E6**. The
  reading is its own tool-less seam (`IEventExtractor`) rather than an assistant turn, because
  printed words reaching a model that holds the MCP tools are an injection surface; the prose turn
  is generated *from* its result. Nothing is written without a person confirming it on a sheet that
  marks every guessed value in amber. Also lands the first **`IsAllDay`** flag end to end — all-day
  events created by hand synced to Google wrong before E1.
- **`huckleberry-integration.md`** — Huckleberry baby tracking via Home Assistant + BLE scale
  capture. Stages H1–H4, S1–S3. Consumes the HA WebSocket live push listed above (H4 builds it).
- **`voice-tts.md`** — voice *output*; companion to §6 above, which owns STT and assistant
  routing. Stage 8R (prosody/cache refactor of the shipped `ITextToSpeech` seam) and Stage 8.5
  (Chatterbox, deferred until a GPU is installed).
- **`ai-assistant.md`** (rev. 2) — the AI assistant workstream, stages **A1–A7**. It **supersedes
  §6 on routing**: §6 describes the hint-scored two-tier router that is live today, and the doc
  replaces it with a **reflex / deliberate** split. Reflex is actions-first plus a small local
  model and takes every voice turn; deliberate is **Hermes Agent** — Nous Research's open-source
  agent, run as its own process — operating the house through an **MCP server HomeHub exposes**,
  which is the workstream's real deliverable. Memory and persona are **Hermes's**, not ours.
  Deviations from this file, argued in the doc: the assistant stops being **stateless server-side
  in effect** (though no HomeHub table holds conversation — the store is in Hermes's process), the
  agent indicator is **brass, not verdigris** (verdigris is spoken-for as *live*), and **streaming
  is deferred into the GPU wave** with Chatterbox 8.5. Shipped: A1 (`Ai:LocalModel` = `gemma3:4b`,
  `Profile.Role`) and A2's rollback (`AssistantIdentity` and `Profile.AgeBand` removed — rev. 1
  read "Hermes" as a *language model* and designed an in-house persona/memory stack that Hermes
  Agent already provides).
- **`meals-planning.md`** — the **Meals** tab: week planner, local recipe folder, and web
  recipe import. Stages M1–M5. Moves *meal planning* and *shared shopping list* out of the
  out-of-scope list above. Note three deliberate deviations from this file's conventions, all
  argued in the doc: recipes are **locally owned with no provider seam** (§4's pattern needs an
  external system of record; there isn't one), **import has no seam either** (one format —
  schema.org `Recipe` JSON-LD — so one class, extract an interface only if a second strategy
  ever lands), and `MealPlanEntry.Date` is **`DateOnly`**, not `DateTime …Utc` (a meal slot is a
  calendar date, not an instant). Reuses the Stage 5 To Do provider and the 8R speech path;
  notably it does **not** use §6's assistant routing — import is fully deterministic and works
  with no AI configured. Takes the nav from eight items to **nine** — see the doc's D8 before
  touching `ledger.css` metrics.

Active build order and the human-gated verification items live in `TODO.md`.

## 12 · Build history (condensed)

0 Foundation & shell · 1 Profiles/PIN/settings · 2 Sensors + alert engine (**live-verified**) ·
3 Weather/NWS (**live-verified**) · 4 Google Calendar (local live) · 5 Microsoft To Do (local live) ·
6 Home Assistant climate (simulated live) · 7 Hybrid AI assistant (routing live) · 8 Voice (browser
STT/TTS) · 9a Offline reads · 9b Offline write-queue (**live-verified**). Plus a post-build design
audit: daylight boost wired, bottom-nav active-section fix, deterministic back-buttons, weather
"Tonight" amber note. Full commit history on `main`.
