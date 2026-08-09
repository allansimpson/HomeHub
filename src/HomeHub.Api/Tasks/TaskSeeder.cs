namespace HomeHub.Api.Tasks;

using HomeHub.Api.Data;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// One-time sample-task seed so the To-Do screen + dashboard TASKS section show data out of the
/// box (local provider only, and only when empty). Skipped once Microsoft Graph is configured.
/// </summary>
public sealed class TaskSeeder : IHostedService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<TaskSeeder> _logger;

    public TaskSeeder(IServiceScopeFactory scopeFactory, ILogger<TaskSeeder> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var scope = _scopeFactory.CreateScope();
            var provider = scope.ServiceProvider.GetRequiredService<ITaskProvider>();
            if (provider.Source != "local") return;

            var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
            if (await db.Tasks.AnyAsync(cancellationToken)) return;
            var profiles = await db.Profiles.Select(p => p.Id).OrderBy(id => id).ToListAsync(cancellationToken);
            if (profiles.Count == 0) return;

            var now = DateTime.UtcNow;
            int p(int i) => profiles[Math.Min(i, profiles.Count - 1)];
            TaskItem T(int profileId, string title, DateTime? due, bool done) => new()
            {
                ProfileId = profileId,
                Source = "local",
                Title = title,
                DueUtc = due,
                Completed = done,
                CompletedAtUtc = done ? now : null,
                CreatedUtc = now,
                UpdatedUtc = now,
            };

            db.Tasks.AddRange(
                T(p(0), "Call plumber — upstairs bath", null, false),
                T(p(0), "RSVP to the garden party", now.AddDays(2), false),
                T(p(1), "Collect the dry cleaning", now.AddHours(6), false),
                T(p(1), "Book the dentist appointment", now.AddDays(4), false),
                T(p(2), "Feed the goldfish", null, true),
                T(p(2), "Pack the swim bag", null, true));

            await db.SaveChangesAsync(cancellationToken);
            _logger.LogInformation("Seeded sample tasks.");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Task seeding failed (non-fatal).");
        }
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
