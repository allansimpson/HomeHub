using System.Security.Cryptography.X509Certificates;
using System.Text.Json.Serialization;
using System.Threading.RateLimiting;
using HomeHub.Api.Accounts;
using HomeHub.Api.Ai;
using HomeHub.Api.Alerts;
using HomeHub.Api.Auth;
using HomeHub.Api.Baby;
using HomeHub.Api.Calendar;
using HomeHub.Api.Calendar.Capture;
using HomeHub.Api.Cats;
using HomeHub.Api.Climate;
using HomeHub.Api.Data;
using HomeHub.Api.HomeAssistant;
using HomeHub.Api.Mcp;
using HomeHub.Api.Meals;
using HomeHub.Api.Notifications;
using HomeHub.Api.Pantry;
using HomeHub.Api.Security;
using HomeHub.Api.Sensors;
using HomeHub.Api.Tasks;
using HomeHub.Api.Weather;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;
using ModelContextProtocol.Server;

var builder = WebApplication.CreateBuilder(args);

// --- Kestrel binding, and presence-detected HTTPS ---
//
// This block is the *only* place that decides which ports the app listens on. Nothing else declares
// them — not `launchSettings.json`, not `ASPNETCORE_URLS` in the systemd env file. Two sources meant
// Kestrel logged "Overriding address(es) 'http://0.0.0.0:5220'" on every start, which reads like a
// misconfiguration when it is simply the same port written down twice. One source, no warning.
//
// HTTPS is opt-in by the certificate existing, rather than by a flag. The phone-side scan screen
// needs `getUserMedia`, which every browser refuses outside a secure context — HTTPS, or localhost.
// A phone reaching the host by LAN address over plain HTTP is neither, so the camera is not blocked
// but *absent*, and the screen falls back to "NO CAMERA HERE". That is as true of the deployed panel
// as of a dev machine: scanning against a laptop is not where anyone unpacks shopping.
//
// Development uses the pair `scripts/make-dev-certs.sh` writes at a known path; production uses
// whatever `Server:CertPath` / `Server:KeyPath` point at, which `scripts/make-panel-cert.sh` signs
// with the *same* household CA, so phones that already trust that CA need nothing further.
//
// HTTP is always bound, with or without a certificate — the kiosk, bookmarks and the deploy health
// check all use it, and a host that has not been given a certificate must still serve.
{
    var isDev = builder.Environment.IsDevelopment();

    // A distinct section, not `Kestrel:` — ASP.NET Core binds that one itself, and burying custom
    // keys in a section with its own schema is how a typo becomes silence rather than an error.
    var certPath = isDev
        ? Path.Combine(builder.Environment.ContentRootPath, "..", "..", "certs", "homehub-dev.crt")
        : builder.Configuration["Server:CertPath"];
    var keyPath = isDev
        ? Path.Combine(builder.Environment.ContentRootPath, "..", "..", "certs", "homehub-dev.key")
        : builder.Configuration["Server:KeyPath"];

    // 0.0.0.0 rather than localhost, in both environments: the panel is reached from tablets and
    // phones on the LAN, and a loopback-only bind is the single most common reason it "works on the
    // machine and nowhere else".
    // The fallback is 5080/5081, not 5000/5001, and that is not cosmetic. 5000 is a crowded default
    // — Kavita, Flask apps, assorted add-ons — so a deployment that simply omits Server__HttpPort
    // lands on an occupied port, and a busy port does not degrade: the host stops, systemd restarts
    // it seconds later, the dying process still holds the socket, and it crash-loops. This matches
    // deploy/deploy.env, deploy/bootstrap-server.sh and deploy/server-systemd.md; all four have to
    // agree, because nothing checks that they do.
    var httpPort = isDev ? 5220 : builder.Configuration.GetValue("Server:HttpPort", 5080);
    var httpsPort = isDev ? 7288 : builder.Configuration.GetValue("Server:HttpsPort", 5081);

    X509Certificate2? certificate = null;
    if (!string.IsNullOrWhiteSpace(certPath) && !string.IsNullOrWhiteSpace(keyPath)
        && File.Exists(certPath) && File.Exists(keyPath))
    {
        try
        {
            // Round-tripped through PKCS#12 on purpose. A certificate built by `CreateFromPemFile`
            // holds its private key in an ephemeral CNG store on Windows, and Schannel cannot use
            // that for server authentication — the handshake fails with a bare "no credentials"
            // error that says nothing about where the key came from. Exporting and re-loading
            // materialises a key Schannel will accept. Linux does not need the dance, but one path
            // is easier to trust than two that diverge by platform.
            using var fromPem = X509Certificate2.CreateFromPemFile(certPath, keyPath);
            certificate = X509CertificateLoader.LoadPkcs12(fromPem.Export(X509ContentType.Pkcs12), null);
        }
        catch (Exception ex)
        {
            // A certificate that cannot be read must not take the panel down with it.
            //
            // `File.Exists` above passes on a key the service cannot actually open: existence needs
            // only execute on the directory, while reading needs the file's own permissions. The
            // usual cause is ownership rather than mode — the pair arrives over scp carrying the
            // uploading account's group, so a 640 key is unreadable by the service account even
            // though it is plainly there and looks right in `ls -l`.
            //
            // Without this catch the throw happens before the host is built, so the process dies at
            // startup and *HTTP goes with it* — the whole panel offline over an optional listener.
            // That contradicts how the rest of this app behaves: a missing database and a failed
            // migration are both non-fatal. Degrade to HTTP and say why.
            //
            // Console.Error, not ILogger: there is no logger yet at this point in startup. systemd
            // captures stderr into the journal, so `journalctl -u homehub` shows it.
            Console.Error.WriteLine(
                $"HTTPS disabled: could not load the certificate at '{certPath}'. Serving HTTP only. {ex.Message}");
        }
    }

    builder.WebHost.ConfigureKestrel(options =>
    {
        options.ListenAnyIP(httpPort);
        if (certificate is not null)
            options.ListenAnyIP(httpsPort, listen => listen.UseHttps(certificate));
    });
}

// --- Services ---
// --- AUDIT A1: the trust boundary ---
// There was none. Every endpoint, including "clear this member's PIN" and "read this member's
// entire chat history", was reachable by anything on the LAN, and `?profileId=` *was* the
// authorisation model. Two schemes replace it:
//
//   * a session cookie for people, minted by POST /api/session against the member's own PIN;
//   * a bearer token for programs — today the voice bridge, which is server-to-server and has
//     nowhere to keep a cookie.
//
// The cookie is the default challenge scheme, so an unauthenticated browser request gets a 401 it
// can act on rather than a redirect to a login page this app does not serve.
builder.Services.AddSingleton<PinLockout>();
// Scoped and hand-built: the handler wants the request's DbContext, which may not be registered at
// all (the app runs without a database for design-system work). `GetService` returns null there,
// which the handler treats as "no roster to protect" — whereas the container's own constructor
// resolution would refuse to build it and every admin check would fail as a 500.
builder.Services.AddScoped<IAuthorizationHandler>(sp => new HouseholdAdminHandler(
    sp.GetRequiredService<ILogger<HouseholdAdminHandler>>(), sp.GetService<HomeHubDbContext>()));

