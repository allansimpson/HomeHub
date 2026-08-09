namespace HomeHub.Api.Controllers;

using HomeHub.Api.Baby;
using Microsoft.AspNetCore.Mvc;

/// <summary>
/// Baby tracking (Huckleberry) reads for the panel. With Home Assistant configured these come from
/// the Huckleberry HACS integration; otherwise the section reports "Not connected" rather than
/// faking data. No HA or Firebase specifics leak here — only <see cref="IHuckleberryProvider"/>,
/// and the SPA never calls Home Assistant itself.
/// </summary>
/// <remarks>
/// Writes do not queue and are irreversible upstream — a failure returns <c>502</c> rather than
/// being retried, and nothing written here can be deleted by HomeHub. Weight crosses this boundary
/// as pounds + ounces (how the household reads it) and is converted to the decimal pounds the
/// integration expects.
/// </remarks>
[ApiController]
[Route("api/baby")]
public class BabyController : ControllerBase
{
    /// <summary>Widest history window a single request may ask for, so a bad caller can't sweep years out of HA.</summary>
    private static readonly TimeSpan MaxHistoryWindow = TimeSpan.FromDays(31);

    private readonly IHuckleberryProvider _huckleberry;
    private readonly Notifications.NotificationService? _notifications;

    public BabyController(IHuckleberryProvider huckleberry, IServiceProvider services)
    {
        _huckleberry = huckleberry;
        // Optional: the app boots without a database, and a missing notification store must not stop
        // anyone logging a feed.
        _notifications = services.GetService<Notifications.NotificationService>();
    }

    /// <summary>
    /// Tell the household what was just recorded.
    /// </summary>
    /// <remarks>
    /// Baby notifications are <b>records, not prompts</b>: they tell the other parent what happened,
    /// and never ask for anything. That is not a stylistic choice — the panel cannot amend or delete
    /// a Huckleberry entry, so a notification offering to do something about one would be a lie. The
    /// meta line says so out loud.
    /// </remarks>
    private async Task NotifyAsync(string childName, string headline, CancellationToken ct)
    {
        if (_notifications is null) return;
        var now = DateTime.UtcNow;
        await _notifications.RecordAsync(
            Notifications.NotificationSources.Baby,
            "Baby",
            Notifications.NotificationSeverities.WorthKnowing,
            "brass",
            headline,
            $"baby:{childName}:{headline}:{now:O}",
            now,
            meta: "Cannot be amended",
            // `/care`, since the consolidation: Baby and the Litter-Robot share one section with a
            // subject switcher, and `?subject=` is how a deep link names which one it means.
            route: "/care?subject=conrad",
            ct: ct);
    }

    /// <summary>Whether Huckleberry is connected, and how it's failing when it isn't.</summary>
    [HttpGet("health")]
    public async Task<BabyHealthDto> Health(CancellationToken ct)
    {
        var health = await _huckleberry.GetHealthAsync(ct);
        return new BabyHealthDto(health.Status.ToString(), health.Detail, health.LastGoodUtc, _huckleberry.IsConfigured);
    }

    /// <summary>The children the integration exposes. Empty when not connected.</summary>
    [HttpGet("children")]
    public async Task<IReadOnlyList<BabyChildDto>> Children(CancellationToken ct)
    {
        var children = await _huckleberry.GetChildrenAsync(ct);
        return children.Select(c => new BabyChildDto(c.Key, c.Name, c.Birthday)).ToList();
    }

    /// <summary>Current state for one child: sleep/nursing timers, last feed, last diaper, latest growth.</summary>
    [HttpGet("{childKey}/state")]
    public async Task<ActionResult<BabyStateDto>> State(string childKey, CancellationToken ct)
    {
        var state = await _huckleberry.GetStateAsync(childKey, ct);
        return state is null ? NotFound() : BabyStateDto.From(state);
    }

    /// <summary>History for a child over a window (defaults to the last 24 hours).</summary>
    [HttpGet("{childKey}/history")]
    public async Task<ActionResult<IReadOnlyList<BabyHistoryEventDto>>> History(
        string childKey, [FromQuery] DateTimeOffset? from, [FromQuery] DateTimeOffset? to, CancellationToken ct)
    {
        var end = to ?? DateTimeOffset.UtcNow;
        var start = from ?? end.AddDays(-1);
        if (start >= end) return BadRequest("'from' must be before 'to'.");
        if (end - start > MaxHistoryWindow) return BadRequest($"History window may not exceed {MaxHistoryWindow.Days} days.");

        var events = await _huckleberry.GetHistoryAsync(childKey, start, end, ct);
        return events.Select(BabyHistoryEventDto.From).ToList();
    }

