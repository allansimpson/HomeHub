using System.Text.Json.Serialization;
using HomeHub.Api.Ai;
using HomeHub.Api.Alerts;
using HomeHub.Api.Calendar;
using HomeHub.Api.Climate;
using HomeHub.Api.Data;
using HomeHub.Api.Sensors;
using HomeHub.Api.Tasks;
using HomeHub.Api.Weather;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

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
        options.UseSqlServer(connectionString));
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
builder.Services.AddScoped<AlertEngine>();

// --- Stage 3: weather (NWS) ---
// Key-free; the default location works out of the box. Alerts are folded into the same alert
// engine + banner as sensors (no duplicate mechanism).
builder.Services.Configure<WeatherOptions>(builder.Configuration.GetSection(WeatherOptions.Section));
builder.Services.AddHttpClient<IWeatherProvider, NwsWeatherProvider>();
builder.Services.AddScoped<WeatherRefresher>();

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
    builder.Services.AddHttpClient<HomeAssistantClimateProvider>();
}

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
