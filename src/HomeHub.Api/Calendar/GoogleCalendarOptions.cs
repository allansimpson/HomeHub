namespace HomeHub.Api.Calendar;

/// <summary>
/// Google Calendar OAuth config, bound from the <c>Google</c> section. Only the OAuth *app*
/// (client id/secret) lives here; each profile's own refresh token lives in
/// <see cref="GoogleAccountLink"/>, mirroring Microsoft To Do — there is no shared fallback token,
/// so calendars are strictly per profile. Secrets are never committed: user-secrets in dev, env
/// vars in prod. When <see cref="IsConfigured"/> is false the app uses the local SQL calendar.
/// </summary>
public sealed class GoogleCalendarOptions
{
    public const string Section = "Google";

    public string? ClientId { get; set; }
    public string? ClientSecret { get; set; }

    public string TokenUrl { get; set; } = "https://oauth2.googleapis.com/token";
    public string ApiBaseUrl { get; set; } = "https://www.googleapis.com/calendar/v3";

    /// <summary>The OAuth app is configured — the provider activates and reads per-profile links.</summary>
    public bool IsConfigured =>
        !string.IsNullOrWhiteSpace(ClientId) && !string.IsNullOrWhiteSpace(ClientSecret);
}