    /// <summary>
    /// Drives a sleep or nursing timer. <c>action</c> is start | pause | resume | cancel | complete |
    /// switchside; <c>side</c> (left|right) applies to nursing start/resume only.
    /// </summary>
    /// <remarks>
    /// <c>cancel</c> discards the session; <c>complete</c> saves it to history. They are not
    /// interchangeable, and the HA switch entity performs a <c>complete</c> — which is why this goes
    /// through the services.
    /// </remarks>
    [HttpPost("{childKey}/timer/{timer}/{action}")]
    public async Task<IActionResult> Timer(
        string childKey, string timer, string action, [FromQuery] string? side, CancellationToken ct)
    {
        if (!Enum.TryParse<BabyTimerKind>(timer, ignoreCase: true, out var kind))
            return BadRequest($"Unknown timer '{timer}'. Use sleep or nursing.");
        if (!Enum.TryParse<BabyTimerAction>(action, ignoreCase: true, out var timerAction))
            return BadRequest($"Unknown action '{action}'. Use start, pause, resume, cancel, complete or switchside.");

        NursingSide? parsedSide = null;
        if (!string.IsNullOrWhiteSpace(side))
        {
            if (!Enum.TryParse<NursingSide>(side, ignoreCase: true, out var s))
                return BadRequest($"Unknown side '{side}'. Use left or right.");
            parsedSide = s;
        }

        return Result(await _huckleberry.TimerActionAsync(childKey, kind, timerAction, parsedSide, ct));
    }

    /// <summary>Logs a diaper change now. Retroactive logging isn't supported upstream.</summary>
    [HttpPost("{childKey}/diaper")]
    public async Task<IActionResult> Diaper(string childKey, [FromBody] DiaperInput input, CancellationToken ct)
    {
        if (input is null) return BadRequest("No diaper details provided.");
        if (!Enum.TryParse<DiaperKind>(input.Kind, ignoreCase: true, out var kind))
            return BadRequest($"Unknown diaper kind '{input.Kind}'. Use pee, poo, both or dry.");

        if (!TryParseOptional<DiaperAmount>(input.PeeAmount, out var pee)) return BadRequest("Invalid peeAmount.");
        if (!TryParseOptional<DiaperAmount>(input.PooAmount, out var poo)) return BadRequest("Invalid pooAmount.");
        if (!TryParseOptional<PooColor>(input.Color, out var color)) return BadRequest("Invalid color.");
        if (!TryParseOptional<PooConsistency>(input.Consistency, out var consistency)) return BadRequest("Invalid consistency.");

        var entry = new DiaperEntry(kind, pee, poo, color, consistency, input.DiaperRash, input.Notes);
        var result = await _huckleberry.LogDiaperAsync(childKey, entry, ct);
        if (result.Success) await NotifyAsync(childKey, $"Diaper recorded, {kind.ToString().ToLowerInvariant()}", ct);
        return Result(result);
    }

    /// <summary>Logs a bottle feed now.</summary>
    [HttpPost("{childKey}/bottle")]
    public async Task<IActionResult> Bottle(string childKey, [FromBody] BottleInput input, CancellationToken ct)
    {
        if (input is null) return BadRequest("No bottle details provided.");
        if (input.Amount <= 0) return BadRequest("Amount must be greater than zero.");
        if (!Enum.TryParse<BottleType>(input.Type?.Replace("_", ""), ignoreCase: true, out var type))
            return BadRequest($"Unknown bottle type '{input.Type}'.");
        if (!Enum.TryParse<BottleUnits>(input.Units ?? "oz", ignoreCase: true, out var units))
            return BadRequest($"Unknown units '{input.Units}'. Use ml or oz.");

        var result = await _huckleberry.LogBottleAsync(childKey, new BottleEntry(input.Amount, type, units), ct);
        if (result.Success) await NotifyAsync(childKey, $"Bottle recorded, {input.Amount:0.##} {units.ToString().ToLowerInvariant()}", ct);
        return Result(result);
    }

    /// <summary>
    /// Logs growth measurements. Weight is taken as <b>pounds + ounces</b> and converted to the
    /// decimal pounds the integration expects.
    /// </summary>
    /// <remarks>
    /// Irreversible and chart-affecting: there is no delete service upstream. The UI should confirm
    /// before calling this.
    /// </remarks>
    [HttpPost("{childKey}/growth")]
    public async Task<IActionResult> Growth(string childKey, [FromBody] GrowthInput input, CancellationToken ct)
    {
        if (input is null) return BadRequest("No measurements provided.");
        if (input.Pounds is < 0 || input.Ounces is < 0 or >= 16)
            return BadRequest("Ounces must be 0–15.99 and pounds non-negative.");

        double? weight = input.Pounds is null && input.Ounces is null
            ? null
            : (input.Pounds ?? 0) + ((input.Ounces ?? 0) / 16d);

        var entry = new GrowthEntry(weight, input.HeightInches, input.HeadInches, MeasurementUnits.Imperial);
        if (!entry.HasAnyMeasurement)
            return BadRequest("Provide at least one of weight, height or head circumference.");

        return Result(await _huckleberry.LogGrowthAsync(childKey, entry, ct));
    }

