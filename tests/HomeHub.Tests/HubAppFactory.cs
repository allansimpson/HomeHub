namespace HomeHub.Tests;

using HomeHub.Api.Calendar;
using HomeHub.Api.Cats;
using HomeHub.Api.Climate;
using HomeHub.Api.Data;
using HomeHub.Api.Meals;
using HomeHub.Api.Notifications;
using HomeHub.Api.Pantry;
using HomeHub.Api.Tasks;
using System.Net.Http.Json;
using HomeHub.Api.Ai;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;

/// <summary>
/// Boots the real app with an isolated in-memory database (unique per factory instance) so the
/// Stage 1 API can be exercised end-to-end without SQL Server. Registering the DbContext here
/// mirrors what a real connection string does in production; the app itself adds none in tests.
/// </summary>
public sealed class HubAppFactory : WebApplicationFactory<Program>
{
    private readonly string _dbName = "hub-tests-" + Guid.NewGuid();

    /// <summary>
    /// Bearer token for the MCP seam, or null to leave it unmapped (the default, and what every
    /// test that is not about MCP wants).
    /// </summary>
    public string? McpApiKey { get; init; }

    /// <summary>
    /// Per-agent MCP credentials: credential name → (key, allowed method names).
    /// </summary>
    /// <remarks>
    /// The shape the seam is meant to be configured in. <see cref="McpApiKey"/> remains for the
    /// tests that cover the deprecated shared key, which must keep working for panels that have not
    /// been reconfigured yet.
    /// </remarks>
    public Dictionary<string, (string Key, string[] Methods)> McpCredentials { get; init; } = [];

    /// <summary>
    /// The <c>Hermes:Agents</c> roster to configure.
    /// </summary>
    /// <remarks>
    /// Defaults to a single reachable-looking Barnaby so the ordinary tests have a roster to resolve
    /// against. The address points nowhere real — nothing in the suite talks to a Hermes, and the
    /// canned fallback is what answers. Tests about *access* deliberately run with agents that cannot
    /// be reached, because who may use an agent is a household decision that must be decidable with
    /// every gateway offline.
    /// </remarks>
    public (string Key, string Name, bool Default)[] Agents { get; init; } =
        [("barnaby", "Barnaby", true)];

    /// <summary>Base URL for every configured agent. Convenience for the single-agent default.</summary>
    public string? HermesBaseUrl { get; init; }

    /// <summary>Base URL per agent key, for tests that need two gateways told apart.</summary>
    public Dictionary<string, string> AgentBaseUrls { get; init; } = [];

    /// <summary>
    /// Whether opening a chat schedules the background naming call. <b>Off here, on in production.</b>
    /// </summary>
    /// <remarks>
    /// It is fire-and-forget by design (<c>Assist.ConversationTitler</c>), so leaving it on would put
    /// an unsynchronised second request to the gateway inside every test that opens a conversation —
    /// enough to make the "which gateway saw which turn" assertions count a race. The titler's own
    /// tests turn it back on, or drive it directly, which is the honest way to test something whose
    /// whole contract is "later, and nobody is waiting".
    /// </remarks>
    public bool NameConversations { get; init; }

    /// <summary>
    /// Service bearer credentials to configure, as name → token. Empty by default.
    /// </summary>
    /// <remarks>
    /// Empty means no service caller can authenticate, which is the shape a deployment that never
    /// sets one should have — closed rather than open. The voice bridge is the real consumer.
    /// </remarks>
    public Dictionary<string, string> ServiceTokens { get; init; } = [];

    /// <summary>
    /// A stand-in for the photograph reader, or null for the not-connected default.
    /// </summary>
    /// <remarks>
    /// The suite must never reach a vision provider, so the default registration is already the
    /// not-connected one — no key, no call. A test that wants to exercise what happens *after* a
    /// reading supplies its own here, which is the honest way to test a seam whose other side is
    /// somebody else's model.
    /// </remarks>
    public HomeHub.Api.Calendar.Capture.IEventExtractor? EventExtractor { get; init; }