builder.Services
    .AddAuthentication(Household.CookieScheme)
    .AddCookie(Household.CookieScheme, options =>
    {
        options.Cookie.Name = Household.CookieName;
        options.Cookie.HttpOnly = true;
        // Strict, not Lax. Nothing here is reached by a cross-site link on purpose: the OAuth
        // callback is the one inbound cross-site navigation and it is [AllowAnonymous], carrying
        // its own single-use state. The SPA's own fetches are same-site and unaffected.
        options.Cookie.SameSite = SameSiteMode.Strict;
        // `Always` would be correct and is what the audit asks for — but HTTP on 5080 is always
        // bound and HTTPS only appears when a certificate is present, so `Always` on an
        // HTTP-only deployment means the browser silently discards the cookie and nobody can ever
        // sign in. SameAsRequest marks it Secure exactly when the request was, which is the strong
        // behaviour wherever the strong behaviour is possible.
        options.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;
        // Long, because the wall panel is the point. A kiosk that has to be signed in again after
        // every power cut — with a PIN somebody has to remember — is a kiosk that gets its PIN
        // removed. Sliding, so a panel in daily use never reaches the end of it.
        options.ExpireTimeSpan = TimeSpan.FromDays(400);
        options.SlidingExpiration = true;
        // This is an API, not a server-rendered site: there is no /Account/Login to send anyone to,
        // and a 302 to a missing page turns an actionable 401 into an HTML body the client parses
        // as a failed request for JSON.
        options.Events.OnRedirectToLogin = ctx =>
        {
            ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return Task.CompletedTask;
        };
        options.Events.OnRedirectToAccessDenied = ctx =>
        {
            ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
            return Task.CompletedTask;
        };
    })
    // Bound here rather than with a plain `Configure<ServiceTokenOptions>`. Authentication options
    // are resolved from `IOptionsMonitor` *by scheme name*, so an unnamed registration binds an
    // instance the handler never sees — every token then reads as unknown, with the config sitting
    // right there looking correct. (Found by the test, which is why it is worth having one.)
    .AddScheme<ServiceTokenOptions, ServiceTokenAuthenticationHandler>(
        Household.ServiceScheme,
        options => builder.Configuration.GetSection(ServiceTokenOptions.Section).Bind(options));

builder.Services.AddAuthorizationBuilder()
    // Authenticated by default, by either scheme. The fallback applies to every endpoint that does
    // not state a policy of its own, so the failure mode of adding a controller and forgetting to
    // think about auth is "nobody can reach it" rather than "everybody can".
    .SetFallbackPolicy(new AuthorizationPolicyBuilder(Household.CookieScheme, Household.ServiceScheme)
        .RequireAuthenticatedUser()
        .Build())
    .AddPolicy(Household.AdminPolicy, policy => policy
        .AddAuthenticationSchemes(Household.CookieScheme)
        .RequireAuthenticatedUser()
        .AddRequirements(new HouseholdAdminRequirement()));

// --- AUDIT A6: rate limiting on the two endpoints where volume is the attack ---
// Everything else is now behind A1's session boundary, which is the real protection. These two are
// worth a second layer for different reasons, and neither is covered by what already exists:
//
//   * sign-in is reachable without a credential, by definition. PinLockout stops five wrong PINs
//     *per profile*; it does nothing about a caller working through the roster, or about the cost
//     of a PBKDF2 verify per request. This bounds the attempts themselves.
//   * an assist turn spends the household's inference budget and can be started by any signed-in
//     member. The ceiling is generous enough that no person will meet it and low enough that a
//     runaway script cannot empty an account overnight.
//
// Partitioned by remote IP rather than globally: one phone retrying must not lock the wall panel
// out of signing in.
builder.Services.AddRateLimiter(options =>
{
    // 429 rather than the default 503 — the client can tell "slow down" from "the server is
    // broken", and only the first is worth retrying on a timer.
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

    options.AddPolicy(RateLimits.SignIn, http => RateLimitPartition.GetFixedWindowLimiter(
        http.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        _ => new FixedWindowRateLimiterOptions
        {
            // Twenty a minute: a household member mistyping a four-digit PIN a few times stays well
            // under it, and PinLockout's own cooldown bites long before this does for a single
            // profile. What this catches is the shape PinLockout cannot see — spreading attempts
            // across profiles to stay under five each.
            PermitLimit = 20,
            Window = TimeSpan.FromMinutes(1),
            QueueLimit = 0,
        }));

    options.AddPolicy(RateLimits.AssistTurn, http => RateLimitPartition.GetFixedWindowLimiter(
        http.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = 30,
            Window = TimeSpan.FromMinutes(1),
            // No queue: a turn that waits in line has already failed the thing it is for. The panel
            // shows the refusal and the household asks again.
            QueueLimit = 0,
        }));
});

builder.Services.AddControllers().AddJsonOptions(o =>
{
    // Serialize enums (alert severity/metric/direction, zone category) as their names.
    o.JsonSerializerOptions.Converters.Add(new JsonStringEnumConverter());
});
builder.Services.AddOpenApi();

// --- AUDIT A2: credentials encrypted at rest ---
// The Google and Microsoft refresh tokens are durable access to two real cloud accounts, and they
// sat in the database in plaintext. SecretProtector puts a Data Protection envelope on those
// columns via an EF value converter, so no call site can write one in the clear.
//
// The key ring is the whole game. Two things make the default location wrong here:
//   * systemd sets ProtectHome=true, so the default `$HOME/.aspnet/DataProtection-Keys` is not
//     writable and Data Protection falls back to keys held only in memory — which works perfectly
//     until the first restart, at which point every stored token becomes undecryptable.
//   * a release directory would be worse: `deploy.sh` flips a symlink to a fresh directory, so
//     keys written beside the binaries would be discarded by the very next deploy.
// So it goes in the same durable state directory as the image cache and the TTS phrases, and it is
// stated in configuration rather than inferred. If it is unset the app still starts — losing
// calendar sync is not worth refusing to serve the clock over — but it says so loudly, because the
// symptom otherwise appears days later as "Google keeps asking me to sign in again".
builder.Services.AddSingleton<ISecretProtector, SecretProtector>();
var keyRingPath = builder.Configuration["DataProtection:KeyPath"];
var dataProtection = builder.Services.AddDataProtection().SetApplicationName("HomeHub");
if (!string.IsNullOrWhiteSpace(keyRingPath))
    dataProtection.PersistKeysToFileSystem(Directory.CreateDirectory(keyRingPath));

