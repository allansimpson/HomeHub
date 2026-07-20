namespace HomeHub.Api.Calendar;

/// <summary>
/// Google Calendar OAuth config, bound from the <c>Google</c> section. Secrets are never
/// committed: user-secrets in dev, env vars in prod (e.g. <c>Google__RefreshToken</c>). The
/// household grants consent once; the stored refresh token yields access tokens silently.
/// When <see cref="IsConfigured"/> is false the app uses the local SQL calendar instead.
/// </summary>
public sealed class GoogleCalendarOptions
{
    public const string Section = "Google";

    public string? ClientId { get; set; }
    public string? ClientSecret { get; set; }
    public string? RefreshToken { get; set; }

    /// <summary>Calendar id to read/write; "primary" is the household account's main calendar.</summary>
    public string CalendarId { get; set; } = "primary";

    public string TokenUrl { get; set; } = "https://oauth2.googleapis.com/token";
    public string ApiBaseUrl { get; set; } = "https://www.googleapis.com/calendar/v3";

    public bool IsConfigured =>
        !string.IsNullOrWhiteSpace(ClientId)
        && !string.IsNullOrWhiteSpace(ClientSecret)
        && !string.IsNullOrWhiteSpace(RefreshToken);
}
