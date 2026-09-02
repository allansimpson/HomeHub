namespace HomeHub.Api.Ai;

/// <summary>
/// Where recorded household speech and the cloud credential are permitted to be sent.
/// </summary>
/// <remarks>
/// <para>
/// <b>`Voice:Stt:CloudAudioEgressAcknowledged` says audio may leave the LAN. It does not say who may
/// receive it.</b> `Ai:OpenAiBaseUrl` was an arbitrary string with a default and no validation, and
/// <see cref="OpenAISpeechToText"/> posts raw audio and an `Authorization: Bearer` header to it. So an
/// acknowledged deployment with a mistyped host, or one whose base URL had been edited to `http://`,
/// would send the household's speech and the credential that pays for it somewhere nobody chose, over
/// a transport nobody chose either. The acknowledgement is consent to a *provider*; this is what makes
/// it consent to a specific one.
/// </para>
/// <para>
/// <b>An exact host allowlist, defaulting to the provider the key belongs to.</b> Not a scheme check
/// alone: HTTPS to the wrong host is still the wrong host, and it is the failure a typo produces. A
/// deployment that genuinely uses an OpenAI-compatible endpoint elsewhere states that host in
/// `Ai:OpenAiAllowedHosts`, which is an explicit act on a protected configuration value rather than a
/// side effect of editing a URL.
/// </para>
/// <para>
/// Checked twice on purpose: <see cref="AiOptionsValidator"/> fails a deployment's startup, and
/// <see cref="AiOptions.CloudSpeechConfigured"/> reads false for a destination that is not permitted,
/// so the router treats the engine as absent and no request is built at all. The second is what holds
/// in Development, where startup validation is deliberately lenient.
/// </para>
/// </remarks>
public static class CloudSpeechEndpoint
{
    /// <summary>The provider the key in <c>Ai:OpenAiApiKey</c> is issued by.</summary>
    public static readonly IReadOnlyList<string> DefaultAllowedHosts = ["api.openai.com"];

    /// <summary>
    /// The reason this base URL may not receive household audio, or null when it may.
    /// </summary>
    /// <remarks>
    /// A sentence rather than an exception, so the caller decides whether it is fatal, and so it can
    /// be logged and tested without a stack trace. It names the host and never the credential.
    /// </remarks>
    public static string? Refuse(string? baseUrl, IReadOnlyCollection<string>? allowedHosts = null)
    {
        if (string.IsNullOrWhiteSpace(baseUrl))
            return "Ai:OpenAiBaseUrl is empty; cloud speech-to-text has no destination.";

        if (!Uri.TryCreate(baseUrl, UriKind.Absolute, out var uri))
            return "Ai:OpenAiBaseUrl must be an absolute URL, e.g. https://api.openai.com.";

        if (uri.Scheme != Uri.UriSchemeHttps)
        {
            return $"Ai:OpenAiBaseUrl must use https; '{uri.Scheme}' would send household audio and "
                + "the cloud credential in the clear.";
        }

        // Userinfo in a URL is a credential in a place nothing here expects one, and it is the classic
        // way a destination is made to *read* as the intended host while resolving somewhere else.
        if (!string.IsNullOrEmpty(uri.UserInfo))
            return "Ai:OpenAiBaseUrl must not carry userinfo.";

        if (!string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment))
            return "Ai:OpenAiBaseUrl must not carry a query string or fragment.";

        var permitted = allowedHosts is { Count: > 0 } ? allowedHosts : DefaultAllowedHosts;
        if (!permitted.Any(h => string.Equals(h, uri.Host, StringComparison.OrdinalIgnoreCase)))
        {
            return $"Ai:OpenAiBaseUrl points at '{uri.Host}', which is not an allowed destination for "
                + "household audio. Use the provider's own host, or name this one explicitly in "
                + "Ai:OpenAiAllowedHosts.";
        }

        return null;
    }

    /// <summary>Whether this base URL may receive household audio.</summary>
    public static bool IsPermitted(string? baseUrl, IReadOnlyCollection<string>? allowedHosts = null) =>
        Refuse(baseUrl, allowedHosts) is null;
}
