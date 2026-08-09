namespace HomeHub.Api.Mcp;

using System.ComponentModel;
using HomeHub.Api.Ai;
using HomeHub.Api.Calendar;
using HomeHub.Api.Climate;
using HomeHub.Api.Data;
using HomeHub.Api.Sensors;
using Microsoft.EntityFrameworkCore;
using ModelContextProtocol.Server;

/// <summary>
/// The house, as tools an agent can call (ai-assistant.md, stage A4).
///
/// This is the workstream's actual deliverable. HomeHub does not assemble prompts, retrieve
/// memories or route between models — an agent does that. What HomeHub owns is the house, and this
/// is the typed surface over it.
///
/// Three rules shape what is here:
///
/// <b>Narrow beats complete.</b> Tool-calling reliability falls off fast as the surface grows, and
/// the model driving these may be small. This is a deliberately short list of things a household
/// actually asks a wall panel, not a projection of every controller.
///
/// <b>List, then act by id.</b> Write tools take ids, never names. The agent calls the matching
/// read tool first and uses what it returns. Fuzzy name matching lives in
/// <see cref="AssistantActions"/> on the reflex path, where a human is speaking and there is no
/// chance to look anything up; here there is, so guessing would be a worse answer available at a
/// higher risk.
///
/// <b>Same seams as the UI.</b> Every tool goes through the provider the screens use, so an agent
/// write and a screen write are the same write — same validation, same sync, same history.
///
/// Parameters typed as DI services are injected and never appear in the schema the agent sees;
/// only the plain parameters below become tool inputs.
/// </summary>
[McpServerToolType]
public static class HouseTools
{
    // ---- Climate ----

    [McpServerTool(Name = "get_climate_zones")]
    [Description("List the household's climate zones with the current temperature, set point, mode "
        + "and whether each is actively running. Call this before changing anything, to get zone ids.")]
    public static async Task<IReadOnlyList<object>> GetClimateZones(
        IClimateProvider climate,
        CancellationToken ct)
    {
        var units = await climate.GetUnitsAsync(ct);
        return units.Select(u => (object)new
        {
            id = u.Id,
            name = u.Name,
            currentTempF = Math.Round(u.CurrentTempF, 1),
            setPointF = Math.Round(u.SetPointF, 1),
            mode = u.Mode.ToString(),
            fanMode = u.FanMode,
            source = u.Source,
        }).ToList();
    }

    [McpServerTool(Name = "set_climate_setpoint")]
    [Description("Set one climate zone's target temperature in Fahrenheit. Use the zone id from "
        + "get_climate_zones. Returns the zone's new state.")]
    public static async Task<object> SetClimateSetPoint(
        IClimateProvider climate,
        [Description("Zone id from get_climate_zones.")] int zoneId,
        [Description("Target temperature in Fahrenheit, 50-90.")] double setPointF,
        CancellationToken ct)
    {
        // Clamped rather than trusted. A tool call is model output, and a mistyped set point on a
        // real mini-split is a cold house at 3am, not a validation error someone reads.
        if (setPointF is < 50 or > 90)
            return new { ok = false, error = $"Set point {setPointF}°F is outside the allowed range of 50–90°F." };

        var updated = await climate.SetSetPointAsync(zoneId, setPointF, ct);
        if (updated is null) return new { ok = false, error = $"No climate zone with id {zoneId}." };

        return new
        {
            ok = true,
            id = updated.Id,
            name = updated.Name,
            setPointF = Math.Round(updated.SetPointF, 1),
            currentTempF = Math.Round(updated.CurrentTempF, 1),
            mode = updated.Mode.ToString(),
        };
    }

    [McpServerTool(Name = "set_climate_mode")]
    [Description("Set one climate zone's mode. Valid modes: Off, Cool, Heat, Fan, Auto. "
        + "Use the zone id from get_climate_zones.")]
    public static async Task<object> SetClimateMode(
        IClimateProvider climate,
        [Description("Zone id from get_climate_zones.")] int zoneId,
        [Description("One of: Off, Cool, Heat, Fan, Auto.")] string mode,
        CancellationToken ct)
    {
        if (!Enum.TryParse<ClimateMode>(mode, ignoreCase: true, out var parsed))
            return new { ok = false, error = $"\"{mode}\" is not a mode. Use Off, Cool, Heat, Fan or Auto." };

        var updated = await climate.SetModeAsync(zoneId, parsed, ct);
        if (updated is null) return new { ok = false, error = $"No climate zone with id {zoneId}." };

        return new { ok = true, id = updated.Id, name = updated.Name, mode = updated.Mode.ToString() };
    }