// EF Core / SQL Server. The connection string is NEVER committed — it is read from the
// secrets mechanism: user-secrets in dev, environment variable / protected config for the
// systemd service in prod (ConnectionStrings__HomeHub). Stage 0 tolerates it being absent
// so the design-system shell still boots for local UI work.
var connectionString = builder.Configuration.GetConnectionString("HomeHub");
if (!string.IsNullOrWhiteSpace(connectionString))
{
    builder.Services.AddDbContext<HomeHubDbContext>(options =>
        options.UseSqlServer(connectionString, sql =>
        {
            // Connection resiliency. The panel's first seconds are its worst: every provider polls
            // at once, so a server that is asleep, resuming, or briefly unreachable turns one slow
            // connection into a wave of "Execution Timeout Expired" across unrelated controllers —
            // and, because the request threads are all parked on SQL, into Home Assistant timeouts
            // that look like an HA fault but are not.
            //
            // Retries make that a pause instead of a cascade. Safe here because nothing in this app
            // opens a user-initiated transaction; EF throws rather than silently retrying half of one.
            // Kept deliberately short. This is a polling panel: every provider re-reads within
            // 15–30s anyway, so a request that retries for minutes is worse than one that fails and
            // is asked again — the browser abandons it, which cancels the work mid-flight and buries
            // the real cause under a cascade of OperationCanceledException. Absorb a blip; let a
            // genuinely asleep server be picked up by the next poll.
            sql.EnableRetryOnFailure(
                maxRetryCount: 3,
                maxRetryDelay: TimeSpan.FromSeconds(5),
                errorNumbersToAdd: null);

            // Above the 30s default for a resuming server, below the point where a queued request
            // outlives the client that asked for it.
            sql.CommandTimeout(45);
        }));
}

// --- Stage 2: sensors + alert engine ---
// The sensor seam: SensorPush when credentials are configured, otherwise the deterministic
// simulated provider so the app is fully functional out of the box (real data on drop-in of
// creds, no code change). UI/logic depend only on ISensorProvider.
builder.Services.Configure<SensorPushOptions>(builder.Configuration.GetSection(SensorPushOptions.Section));
var sensorPush = builder.Configuration.GetSection(SensorPushOptions.Section).Get<SensorPushOptions>();
if (sensorPush?.IsConfigured == true)
{
    builder.Services.AddHttpClient<SensorPushProvider>();
    builder.Services.AddScoped<ISensorProvider>(sp => sp.GetRequiredService<SensorPushProvider>());
}
else
{
    builder.Services.AddSingleton<ISensorProvider, SimulatedSensorProvider>();
}
// Pending OAuth flows for in-panel account linking. Singleton because a consent begun on one
// request completes on another, and in-memory because losing them on restart is correct.
builder.Services.AddSingleton<AccountLinkState>();
// A plain client for the OAuth token exchange — the provider-specific clients are registered only
// when that provider is configured, and linking has to work on the way to being configured.
builder.Services.AddHttpClient();

builder.Services.AddScoped<AlertEngine>();

// The one notification queue behind the live cards, the drawer and the inbox. Registered only with
// a database, because unlike alerts — which are recomputed from live state every tick — a
// notification is a record, and a record that vanishes on restart is not one.
if (!string.IsNullOrWhiteSpace(connectionString))
{
    builder.Services.AddScoped<NotificationService>();
    // Retention was a read filter only until this existed — the table itself grew forever, and the
    // per-record dedupe lookup scanned all of it. See NotificationPruneService.
    builder.Services.AddHostedService<NotificationPruneService>();
}

// --- Stage 3: weather (NWS) ---
// Key-free; the default location works out of the box. Alerts are folded into the same alert
// engine + banner as sensors (no duplicate mechanism).
builder.Services.Configure<WeatherOptions>(builder.Configuration.GetSection(WeatherOptions.Section));
builder.Services.AddHttpClient<IWeatherProvider, NwsWeatherProvider>();
builder.Services.AddScoped<WeatherRefresher>();

// --- Stage M2: recipe import ---
// The fetcher gets its own typed client so its timeout and User-Agent are its own, and so the
// SSRF guard in RecipeFetcher is the only path by which this app fetches a user-supplied URL.
// The handler comes from RecipeFetcher rather than being assembled here: it carries the connect
// callback that screens every address at dial time, and `AllowAutoRedirect = false` — redirects are
// followed by hand inside the fetcher (see D4) so each hop is re-checked. Both properties are the
// guard, so they are declared next to it and not in this file, where a later edit would not know.
builder.Services.Configure<MealsOptions>(builder.Configuration.GetSection(MealsOptions.Section));
builder.Services.AddHttpClient<RecipeFetcher>()
    .ConfigurePrimaryHttpMessageHandler(sp =>
        RecipeFetcher.CreateGuardedHandler(sp.GetRequiredService<IOptions<MealsOptions>>().Value));
builder.Services.AddScoped<RecipeImportService>();
// The Meals notifications (MEALS_BEHAVIOURS §4). Both require the database: the notifier writes
// through the request's DbContext, and the lead-time watcher has no durable plan to inspect without
// one. Keep them out of the no-database shell so its health endpoint can still start cleanly.
if (!string.IsNullOrWhiteSpace(connectionString))
{
    builder.Services.AddScoped<MealNotifier>();
    builder.Services.AddHostedService<MealLeadTimeService>();
}

// --- Stage M5: pantry ---
// The ledger is the only thing that mutates a pantry item, so everything that writes takes it
// rather than touching the entity — see PantryLedger for why the two can never be allowed to drift.
// All four services require a DbContext, so the no-database shell must not validate them.
if (!string.IsNullOrWhiteSpace(connectionString))
{
    builder.Services.AddScoped<PantryLedger>();
    builder.Services.AddScoped<StockCheckService>();
    builder.Services.AddScoped<DeductionService>();
    // Canonical units. Scoped because it caches the (tiny) unit table for the life of one request and
    // adds new ones through that request's DbContext — see UnitRegistry for why a per-value round trip
    // would be fifteen queries to save one recipe. Every field that takes a typed unit goes through it,
    // which is the only reason canonical units are worth having: the pantry and the recipe folder have
    // to spell things the same way or the stock check cannot join them.
    builder.Services.AddScoped<UnitRegistry>();
}

// Barcode → product name. Open Food Facts when switched on, otherwise nothing at all — and
// "nothing at all" is the handoff's own design (DECISIONS PG4), where every new barcode is an
// unmatched row the household names once. The lookup only ever pre-fills that row; it never creates
// an item and never writes a catalogue entry, so turning it off changes convenience, not behaviour.
builder.Services.Configure<OpenFoodFactsOptions>(builder.Configuration.GetSection(OpenFoodFactsOptions.Section));
var openFoodFacts = builder.Configuration.GetSection(OpenFoodFactsOptions.Section).Get<OpenFoodFactsOptions>();
if (openFoodFacts?.IsConfigured == true)
{
    builder.Services.AddHttpClient<IProductLookup, OpenFoodFactsProductLookup>();
}
else
{
    builder.Services.AddScoped<IProductLookup, NotConnectedProductLookup>();
}
// The mirror is a singleton with its own scope factory because it also runs from a hosted worker,
// outside any request. It shares the Microsoft OAuth config with the Tasks provider — one linked
// account, two things using it — and does nothing at all until a list is chosen, which is a
// supported way to run the section rather than a broken one (PANTRY_BEHAVIOURS §8).
builder.Services.AddHttpClient(nameof(GroceryMirrorService));
builder.Services.AddSingleton<GroceryMirrorService>(sp => new GroceryMirrorService(
    sp.GetRequiredService<IServiceScopeFactory>(),
    sp.GetRequiredService<IHttpClientFactory>().CreateClient(nameof(GroceryMirrorService)),
    sp.GetRequiredService<IOptions<MicrosoftTodoOptions>>(),
    sp.GetRequiredService<TimeProvider>(),
    sp.GetRequiredService<ILogger<GroceryMirrorService>>()));
