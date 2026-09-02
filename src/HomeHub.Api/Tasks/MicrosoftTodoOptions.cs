namespace HomeHub.Api.Tasks;

using HomeHub.Api.Net;

/// <summary>
/// Microsoft Graph (To Do) OAuth config, bound from the <c>Microsoft</c> section. Per-profile
/// refresh tokens live in <see cref="MicrosoftAccountLink"/>, not here. Secrets never committed:
/// user-secrets in dev, env vars in prod. When <see cref="IsConfigured"/> is false the app uses
/// the local SQL tasks provider instead.
/// </summary>
public sealed class MicrosoftTodoOptions
{
    public const string Section = "Microsoft";

    public string? ClientId { get; set; }
    public string? ClientSecret { get; set; }

    /// <summary>Token endpoint; "common" allows personal + work/school accounts.</summary>
    public string TokenUrl { get; set; } = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
    public string GraphBaseUrl { get; set; } = "https://graph.microsoft.com/v1.0";

    /// <summary>Where the household is sent to consent.</summary>
    public string AuthorizeUrl { get; set; } = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";

    /// <summary>
    /// Scopes asked for at consent. Deliberately not <c>.default</c>, which is only meaningful for
    /// pre-consented app permissions and yields no refresh token in this flow.
    /// </summary>
    public string AuthorizeScope { get; set; } =
        "https://graph.microsoft.com/Tasks.ReadWrite offline_access User.Read";

    /// <summary>Derived from the request when null — see the Google twin for why.</summary>
    public string? RedirectUri { get; set; }
    public string Scope { get; set; } = "https://graph.microsoft.com/.default offline_access";

    /// <summary>
    /// Hosts permitted to receive this household's task data and Microsoft credentials.
    /// </summary>
    /// <remarks>
    /// The Google twin's note applies unchanged, and the blast radius here is wider: the grocery
    /// mirror shares these endpoints, so the same unvalidated host receives the shopping list as well
    /// as the tasks. Empty means Microsoft's own hosts.
    /// </remarks>
    public List<string> AllowedHosts { get; set; } = [];

    private static readonly string[] MicrosoftHosts =
        ["login.microsoftonline.com", "graph.microsoft.com"];

    /// <summary>The rule for every Microsoft destination, shared by startup and the request sinks.</summary>
    public EgressRule Rule => new(
        "Microsoft", EgressReach.Internet, AllowedHosts.Count > 0 ? AllowedHosts : MicrosoftHosts);

    /// <summary>Every configured destination, so one check can cover all of them.</summary>
    public IEnumerable<(string Setting, string Url)> Destinations =>
    [
        ("Microsoft:TokenUrl", TokenUrl),
        ("Microsoft:GraphBaseUrl", GraphBaseUrl),
        ("Microsoft:AuthorizeUrl", AuthorizeUrl),
    ];

    /// <summary>The reason this configuration may not be used, or null when it may.</summary>
    public string? RefuseDestinations() => Destinations
        .Select(d => EgressGuard.Refuse(d.Url, Rule with { Setting = d.Setting }))
        .FirstOrDefault(r => r is not null);

    /// <summary>
    /// The OAuth app is configured. <b>And points somewhere it is allowed to point</b> — see the
    /// Google twin for why a client ID and secret are not the whole condition.
    /// </summary>
    /// <summary>
    /// An OAuth app exists. <b>Says nothing about where its credentials would be sent</b> — that is
    /// {@link IsConfigured}. Kept apart so the startup validator can tell "not set up" from "set up
    /// and pointing somewhere it may not", and stay quiet about the first.
    /// </summary>
    public bool IsAppRegistered =>
        !string.IsNullOrWhiteSpace(ClientId) && !string.IsNullOrWhiteSpace(ClientSecret);

    public bool IsConfigured => IsAppRegistered && RefuseDestinations() is null;
}
