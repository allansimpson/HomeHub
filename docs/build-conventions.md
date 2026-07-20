# Build conventions (HomeHub)

Conventions inferred from the **actual Stage 0 code**. Every later stage must follow these so the codebase stays consistent. Where the build package (`CentralHome_ClaudeCode_BuildPackage/`) uses placeholder names, translate to what's below.

## Names & structure
- **Solution:** `HomeHub.slnx` (net10.0). Product/display name is "Central Home"; **code name is `HomeHub`**.
- **API project:** `src/HomeHub.Api`, root namespace `HomeHub.Api`. File-scoped namespaces (`namespace HomeHub.Api.Xxx;`) with `using`s after the namespace line, matching existing files.
- **Client:** `client/` — React 19 + TypeScript + Vite. Components in `client/src/components/`, screens in `client/src/screens/`, app shell in `client/src/app/`, icons in `client/src/icons/`, theme in `client/src/theme/`.
- **Tests:** `tests/HomeHub.Tests` (xUnit + `Microsoft.AspNetCore.Mvc.Testing`). Add integration tests here per stage; follow `HealthEndpointTests` style (boots the real app via `WebApplicationFactory<Program>`).
- **Shared MSBuild:** `Directory.Build.props` centralizes `TargetFramework=net10.0`, `Nullable=enable`, `ImplicitUsings=enable`, `InvariantGlobalization=true`. Don't re-declare these per-project.

## Where new code goes (suggested, consistent with the above)
- **Provider seams** (interfaces + implementations): group by domain under the API project, e.g. `src/HomeHub.Api/Sensors/` (`ISensorProvider`, `SensorPushProvider`), `src/HomeHub.Api/Climate/` (`IClimateProvider`, `HomeAssistantClimateProvider`), `src/HomeHub.Api/Ai/` (`IAssistantProvider`, `AssistantRouter`, `LocalAssistantProvider`, `OpenAIAssistantProvider`). UI/controllers depend on the **interface**, never a vendor SDK.
- **EF entities & configuration:** register in `HomeHubDbContext.OnModelCreating` (per-stage, as the class comment says). One migration per stage; keep the design-time factory working.
- **Background services** (e.g. the SensorPush poller): `IHostedService`/`BackgroundService` registered in `Program.cs`.
- **Controllers:** `src/HomeHub.Api/Controllers/`, `[ApiController]`, route `api/[controller]` (see `HealthController`).
- **React screens** already exist as placeholders — wire them in place rather than recreating; reuse the exported components from `client/src/components/index.ts`.

## Design system (already built — consume, don't recreate)
- **Tokens are CSS custom properties** in `client/src/theme/tokens.css` (dark theme + `:root[data-ambient='bright']` daylight boost). Use the `var(--…)` tokens; never hardcode hex. `HomeHub_ClaudeDesign/design-tokens.json` is the design source, not a runtime file.
- **Component styles** live in `client/src/components/ledger.css` under the **`ml-` class prefix**. No Tailwind. No border-radius, no shadows (enforced in `index.css` reset).
- **4K portrait rem scaling** is in `client/src/index.css` (`font-size: min(calc(100vw / 33.75), calc(100vh / 60))`) with crisp-hairline device-px exceptions in tokens. Build new UI in rem via this system.
- **Fonts** are self-hosted (`client/src/fonts/` + `fonts.css`, `font-display: block`). Marcellus (numerals/titles) via `.serif`; Josefin Sans (body/labels). Add glyphs to the existing woff2 subset only if new copy needs them.
- **Icons:** inline SVG sprite in `client/src/icons/IconSprite.tsx`, referenced via `<Icon id="ico-…"/>`. Add new deco glyphs to the sprite in the same 24×24 stroke style; extend the `IconId` union in `Icon.tsx`.
- Match each screen to its spec in `HomeHub_ClaudeDesign/specs/*.md` + `screens/*.png`.

## Config & secrets
- Connection string: `ConnectionStrings:HomeHub` (env `ConnectionStrings__HomeHub`). App tolerates it being absent (shell still boots) — preserve that behavior.
- New secrets follow the same pattern: user-secrets in dev, env vars / protected config for the systemd service in prod. Suggested config keys as stages arrive: `SensorPush:*`, `Nws:UserAgent`, `Google:*`, `Microsoft:*`, `HomeAssistant:{BaseUrl,Token}`, `Ai:{OpenAiApiKey,OpenAiModel,LocalEndpoint,LocalModel,Routing:*}`. **Never commit secrets** (`.gitignore` already excludes `*.env`, `secrets.json`, `appsettings.*.Local.json`).
- Migrations run on startup when a connection string is present and `RunMigrationsOnStartup` (default true); failure is logged non-fatally so the shell still serves. Keep this offline-first behavior.

## Runtime / deployment (already established)
- Dev: two processes — Kestrel (`http://localhost:5220`) + Vite (`5173`, proxies `/api`). Prod: one unit — SPA built into `wwwroot`, served by Kestrel, run as a systemd service. See `README.md`, `deploy/server-systemd.md`, `deploy/pi-kiosk.md`.
- No HTTPS redirect / no CORS (same-origin in prod, Vite proxy in dev) — don't add these without reason.
- Real-time: prefer push. Backend→client via SignalR; HA→backend via WebSocket (Stage 6). Falls back to polling only if needed.

## Cross-cutting rules (from `00-architecture.md`)
- **Provider seams are mandatory** (sensor, climate, AI). **Alert engine is built once (Stage 2) and reused** (Stage 3+). **Offline:** cached reads + honest reconnecting state everywhere; the write-queue is Stage 9b only.
- Each stage ends at a **running, testable app**; never a half-wired state. Later stages must not break earlier milestones.