    /// <summary>
    /// A stand-in for the Kitchen's photograph reader, or null for the not-connected default.
    /// </summary>
    /// <remarks>
    /// Same bargain as <see cref="EventExtractor"/>, and the same reason: the suite must never reach
    /// a model, so the default answers "not switched on" and a test that cares about what happens
    /// after a reading brings its own.
    /// </remarks>
    public HomeHub.Api.Kitchen.IKitchenPhotoReader? KitchenPhotoReader { get; init; }

    /// <summary>
    /// Configuration keys to set before the host is built, for tests about *registration*.
    /// </summary>
    /// <remarks>
    /// <see cref="EventExtractor"/> replaces the reader after the fact, which is right for tests
    /// about what the endpoint does with a reading. It cannot answer which reader `Program` chooses,
    /// and that became a question worth asking when the default became the house agent rather than a
    /// vision vendor: "nothing configured" is now a specific combination rather than the absence of
    /// one key.
    /// </remarks>
    public Dictionary<string, string> Settings { get; init; } = [];

    /// <summary>The host environment used by registration tests. Ordinary tests stay Development.</summary>
    public string EnvironmentName { get; init; } = Environments.Development;

    /// <summary>Optional physical web root for static-file integration tests.</summary>
    public string? WebRootPath { get; init; }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment(EnvironmentName);
        if (WebRootPath is not null) builder.UseWebRoot(WebRootPath);
        // Program.cs reads `Mcp:ApiKey` from raw configuration at build time to decide whether to
        // map the endpoint at all, so this cannot be a PostConfigure like the AI keys below — it
        // has to be the configuration value itself. Blank by default: a developer with a real key
        // in user-secrets must not get an MCP surface that CI does not have.
        builder.UseSetting("Mcp:ApiKey", McpApiKey ?? "");
        foreach (var (key, value) in Settings) builder.UseSetting(key, value);
        foreach (var (name, token) in ServiceTokens)
            builder.UseSetting($"Auth:ServiceTokens:Tokens:{name}", token);
        foreach (var (name, cred) in McpCredentials)
        {
            builder.UseSetting($"Mcp:Credentials:{name}:ApiKey", cred.Key);
            for (var i = 0; i < cred.Methods.Length; i++)
                builder.UseSetting($"Mcp:Credentials:{name}:Methods:{i}", cred.Methods[i]);
        }