// The worker needs a database to have anything to mirror; without one it would wake every 20s to
// resolve a DbContext that isn't registered.
if (!string.IsNullOrWhiteSpace(connectionString))
{
    builder.Services.AddHostedService<GroceryMirrorWorker>();
}

// --- Stage 4: calendar ---
// Google Calendar when OAuth is configured; otherwise a local SQL calendar so the panel is
// fully usable (create/edit/delete persist) without any external account. UI depends only on
// ICalendarProvider. Both variants need the database, so registration is DB-gated below.
builder.Services.Configure<GoogleCalendarOptions>(builder.Configuration.GetSection(GoogleCalendarOptions.Section));
var google = builder.Configuration.GetSection(GoogleCalendarOptions.Section).Get<GoogleCalendarOptions>();
if (google?.IsConfigured == true)
{
    builder.Services.AddHttpClient<GoogleCalendarProvider>();
}

// --- E2: reading engagements off a photograph ---
// Its own credential section, deliberately not the speech key in `Ai:` and deliberately not an
// agent: this is HomeHub's own structured, tool-less call. Unconfigured — which is every panel that
// has not opted into sending photographs off the LAN, and the whole test suite — resolves to the
// not-connected implementation, so the seam always answers and the endpoint never 500s.
builder.Services.Configure<EventCaptureOptions>(builder.Configuration.GetSection(EventCaptureOptions.Section));
// The photograph store is registered whether or not a reader is: retention outlives the reading, so
// serving and forgetting kept photographs must keep working on a panel that has since turned the
// vision provider off.
builder.Services.AddSingleton<EventPhotoStore>();
/*
 * Which reader, and why the house agent is the default.
 *
 * The design assumed extraction needed its own vision vendor, on the grounds that an assistant turn
 * "streams text and nothing else". Tested rather than assumed, that is half true: Hermes ignores
 * `response_format` and answers prose — but asked for JSON in words it returns the agreed shape and
 * reads a flyer at least as well as a vision API does.
 *
 * That inverts the original argument. Every attached image *already* reaches the agent on the
 * ordinary chat turn, so adding a vendor would have sent each of the household's flyers to two
 * providers rather than one, and charged for the second. The vendor path stays for anyone who wants
 * a schema the provider enforces rather than merely requests.
 */
var eventCapture = builder.Configuration.GetSection(EventCaptureOptions.Section).Get<EventCaptureOptions>();

/*
 * The private image-extractor listener — the qualified path, preferred over everything below it.
 *
 * A dedicated Hermes profile with no callable tools, no MCP servers, no skills, no memory and no
 * delegation. Printed words in a flyer cannot cause a tool call because there is nothing to call,
 * which is the architectural guarantee `event-capture.md` D1 asked for and neither earlier path
 * could give: the vendor path sent the household's post to a second company, and the house-agent
 * path handed untrusted pixels to a listener holding `set_climate_setpoint` and `add_todo`.
 *
 * Registered as a service dependency and deliberately not as an agent — it never appears in the
 * household's roster, and nothing about it reaches the browser.
 */
builder.Services.Configure<ImageExtractorOptions>(builder.Configuration.GetSection(ImageExtractorOptions.Section));
var imageExtractor = builder.Configuration.GetSection(ImageExtractorOptions.Section).Get<ImageExtractorOptions>();

if (imageExtractor?.Configured == true)
{
    builder.Services.AddHttpClient<IImageExtractionClient, ImageExtractionClient>(http =>
    {
        http.BaseAddress = new Uri(imageExtractor.BaseUrl.TrimEnd('/') + "/");
        http.DefaultRequestHeaders.Authorization =
            new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", imageExtractor.ApiKey);
        // The per-call budget is enforced inside the client, which needs to tell a timeout from a
        // cancellation; this is only the backstop for a socket that never answers at all.
        http.Timeout = TimeSpan.FromSeconds(Math.Clamp(imageExtractor.TimeoutSeconds, 5, 180) + 30);
    });
    builder.Services.AddSingleton<IEventExtractor, ExtractorEventReader>();
}
else if (eventCapture?.UsesHouseAgent == false && eventCapture.Configured)
{
    // Legacy: a vision vendor. Kept reachable by explicit configuration, no longer a default — it is
    // a second destination for the household's post and a second bill for a job now done in-house.
    builder.Services.AddHttpClient<IEventExtractor, VisionEventExtractor>();
}
else if (eventCapture?.UsesHouseAgent != false)
{
    /*
     * Legacy: the household's own agent.
     *
     * Hermes reviewed this path and declined it for production — the reading runs against a listener
     * with write-capable tools available throughout, and the injection canary that passed is evidence
     * of good behaviour rather than of isolation. It stays reachable for TEST evaluation only, and
     * only when `ImageExtractor` is not configured.
     */
    builder.Services.AddSingleton<IEventExtractor, HermesEventExtractor>();
}
else
{
    builder.Services.AddSingleton<IEventExtractor, NotConfiguredEventExtractor>();
}

// --- Stage 5: tasks ---
// Microsoft To Do (Graph) when configured; otherwise a local SQL tasks store so the panel is
// fully usable without any linked account. UI depends only on ITaskProvider. DB-gated below.
builder.Services.Configure<MicrosoftTodoOptions>(builder.Configuration.GetSection(MicrosoftTodoOptions.Section));
var microsoft = builder.Configuration.GetSection(MicrosoftTodoOptions.Section).Get<MicrosoftTodoOptions>();
if (microsoft?.IsConfigured == true)
{
    builder.Services.AddHttpClient<MicrosoftTodoProvider>();
}

// --- Stage 6: climate (Home Assistant) ---
// HA when a URL + token are configured; otherwise a simulated climate store so the multi-zone
// screen is fully usable without hardware. UI depends only on IClimateProvider. DB-gated below.
builder.Services.Configure<HomeAssistantOptions>(builder.Configuration.GetSection(HomeAssistantOptions.Section));
var homeAssistant = builder.Configuration.GetSection(HomeAssistantOptions.Section).Get<HomeAssistantOptions>();
if (homeAssistant?.IsConfigured == true)
{
    // One HA client shared by every HA-backed provider (climate today, Huckleberry below).
    builder.Services.AddHttpClient<HomeAssistantClient>();
    builder.Services.AddScoped<HomeAssistantClimateProvider>();
}

