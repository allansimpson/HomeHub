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

    private readonly IServiceProvider _services;

    public HealthController(IServiceProvider services) => _services = services;

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
            database,
            pendingMigrations,
        });
    }
}
