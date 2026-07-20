# Central Home App (HomeHub)

A wall-mounted household hub for a Raspberry Pi 5 driving a 4K portrait touch panel, served
from an always-on Ubuntu home server. Shared calendar, per-person to-dos, room sensors with
history, mini-split climate control, weather with severe alerts, a hybrid AI assistant with
voice, and PIN-locked profiles. Visual design: **Meridian Ledger**.

**The build is complete (Stages 0–9).** Every external integration sits behind a provider seam
with a **simulated/local fallback**, so the app runs end-to-end with **zero configuration**. Each
real service activates by adding config — no code changes. Architecture, conventions, and the
provider-seam model are in **[`PROJECT.md`](PROJECT.md)**.

## Contents

- [Prerequisites](#prerequisites)
- [Quick start (no configuration)](#quick-start-no-configuration)
- [Database setup](#database-setup)
- [How configuration works](#how-configuration-works)
- [Third-party service configuration](#third-party-service-configuration)
  - [Sensors — SensorPush](#sensors--sensorpush)
  - [Weather — NWS](#weather--nws-national-weather-service)
  - [Calendar — Google](#calendar--google-calendar)
  - [Tasks — Microsoft To Do](#tasks--microsoft-to-do)
  - [Climate — Home Assistant](#climate--home-assistant)
  - [AI assistant — OpenAI / local model](#ai-assistant--openai--local-model)
  - [Voice — STT / TTS](#voice--stt--tts)
- [Configuration reference (all keys)](#configuration-reference-all-keys)
- [Build one deployable unit](#build-one-deployable-unit)
- [Test](#test)
- [Deploy](#deploy)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **.NET SDK 10.x** | `dotnet --version` ≥ 10.0. Includes `dotnet ef` (`dotnet tool install --global dotnet-ef` if missing). |
| **Node 20+** | Built with Node 25 / npm 11. |
| **SQL Server** | Any reachable instance. On Windows, **LocalDB** works for dev (`(localdb)\MSSQLLocalDB`). The app creates + migrates its own `HomeHub` database. |
| **libicu** (Linux/Pi only) | Required by `Microsoft.Data.SqlClient` — the app runs with globalization **on** (`InvariantGlobalization=false`). `sudo apt install libicu-dev`. |

The app boots **without** a database (the shell serves and shows a reconnecting state) and
**without** any service credentials (simulated/local providers respond). Nothing below is required
to get a running panel — it's required only to connect real data.

## Quick start (no configuration)

Two terminals — the API (Kestrel) and the Vite dev server (which proxies `/api` to Kestrel):

```bash
# terminal 1 — API on http://localhost:5220
cd src/HomeHub.Api
dotnet run

# terminal 2 — SPA on http://localhost:5173 (hot reload)
cd client
npm install
npm run dev
```

Open **http://localhost:5173**. You'll get the full UI driven by simulated sensors/climate, live
key-free weather, a local calendar/to-do store, and the on-device demo assistant. To persist data,
add a database (next); to connect real services, see [service configuration](#third-party-service-configuration).

> **Preview at panel geometry:** size a Chromium window to 2160×3840 (or use the device toolbar).
> The layout is viewport-relative — it scales to any window while keeping hairlines crisp.

## Database setup

Persistence (profiles, sensor history, calendar, tasks, climate, weather cache) needs SQL Server.
Provide a connection string named **`HomeHub`**; migrations run automatically on startup.

```bash
cd src/HomeHub.Api
# Windows LocalDB example:
dotnet user-secrets set "ConnectionStrings:HomeHub" \
  "Server=(localdb)\\MSSQLLocalDB;Database=HomeHub;Trusted_Connection=True;TrustServerCertificate=True"
# Full SQL Server example:
dotnet user-secrets set "ConnectionStrings:HomeHub" \
  "Server=myhost;Database=HomeHub;User Id=homehub;Password=…;TrustServerCertificate=True"
```

- **Migrations on startup** are on by default; failure is logged non-fatally (the shell still
  serves). To disable and run them by hand: set `RunMigrationsOnStartup=false` and
  `dotnet ef database update`.
- Without a connection string the app still runs; data endpoints return errors until a DB exists.

## How configuration works

Configuration binds from (in increasing precedence) `appsettings.json` → user-secrets (dev) →
**environment variables** (prod). `appsettings.json` holds only non-secret defaults — **secrets are
never committed**.

- **Dev:** `dotnet user-secrets set "Section:Key" "value"` (run in `src/HomeHub.Api`; a
  `UserSecretsId` is already configured).
- **Prod (systemd):** environment variables, using `__` (double underscore) for nesting:

  ```ini
  # in the systemd unit (see deploy/server-systemd.md)
  Environment=ConnectionStrings__HomeHub=Server=…;Database=HomeHub;…
  Environment=Google__ClientId=…
  Environment=Ai__OpenAiApiKey=…
  ```

- **Nested keys / dictionaries:** `Section__Sub__Key`. Example: `HomeAssistant__ZoneNames__climate.living_room=Living Room`.

Each integration turns on only when its required keys are present; otherwise the fallback stays
active. You can wire services one at a time.

---

## Third-party service configuration

### Sensors — SensorPush

Real fridge/freezer/room readings via the SensorPush cloud API. **Fallback:** deterministic
simulated readings.

**You need:** your SensorPush account email + password (the same login as the SensorPush mobile
app). No API key — the app performs the OAuth email/password flow itself.

```bash
dotnet user-secrets set "SensorPush:Email"    "you@example.com"
dotnet user-secrets set "SensorPush:Password" "…"
```

- When configured, the background poller discovers your sensors and creates zones (source
  `sensorpush`) automatically, writing every reading to SQL every `Sensors:PollSeconds` (default 60).
- **Optional friendly names** — map a SensorPush sensor id to a display name:
  `SensorPush__ZoneNames__<sensorId>=Freezer`. Sensor ids are visible in the SensorPush app/API.
- The five pre-seeded **simulated** zones remain in the DB alongside your real ones; delete those
  seed rows (`DELETE FROM SensorZones WHERE Source = 'simulated'`) once real sensors are flowing.

### Weather — NWS (National Weather Service)

Current conditions, hourly + 7-day forecast, and official severe alerts. **No API key.** Already
live out of the box for the default location; just set yours.

```bash
dotnet user-secrets set "Weather:Latitude"  "44.98"      # your decimal-degree latitude
dotnet user-secrets set "Weather:Longitude" "-93.27"     # your decimal-degree longitude
dotnet user-secrets set "Weather:UserAgent" "HomeHub/1.0 (you@example.com)"
```

- NWS **requires a descriptive `User-Agent` with contact info** — set `Weather:UserAgent` to your
  app + email. Requests can be throttled/blocked without it.
- Default location is Minneapolis (44.98, -93.27). Optional: `Weather:PollMinutes` (default 10).

### Calendar — Google Calendar

Shared household calendar (display + add/edit/delete). **Fallback:** a fully-working local SQL
calendar.

**You need:** a Google Cloud OAuth client and a **refresh token** for the household account.

1. **Google Cloud Console** → create/select a project → **enable the Google Calendar API**.
2. **OAuth consent screen** → External → add the household Google account as a test user → add the
   scope `https://www.googleapis.com/auth/calendar` (read/write).
3. **Credentials → Create OAuth client ID** (Desktop app is simplest) → note the **client id** and
   **client secret**.
4. **Get a refresh token** (one-time): easiest via the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground) —
   gear icon → *Use your own OAuth credentials* → paste client id/secret → authorize the Calendar
   scope with the household account → exchange the code → copy the **refresh token**.

```bash
dotnet user-secrets set "Google:ClientId"     "…apps.googleusercontent.com"
dotnet user-secrets set "Google:ClientSecret" "…"
dotnet user-secrets set "Google:RefreshToken" "…"
dotnet user-secrets set "Google:CalendarId"   "primary"   # or a specific shared calendar id
```

The refresh token is stored server-side; the app refreshes access tokens silently. Owner-tagging
(the WHO chips) is kept local and is not pushed to Google.

### Tasks — Microsoft To Do

Per-profile task lists via Microsoft Graph. **Fallback:** a local per-profile SQL store.

**You need:** an Azure app registration and a **per-profile refresh token** (each member links once).

1. **Azure Portal → Microsoft Entra ID → App registrations → New registration.** Supported account
   types: *personal + work/school* (the app uses the `common` authority).
2. **Certificates & secrets → New client secret.** Note the **client id** and **secret value**.
3. **API permissions → Microsoft Graph → Delegated** → add **`Tasks.ReadWrite`** and
   **`offline_access`** → grant.
4. Add a **redirect URI** for the auth flow (e.g. the OAuth playground's, or
   `https://login.microsoftonline.com/common/oauth2/nativeclient`).

```bash
dotnet user-secrets set "Microsoft:ClientId"     "…"
dotnet user-secrets set "Microsoft:ClientSecret" "…"
```

**Per-profile linking:** each household member authenticates their Microsoft account once (an
auth-code flow using the app above, requesting `Tasks.ReadWrite offline_access`) to obtain a
refresh token. There is **no in-app linking screen yet**, so store the token directly, keyed by the
profile id:

```sql
-- profile ids come from the Profiles table (e.g. Astrid = 1)
INSERT INTO MicrosoftAccountLinks (ProfileId, RefreshToken, ListId, LinkedUtc)
VALUES (1, '<refresh-token>', NULL, SYSUTCDATETIME());   -- ListId NULL = the account's default Tasks list
```

Once linked, that profile's tasks round-trip to Microsoft To Do; the "Everyone" tab aggregates all
linked profiles. (An in-app consent/linking flow is a planned enhancement.)

### Climate — Home Assistant

Multi-zone mini-split control through Home Assistant. **Fallback:** a simulated zone set that drifts
toward its set point.

**Precondition:** Home Assistant is running on the LAN and already controls the units (via its
Sensibo/Daikin/Mr. Cool/etc. integration). The app talks to **HA**, not the AC units directly.

1. In HA, open your **profile → Long-Lived Access Tokens → Create Token**. Copy it.
2. Note your HA base URL (e.g. `http://homeassistant.local:8123` or the LAN IP).

```bash
dotnet user-secrets set "HomeAssistant:BaseUrl" "http://homeassistant.local:8123"
dotnet user-secrets set "HomeAssistant:Token"   "<long-lived-token>"
dotnet user-secrets set "HomeAssistant:EveningScene" "scene.evening"   # scene/script for EVENING SCENE
```

- Zones are discovered from HA's `climate.*` entities automatically. Optional friendly names:
  `HomeAssistant__ZoneNames__climate.bedroom=Bedroom`.
- `ALL OFF` sets every unit's HVAC mode to off; `EVENING SCENE` calls the configured scene/script.
- Live state is currently poll-based; a WebSocket push path is a planned enhancement.

### AI assistant — OpenAI / local model

Hybrid assistant: routine requests to a **local model on the server**, demanding ones to **cloud
(OpenAI)**, with a per-turn LOCAL/CLOUD tag. **Fallback:** a built-in on-device demo assistant.
Configure **either or both**.

**Cloud (OpenAI):**

```bash
dotnet user-secrets set "Ai:OpenAiApiKey" "sk-…"
dotnet user-secrets set "Ai:OpenAiModel"  "gpt-4o-mini"   # use a vision-capable model for image analysis
```

**Local (Ollama-compatible), running on the home server:**

```bash
# e.g. `ollama serve` + `ollama pull llama3.1`
dotnet user-secrets set "Ai:LocalEndpoint" "http://localhost:11434"
dotnet user-secrets set "Ai:LocalModel"    "llama3.1"
```

- **Routing** is tunable: `Ai:Routing:DefaultOrigin` (`cloud`/`local`), the `Ai:Routing:LocalHints`
  / `Ai:Routing:CloudHints` keyword lists, and `Ai:Routing:MinConfidentLength` (low-confidence
  escalation). Task-based routing decides local vs cloud; a weak local answer escalates to cloud.
- **Privacy:** local/simulated turns stay on the LAN; only cloud-routed turns leave it. Camera→AI
  is out of scope — only deliberate image uploads go out.

### Voice — STT / TTS

Push-to-talk on the assistant. **STT default:** the kiosk browser's Web Speech API (on-device, no
config). **TTS:** on-device browser speech synthesis. **Server STT (optional):** OpenAI Whisper,
which activates automatically when `Ai:OpenAiApiKey` is set (it reuses that key) — `GET
/api/voice/capabilities` reports whether server STT is on.

**On the Raspberry Pi:**

- A working USB mic + speaker at the OS level (a wall panel has none by default).
- Chromium kiosk flags so the mic can open and audio can autoplay without a gesture, e.g.
  `--autoplay-policy=no-user-gesture-required`, and grant microphone permission for the panel's
  origin. See [`deploy/pi-kiosk.md`](deploy/pi-kiosk.md).
- The mic is **push-to-talk only** (no wake word); the verdigris "microphone is live" banner shows
  on every screen whenever it's open and cannot be disabled.

---

## Configuration reference (all keys)

| Section / key | Default | Purpose |
|---|---|---|
| `ConnectionStrings:HomeHub` | — | SQL Server connection (env: `ConnectionStrings__HomeHub`) |
| `RunMigrationsOnStartup` | `true` | Apply EF migrations at boot |
| `Sensors:PollSeconds` | `60` | Sensor poll interval |
| `SensorPush:Email` / `:Password` | — | SensorPush account login (enables real sensors) |
| `SensorPush:ZoneNames:<sensorId>` | — | Optional sensor→name overrides |
| `Weather:Latitude` / `:Longitude` | `44.98` / `-93.27` | Location for NWS |
| `Weather:UserAgent` | HomeHub/1.0 (…) | **Required by NWS** — app + contact |
| `Weather:PollMinutes` | `10` | Weather refresh interval |
| `Google:ClientId` / `:ClientSecret` / `:RefreshToken` | — | Google OAuth (enables Google Calendar) |
| `Google:CalendarId` | `primary` | Which calendar to use |
| `Microsoft:ClientId` / `:ClientSecret` | — | Azure app reg (enables MS To Do) |
| *(per-profile)* `MicrosoftAccountLinks` row | — | Per-member refresh token (SQL, see above) |
| `HomeAssistant:BaseUrl` / `:Token` | — | HA URL + long-lived token (enables real climate) |
| `HomeAssistant:EveningScene` | `scene.evening` | Entity for EVENING SCENE |
| `HomeAssistant:ZoneNames:<entityId>` | — | Optional climate entity→name overrides |
| `Ai:OpenAiApiKey` / `:OpenAiModel` | — / `gpt-4o-mini` | Cloud assistant + server Whisper STT |
| `Ai:LocalEndpoint` / `:LocalModel` | — / `llama3.1` | Local server model (Ollama-compatible) |
| `Ai:Routing:DefaultOrigin` | `cloud` | Where unmatched requests go |
| `Ai:Routing:MinConfidentLength` | `12` | Low-confidence escalation threshold |

## Build one deployable unit

```bash
cd client && npm run build           # SPA → src/HomeHub.Api/wwwroot
cd ../src/HomeHub.Api && dotnet run   # serves API + SPA from one origin
```

Health check: `GET /api/health` → `{"status":"ok",…}`. In prod the SPA is served same-origin, so
there's no CORS and no HTTPS redirect (put TLS in front via nginx if needed).

## Test

```bash
dotnet test        # 55 integration/unit tests (in-memory DB; no external services needed)
```

## Deploy

See [`deploy/server-systemd.md`](deploy/server-systemd.md) (the home-server service) and
[`deploy/pi-kiosk.md`](deploy/pi-kiosk.md) (the Pi kiosk / Chromium). In prod, supply all secrets as
environment variables on the systemd unit (the `__` form above); **never commit them**. On
Linux/Pi, install `libicu`.

## Troubleshooting

- **`Globalization Invariant Mode is not supported` on DB connect** — ensure `libicu` is installed
  (Linux) and `InvariantGlobalization` is `false` (it is, in `Directory.Build.props`).
- **Data endpoints 500 / no data** — no `ConnectionStrings:HomeHub` set, or SQL Server unreachable;
  the shell still serves. Add the connection string.
- **A real integration isn't taking effect** — its required keys aren't all present (it silently
  stays on the fallback). Re-check the keys for that section above.
- **Weather empty / blocked** — set a real `Weather:UserAgent` with contact info.
- **Voice does nothing** — the browser lacks the Web Speech API, or the Pi mic/Chromium flags aren't
  set; the assistant still works via text.
</content>