// --- Stage H2: Huckleberry (baby tracking) via Home Assistant ---
// Reads only, behind IHuckleberryProvider. Huckleberry is the system of record — no EF entities
// here, just an in-memory display cache. Without HA config the section honestly reports "Not
// connected" rather than simulating baby data. No database needed.
// TimeProvider is not registered by the framework. Providers depend on the abstraction rather than
// DateTime.UtcNow so cache-expiry logic is testable without sleeping.
builder.Services.TryAddSingleton(TimeProvider.System);

builder.Services.Configure<HuckleberryOptions>(builder.Configuration.GetSection(HuckleberryOptions.Section));
var huckleberry = builder.Configuration.GetSection(HuckleberryOptions.Section).Get<HuckleberryOptions>() ?? new HuckleberryOptions();
if (homeAssistant?.IsConfigured == true && huckleberry.Enabled)
{
    builder.Services.AddSingleton<HuckleberrySnapshotCache>();
    builder.Services.AddScoped<IHuckleberryProvider, HuckleberryHomeAssistantProvider>();
}
else
{
    builder.Services.AddScoped<IHuckleberryProvider, NotConnectedHuckleberryProvider>();
}

// --- Litter-Robot (Cat section) via Home Assistant ---
// Reads ride the same HA client as climate/Huckleberry. The write path is a separate seam
// (ILitterRobotCommands) because HA can only reach two rungs of the recovery ladder — a full reset and
// a clean cycle — while the Whisker cloud API also accepts a short reset press and discrete power
// commands. Splitting them means a direct-Whisker implementation can be dropped in later without the
// recovery loop changing. Without HA config the section honestly reports "Not connected" rather than
// simulating a litter box.
builder.Services.Configure<CatOptions>(builder.Configuration.GetSection(CatOptions.Section));
var cats = builder.Configuration.GetSection(CatOptions.Section).Get<CatOptions>() ?? new CatOptions();
var catsLive = homeAssistant?.IsConfigured == true && cats.Enabled;
if (catsLive)
{
    builder.Services.AddSingleton<CatSnapshotCache>();
    builder.Services.AddScoped<ILitterRobotProvider, LitterRobotHomeAssistantProvider>();
    builder.Services.AddScoped<ILitterRobotCommands, HomeAssistantLitterRobotCommands>();
}
else
{
    builder.Services.AddScoped<ILitterRobotProvider, NotConnectedLitterRobotProvider>();
    builder.Services.AddScoped<ILitterRobotCommands, NotConnectedLitterRobotCommands>();
}
// The tracker holds live episode state shared by the recovery loop and the panel, so it is a singleton.
// The runner is scoped because it records attempts through the request/tick's DbContext.
builder.Services.AddSingleton<RecoveryTracker>();
builder.Services.AddScoped<LitterRobotRecoveryRunner>();

// --- Assist: the Hermes seam ---
//
// HomeHub holds no model, provider, tier, route or escalation configuration. It chooses an *agent*;
// Hermes owns every decision about how that agent answers. What is registered here is a connection
// per agent and nothing more.
//
// One gateway per agent — Barnaby and Geist are independent Hermes listeners on their own loopback
// ports, each with its own profile, session database, memory and API key. There is no multiplexing:
// the endpoint is the agent selector.

builder.Services.AddSingleton<IValidateOptions<HermesOptions>, HermesOptionsValidator>();
// Bound **once**, and validated at boot rather than on first use. Options validation is lazy by
// default, so without ValidateOnStart a half-written roster surfaces as a 500 the first time
// somebody asks the panel a question — on a headless box, hours after the deploy that caused it, to
// whoever happened to walk up.
//
// One registration, not Configure() plus Bind(): binding the same section twice *appends* to every
// List<T> it fills, so each configured value would appear twice.
builder.Services.AddOptions<HermesOptions>()
    .Bind(builder.Configuration.GetSection(HermesOptions.Section))
    .ValidateOnStart();

// One pooled handler; the address and this profile's bearer are set per call from live options, so
// the key never leaves HermesClientFactory and a config reload is picked up without a restart.
builder.Services.AddHttpClient(HermesClientFactory.ClientName);
builder.Services.AddSingleton<HermesClientFactory>();
builder.Services.AddSingleton<HermesClient>();

// Speech credentials only — cloud STT. Not an assistant model choice; see AiOptions.
builder.Services.Configure<AiOptions>(builder.Configuration.GetSection(AiOptions.Section));

// The roster is configuration, so it is a singleton: nothing about which agents exist varies by
// request. Which *member* gets which agent is household data and is read per request.
builder.Services.AddSingleton<AgentRoster>();
if (!string.IsNullOrWhiteSpace(connectionString))
    builder.Services.AddScoped<HomeHub.Api.Assist.AgentAccess>();
// Singleton: the point of the gate is that two *requests* contend for it.
builder.Services.AddSingleton<HomeHub.Api.Assist.ConversationLocks>();
// Singleton for the same reason, and one step further: a turn now outlives the request that started
// it, so the Stop that ends it — and the lookup a reconnecting panel makes after its stream died —
// both arrive on a *different* request and have to find it.
builder.Services.AddSingleton<HomeHub.Api.Assist.TurnRegistry>();

// The §3.1 lineage repair report. Read-only, on demand, never scheduled: it enumerates every session
// on every agent, which is not something to do on a timer behind a wall panel.
if (!string.IsNullOrWhiteSpace(connectionString))
    builder.Services.AddScoped<HomeHub.Api.Assist.LineageAudit>();

// In-app action layer (add a task, …). Resolves the task provider/DB from the request scope, so it
// degrades gracefully when no database is configured. Runs *before* any agent and works with every
// agent offline — that is the point of it.
builder.Services.AddScoped<AssistantActions>();
builder.Services.AddScoped<AssistTurnService>();
// The retention/deletion queue. Registered as a singleton *and* as the hosted service so the delete
// endpoint can drain it immediately — the ordinary case finishes before the response lands, and
// anything that fails is already durable and retried in the background.
builder.Services.AddSingleton<HomeHub.Api.Assist.SessionDeletionWorker>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<HomeHub.Api.Assist.SessionDeletionWorker>());
// Names a chat once its first turn has been answered. Singleton because it outlives the request that
// starts it — the browser has its reply and is gone by the time this writes anything — so it opens
// its own scope for the database rather than borrowing one that is about to be disposed.
builder.Services.AddSingleton<HomeHub.Api.Assist.ConversationTitler>();

// --- Stage 8: voice (server STT seam) ---
// Local-first STT: a faster-whisper sidecar on the LAN behind the seam, with OpenAI Whisper as cloud
// fallback, fronted by SttRouter (mirrors the assistant router). Browser on-device STT+TTS remains the
// demoable default. TTS is done in the browser. No database needed.
builder.Services.Configure<VoiceOptions>(builder.Configuration.GetSection(VoiceOptions.Section));
var voice = builder.Configuration.GetSection(VoiceOptions.Section).Get<VoiceOptions>() ?? new VoiceOptions();
builder.Services.AddHttpClient<OpenAISpeechToText>();
builder.Services.AddHttpClient<LocalWhisperSpeechToText>(c =>
    c.Timeout = TimeSpan.FromSeconds(Math.Max(1, voice.Stt.TimeoutSeconds)));
