namespace HomeHub.Api.Calendar;

using HomeHub.Api.Data;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// One-time sample-event seed so the calendar + dashboard NEXT section show data out of the
/// box (only for the local provider, and only when the table is empty). Times are anchored to
/// "now" so events are always upcoming. Skipped entirely once Google is configured.
/// </summary>
public sealed class CalendarSeeder : IHostedService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<CalendarSeeder> _logger;

    public CalendarSeeder(IServiceScopeFactory scopeFactory, ILogger<CalendarSeeder> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var scope = _scopeFactory.CreateScope();
            var provider = scope.ServiceProvider.GetRequiredService<ICalendarProvider>();
            if (provider.Source != "local") return; // Google is the source of truth when configured.

            var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
            if (await db.CalendarEvents.AnyAsync(cancellationToken)) return;

            var today = DateTime.Now.Date;
            CalendarEvent Ev(int dayOffset, int hour, int minute, int durationMin, string title, string? loc, string owners) =>
                new()
                {
                    Source = "local",
                    Title = title,
                    StartUtc = today.AddDays(dayOffset).AddHours(hour).AddMinutes(minute).ToUniversalTime(),
                    EndUtc = today.AddDays(dayOffset).AddHours(hour).AddMinutes(minute + durationMin).ToUniversalTime(),
                    Location = loc,
                    OwnerTags = owners,
                    UpdatedUtc = DateTime.UtcNow,
                };

            db.CalendarEvents.AddRange(
                Ev(0, 17, 30, 45, "Theo — Swim Lesson", "Riverside Pool", "3"),
                Ev(0, 19, 0, 120, "Dinner with the Marlowes", "Verdi's, 12 Grand Avenue", "1,2"),
                Ev(1, 9, 0, 30, "Grocery Delivery", null, ""),
                Ev(2, 18, 30, 60, "Astrid — Book Club", "The Hearth", "1"),
                Ev(4, 12, 0, 90, "Family Lunch", "Grandma June's", "1,2,3"));

            await db.SaveChangesAsync(cancellationToken);
            _logger.LogInformation("Seeded sample calendar events.");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Calendar seeding failed (non-fatal).");
        }
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
