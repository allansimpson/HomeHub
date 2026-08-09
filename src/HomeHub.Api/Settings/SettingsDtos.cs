namespace HomeHub.Api.Settings;

using System.Globalization;

/// <summary>Household settings as sent to / from the client.</summary>
public record SettingsDto(
    int IdleTimeoutMinutes,
    bool IdleDimmingEnabled,
    string DaylightBoost,
    int? ActiveProfileId,
    /// <summary>What the household calls the cat; null falls back to the literal word everywhere.</summary>
    string? CatName,
    /// <summary>Drawer fullness (%) at which the panel asks for the litter to be changed.</summary>
    int LitterFullPercent,
    /// <summary>`HH:mm` local wall time. A start later than the end is a window across midnight.</summary>
    string NightDimStart,
    string NightDimEnd,
    /// <summary>Whether Assist keeps conversations at all. Off means the chat in front of you is all there is.</summary>
    bool StoreConversations,
    /// <summary>Days a conversation is kept after its last message.</summary>
    int ConversationRetentionDays,
    /// <summary>
    /// Where the weather is for, when the household has said. Null on both means the deployment's
    /// configured location is still in force — see <see cref="HouseholdSettings.WeatherLatitude"/>.
    /// </summary>
    double? WeatherLatitude = null,
    double? WeatherLongitude = null)
{
    public static SettingsDto From(HouseholdSettings s) => new(
        s.IdleTimeoutMinutes, s.IdleDimmingEnabled, s.DaylightBoost, s.ActiveProfileId, s.CatName,
        s.LitterFullPercent, Clock.Wire(s.NightDimStart), Clock.Wire(s.NightDimEnd),
        s.StoreConversations, s.ConversationRetentionDays, s.WeatherLatitude, s.WeatherLongitude);
}

/// <summary>Update payload for the editable household settings (active profile has its own route).</summary>
public record UpdateSettingsRequest(
    int IdleTimeoutMinutes,
    bool IdleDimmingEnabled,
    string DaylightBoost,
    /// <summary>
    /// `HH:mm`, both optional and both meaning <i>leave it alone</i> when absent.
    /// </summary>
    /// <remarks>
    /// Trailing and nullable so an older client — or any screen that shows the idle controls without
    /// showing the window — cannot blank the schedule by not mentioning it. Same rule as everywhere
    /// else in this app: not stating a thing must never overwrite a thing somebody stated.
    /// </remarks>
    string? NightDimStart = null,
    string? NightDimEnd = null);

/// <summary>`HH:mm` on the wire, <see cref="TimeOnly"/> in the database.</summary>
/// <remarks>
/// Two lines each way rather than letting <see cref="TimeOnly"/> serialize itself: its default JSON
/// form is <c>22:00:00</c>, and the seconds are a precision this setting does not have and an
/// `&lt;input type="time"&gt;` will not round-trip.
/// </remarks>
internal static class Clock
{
    // Invariant because this is a wire format, not a display one. The custom format string pins the
    // layout but not the digits: on a machine whose culture uses non-ASCII digits the current-culture
    // overload emits characters `<input type="time">` cannot parse, and the setting silently stops
    // round-tripping on that machine only.
    public static string Wire(TimeOnly value) => value.ToString("HH\\:mm", CultureInfo.InvariantCulture);

    /// <summary>Parse a wire time, or null when it is absent or not a time.</summary>
    /// <remarks>
    /// Unparseable is treated as absent — "leave it alone" — rather than as a 400. The only producer
    /// is a time input that cannot emit anything else, so a rejection would be reachable only by a
    /// hand-made request, and the useful answer there is still the schedule the household already
    /// had.
    /// </remarks>
    public static TimeOnly? Read(string? value) =>
        TimeOnly.TryParseExact(value, "HH\\:mm", out var parsed) ? parsed : null;
}

/// <summary>Active-profile switch payload; null clears the active profile.</summary>
public record SetActiveProfileRequest(int? ProfileId);

/// <summary>
/// The cat's name, on its own route.
/// </summary>
/// <remarks>
/// Separate from <see cref="UpdateSettingsRequest"/> because it is edited from Litter Settings, which
/// holds no idle-timeout or daylight state to send back — folding it into the whole-object PUT would
/// make that screen capable of clobbering settings it never showed. Blank clears it.
/// </remarks>
public record SetCatNameRequest(string? Name);

/// <summary>
/// The drawer-full threshold, on its own route for the same reason as <see cref="SetCatNameRequest"/>:
/// it is edited from Litter Settings, which holds none of the whole-object PUT's other state.
/// </summary>
public record SetLitterFullPercentRequest(int Percent);

/// <summary>
/// Assist's conversation policy — the store switch and the retention window, on their own route for
/// the same reason as <see cref="SetCatNameRequest"/>: they are edited from the Config privacy view,
/// which holds none of the whole-object PUT's other state.
/// </summary>
public record SetConversationPolicyRequest(bool StoreConversations, int RetentionDays);

/// <summary>
/// Where the weather is for, on its own route for the same reason as <see cref="SetCatNameRequest"/>:
/// it is edited from the Config weather view, which holds none of the whole-object PUT's other state.
/// </summary>
/// <remarks>
/// Both null clears the household's answer and hands the question back to <c>Weather:Latitude</c> /
/// <c>Weather:Longitude</c> — which is a thing somebody might genuinely want, having set a location by
/// hand and then decided the deployment's was right after all. Setting only one is rejected: half a
/// coordinate is not a location.
/// </remarks>
public record SetWeatherLocationRequest(double? Latitude, double? Longitude);

/// <summary>What the panel needs to draw the weather-location page.</summary>
/// <param name="Latitude">In force right now — the household's if they set one, else the deployment's.</param>
/// <param name="Longitude">As above.</param>
/// <param name="FromHousehold">
/// Whether that is the household's own answer or the configured fallback. The page says which, because
/// "the panel is showing a forecast for somewhere I did not choose" is otherwise indistinguishable from
/// "I chose this and mistyped it".
/// </param>
/// <param name="Place">
/// What the forecast provider calls it, from the last refresh. Null before the first one — and the
/// point of the whole page: a set of coordinates confirms nothing, and a town name confirms everything.
/// </param>
public record WeatherLocationDto(double Latitude, double Longitude, bool FromHousehold, string? Place);
