namespace HomeHub.Api.Meals;

using HomeHub.Api.Data;
using HomeHub.Api.Notifications;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// The Meals section's notifications (MEALS_BEHAVIOURS §4).
/// <para>
/// <b>The rate rules matter more than the visuals</b>, and they are expressed here as dedupe keys
/// rather than as bookkeeping: <see cref="NotificationService.RecordAsync"/> already drops a repeat
/// of a key it has seen, so "one per recipe per day" is a key with the date in it and "one per
/// recipe" is a key without. Nothing needs to remember what it has already said.
/// </para>
/// <para>
/// <b>Nothing here notifies anyone about their own action.</b> The panel has one shared feed, so
/// that means: if the profile that made the change is the one currently active on the panel, the
/// change was made *here* and the panel telling itself about it is noise.
/// </para>
/// </summary>
public sealed class MealNotifier
{
    private readonly HomeHubDbContext _db;
    private readonly NotificationService? _notifications;
    private readonly TimeProvider _time;

    public MealNotifier(HomeHubDbContext db, TimeProvider time, NotificationService? notifications = null)
    {
        _db = db;
        _time = time;
        _notifications = notifications;
    }

    /// <summary>
    /// Someone else changed a recipe. <b>One per recipe per day</b>, collapsed — a recipe being
    /// tuned across an evening is one piece of news, not six.
    /// </summary>
    public Task RecipeChangedAsync(Recipe recipe, int? actorProfileId, CancellationToken ct) =>
        NotifyAsync(
            actorProfileId,
            who => $"{who} changed {recipe.Title}",
            key: (now) => $"meals:recipe-changed:{recipe.Id}:{now:yyyy-MM-dd}",
            route: $"/meals/recipes/{recipe.Id}",
            ct);

    /// <summary>Someone else added a recipe. Once per recipe — there is only one first time.</summary>
    public Task RecipeAddedAsync(Recipe recipe, int? actorProfileId, CancellationToken ct) =>
        NotifyAsync(
            actorProfileId,
            who => $"{who} added {recipe.Title}",
            key: _ => $"meals:recipe-added:{recipe.Id}",
            route: $"/meals/recipes/{recipe.Id}",
            ct);

    /// <summary>
    /// Someone else changed a night.
    /// </summary>
    /// <remarks>
    /// <b>Only for today or tomorrow.</b> Next Thursday's dinner changing is not worth interrupting
    /// anyone about, and a panel that announced every future edit would train the household to stop
    /// reading it. Deliberately a filter on *which* nights notify rather than a rate limit.
    /// </remarks>
    public async Task PlanChangedAsync(
        DateOnly date, MealSlot slot, string? dish, int? actorProfileId, CancellationToken ct)
    {
        var today = DateOnly.FromDateTime(_time.GetLocalNow().DateTime);
        if (date != today && date != today.AddDays(1)) return;

        var when = date == today ? "tonight" : "tomorrow";
        await NotifyAsync(
            actorProfileId,
            who => dish is null
                ? $"{who} cleared {when}'s {slot.ToString().ToLowerInvariant()}"
                : $"{who} put {dish} on {when}",
            key: (now) => $"meals:plan:{date:yyyy-MM-dd}:{slot}:{now:yyyy-MM-dd-HH}",
            route: "/meals",
            ct);
    }

    /// <summary>
    /// The evening-before lead-time notice. Fires once for a given night and recipe.
    /// </summary>
    /// <remarks>
    /// Not filtered by actor: this is the panel noticing something about tomorrow, not reporting
    /// what a person did, so there is nobody to exclude.
    /// </remarks>
    public async Task LeadTimeAsync(DateOnly date, Recipe recipe, CancellationToken ct)
    {
        if (_notifications is null) return;

        var sentence = recipe.PrepNote is { Length: > 0 } note
            ? $"For tomorrow: {note}"
            : $"For tomorrow: {recipe.Title} takes a while — worth starting early.";

        await _notifications.RecordAsync(
            NotificationSources.Meals,
            "Meals",
            // Something to actually go and do tonight, so it does not time out on screen.
            NotificationSeverities.WantsYou,
            "amber",
            sentence,
            $"meals:lead:{date:yyyy-MM-dd}:{recipe.Id}",
            _time.GetUtcNow().UtcDateTime,
            route: $"/meals/recipes/{recipe.Id}",
            ct: ct);
    }

    /// <summary>
    /// Record a "someone else did this" notice, unless the someone else is whoever is signed in at
    /// the panel.
    /// </summary>
    private async Task NotifyAsync(
        int? actorProfileId,
        Func<string, string> headline,
        Func<DateTimeOffset, string> key,
        string route,
        CancellationToken ct)
    {
        if (_notifications is null) return;
        // An unattributed write (a script, the importer) has nobody to name and nobody to exclude,
        // so it stays quiet rather than announcing that "someone" did something.
        if (actorProfileId is not { } actor) return;

        var activeProfileId = await _db.Settings.Select(s => s.ActiveProfileId).FirstOrDefaultAsync(ct);
        if (activeProfileId == actor) return;

        var who = await _db.Profiles.Where(p => p.Id == actor).Select(p => p.Name).FirstOrDefaultAsync(ct);
        if (string.IsNullOrWhiteSpace(who)) return;

        var now = _time.GetLocalNow();
        await _notifications.RecordAsync(
            NotificationSources.Meals,
            "Meals",
            // Somebody else's edit is worth knowing, not something you must act on — so it times
            // out on screen and stays in the record.
            NotificationSeverities.WorthKnowing,
            "brass",
            headline(who),
            key(now),
            _time.GetUtcNow().UtcDateTime,
            route: route,
            ct: ct);
    }
}
