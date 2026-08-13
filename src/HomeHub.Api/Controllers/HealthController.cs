namespace HomeHub.Api.Controllers;

using System.Reflection;
using HomeHub.Api.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// Liveness endpoint. Used by the kiosk boot check and by monitoring to confirm the
/// app is up before pointing Chromium at it, and by the deploy script to confirm a new
/// release actually serves.
/// </summary>
[ApiController]
[Route("api/[controller]")]
// Anonymous, and it has to be. The panel's connection banner polls this every ten seconds to
// distinguish "the server is up" from "the server is gone", and deploy.sh probes it before flipping
// the symlink — neither has a session, and requiring one would make the health check answer "the
// server is broken" for the one condition it exists to rule out. It reports version and migration
// state and nothing about the household.
[AllowAnonymous]
public class HealthController : ControllerBase
{
    private static readonly string Version =
        Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "0.0.0";

    /// <summary>
    /// Which build this actually is — the commit, and when it was compiled.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <see cref="Version"/> is the SDK's default <c>1.0.0.0</c> on every build this project has ever
    /// produced, so it answers "which release is running" with a number that has never once changed.
    /// It stays, because the deploy script and the kiosk boot check read it, but it is not identity.
    /// </para>
    /// <para>
    /// The commit arrives via <c>SourceRevisionId</c>, which the SDK appends to
    /// <c>InformationalVersion</c> after a <c>+</c> (see the csproj's <c>StampBuild</c> target). A
    /// build made where git would not answer has no commit and falls back to the timestamp, which is
    /// still enough to tell today's deploy from last week's.
    /// </para>
    /// </remarks>
    private static readonly string Build = BuildStamp();

    private static string BuildStamp()
    {
        var assembly = Assembly.GetExecutingAssembly();
        var informational = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        // Everything after the *first* "+" is the source revision — taken as a remainder rather than
        // by splitting, because the revision itself ends in "+" when the build came from a tree with
        // uncommitted changes. `Split` drops that as an empty trailing part, which silently threw
        // away the one character distinguishing a reproducible build from somebody's working copy.
        var plus = informational?.IndexOf('+', StringComparison.Ordinal) ?? -1;
        var commit = plus >= 0 && plus + 1 < informational!.Length ? informational[(plus + 1)..] : null;

        var built = assembly
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .FirstOrDefault(a => a.Key == "BuildTimestampUtc")?.Value;

        return (commit, built) switch
        {
            (not null, not null) => $"{commit} · {built}",
            (not null, null) => commit,
            (null, not null) => built,
            // A build with neither is one made outside the normal target — worth saying plainly
            // rather than reporting an empty string that reads as a field nobody filled in.
            _ => "unstamped",
        };
    }

    /// <summary>The newest migration compiled into this binary, or null if it has none.</summary>
    /// <remarks>
    /// Read from the assembly's own migration attributes rather than from the database, so it
    /// answers even when the database is unreachable — which is one of the moments somebody most
    /// wants to know which build they are looking at.
    /// </remarks>
    private static readonly string? MigrationHead = Assembly.GetExecutingAssembly()
        .GetTypes()
        .Select(t => t.GetCustomAttribute<Microsoft.EntityFrameworkCore.Migrations.MigrationAttribute>()?.Id)
        .Where(id => id is not null)
        .OrderByDescending(id => id, StringComparer.Ordinal)
        .FirstOrDefault();

    private readonly IServiceProvider _services;
    private readonly IWebHostEnvironment _environment;

    public HealthController(IServiceProvider services, IWebHostEnvironment environment)
    {
        _services = services;
        _environment = environment;
    }

    /// <summary>
    /// The hashed name of the SPA bundle in <c>wwwroot</c>, or a word saying why there is none.
    /// </summary>
    /// <remarks>
    /// Read from the directory rather than parsed out of <c>index.html</c>: the filename is the part
    /// that carries the content hash, and a directory listing cannot be fooled by a cached or
    /// half-written index. In Development the SPA is served by Vite and <c>wwwroot</c> is empty,
    /// which is not a fault and says so.
    /// </remarks>
    private string SpaBundle()
    {
        try
        {
            var assets = Path.Combine(_environment.WebRootPath ?? "", "assets");
            if (!Directory.Exists(assets)) return "none";
            var bundle = Directory.EnumerateFiles(assets, "index-*.js").Select(Path.GetFileName).FirstOrDefault();
            return bundle ?? "none";
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return "unreadable";
        }
    }

    /// <param name="deep">
    /// Also report pending migrations. Costs a round trip to the database, so it is opt-in: the
    /// kiosk polls this endpoint and does not need it. The deploy script asks for it once.
    /// </param>
    [HttpGet]
    public async Task<IActionResult> Get([FromQuery] bool deep = false, CancellationToken ct = default)
    {
        // Resolved, not constructor-injected. The DbContext is registered only when a connection
        // string is present (Program.cs gates every DB-dependent registration), so a constructor
        // dependency would make the one endpoint whose job is to answer when things are broken
        // fail to resolve on exactly the hosts where it matters most.
        var db = _services.GetService<HomeHubDbContext>();

        var database = "not-configured";
        int? pendingMigrations = null;

        if (db is not null)
        {
            try
            {
                if (await db.Database.CanConnectAsync(ct))
                {
                    database = "ok";

                    // Migrations are applied at startup and their failure is deliberately non-fatal
                    // — the shell must still serve. That means a swallowed migration error is
                    // otherwise invisible, and a pending count is the only thing separating
                    // "migrated" from "quietly didn't".
                    if (deep)
                        pendingMigrations = (await db.Database.GetPendingMigrationsAsync(ct)).Count();
                }
                else
                {
                    database = "unreachable";
                }
            }
            catch (Exception)
            {
                // Broad on purpose. This is a probe: a bad connection string, a DNS failure and a
                // login rejection are all "the database is not usable", and the caller needs that
                // answer rather than a 500 from the health check itself.
                database = "unreachable";
            }
        }

        // `status` stays pure liveness. The kiosk uses it to decide when to point Chromium at the
        // app, and the app is designed to serve its shell without a database at all — so a database
        // problem is reported *alongside* the status, never by failing the check.
        return Ok(new
        {
            status = "ok",
            service = "HomeHub.Api",
            version = Version,
            /// The commit and compile time of *this* binary. See <see cref="Build"/>.
            build = Build,
            database,
            pendingMigrations,
            /*
             * The last migration this binary knows about.
             *
             * Free — read off the assembly, no database — and it is the field that separates "the
             * API is older than its schema" from "the schema is behind the API", which
             * `pendingMigrations` alone cannot: a count of zero is what both a fully-migrated new
             * release and an old release that has never heard of those migrations report.
             *
             * That ambiguity is not hypothetical. It is how a TEST box spent a day serving the new
             * panel in front of the old server with every health check saying "ok".
             */
            migrationHead = MigrationHead,
            /*
             * The SPA this API is serving, as its content-hashed bundle name.
             *
             * <b>Because the two halves can be deployed apart.</b> The client build writes itself
             * into `wwwroot`; the API is a separate binary; and a rollback that restores one and not
             * the other leaves a panel whose code asks for endpoints the server does not have. From
             * the outside that looks exactly like a working release — the shell loads, the chat
             * answers — until some feature quietly does nothing.
             *
             * Vite hashes the filename from the bundle's contents, so this string changes whenever
             * the client changes and is stable when it does not. Comparing it against the artifact
             * the release was built from is the check that catches a half-applied deploy.
             */
            spaBundle = SpaBundle(),
        });
    }
}