builder.Services.AddKeyedScoped<ISpeechToText>(SttRouter.LocalKey, (sp, _) => sp.GetRequiredService<LocalWhisperSpeechToText>());
builder.Services.AddKeyedScoped<ISpeechToText>(SttRouter.CloudKey, (sp, _) => sp.GetRequiredService<OpenAISpeechToText>());
builder.Services.AddScoped<SttRouter>();

// Central TTS (Stage 8R): one voice for the whole app, chosen by VoiceRouter. Piper is the default
// and the permanent fallback; Chatterbox becomes primary by setting Voice:Tts:Primary=chatterbox
// once a GPU is installed. Falls back to browser synthesis when neither is configured.
builder.Services.AddSingleton<PiperTextToSpeech>();
builder.Services.AddHttpClient<ChatterboxTextToSpeech>();
builder.Services.AddKeyedScoped<ITextToSpeech>(VoiceRouter.PiperKey, (sp, _) => sp.GetRequiredService<PiperTextToSpeech>());
builder.Services.AddKeyedScoped<ITextToSpeech>(VoiceRouter.ChatterboxKey, (sp, _) => sp.GetRequiredService<ChatterboxTextToSpeech>());
// The phrase cache clears itself at startup when the voice config hash changes, so it is a singleton.
builder.Services.AddSingleton<PhraseCache>();
// Deliberately no unkeyed ITextToSpeech registration: VoiceRouter is the only way to speak, so no
// call site can quietly bypass the fallback deadline and the phrase cache.
builder.Services.AddScoped<VoiceRouter>();

// The pollers write owned history / cache + evaluate alerts, and the calendar/task providers
// need a DB. All are registered only alongside a database; without a connection string the shell
// still serves (offline-first) and these data endpoints simply return errors until a DB exists.
if (!string.IsNullOrWhiteSpace(connectionString))
{
    if (google?.IsConfigured == true)
        builder.Services.AddScoped<ICalendarProvider>(sp => sp.GetRequiredService<GoogleCalendarProvider>());
    else
        builder.Services.AddScoped<ICalendarProvider, SqlCalendarProvider>();

    if (microsoft?.IsConfigured == true)
        builder.Services.AddScoped<ITaskProvider>(sp => sp.GetRequiredService<MicrosoftTodoProvider>());
    else
        builder.Services.AddScoped<ITaskProvider, SqlTaskProvider>();

    if (homeAssistant?.IsConfigured == true)
        builder.Services.AddScoped<IClimateProvider>(sp => sp.GetRequiredService<HomeAssistantClimateProvider>());
    else
        builder.Services.AddScoped<IClimateProvider, SimulatedClimateProvider>();

    // The Climate control loop. HomeHub reads the room's probe and moves the unit's set point itself
    // — the panel is where that is tuned, not where it runs. DB-gated with everything else: the loop
    // is a ledger before it is a controller, and one that cannot write down what it did has no way to
    // answer "why was the bedroom cold last night".
    builder.Services.AddScoped<ClimateReader>();
    builder.Services.AddScoped<ClimateBinder>();
    builder.Services.AddScoped<ClimateLoop>();
    builder.Services.AddScoped<ClimateCommands>();
    builder.Services.AddHostedService<ClimateLoopService>();

    // The recovery loop needs the DB for the rolling 24h attempt cap — without persisted attempt
    // history the cap would reset on every restart, which is the one brake that must not be losable.
    if (catsLive)
        builder.Services.AddHostedService<LitterRobotRecoveryService>();

    builder.Services.AddHostedService<SensorPollingService>();
    builder.Services.AddHostedService<WeatherPollingService>();
    builder.Services.AddHostedService<CalendarSeeder>();
    builder.Services.AddHostedService<TaskSeeder>();
}

// --- Stage A4: the MCP seam (ai-assistant.md) ---
// **Registered here, after the providers its tools inject.** Three of the six house tools take
// ICalendarProvider / IClimateProvider, which are DB-gated and registered just above. The MCP SDK
// decides which parameters come from DI and which become part of the tool's public schema by asking
// what the service collection can satisfy — so registering the tools before those providers exist
// leaks `climate` and `calendar` into the schema an agent is shown, as arguments it is expected to
// supply. That surfaced as an intermittent test failure and would have been a permanently malformed
// tool schema on a cold start.
//
// The house, exposed as tools an agent can call. HomeHub does not route between models or hold the
// assistant's memory — an agent does that, off-process — so what is registered here is a typed
// surface over the domain, not an assistant. Off unless a credential is configured: the tools write,
// and on a household LAN "reachable" is not "authorised".

builder.Services.AddSingleton<IValidateOptions<McpOptions>, McpOptionsValidator>();
// Same reasoning, and it matters more here: the failure this catches is two agents sharing one
// credential — a security boundary that has silently stopped existing.
//
// The double-bind above is not hypothetical. Registering both Configure() and Bind() here made every
// credential's Methods list bind twice, and the duplicate-method check rejected it at boot.
builder.Services.AddOptions<McpOptions>()
    .Bind(builder.Configuration.GetSection(McpOptions.Section))
    .ValidateOnStart();
var mcp = builder.Configuration.GetSection(McpOptions.Section).Get<McpOptions>() ?? new McpOptions();
if (mcp.IsConfigured)
{
    // The filters read the authenticated caller off the request, so the accessor is a dependency of
    // authorisation here rather than a convenience.
    builder.Services.AddHttpContextAccessor();
    builder.Services.AddSingleton<McpCallerRegistry>();

    // Stateless: the agent holds the conversation, so there is no server-to-client channel to keep
    // open and nothing to resume. One request, one scope, one answer.
    builder.Services
        .AddMcpServer(o => o.AddHouseMethodScoping())
        .WithHttpTransport(o => o.Stateless = true)
        // Listed explicitly rather than scanned from the assembly: the tool surface is meant to stay
        // short and deliberate, and a new [McpServerToolType] should not reach an agent by accident.
        .WithTools([typeof(HouseTools)]);
}

var app = builder.Build();

// Which agents are configured, said once, at boot.
//
// An agent with no key is a normal state, not a fault — it lists in the roster, reports
// `configured: false`, and answers with the canned line — so it must not stop the panel starting.
// But it is also exactly the state that looks like a bug six weeks later ("why does Geist never
// reply?"), and the answer lives in an env file on a headless box. One line in the journal is the
// difference between a five-minute check and an afternoon.
{
    var roster = app.Services.GetRequiredService<HomeHub.Api.Ai.AgentRoster>();
    var unconfigured = roster.All.Where(a => !a.IsConfigured).Select(a => a.Key).ToList();
    if (unconfigured.Count > 0)
        app.Services.GetRequiredService<ILoggerFactory>()
            .CreateLogger("HomeHub.Ai.Roster")
            .LogWarning(
                "Hermes agent(s) {Agents} have no ApiKey, so they cannot answer — set "
              + "Hermes__Agents__<key>__ApiKey in /etc/homehub/homehub.env and restart. "
              + "The panel runs without them.", string.Join(", ", unconfigured));
}