        builder.ConfigureServices(services =>
        {
            // If the developer has a real connection string in user-secrets/env, Program.cs registers
            // the SqlServer provider (+ DB-gated pollers). Strip all EF Core registrations and the
            // app's background pollers so tests run against an isolated in-memory DB regardless of the
            // machine's config — otherwise the two DB providers collide ("only a single provider").
            var stale = services.Where(d =>
                    (d.ServiceType.FullName?.StartsWith("Microsoft.EntityFrameworkCore", StringComparison.Ordinal) ?? false)
                    || d.ServiceType == typeof(HomeHubDbContext)
                    || (d.ServiceType == typeof(IHostedService)
                        && (d.ImplementationType?.Namespace?.StartsWith("HomeHub.Api", StringComparison.Ordinal) ?? false)))
                .ToList();
            foreach (var d in stale) services.Remove(d);

            services.AddDbContext<HomeHubDbContext>(options => options.UseInMemoryDatabase(_dbName));
            // The app DB-gates these on a connection string; register the local providers here so the
            // calendar/task/climate endpoints work against the in-memory DB (last registration wins).
            services.AddScoped<ICalendarProvider, SqlCalendarProvider>();
            services.AddScoped<ITaskProvider, SqlTaskProvider>();
            services.AddScoped<IClimateProvider, SimulatedClimateProvider>();
            services.AddScoped<ClimateReader>();
            services.AddScoped<ClimateBinder>();
            services.AddScoped<ClimateLoop>();
            services.AddScoped<ClimateCommands>();
            services.AddScoped<NotificationService>();
            services.AddScoped<MealNotifier>();
            services.AddScoped<PantryLedger>();
            services.AddScoped<StockCheckService>();
            services.AddScoped<PlanClaimService>();
            services.AddScoped<DueScoreService>();
            services.AddScoped<MatchingService>();
            services.AddScoped<CookabilityService>();
            services.AddScoped<DeductionService>();
            services.AddScoped<UnitRegistry>();
            // Care logging is DB-gated in the app for the same reason as the calendar: the panel
            // serves its shell without a database, and a store that demanded one would take the
            // whole thing down rather than the one tab that needs it.
            services.AddScoped<HomeHub.Api.Care.CareLogService>();
            if (EventExtractor is { } extractor)
                services.AddSingleton(extractor);
            if (KitchenPhotoReader is { } kitchenReader)
                services.AddSingleton(kitchenReader);
            services.AddScoped<HomeHub.Api.Assist.AgentAccess>();
            services.AddScoped<HomeHub.Api.Assist.LineageAudit>();
            // Same reasoning, with sharper teeth: the litter-box seam has a *write* side. On a machine
            // with HomeAssistant in user-secrets, a test touching the cycle endpoint would send a real
            // reset to a real litter box. Pin both halves to the not-connected implementations; the
            // recovery ladder is covered by LitterRobotRecoveryTests against a fake robot.
            services.AddScoped<ILitterRobotProvider, NotConnectedLitterRobotProvider>();
            services.AddScoped<ILitterRobotCommands, NotConnectedLitterRobotCommands>();

            // Tests assert the no-integration fallbacks (simulated assistant, no server STT). Clear any
            // AI keys the developer has in user-secrets so those defaults hold regardless of machine.
            // Speech credentials only. No assistant model configuration exists any more: HomeHub
            // chooses an agent, and Hermes owns every decision about how that agent answers.
            services.PostConfigure<AiOptions>(o => o.OpenAiApiKey = null);

            // A roster with addresses that point nowhere. Nothing in the suite reaches a Hermes, so
            // every turn is answered by the canned fallback — which is exactly the state these tests
            // need: ownership, locking, lineage and the ledger must all be correct before an agent is
            // reachable, not after.
            services.PostConfigure<HermesOptions>(o =>
            {
                o.NameConversations = NameConversations;
                o.Agents = Agents.ToDictionary(
                    a => a.Key,
                    a => new HermesAgentOptions
                    {
                        Name = a.Name,
                        Tagline = a.Name + " tagline",
                        // Unreachable by default: an address that resolves instantly and refuses.
                        // Most tests want the ledger's behaviour with no agent answering.
                        BaseUrl = AgentBaseUrls.TryGetValue(a.Key, out var url) ? url
                            : HermesBaseUrl ?? "http://127.0.0.1:1",
                        ApiKey = "test-key-not-a-real-credential",
                        Default = a.Default,
                        SupportsHouseControl = a.Default,
                    },
                    StringComparer.OrdinalIgnoreCase);
            });
        });
    }

    /// <summary>
    /// Seeded database, and a client signed in as a household member.
    /// </summary>
    /// <remarks>
    /// <para>
    /// AUDIT A1 made <c>[Authorize]</c> the default, so a client with no session now 401s on almost
    /// everything. This signs in for real — a <c>POST /api/session</c> against a seeded profile,
    /// with the cookie carried by the handler <see cref="WebApplicationFactory{TEntryPoint}"/>
    /// already gives its clients. That is deliberately not a test-only authentication scheme: a
    /// stub principal would mean 800 tests exercising a boundary that does not exist in production,
    /// and the one thing worth being sure of here is that the real one works.
    /// </para>
    /// <para>
    /// Profile 1 (Astrid) is the seeded administrator, so the default client can reach the admin
    /// endpoints. Tests about who may do what ask for a different profile, or for
    /// <see cref="CreateAnonymousClient"/>.
    /// </para>
    /// </remarks>
    /// <param name="profileId">Which seeded member to sign in as. 1 is the administrator.</param>
    public HttpClient CreateSeededClient(int profileId = 1)
    {
        var client = CreateAnonymousClient();
        SignIn(client, profileId);
        return client;
    }

    /// <summary>
    /// Seeded database, and a client holding no session — for testing the boundary itself.
    /// </summary>
    public HttpClient CreateAnonymousClient() => CreateClient();

    /// <summary>
    /// Seed the database the moment the host exists, before anything can touch it.
    /// </summary>
    /// <remarks>
    /// This used to live in <c>CreateSeededClient</c>, and that was a latent ordering bug the
    /// session work surfaced: <c>EnsureCreated</c> on the InMemory provider applies <c>HasData</c>
    /// <i>only when it creates the database</i>, and the database is created by the first access to
    /// it. A test that reached into <c>Services</c> first — writing a conversation before asking for
    /// a client, as the lineage tests do — got an unseeded database and a later `EnsureCreated` that
    /// silently did nothing. Nothing noticed while no request needed a profile to exist; sign-in
    /// needs one, so every such test failed at once. Seeding here removes the ordering entirely.
    /// </remarks>
    protected override IHost CreateHost(IHostBuilder builder)
    {
        var host = base.CreateHost(builder);
        using var scope = host.Services.CreateScope();
        scope.ServiceProvider.GetRequiredService<HomeHubDbContext>().Database.EnsureCreated();
        return host;
    }

    /// <summary>Sign an existing client in, replacing whatever session it held.</summary>
    /// <remarks>
    /// Throws rather than returning a status: every caller here is arranging a precondition, and a
    /// sign-in that quietly failed would surface later as a confusing 401 in the assertion instead
    /// of here, where the cause is.
    /// </remarks>
    public static void SignIn(HttpClient client, int profileId, string? pin = null)
    {
        var res = client.PostAsJsonAsync("/api/session", new { profileId, pin, remember = true })
            .GetAwaiter().GetResult();
        if (!res.IsSuccessStatusCode)
            throw new InvalidOperationException($"Test sign-in as profile {profileId} failed: {res.StatusCode}.");
    }

    /// <summary>
    /// Put a fresh probe reading on a sensor zone.
    /// </summary>
    /// <remarks>
    /// The sensor poller is one of the hosted services these tests strip, so a seeded database has
    /// zones and no readings — and a Climate row with no reading is correctly a probe-lost row. Any
    /// test about what the loop does with a room it can *see* has to say so first.
    /// </remarks>
    public void AddProbeReading(int sensorZoneId, double tempF, double humidity = 45)
    {
        using var scope = Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
        db.SensorReadings.Add(new Api.Sensors.SensorReading
        {
            ZoneId = sensorZoneId,
            TimestampUtc = DateTime.UtcNow,
            TempF = tempF,
            Humidity = humidity,
        });
        db.SaveChanges();
    }

    /// <summary>
    /// Run one pass of the Meals lead-time watcher at a fixed local time.
    /// </summary>
    /// <remarks>
    /// Built here rather than resolved from the container so the clock can be pinned: the whole
    /// behaviour under test is "only inside the evening window", and waiting until 21:00 to find out
    /// is not a test. Same shape as the litter recovery loop's deterministic tick.
    /// </remarks>
    public Task RunLeadTimePassAsync(DateTimeOffset now) =>
        new MealLeadTimeService(
            Services.GetRequiredService<IServiceScopeFactory>(),
            new PinnedClock(now),
            NullLogger<MealLeadTimeService>.Instance)
        .EvaluateOnceAsync(CancellationToken.None);

    /// <summary>
    /// A fixed clock. `GetLocalNow` is not virtual on <see cref="TimeProvider"/> — it is derived from
    /// `GetUtcNow` and `LocalTimeZone` — so the zone is pinned to UTC and the supplied instant is
    /// then both the local and the universal time. That is what lets a test say "21:05" and mean it
    /// on any machine.
    /// </summary>
    private sealed class PinnedClock(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
        public override TimeZoneInfo LocalTimeZone => TimeZoneInfo.Utc;
    }
}
