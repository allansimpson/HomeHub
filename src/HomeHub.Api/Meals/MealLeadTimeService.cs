namespace HomeHub.Api.Meals;

using HomeHub.Api.Data;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// The evening-before lead-time notice (MEALS_BEHAVIOURS §4, MEALS_SCREEN §10).
/// <para>
/// The one thing in this section that has to happen while nobody is looking at the panel. Everything
/// else the household sees because it opened a screen; a marinade that needs starting tonight is
/// only useful if the panel says so <b>tonight</b>. Without this, `BEFORE YOU START` tells you at
/// five o'clock the following day, which is exactly too late to be worth having.
/// </para>
/// </summary>
public sealed class MealLeadTimeService : BackgroundService
{
    /// <summary>
    /// Cook times past this are worth a heads-up on their own, with or without a written note —
    /// a three-hour ragù does not need a prep note to be a thing you should have started earlier.
    /// </summary>
    private const int LongCookMinutes = 120;

    private readonly IServiceScopeFactory _scopeFactory;
    private readonly TimeProvider _time;
    private readonly ILogger<MealLeadTimeService> _logger;

    public MealLeadTimeService(
        IServiceScopeFactory scopeFactory, TimeProvider time, ILogger<MealLeadTimeService> logger)
    {
        _scopeFactory = scopeFactory;
        _time = time;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("Meals lead-time watcher started; evening window {From}:00–{To}:00.", FromHour, ToHour);
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(15), _time);
        do
        {
            try
            {
                await EvaluateOnceAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                // A failed pass must not take the watcher down — the next tick is fifteen minutes away
                // and the evening window is two hours wide, so one bad read costs nothing.
                _logger.LogWarning(ex, "Meals lead-time pass failed; will retry on the next tick.");
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    /// <summary>
    /// The evening window. Two hours wide rather than an instant so a panel that was asleep, or a
    /// service that restarted at 21:05, still gets its pass in — the dedupe key stops the extra
    /// ticks turning into extra notices.
    /// </summary>
    private const int FromHour = 21;
    private const int ToHour = 23;

    /// <summary>One pass. Internal so tests drive a deterministic tick rather than waiting on a timer.</summary>
    internal async Task EvaluateOnceAsync(CancellationToken ct)
    {
        var now = _time.GetLocalNow();
        if (now.Hour < FromHour || now.Hour >= ToHour) return;

        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetService<HomeHubDbContext>();
        var notifier = scope.ServiceProvider.GetService<MealNotifier>();
        if (db is null || notifier is null) return;

        var tomorrow = DateOnly.FromDateTime(now.DateTime).AddDays(1);

        // Every dish on tomorrow's dinner, not just the main: on a meal, the side is as likely to be
        // the thing needing an overnight step as the main is.
        var recipes = await db.MealPlanEntries
            .Where(e => e.Date == tomorrow && e.Slot == MealSlot.Dinner && e.Recipe != null)
            .OrderBy(e => e.Position)
            .Select(e => e.Recipe!)
            .ToListAsync(ct);

        foreach (var recipe in recipes)
        {
            // Exactly the condition the spec names: a written note, or a cook long enough to matter.
            var worthSaying = !string.IsNullOrWhiteSpace(recipe.PrepNote)
                || recipe.LeadMinutes is > 0
                || recipe.TotalMinutes > LongCookMinutes;
            if (!worthSaying) continue;

            await notifier.LeadTimeAsync(tomorrow, recipe, ct);
        }
    }
}