// --- Pipeline ---
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

// No HTTPS redirect: the kiosk is served over plain HTTP on the trusted LAN
// (nginx/TLS can be layered in front later, per the architecture).

// A client that walks away — a page reload, a poll overtaking its predecessor, the kiosk
// navigating — aborts its request, and every `await` carrying the request token unwinds with
// OperationCanceledException. That is correct behaviour, but nothing in our code was catching it, so
// it escaped to the framework: logged as a fault, and reported by the debugger as "unhandled in user
// code" at whichever line happened to be awaiting. That is what sent us looking at Home Assistant,
// then at SQL Server, when the truth was simply that nobody was listening any more.
//
// Handling it here, once, keeps the diagnosis honest: a disconnect is a disconnect, not an error in
// whichever provider drew the short straw. 499 is nginx's "client closed request" — nothing reads
// the status (the caller is gone), but it keeps the log truthful.
app.Use(async (context, next) =>
{
    try
    {
        await next();
    }
    catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested)
    {
        if (!context.Response.HasStarted) context.Response.StatusCode = 499;
    }
});

// Apply migrations on startup so the app owns its schema. Controlled by
// RunMigrationsOnStartup (default true). Failure is logged but non-fatal — the SPA shell
// must still load and show a calm reconnecting state rather than a crash, per the
// offline-first principle.
if (!string.IsNullOrWhiteSpace(connectionString)
    && app.Configuration.GetValue("RunMigrationsOnStartup", true))
{
    using var scope = app.Services.CreateScope();
    var logger = scope.ServiceProvider.GetRequiredService<ILogger<Program>>();
    try
    {
        var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
        db.Database.Migrate();
        logger.LogInformation("Database migrations applied.");

        // Runs after Migrate() because it writes to columns the schema has to already have, and
        // separately from it because encrypting data with a runtime key is not a schema change.
        // Idempotent — after the first pass there is nothing left in plaintext to find.
        await LegacySecretMigration.RunAsync(
            db, scope.ServiceProvider.GetRequiredService<ISecretProtector>(), logger);
    }
    catch (Exception ex)
    {
        logger.LogError(ex, "Database migration failed at startup; serving app without a verified schema.");
    }
}

// Said once, at startup, rather than at the point of failure: a token that cannot be decrypted
// surfaces as an ordinary Google auth error days later, and nothing at that point points here.
if (string.IsNullOrWhiteSpace(keyRingPath))
{
    app.Logger.LogWarning(
        "DataProtection:KeyPath is not set, so encryption keys are not persisted. Stored Google and "
        + "Microsoft account links will need re-linking after every restart. Set it to a durable "
        + "directory the service account owns (see deploy/deploy.env.example).");
}

/*
 * Whether this panel can read photographs, said once at startup.
 *
 * <b>Because the alternative is a feature that is silent in three different ways.</b> A photograph
 * attached with no reader configured is answered honestly by the endpoint — `available: false` — and
 * the panel deliberately says nothing rather than blaming a picture that may be perfectly clear
 * (`event-capture.md` D7). That is right for a household that has chosen not to send photographs off
 * the LAN, and indistinguishable from a broken deployment for one that has: attach a flyer, watch
 * nothing happen, and there is no way to tell "switched off" from "the release without this in it"
 * from "the key is wrong". None of the three logged anything.
 *
 * So the log states which it is, in the household's terms, where `journalctl -u homehub` will find
 * it. It names no secret — only whether one is present.
 */
// Asked of the reader that was actually registered, rather than re-deduced from configuration —
// availability on the agent path is the Hermes roster's answer, not a key's.
using (var probe = app.Services.CreateScope())
{
    var reader = probe.ServiceProvider.GetRequiredService<IEventExtractor>();
    if (!reader.IsAvailable)
    {
        app.Logger.LogInformation(
            "Reading engagements off photographs is OFF ({Reader}). Attached images stay on the panel "
            + "and the calendar offer never appears. Set EventCapture__Agent to a configured agent, or "
            + "EventCapture__Provider=openai with EventCapture__ApiKey.",
            reader.GetType().Name);
    }
    else if (imageExtractor?.Configured == true)
    {
        app.Logger.LogInformation(
            "Reading engagements off photographs is ON, using the private image-extractor at {BaseUrl} "
            + "— a profile with no callable tools, no memory and no delegation.",
            imageExtractor.BaseUrl);
    }
    else if (eventCapture?.UsesHouseAgent != false)
    {
        // Said as a warning, because it is one. Hermes reviewed this path and declined it for
        // production: the reading runs against a listener with write-capable tools available
        // throughout. It is here for TEST evaluation until ImageExtractor__* is configured.
        /*
         * Names the missing piece, because "configure ImageExtractor" is not actionable at 5pm.
         *
         * The likeliest cause by far is `Enabled`: the qualification asks for this to land behind a
         * disabled-by-default flag, and the handoff's suggested environment block lists BaseUrl,
         * ApiKey, TimeoutSeconds and MaxConcurrent — but not Enabled. Somebody following that
         * document exactly gets a fully configured extractor that never runs, and a panel that looks
         * broken in the same silent way it looked broken before any of this existed.
         */
        var missing =
            string.IsNullOrWhiteSpace(imageExtractor?.BaseUrl) ? "ImageExtractor__BaseUrl is not set"
            : string.IsNullOrWhiteSpace(imageExtractor.ApiKey) ? "ImageExtractor__ApiKey is not set"
            : !imageExtractor.Enabled ? "ImageExtractor__Enabled is not true — the address and key are both present"
            : "ImageExtractor is configured but was not selected";

        app.Logger.LogWarning(
            "Reading engagements off photographs is ON using the house agent '{Agent}' — the legacy "
            + "path, which is NOT approved for production because that listener holds house tools. "
            + "The private extractor was not used: {Missing}.",
            eventCapture?.Agent ?? "barnaby",
            missing);
    }
    else
    {
        app.Logger.LogInformation(
            "Reading engagements off photographs is ON (model {Model} at {BaseUrl}). Attached images "
            + "are sent to that endpoint, which is off the LAN.",
            eventCapture.Model,
            eventCapture.BaseUrl);
    }
}

// Serve the built React SPA (client/dist copied into wwwroot at publish). In Development the SPA is
// served by Vite (npm run dev) and proxied, so wwwroot is typically empty.
//
// Before the authorisation middleware, and that ordering is the whole point. A1's fallback policy
// authenticates every request that does not state a policy of its own — and the authorisation
// middleware applies it to requests that match *no endpoint* too, which is exactly what a static
// asset is (`{*path:nonfile}` deliberately does not match a path ending in a file extension). With
// these two registered after it, `/assets/index-*.js`, the fonts, the icons and favicon.ico all
// answered 401: the browser could never load the app that asks for the PIN, so nobody could sign in
// to get the cookie that would have let the assets through. Served here, they short-circuit before
// authorisation ever runs.
//
// Nothing secret is behind this. It is the compiled client — the same bytes any signed-in browser
// would fetch — plus the household CA certificate, which is a public key that deploy/dev-https.md
// tells devices to download from exactly this path.
app.UseDefaultFiles();

