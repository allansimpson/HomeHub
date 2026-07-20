namespace HomeHub.Api.Data;

using Microsoft.EntityFrameworkCore;

/// <summary>
/// The application's own database context. Stage 0 keeps this intentionally empty —
/// entities (profiles, sensor zones/readings, alerts, caches, settings) are added by
/// their owning stage. This context owns and migrates the <c>HomeHub</c> database only;
/// it must never touch anything else on the shared SQL Server instance.
/// </summary>
public class HomeHubDbContext : DbContext
{
    public HomeHubDbContext(DbContextOptions<HomeHubDbContext> options) : base(options)
    {
    }

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);
        // Entity configurations are registered here per stage.
    }
}
