namespace HomeHub.Api.Calendar;

using HomeHub.Api.Net;

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

    /// <summary>Where the household is sent to consent.</summary>
    public string AuthorizeUrl { get; set; } = "https://accounts.google.com/o/oauth2/v2/auth";

    public string Scope { get; set; } = "https://www.googleapis.com/auth/calendar";

    /// <summary>
    /// Where Google returns to after consent. Left null it is derived from the request, which is
    /// what you want on the panel: the kiosk browser and the API share a host, so the callback comes
    /// back to whatever address the panel was already using.
    /// </summary>
    /// <remarks>
    /// Whatever this resolves to must be registered verbatim in the Google Cloud console — Google
    /// compares the string, not the destination. Set it explicitly if the panel sits behind a proxy
    /// or a hostname the request cannot see.
    /// </remarks>
    public string? RedirectUri { get; set; }

    /// <summary>
    /// Hosts permitted to receive this household's calendar data and Google credentials.
    /// </summary>
    /// <remarks>
    /// <b>Every one of the four URLs above was an arbitrary string.</b> The client secret and each
    /// member's refresh token are posted to <see cref="TokenUrl"/>, bearer tokens and the household's
    /// calendar travel to <see cref="ApiBaseUrl"/>, and the household's browser is sent to
    /// <see cref="AuthorizeUrl"/> to type a Google password — so a mistyped or edited host takes
    /// credentials, private content and a consent screen with it. Enabling the provider on client
    /// ID/secret presence alone said nothing about where any of that goes.
    /// <para>
    /// Empty means Google's own hosts, which is what a household deploying this wants. A value here is
    /// how a deployment states that it is pointing somewhere else — a proxy, a test double — as an
    /// explicit act on a protected configuration value rather than a side effect of editing a URL.
    /// </para>
    /// </remarks>
    public List<string> AllowedHosts { get; set; } = [];

    /// <summary>Google's own endpoints, and the default this refuses to leave without being told.</summary>
    private static readonly string[] GoogleHosts =
        ["oauth2.googleapis.com", "www.googleapis.com", "accounts.google.com"];

    /// <summary>The rule for every Google destination, shared by startup and the request sinks.</summary>
    public EgressRule Rule => new(
        "Google", EgressReach.Internet, AllowedHosts.Count > 0 ? AllowedHosts : GoogleHosts);

    /// <summary>Every configured destination, so one check can cover all of them.</summary>
    public IEnumerable<(string Setting, string Url)> Destinations =>
    [
        ("Google:TokenUrl", TokenUrl),
        ("Google:ApiBaseUrl", ApiBaseUrl),
        ("Google:AuthorizeUrl", AuthorizeUrl),
    ];

    /// <summary>The reason this configuration may not be used, or null when it may.</summary>
    public string? RefuseDestinations() => Destinations
        .Select(d => EgressGuard.Refuse(d.Url, Rule with { Setting = d.Setting }))
        .FirstOrDefault(r => r is not null);

    /// <summary>
    /// The OAuth app is configured — the provider activates and reads per-profile links.
    /// </summary>
    /// <remarks>
    /// A client ID and secret used to be the whole condition, which activated the provider for any
    /// destination at all. A destination that fails the rule now reads as an unconfigured provider, so
    /// the panel falls back to its local calendar rather than posting a refresh token somewhere
    /// nobody authorised. That is the fail-closed half of the startup check.
    /// </remarks>
    /// <summary>
    /// An OAuth app exists. <b>Says nothing about where its credentials would be sent</b> — that is
    /// {@link IsConfigured}. Kept apart so the startup validator can tell "not set up" from "set up
    /// and pointing somewhere it may not", and stay quiet about the first.
    /// </summary>
    public bool IsAppRegistered =>
        !string.IsNullOrWhiteSpace(ClientId) && !string.IsNullOrWhiteSpace(ClientSecret);

    public bool IsConfigured => IsAppRegistered && RefuseDestinations() is null;
}