    /// <summary>502 on failure — writes are never queued, so the panel sees the truth immediately.</summary>
    private IActionResult Result(BabyWriteResult result) => result.Success
        ? NoContent()
        : StatusCode(StatusCodes.Status502BadGateway, result.Error);

    private static bool TryParseOptional<T>(string? value, out T? parsed) where T : struct, Enum
    {
        parsed = null;
        if (string.IsNullOrWhiteSpace(value)) return true;
        if (!Enum.TryParse<T>(value, ignoreCase: true, out var v)) return false;
        parsed = v;
        return true;
    }
}

/// <summary>Diaper details. Only <c>kind</c> is required.</summary>
public sealed record DiaperInput(
    string Kind,
    string? PeeAmount = null,
    string? PooAmount = null,
    string? Color = null,
    string? Consistency = null,
    bool? DiaperRash = null,
    string? Notes = null);

/// <summary>Bottle feed. <c>type</c> accepts either <c>breast_milk</c> or <c>breastmilk</c>.</summary>
public sealed record BottleInput(double Amount, string? Type, string? Units = "oz");

/// <summary>
/// Growth measurements in the household's units: weight as pounds + ounces, lengths in inches.
/// </summary>
public sealed record GrowthInput(int? Pounds, double? Ounces, double? HeightInches, double? HeadInches);

public sealed record BabyHealthDto(string Status, string? Detail, DateTimeOffset? LastGoodUtc, bool Configured);

/// <summary>
/// A child for the panel. Huckleberry's internal <c>uid</c> is deliberately not exposed — the SPA
/// addresses children by slug, and the uid is an upstream account identifier.
/// </summary>
public sealed record BabyChildDto(string Key, string Name, DateOnly? Birthday);

public sealed record BabyStateDto(
    string ChildKey,
    string ChildName,
    string SleepState,
    DateTimeOffset? SleepStartedUtc,
    bool SleepPaused,
    DateTimeOffset? LastSleepStartUtc,
    double? LastSleepMinutes,
    bool NursingRunning,
    bool NursingPaused,
    DateTimeOffset? NursingStartedUtc,
    string? NursingSide,
    DateTimeOffset? LastNursingUtc,
    double? LastNursingMinutes,
    double? LastNursingLeftMinutes,
    double? LastNursingRightMinutes,
    DateTimeOffset? LastBottleUtc,
    double? BottleAmount,
    string? BottleUnit,
    string? BottleType,
    DateTimeOffset? LastDiaperUtc,
    string? DiaperType,
    DateTimeOffset? GrowthMeasuredUtc,
    double? Weight,
    string? WeightUnit,
    double? Height,
    double? HeadCircumference,
    string? LengthUnit,
    int FeedsToday,
    int DiapersToday,
    DateTimeOffset FetchedUtc,
    bool Stale)
{
    public static BabyStateDto From(BabyState s) => new(
        s.ChildKey,
        s.ChildName,
        s.Sleep.State.ToString(),
        s.Sleep.StartedUtc,
        s.Sleep.Paused,
        s.Sleep.LastSessionStartUtc,
        s.Sleep.LastSessionDuration?.TotalMinutes,
        s.Nursing.Running,
        s.Nursing.Paused,
        s.Nursing.StartedUtc,
        s.Nursing.Side,
        s.Nursing.LastAtUtc,
        s.Nursing.LastDuration?.TotalMinutes,
        s.Nursing.LastLeftDuration?.TotalMinutes,
        s.Nursing.LastRightDuration?.TotalMinutes,
        s.Bottle.LastAtUtc,
        s.Bottle.Amount,
        s.Bottle.Unit,
        s.Bottle.Kind,
        s.Diaper.LastAtUtc,
        s.Diaper.Kind,
        s.Growth.MeasuredAtUtc,
        s.Growth.Weight,
        s.Growth.WeightUnit,
        s.Growth.Height,
        s.Growth.HeadCircumference,
        s.Growth.LengthUnit,
        s.Today.Feeds,
        s.Today.Diapers,
        s.FetchedUtc,
        s.Stale);
}

public sealed record BabyHistoryEventDto(
    DateTimeOffset StartUtc, DateTimeOffset? EndUtc, string Kind, string Summary, string? Detail)
{
    public static BabyHistoryEventDto From(BabyHistoryEvent e) =>
        new(e.StartUtc, e.EndUtc, e.Kind, e.Summary, e.Detail);
}
