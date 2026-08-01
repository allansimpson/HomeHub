namespace HomeHub.Api.Tasks;

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

    public bool IsConfigured =>
        !string.IsNullOrWhiteSpace(ClientId) && !string.IsNullOrWhiteSpace(ClientSecret);
}
