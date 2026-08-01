using System.Security.Cryptography.X509Certificates;
using System.Text.Json.Serialization;
using HomeHub.Api.Accounts;
using HomeHub.Api.Ai;
using HomeHub.Api.Alerts;
using HomeHub.Api.Baby;
using HomeHub.Api.Calendar;
using HomeHub.Api.Cats;
using HomeHub.Api.Climate;
using HomeHub.Api.Data;
using HomeHub.Api.HomeAssistant;
using HomeHub.Api.Meals;
using HomeHub.Api.Notifications;
using HomeHub.Api.Pantry;
using HomeHub.Api.Sensors;
using HomeHub.Api.Tasks;
using HomeHub.Api.Weather;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;

var builder = WebApplication.CreateBuilder(args);

// --- Development HTTPS (opt-in, presence-detected) ---
//
// The phone-side scan screen needs `getUserMedia`, which every browser refuses outside a secure
// context — HTTPS, or localhost. A phone reaching the dev machine by LAN address over plain HTTP is
// neither, so the camera is not blocked but *absent*, and the screen falls back to "NO CAMERA HERE".
//
// Detected by the certificate simply existing (`scripts/make-dev-certs.sh` writes it) rather than
// by a flag, so a checkout with no certs behaves exactly as before and nobody has to know this code
// is here. Both schemes are bound: the API is reachable over plain HTTP for anything already
// pointed at 5220, and over HTTPS on every interface for the phone. Development only — the systemd
// unit sets its own ASPNETCORE_URLS and never generates a certificate.
if (builder.Environment.IsDevelopment())
{
    var certPath = Path.Combine(builder.Environment.ContentRootPath, "..", "..", "certs", "homehub-dev.crt");
    var keyPath = Path.Combine(builder.Environment.ContentRootPath, "..", "..", "certs", "homehub-dev.key");

    if (File.Exists(certPath) && File.Exists(keyPath))
    {
        // Round-tripped through PKCS#12 on purpose. A certificate built by `CreateFromPemFile` holds
        // its private key in an ephemeral CNG store on Windows, and Schannel cannot use that for
        // server authentication — the handshake fails with a bare "no credentials" error that says
        // nothing about where the key came from. Exporting and re-loading materialises a key
        // Schannel will accept.
        using var fromPem = X509Certificate2.CreateFromPemFile(certPath, keyPath);
        var certificate = X509CertificateLoader.LoadPkcs12(fromPem.Export(X509ContentType.Pkcs12), null);

        builder.WebHost.ConfigureKestrel(options =>
        {
            options.ListenAnyIP(5220);
            options.ListenAnyIP(7288, listen => listen.UseHttps(certificate));
        });
    }
}

// --- Services ---
builder.Services.AddControllers().AddJsonOptions(o =>
{
    // Serialize enums (alert severity/metric/direction, zone category) as their names.
    o.JsonSerializerOptions.Converters.Add(new JsonStringEnumConverter());
});
builder.Services.AddOpenApi();

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
// Redirects are followed by hand inside it — see D4 — so the handler must not follow them itself,
// or hops 2..n would reach the network without ever being checked.
builder.Services.Configure<MealsOptions>(builder.Configuration.GetSection(MealsOptions.Section));
builder.Services.AddHttpClient<RecipeFetcher>()
    .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false });
builder.Services.AddScoped<RecipeImportService>();
// The Meals notifications (MEALS_BEHAVIOURS §4). The notifier is scoped because it writes through
// the request's DbContext; the lead-time watcher is the one thing here that has to run while nobody
// is looking at the panel, so it is hosted.
builder.Services.AddScoped<MealNotifier>();
builder.Services.AddHostedService<MealLeadTimeService>();

// --- Stage M5: pantry ---
// The ledger is the only thing that mutates a pantry item, so everything that writes takes it
// rather than touching the entity — see PantryLedger for why the two can never be allowed to drift.
builder.Services.AddScoped<PantryLedger>();
builder.Services.AddScoped<StockCheckService>();
builder.Services.AddScoped<DeductionService>();

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

// --- Stage 7: AI assistant (hybrid local/cloud) ---
// The router routes each turn between the local server model and OpenAI, falling back to a
// built-in simulated on-device assistant when neither is configured. No database needed, so this
// is available even without a connection string. UI depends only on the router.
builder.Services.Configure<AiOptions>(builder.Configuration.GetSection(AiOptions.Section));
builder.Services.AddHttpClient<LocalAssistantProvider>();
builder.Services.AddHttpClient<OpenAIAssistantProvider>();
// Expose the three providers behind the seam under keys the router resolves.
builder.Services.AddKeyedScoped<IAssistantProvider>(AssistantRouter.LocalKey, (sp, _) => sp.GetRequiredService<LocalAssistantProvider>());
builder.Services.AddKeyedScoped<IAssistantProvider>(AssistantRouter.CloudKey, (sp, _) => sp.GetRequiredService<OpenAIAssistantProvider>());
builder.Services.AddKeyedScoped<IAssistantProvider>(AssistantRouter.SimulatedKey, (sp, _) => new SimulatedAssistantProvider());
builder.Services.AddScoped<AssistantRouter>();
// In-app action layer (add a task, …). Resolves the task provider/DB from the request scope, so it
// degrades gracefully when no database is configured.
builder.Services.AddScoped<AssistantActions>();

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

    // The recovery loop needs the DB for the rolling 24h attempt cap — without persisted attempt
    // history the cap would reset on every restart, which is the one brake that must not be losable.
    if (catsLive)
        builder.Services.AddHostedService<LitterRobotRecoveryService>();

    builder.Services.AddHostedService<SensorPollingService>();
    builder.Services.AddHostedService<WeatherPollingService>();
    builder.Services.AddHostedService<CalendarSeeder>();
    builder.Services.AddHostedService<TaskSeeder>();
}

var app = builder.Build();

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
    }
    catch (Exception ex)
    {
        logger.LogError(ex, "Database migration failed at startup; serving app without a verified schema.");
    }
}

app.MapControllers();

// Serve the built React SPA (client/dist copied into wwwroot at publish) with SPA
// fallback so client-side routes deep-link correctly. In Development the SPA is served by
// Vite (npm run dev) and proxied, so wwwroot is typically empty.
app.UseDefaultFiles();
app.UseStaticFiles();
app.MapFallbackToFile("index.html");

app.Run();

// Exposed so the integration test project can reference the app entry point via WebApplicationFactory.
public partial class Program { }