/*
 * How long a browser may believe it already has the panel.
 *
 * <b>Nothing here said anything, and silence is not "ask me every time".</b> With no
 * `Cache-Control`, a browser falls back to heuristic freshness — roughly a tenth of the file's age —
 * so a shell that had been sitting there a day was reused for a couple of hours without a word to
 * the server. On a tab that is opened and closed, that is invisible. On a panel installed to a home
 * screen and never deliberately reloaded, it is a version of the app that outlives its own deploy:
 * one device answering with code that was replaced this morning while the machine beside it, whose
 * developer tools disable the cache, gets the fix and reports the bug fixed.
 *
 * Two rules, because there are two kinds of file here:
 *
 *   * the shell — `index.html`, the manifest, the icons — is a stable name with changing contents,
 *     so it must be revalidated every time. `no-cache` is that, and is not `no-store`: the copy is
 *     kept and reused on a 304, so the cost of being correct is one conditional request.
 *   * everything under /assets is content-addressed by the build (`index-CFU0mR3q.js`), so its name
 *     changes whenever its bytes do. A year is not optimism, it is what the hash makes true, and
 *     `immutable` stops a reload from revalidating what cannot have changed.
 */
app.UseStaticFiles(new StaticFileOptions
{
    OnPrepareResponse = ctx =>
    {
        var path = ctx.Context.Request.Path.Value ?? "";
        ctx.Context.Response.Headers.CacheControl =
            path.StartsWith("/assets/", StringComparison.OrdinalIgnoreCase)
                ? "public, max-age=31536000, immutable"
                : "no-cache";
    },
});

// Before MapControllers, and in this order: authentication decides who the caller is, authorisation
// decides whether they may proceed, and the second is meaningless without the first having run.
app.UseAuthentication();
app.UseAuthorization();
// After authorisation: a rejected request should not consume a rate-limit permit, and only the
// endpoints that opt in with [EnableRateLimiting] are affected at all.
app.UseRateLimiter();

app.MapControllers();

// --- Stage A4: the MCP endpoint ---
// Bearer-gated in front of the transport rather than inside a tool: MCP's own handshake runs before
// any tool body would, and an unauthenticated caller should not learn the shape of the house — let
// alone reach a write.
//
// Authentication only decides *who* is calling. What they may call is decided per method by
// McpMethodScoping, using the credential resolved here. Holding a valid token is never itself
// permission to do anything.
if (mcp.IsConfigured)
{
    app.UseWhen(
        ctx => ctx.Request.Path.StartsWithSegments(mcp.Route),
        branch => branch.Use(async (ctx, next) =>
        {
            var header = ctx.Request.Headers.Authorization.ToString();
            var token = header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)
                ? header["Bearer ".Length..].Trim()
                : "";

            var caller = ctx.RequestServices.GetRequiredService<McpCallerRegistry>().Resolve(token);
            if (caller is null)
            {
                ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
                ctx.Response.Headers.WWWAuthenticate = "Bearer";
                return;
            }

            ctx.Items[McpMethodScoping.CallerItemKey] = caller;
            await next();
        }));

    // Anonymous to the *authorisation middleware*, not to callers. These endpoints state no policy
    // of their own, so the fallback policy above claimed them — and that policy is satisfied by a
    // household cookie or a service token, neither of which an agent on another machine has or
    // should need. It runs in UseAuthorization, several lines above the bearer branch, so a correct
    // token was rejected before anything ever looked at it: POST /mcp answered 401, and GET — which
    // matches no MCP endpoint and so was never claimed — passed the bearer check and fell through to
    // the SPA fallback, which is the `text/html` the agent reports as "not an MCP response".
    //
    // The door is the UseWhen branch directly above, which covers every request to this route and
    // resolves a credential or ends the request. What that credential may then *do* is still decided
    // per method by McpMethodScoping. This removes a second, wrong lock from the same door; it does
    // not remove the lock.
    app.MapMcp(mcp.Route).AllowAnonymous();

    // The transport is stateless, so there is no server-to-client stream to hold open and the SDK
    // maps no GET here. Without this, an unmapped GET on this path is claimed by the SPA fallback at
    // the bottom of the file and the agent is handed the HTML shell — which is what Barnaby reported
    // as "returned Content-Type 'text/html' … most likely points at a web page rather than an MCP
    // endpoint". Same reasoning as the /api fallback below: a request shaped for a machine must not
    // be answered with a page meant for a person.
    //
    // A fallback rather than a MapGet, so that a future transport which *does* serve GET wins the
    // route and this quietly stops applying, instead of colliding with it. 405 is what the Streamable
    // HTTP spec has a server without an SSE stream answer GET with, and clients must handle it — so
    // the agent goes on to POST rather than concluding it found a website. Anonymous for the same
    // reason as the transport above: the bearer branch has already run, and refused anyone without a
    // credential.
    app.MapFallback(mcp.Route, () => Results.Json(
        new { error = "This is an MCP endpoint. Use POST for Streamable HTTP; it serves no GET stream." },
        statusCode: StatusCodes.Status405MethodNotAllowed)).AllowAnonymous();
}

// SPA fallback, so a deep link like /meals/plan or a kiosk reload on /dashboard serves the shell
// and lets the client router take it from there. The static-file middleware that backs it is
// registered further up, before authorisation.
//
// Anonymous, for the same reason the assets are: this endpoint *is* the sign-in screen. The
// fallback policy would otherwise 401 every route but `/`, so a panel reloading on the screen it
// was left on — which is every reboot of a wall panel — would come back to a blank error instead of
// the PIN pad. The shell it serves knows nothing; it calls GET /api/session on boot and renders the
// PIN pad when the answer is "nobody". Every endpoint holding household data stays authorised.
//
// Except under /api, which gets its own fallback first. The SPA pattern is `{*path:nonfile}`, and a
// mistyped or retired API route has no file extension either — so without this, `GET /api/climate`
// (a route that does not exist; the controller serves /zones and /units) answered 200 with the HTML
// shell, and the client parsed a document as JSON. This one states no policy, so the A1 fallback
// applies to it: an unknown API path is refused before it is reported missing, and only a caller
// with a session learns the difference between "no such route" and "not for you".
app.MapFallback("/api/{**rest}", () => Results.NotFound());
// The same `no-cache` the shell gets when it is served as a default file, because this is the same
// file and a deep link — /assist/c, the route a panel is left sitting on — arrives here instead.
// Setting it in one place and not the other would leave exactly the devices that never navigate to
// `/` holding a version nobody can talk them out of.
app.MapFallbackToFile("index.html", new StaticFileOptions
{
    OnPrepareResponse = ctx => ctx.Context.Response.Headers.CacheControl = "no-cache",
}).AllowAnonymous();

app.Run();

// Exposed so the integration test project can reference the app entry point via WebApplicationFactory.
public partial class Program { }