    // ---- Sensors ----

    [McpServerTool(Name = "get_sensor_readings")]
    [Description("Current temperature and humidity for every room the panel monitors, with how "
        + "fresh each reading is.")]
    public static async Task<IReadOnlyList<object>> GetSensorReadings(
        HomeHubDbContext db,
        TimeProvider clock,
        CancellationToken ct)
    {
        // Reads come from owned SQL history, never straight from a provider — the same rule
        // SensorsController follows, so an agent and the dashboard cannot disagree about the house.
        var zones = await db.SensorZones.OrderBy(z => z.DisplayOrder).ToListAsync(ct);
        var now = clock.GetUtcNow();
        var result = new List<object>(zones.Count);

        foreach (var zone in zones)
        {
            var latest = await db.SensorReadings
                .Where(r => r.ZoneId == zone.Id)
                .OrderByDescending(r => r.TimestampUtc)
                .FirstOrDefaultAsync(ct);

            result.Add(new
            {
                id = zone.Id,
                name = zone.Name,
                category = zone.Category.ToString(),
                tempF = latest?.TempF is { } t ? Math.Round(t, 1) : (double?)null,
                humidity = latest?.Humidity is { } h ? Math.Round(h, 1) : (double?)null,
                // Age, not a raw timestamp: "is this current?" is the question being asked, and a
                // small model reasons about "4 minutes ago" far more reliably than about UTC.
                readingAgeMinutes = latest is null
                    ? (int?)null
                    : (int)Math.Max(0, (now - new DateTimeOffset(latest.TimestampUtc, TimeSpan.Zero)).TotalMinutes),
            });
        }
        return result;
    }

    // ---- Calendar ----

    [McpServerTool(Name = "get_calendar")]
    [Description("Upcoming calendar events for the household, soonest first.")]
    public static async Task<IReadOnlyList<object>> GetCalendar(
        ICalendarProvider calendar,
        TimeProvider clock,
        [Description("How many days ahead to look. Defaults to a week; 1 means today only.")] int? days,
        CancellationToken ct)
    {
        var from = clock.GetUtcNow().UtcDateTime;
        var window = Math.Clamp(days ?? 7, 1, 60);
        var events = await calendar.ListAsync(null, from, from.AddDays(window), ct);

        return events
            .OrderBy(e => e.StartUtc)
            .Select(e => (object)new
            {
                id = e.Id,
                title = e.Title,
                startUtc = e.StartUtc,
                endUtc = e.EndUtc,
                location = e.Location,
                calendar = e.CalendarName,
            })
            .ToList();
    }

    // ---- To-do ----

    [McpServerTool(Name = "add_todo")]
    [Description("Add an item to one of the household's to-do lists. The list name is matched to "
        + "the closest existing list, so a rough name like 'grocery' is fine.")]
    public static async Task<object> AddTodo(
        AssistantActions actions,
        HomeHubDbContext db,
        [Description("Which list to add to, e.g. 'grocery' or 'household'.")] string list,
        [Description("The item to add.")] string item,
        CancellationToken ct)
    {
        // Writes run as whoever is signed in at the panel. The agent has no session of its own and
        // must not invent one: a to-do belongs to a person, and if nobody is signed in the honest
        // answer is that this cannot be done rather than filing it under a guess.
        var settings = await db.Settings.AsNoTracking().FirstOrDefaultAsync(ct);
        if (settings?.ActiveProfileId is not { } profileId)
            return new { ok = false, error = "Nobody is signed in at the panel, so there is no list to add to." };

        // Straight through the reflex path's executor — same fuzzy list resolution, same wording,
        // same provider. An agent-added item is indistinguishable from a spoken one.
        var outcome = await actions.AddTaskAsync(profileId, list, item, ct);
        return new { ok = outcome.Action is not null, message = outcome.Message };
    }
}
