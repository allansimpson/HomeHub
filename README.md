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
- [Test from a tablet on the LAN](#test-from-a-tablet-on-the-lan)
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
- [What belongs in user secrets](#what-belongs-in-user-secrets)
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
| **SQL Server** | Any reachable instance. The app creates + migrates its own `HomeHub` database. |
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

## Test from a tablet on the LAN

Real touch behaviour — tap targets, scroll momentum, the on-screen keyboard, `:hover` states that
stick on touch — only shows up on a real device. Both servers already listen on every interface, so
a tablet on the same network reaches them by IP with no tunnel or extra tooling.

**Find the dev machine's LAN address**, then browse to it from the tablet:

```powershell
# Windows
(Get-NetIPConfiguration | Where-Object { $_.NetAdapter.Status -eq 'Up' }).IPv4Address.IPAddress
```
```bash
# Linux / macOS
hostname -I        # or: ipconfig getifaddr en0
```

| Address | What it serves | Use it for |
|---|---|---|
| `http://<ip>:5173` | Vite dev server, hot reload | **Day-to-day UI iteration** — edits appear on the tablet as you save |
| `http://<ip>:5220` | Kestrel serving `wwwroot` + the API | Verifying the **production** single-origin build (run `npm run build` first) |
| `http://<ip>:5220/api/health` | JSON health check | Confirming the tablet can reach the API at all |

Port 5173 proxies `/api` to Kestrel *from the dev machine*, so the tablet only ever talks to one
origin — there is no CORS configuration to add on either port.

**The bindings that make this work** (already committed, listed here so they aren't "fixed" back):

- [`client/vite.config.ts`](client/vite.config.ts) — `server.host: true` listens on all interfaces
  instead of loopback only; `strictPort: true` prevents a silent hop to 5174 that would leave a
  tablet bookmark pointing at nothing.
- [`src/HomeHub.Api/Properties/launchSettings.json`](src/HomeHub.Api/Properties/launchSettings.json)
  — the `http` profile binds `http://0.0.0.0:5220`. The `https` profile stays on `localhost`: its
  dev certificate is self-signed, so a tablet would reject it.

**Open the ports in the host firewall.** Scope the rules to your own subnet rather than the whole
profile — the dev server has no authentication:

```powershell
# Windows, elevated — substitute your subnet
New-NetFirewallRule -DisplayName "HomeHub API (Kestrel 5220) - LAN" -Group "HomeHub" `
  -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5220 -RemoteAddress 192.168.5.0/24 -Profile Any
New-NetFirewallRule -DisplayName "HomeHub SPA dev (Vite 5173) - LAN" -Group "HomeHub" `
  -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5173 -RemoteAddress 192.168.5.0/24 -Profile Any
```

Remove them again with `Remove-NetFirewallRule -Group "HomeHub"`.

**Gotchas, in the order they usually bite:**

- **A VPN client on the dev machine** (NordVPN/WireGuard/etc.) routes the LAN away by default. Turn
  on its "allow LAN / local network access" setting, or drop the tunnel while testing.
- **Client isolation / guest Wi-Fi** — many APs block device-to-device traffic outright. Put the
  tablet on the main SSID, not the guest one.
- **Both devices must be on the same subnet.** A 2.4 GHz IoT VLAN and the main 5 GHz network often
  are not.
- **OAuth linking will not work from the tablet.** Google and Microsoft reject plain `http` for
  anything but loopback, so **CONFIG → Calendars → Connect** must be done in a browser on the dev
  machine at `localhost`. See [Linking accounts from the panel](#linking-accounts-from-the-panel).
- **Mic and server STT need a secure context.** Browsers gate `getUserMedia` to HTTPS or
  `localhost`, so push-to-talk is unavailable over a LAN IP. Everything else — including text chat
  with the assistant — works normally. Put TLS in front of the panel to test voice off-device.

Diagnose from the tablet by loading `http://<ip>:5220/api/health` first: JSON back means the network
path and firewall are fine and the problem is in the app; a timeout means it is one of the four
network gotchas above.

## Database setup

Persistence (profiles, sensor history, calendar, tasks, climate, weather cache) needs SQL Server.
Provide a connection string named **`HomeHub`**; migrations run automatically on startup.

```bash
cd src/HomeHub.Api
dotnet user-secrets set "ConnectionStrings:HomeHub" \
  "Server=myhost;Database=HomeHub;User Id=homehub;Password=…;TrustServerCertificate=True;Connect Timeout=60"
```

> **Set `Connect Timeout` generously** — 60s rather than the 15s default. Startup is when the panel
> is hardest on the database: every provider polls at once, so a server that is asleep, resuming or
> briefly unreachable turns one slow connection into a wave of timeouts across unrelated controllers.
> EF is configured to retry transient failures (see `Program.cs`), but it cannot retry a connection
> that was never given long enough to open.

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

### Linking accounts from the panel

Both Google and Microsoft are linked the same way, and the panel can do the whole exchange itself —
no OAuth Playground, no `INSERT`. The panel travels to the provider's consent page, comes back, and
stores the refresh token server-side
([`AccountLinkController`](src/HomeHub.Api/Controllers/AccountLinkController.cs)). The token never
reaches the browser, and re-linking keeps the member's calendar/list choices.

Two places to start it:

- **Any member — CONFIG → Household → `Accounts ▸`** on that person. Shows Google and Microsoft with
  **Connect** / **Reconnect** / **Unlink**, and reports the result on that member's own page. This is
  the one to use for someone who is not signed in: consent happens on the provider's sign-in page, so
  each member authenticates as themselves and you never hold their credentials.
- **The signed-in member — CONFIG → Calendars** (or **→ To-Do lists**), which also shows **Connect**
  for a profile with no link, and **Reconnect** when the provider has stopped accepting an existing
  one. These two screens still choose *which* calendars and lists display for the **active profile
  only**; linking is what the Household route generalises.

For Google, whether another member can consent at all is a project-level setting — see
[Every member must be allowed to sign in](#every-member-must-be-allowed-to-sign-in).

The one thing to register is the **redirect URI** — the address the provider returns to, which must
match what the panel sends *verbatim*: scheme, host, port and path, no trailing slash. By default the
panel derives it from the address it is being used at, so it is whatever is in the address bar plus
`/api/link/{provider}/callback`.

**Link from a browser running on the panel itself**, at `localhost`. Both providers refuse plain
`http` for anything except loopback — `http://192.168.x.x:5220/…` and `http://homehub.local:5220/…`
are rejected when you try to register them, and only `http://localhost` / `http://127.0.0.1` (any
port) are exempt. Linking from a phone on the LAN needs TLS in front of the panel first.

Register these on **Google Auth Platform → Clients → Authorized redirect URIs** and on the Azure
app's **Authentication → Redirect URIs (Web)**. In development the SPA is served by Vite on 5173 and
the API by Kestrel on 5220; the Vite proxy preserves the host, so whichever port you browse is the
one that gets sent — register both and it works either way:

```
http://localhost:5220/api/link/google/callback
http://localhost:5173/api/link/google/callback
http://localhost:5220/api/link/microsoft/callback
http://localhost:5173/api/link/microsoft/callback
```

Google applies edits to an OAuth client within a few minutes, so a `redirect_uri_mismatch` right
after adding one is worth a short wait and a retry before hunting for a typo.

To send a fixed address regardless of where the panel is browsed — useful once it sits behind TLS:

```bash
dotnet user-secrets set "Google:RedirectUri"        "https://homehub.example.com/api/link/google/callback"
dotnet user-secrets set "MicrosoftTodo:RedirectUri" "https://homehub.example.com/api/link/microsoft/callback"
```

`POST /api/link/{provider}/start` returns the redirect URI it used alongside the consent URL, so when
a provider rejects it you can read back the exact string to register rather than guessing:

```bash
curl -s -X POST "http://localhost:5220/api/link/google/start?profileId=1"
```

The manual routes below still work and remain the fallback when the panel has no browser to hand
(headless setup, or a provider that will not accept a LAN redirect URI).

### Calendar — Google Calendar

**Per-profile** calendars: each household member links their **own** Google account, and the panel
shows the **active profile's** selected calendars (mirrors how Microsoft To Do handles per-profile
lists — cross-sharing between members is done on Google's side). **Fallback:** a fully-working local
SQL calendar when the OAuth app isn't configured.

**You need:** one Google Cloud OAuth **app** (client id/secret, shared by all members) and a
**refresh token per member**. Only the app lives in config; each member's refresh token lives in a
`GoogleAccountLink` row, keyed by profile.

Google recently merged the *OAuth consent screen* and *Credentials* pages into the **Google Auth
Platform** (left nav: Overview · Branding · Audience · Clients · Data Access). The steps below use
that newer UI.

1. **Google Cloud Console** → create/select a project (e.g. `HomeHub`) → **APIs & Services → enable
   the Google Calendar API**.
2. **[Google Auth Platform → Branding](https://console.cloud.google.com/auth/branding)** → set an app
   name + support email.
3. **[Google Auth Platform → Audience](https://console.cloud.google.com/auth/audience)** →
   **User type: External**, then **set Publishing status to *In production***. See
   [Every member must be allowed to sign in](#every-member-must-be-allowed-to-sign-in) below — this
   is the step that decides whether other household members can link at all, and whether their links
   survive more than a week.
4. **[Google Auth Platform → Data Access](https://console.cloud.google.com/auth/scopes)** → add the
   scope `https://www.googleapis.com/auth/calendar` (read/write).
5. **Google Auth Platform → Clients → Create OAuth client** →
   - **Application type: Web application** — *not* Desktop. The refresh token is obtained via the
     OAuth Playground, which needs a registered redirect URI, and only Web clients allow one.
   - **Authorized redirect URIs → Add URI:** `https://developers.google.com/oauthplayground`
     (exact, no trailing slash).
   - Create → copy the **client id** and **client secret**.
6. **Get a refresh token** (one-time) via the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground):
   - **⚙️ gear** → confirm **Access type: Offline** and **Force prompt: Consent Screen** (both are
     required for a *refresh* token to come back) → check **Use your own OAuth credentials** → paste
     the client id/secret → **Close**.
   - **Step 1** → in **Input your own scopes** paste `https://www.googleapis.com/auth/calendar` →
     **Authorize APIs** → sign in with that member's Google account (which must be allowed to consent
     — see [Every member must be allowed to sign in](#every-member-must-be-allowed-to-sign-in)) → on
     the unverified-app warning click **Advanced → Go to <app> (unsafe)** → allow.
   - Do this once **per member**, each signing in with *their own* Google account.
   - **Step 2** → **Exchange authorization code for tokens** → copy that member's **`refresh_token`** (`1//…`).

**Configure the app once** (client id/secret only — no token here):

```bash
dotnet user-secrets set "Google:ClientId"     "…apps.googleusercontent.com"
dotnet user-secrets set "Google:ClientSecret" "…"
```

**Link each member** by inserting a `GoogleAccountLink` row (same pattern as Microsoft To Do's
`MicrosoftAccountLinks`). `PrimaryCalendarId` is where that member's new events are created — leave
it `NULL` for their default calendar; `CalendarsConfigured = 0` means "not chosen yet → sync all"
(it flips to `1` automatically the first time they toggle in CONFIG → Calendars):

```sql
SELECT Id, Name FROM Profiles;                 -- find each member's ProfileId

INSERT INTO GoogleAccountLinks (ProfileId, RefreshToken, PrimaryCalendarId, CalendarsConfigured)
VALUES (<profile-id>, '1//<their-refresh-token>', NULL, 0);
```

Then, on the panel, open **CONFIG → Calendars** (as that profile) to toggle which of their calendars
display. The Calendar view and dashboard NEXT show the **active profile's** calendars and refresh
about every 30 s while on screen, so events added in Google appear without reloading.

**Strictly per-profile** — like Microsoft To Do, a profile shows calendars only when it has its own
`GoogleAccountLink`. There is no shared fallback: a profile without a row shows no calendars (CONFIG →
Calendars reads "No Google account linked"). `Google:RefreshToken` / `Google:CalendarId` are no longer
used — move that token into a `GoogleAccountLink` row for the owning profile, then remove the two
secrets (see [What belongs in user secrets](#what-belongs-in-user-secrets)). To purge events cached
under the old shared token: `DELETE FROM CalendarEvents WHERE Source = 'google' AND ProfileId NOT IN
(SELECT ProfileId FROM GoogleAccountLinks);`

**Finding a specific calendar id:** `primary` is an account's default. For a shared/secondary calendar,
open [Google Calendar](https://calendar.google.com) → hover it in *My calendars* → **⋮ → Settings and
sharing → Integrate calendar → Calendar ID** (a `…@group.calendar.google.com` string).

Refresh tokens are stored server-side; the app refreshes access tokens silently, per profile.
Owner-tagging (the WHO chips) is kept local and is not pushed to Google.

#### Every member must be allowed to sign in

One Google Cloud app serves the whole household, so **who is allowed to consent is a project-level
setting**, not a per-member one. Get this wrong and the second person you try to link is refused
with:

> **Access blocked: HomeHub has not completed the Google verification process.** The app is
> currently being tested, and can only be accessed by developer-approved testers.

That is the project's **Publishing status** being *Testing*, which restricts consent to an explicit
allowlist. There are two ways out, and only one of them is right for a permanent panel.

| | **Testing** | **In production** (unverified) |
|---|---|---|
| Who can link | Only accounts listed under **Test users** (max 100) | Anyone, up to a 100-user cap |
| What they see | Normal consent | An "unverified app" screen once — **Advanced → Go to HomeHub (unsafe)** |
| **Refresh-token lifetime** | **7 days** | Does not expire on that rule |
| Google verification needed | No | **No** — `calendar` is a *sensitive* scope, not a *restricted* one |

**Set [Audience](https://console.cloud.google.com/auth/audience) → Publishing status → In
production.** The 7-day expiry is the reason: the panel stores one refresh token per member and
expects it to last, so on *Testing* every member you link silently stops syncing about a week later
and has to be re-linked by hand — forever.

**After publishing, re-link everyone you linked while in Testing, including yourself.** Tokens
already issued keep the 7-day expiry they were minted with; changing the publishing status does not
retroactively extend them. Skipping this makes it look as though publishing didn't work.

*Adding a **Test user** on the Audience page is still the right move if you only need to let someone
in for a few minutes* — it takes effect immediately — but treat it as a stopgap, not the setup.

Once published, linking is per-member from the panel: **Config → Household → `Accounts ▸`** on that
person → **Connect**. Consent happens on Google's own sign-in page, so each member authenticates as
themselves and the refresh token is stored against *their* profile — you can start the flow for
someone else without ever holding their credentials.

### Tasks — Microsoft To Do

Per-profile task lists via Microsoft Graph. **Fallback:** a local per-profile SQL store.

**You need:** an Azure (Microsoft Entra) app registration and a **per-profile refresh token** (each
member links once). The app never runs the interactive sign-in itself — it only does the silent
`refresh_token` grant against the `common` authority ([`MicrosoftTodoProvider`](src/HomeHub.Api/Tasks/MicrosoftTodoProvider.cs)).
You obtain each refresh token once, out of band, and store it keyed by profile.

Everything below is free — app registrations, client secrets, and personal-account sign-in all sit
in the **Entra ID Free** tier. No Azure subscription or credit card is required.

#### 0. Make sure you have a tenant you administer

App registration lives inside a **tenant**. A personal Microsoft account (e.g. `you@outlook.com`)
often has no tenant of its own, or defaults into a workplace tenant where you're not an admin — in
which case **App registrations** will be missing or greyed out. If so, create your own free tenant
(you become its Global Administrator):

1. Sign in at **[entra.microsoft.com](https://entra.microsoft.com)** with your account.
2. **Manage tenants → + Create → Microsoft Entra ID.**
3. Give it an org name + initial domain (e.g. `myhomehub` → `myhomehub.onmicrosoft.com`), pick a
   region, complete the CAPTCHA, **Create**.
4. Switch into the new tenant (directory switcher / **Directories + subscriptions**).

This tenant is only the *home* for the app registration — you'll still consent with your normal
personal account, and the "personal accounts" setting below is what makes that work. You do **not**
need to add your personal account into the tenant as a user.

#### 1. Register the application

**Microsoft Entra ID → App registrations → New registration:**

- **Name:** `HomeHub` (anything).
- **Supported account types:** **"Accounts in any organizational directory (any Microsoft Entra ID
  tenant – Multitenant) and personal Microsoft accounts (e.g. Skype, Xbox, Outlook.com)."**
  This is the setting that lets an `outlook.com`/`live.com` account sign in; it must match the app's
  `common` authority. (Manifest equivalent: `"signInAudience": "AzureADandPersonalMicrosoftAccount"`.)
- **Redirect URI:** platform **Web** (or *Mobile & desktop*), value
  `https://login.microsoftonline.com/common/oauth2/nativeclient` — or, if you'll use the OAuth
  playground/Postman/your own tool to get the token, that tool's redirect URI. It must match the
  `redirect_uri` you send during consent **exactly**.

Copy the **Application (client) ID** from the Overview page.

#### 2. Client secret

**Certificates & secrets → New client secret** → set an expiry → **copy the secret _value_** (shown
once; the "Secret ID" is not the value). Set an expiry you're willing to rotate on — the To Do
integration silently stops working the day the secret expires.

#### 3. API permissions

**API permissions → Add a permission → Microsoft Graph → Delegated permissions**, add:

- **`Tasks.ReadWrite`** — read/write To Do tasks.
- **`offline_access`** — required to receive a **refresh token**.
- **`User.Read`** — sign-in + basic profile.

The app requests the `https://graph.microsoft.com/.default` scope, which grants exactly the
delegated permissions registered here — so anything missing from this list silently won't be in the
token. For a personal-account (single-user) setup you don't need admin consent; each user consents
for themselves during step 5.

```bash
# in src/HomeHub.Api
dotnet user-secrets set "Microsoft:ClientId"     "<application-client-id>"
dotnet user-secrets set "Microsoft:ClientSecret" "<client-secret-value>"
```

Optional overrides (defaults in [`MicrosoftTodoOptions`](src/HomeHub.Api/Tasks/MicrosoftTodoOptions.cs))
— `Microsoft:TokenUrl`, `Microsoft:GraphBaseUrl`, `Microsoft:Scope`. The defaults are correct for
the `common` authority; only change them for a single-tenant app or a sovereign cloud.

#### 4. Get a refresh token (per profile, one-time)

Each household member does the OAuth **authorization-code** flow once, using the app above. The
authority **must** be `common` (or `consumers`) so personal accounts are accepted — never
`organizations` or a tenant GUID. Any OAuth tool works; the raw two-step flow is:

Open this URL in a browser (it is **one line** — the query string must not contain any line breaks
or spaces; replace `<client-id>`), sign in with THAT member's Microsoft account, and approve consent:

```text
https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=<client-id>&response_type=code&response_mode=query&redirect_uri=https%3A%2F%2Flogin.microsoftonline.com%2Fcommon%2Foauth2%2Fnativeclient&scope=https%3A%2F%2Fgraph.microsoft.com%2FTasks.ReadWrite%20offline_access%20User.Read
```

The query params, already URL-encoded in the line above, are:

| Param | Value |
|---|---|
| `client_id` | your Application (client) ID |
| `response_type` | `code` |
| `response_mode` | `query` |
| `redirect_uri` | `https://login.microsoftonline.com/common/oauth2/nativeclient` (must match the app registration) |
| `scope` | `Tasks.ReadWrite offline_access User.Read` |

After consent you're redirected to the redirect URI with `?code=<AUTH_CODE>` in the address bar (the
page itself is blank — that's expected). Copy that `code` value.

```bash
# 2) Exchange the code for tokens (the response includes refresh_token):
curl -s -X POST https://login.microsoftonline.com/common/oauth2/v2.0/token \
  -d client_id=<client-id> \
  -d client_secret=<client-secret-value> \
  -d grant_type=authorization_code \
  -d redirect_uri=https://login.microsoftonline.com/common/oauth2/nativeclient \
  --data-urlencode "scope=https://graph.microsoft.com/Tasks.ReadWrite offline_access User.Read" \
  --data-urlencode code=<AUTH_CODE>
```

Copy the `refresh_token` from the JSON response. (The app then refreshes access tokens silently and
stores nothing but this refresh token.)

#### 5. Link the token to a profile

There is **no in-app linking screen yet**, so store each refresh token directly, keyed by profile id:

```sql
-- profile ids come from the Profiles table (e.g. Astrid = 1)
INSERT INTO MicrosoftAccountLinks (ProfileId, RefreshToken, ListId, LinkedUtc)
VALUES (1, '<refresh-token>', NULL, SYSUTCDATETIME());   -- ListId NULL = the account's default Tasks list
```

Once linked, that profile's tasks round-trip to Microsoft To Do; the "Everyone" tab aggregates all
linked profiles. Repeat steps 4–5 per member. (An in-app consent/linking flow is a planned
enhancement.)

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

Push-to-talk on the assistant. **STT default:** the kiosk browser's Web Speech API (no config; note
Chromium streams that audio to Google — not on-LAN). **TTS default:** on-device browser speech
synthesis (whatever voices the browser exposes).

**Central voice (optional — Piper):** configure a Piper binary + voice model and the *whole app*
speaks in that one voice (e.g. `en_US-norman-medium`, the same voice the Pi bridge uses) via
`POST /api/voice/speak`. The client prefers it automatically and falls back to browser synthesis when
it isn't configured (or a synth call fails). This is the in-app path — distinct from the Pi voice
bridge, which speaks Piper audio out the Pi's own speaker.

Piper is one self-contained binary plus a voice-model pair (`.onnx` + `.onnx.json`).

**Windows (test norman in a desktop browser):**

1. Download `piper_windows_amd64.zip` from the [Piper releases](https://github.com/rhasspy/piper/releases)
   and extract to `C:\piper` — you'll get `piper.exe` plus DLLs and an `espeak-ng-data\` folder (keep
   that folder next to `piper.exe`; Piper needs it).
2. Download **both** voice files from
   [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/norman/medium)
   into `C:\piper\voices\`: `en_US-norman-medium.onnx` (~60 MB) and `en_US-norman-medium.onnx.json`.
3. Smoke-test (PowerShell):
   ```powershell
   "Hello from Barnaby." | C:\piper\piper.exe --model C:\piper\voices\en_US-norman-medium.onnx --output_file test.wav
   start test.wav
   ```
4. Point the app at it and restart:
   ```bash
   dotnet user-secrets set "Voice:Tts:PiperPath"  "C:\piper\piper.exe"
   dotnet user-secrets set "Voice:Tts:VoiceModel" "C:\piper\voices\en_US-norman-medium.onnx"
   ```

**Raspberry Pi (deploy):** same idea with the ARM build —

```bash
# 64-bit Pi OS: piper_linux_aarch64.tar.gz   (32-bit: piper_linux_armv7l.tar.gz)
mkdir -p /opt/piper && tar -xzf piper_linux_aarch64.tar.gz -C /opt/piper
# drop the two en_US-norman-medium.onnx / .onnx.json files in /opt/piper/voices/
dotnet user-secrets set "Voice:Tts:PiperPath"  "/opt/piper/piper"
dotnet user-secrets set "Voice:Tts:VoiceModel" "/opt/piper/voices/en_US-norman-medium.onnx"
```

`pip install piper-tts` also works — same `--model` / `--output_file` flags, so the app doesn't care
which you use. Gotchas: the **`.onnx.json` is required** (Piper won't run with just the `.onnx`), Windows
needs the `espeak-ng-data\` folder beside `piper.exe`, and the first audio play in a normal desktop
browser may need a user gesture — the tap-to-speak interaction covers that on the kiosk.

**Server STT (optional, local-first):** post captured audio to `POST /api/voice/transcribe` and it is
transcribed by `SttRouter` — a **local faster-whisper sidecar** first, falling back to **OpenAI
Whisper** when the local engine is unavailable or errors (unless fallback is disabled). The response
and `GET /api/voice/capabilities` report which engine ran, so voice inherits the LOCAL/CLOUD story.

Point it at a faster-whisper sidecar exposing the OpenAI-compatible `/v1/audio/transcriptions` route
(e.g. `faster-whisper-server` / Speaches, run as a Docker/systemd unit on the home server — never the
Pi). Cloud fallback reuses the assistant's `Ai:OpenAiApiKey`.

```bash
dotnet user-secrets set "Voice:Stt:LocalEndpoint"      "http://localhost:8000"
dotnet user-secrets set "Voice:Stt:LocalModel"         "base.en"   # tiny.en/base.en/small.en
dotnet user-secrets set "Voice:Stt:AllowCloudFallback" "true"      # false = LAN-only (never cloud)
```

**On the Raspberry Pi:**

- A working USB mic + speaker at the OS level (a wall panel has none by default).
- Chromium kiosk flags so the mic can open and audio can autoplay without a gesture, e.g.
  `--autoplay-policy=no-user-gesture-required`, and grant microphone permission for the panel's
  origin. See [`deploy/pi-kiosk.md`](deploy/pi-kiosk.md).
- In the browser panel the mic is **push-to-talk only** (no wake word); the verdigris "microphone is
  live" banner shows on every screen whenever it's open and cannot be disabled. Hands-free
  **"Hey Barnaby"** / **"Oh Barnaby"** wake-word listening is the separate on-Pi voice bridge — one
  trained openWakeWord model per phrase, either of which opens the mic. See
  [`voice-bridge/`](voice-bridge/README.md).

---

## What belongs in user secrets

Only **config** belongs in user-secrets. Per-member OAuth **refresh tokens live in the database**
(`GoogleAccountLinks` / `MicrosoftAccountLinks`), never here — so linking or re-linking a member is a
SQL row, not a secret. This is the complete set of keys the app reads from secrets; anything else can
be removed. Everything except the connection string and `Weather:UserAgent` is optional (the matching
feature just falls back to its local/simulated provider when unset).

```bash
# run all of these in src/HomeHub.Api

# Database — required for any persisted data
ConnectionStrings:HomeHub

# Weather — UserAgent required by NWS; lat/long optional (default Minneapolis)
Weather:UserAgent
Weather:Latitude
Weather:Longitude

# Sensors — optional (real SensorPush hardware)
SensorPush:Email
SensorPush:Password

# Google Calendar — the OAuth APP only. Per-member tokens are GoogleAccountLinks rows.
Google:ClientId
Google:ClientSecret

# Microsoft To Do — the OAuth APP only. Per-member tokens are MicrosoftAccountLinks rows.
Microsoft:ClientId
Microsoft:ClientSecret

# Climate — optional (Home Assistant)
HomeAssistant:BaseUrl
HomeAssistant:Token
HomeAssistant:EveningScene

# AI assistant — optional
Ai:OpenAiApiKey
Ai:OpenAiModel
Ai:LocalEndpoint
Ai:LocalModel

# Voice STT — optional
Voice:Stt:LocalEndpoint
Voice:Stt:LocalModel
Voice:Stt:AllowCloudFallback

# Voice TTS (central Piper voice) — optional
Voice:Tts:PiperPath
Voice:Tts:VoiceModel
```

**Remove — no longer used** (superseded by per-profile `GoogleAccountLinks` rows):

```bash
dotnet user-secrets remove "Google:RefreshToken" --project src/HomeHub.Api
dotnet user-secrets remove "Google:CalendarId"   --project src/HomeHub.Api
```

`Google:RefreshToken` moved into `GoogleAccountLinks.RefreshToken` (per profile); `Google:CalendarId`
is replaced by each profile's `PrimaryCalendarId` plus their CONFIG → Calendars selection. List what
you currently have with `dotnet user-secrets list --project src/HomeHub.Api`.

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
| `Google:ClientId` / `:ClientSecret` | — | Google OAuth **app** (enables Google Calendar) |
| *(per-profile)* `GoogleAccountLinks` row | — | Per-member refresh token + calendars (SQL, see above) |
| `Microsoft:ClientId` / `:ClientSecret` | — | Azure app reg (enables MS To Do) |
| *(per-profile)* `MicrosoftAccountLinks` row | — | Per-member refresh token (SQL, see above) |
| `HomeAssistant:BaseUrl` / `:Token` | — | HA URL + long-lived token (enables real climate) |
| `HomeAssistant:EveningScene` | `scene.evening` | Entity for EVENING SCENE |
| `HomeAssistant:ZoneNames:<entityId>` | — | Optional climate entity→name overrides |
| `Ai:OpenAiApiKey` / `:OpenAiModel` | — / `gpt-4o-mini` | Cloud assistant + server Whisper STT |
| `Ai:LocalEndpoint` / `:LocalModel` | — / `llama3.1` | Local server model (Ollama-compatible) |
| `Voice:Stt:LocalEndpoint` / `:LocalModel` | — / `base.en` | Local faster-whisper sidecar (enables local STT) |
| `Voice:Stt:AllowCloudFallback` | `true` | Fall back to OpenAI Whisper when local STT is down (`false` = LAN-only) |
| `Voice:Stt:Prefer` | `local` | Preferred STT engine (`local` / `cloud`) |
| `Voice:Stt:TimeoutSeconds` | `120` | Local STT request timeout |
| `Voice:Tts:PiperPath` / `:VoiceModel` | — | Central Piper voice (enables server TTS across the app) |
| `Voice:Tts:TimeoutSeconds` | `30` | Piper synthesis timeout |
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
- **MS To Do sign-in: _"account from identity provider 'live.com' does not exist in tenant … cannot
  access the application … sign in with a different Azure Active Directory account"_** — the app
  registration doesn't allow personal Microsoft accounts. Set **Supported account types** to include
  *personal Microsoft accounts* (`signInAudience: AzureADandPersonalMicrosoftAccount`), and use the
  `common`/`consumers` authority in the consent URL — not `organizations` or a tenant GUID. See
  [Tasks — Microsoft To Do](#tasks--microsoft-to-do).
- **MS To Do: consent succeeds but no `refresh_token` / tasks don't sync** — `offline_access` (and
  `Tasks.ReadWrite`) missing from the app's **API permissions**, or the client secret expired.
- **Voice does nothing** — the browser lacks the Web Speech API, or the Pi mic/Chromium flags aren't
  set; the assistant still works via text.
</content>
