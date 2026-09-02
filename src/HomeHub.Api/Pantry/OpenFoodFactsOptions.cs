namespace HomeHub.Api.Pantry;

using HomeHub.Api.Net;

/// <summary>
/// Open Food Facts lookup config, bound from the <c>OpenFoodFacts</c> section.
/// </summary>
/// <remarks>
/// No API key, no account — the reason this source was chosen over the commercial ones. What it
/// does need is a <see cref="UserAgent"/> that identifies the caller, which the project asks of
/// every client and which costs nothing to supply honestly.
/// <para>
/// <b><see cref="Enabled"/> defaults to false here and is switched on in <c>appsettings.json</c></b>,
/// so the fact that this panel makes an outbound call is visible in configuration rather than
/// buried in a C# default. It is the pantry's only call off the LAN, and it sends barcodes — not
/// much, but not nothing, and worth being able to see and turn off in one place.
/// </para>
/// </remarks>
public sealed class OpenFoodFactsOptions
{
    public const string Section = "OpenFoodFacts";

    public bool Enabled { get; set; }

    public string BaseUrl { get; set; } = "https://world.openfoodfacts.org";

    /// <summary>Open Food Facts asks callers to identify themselves; anonymous agents get throttled.</summary>
    public string UserAgent { get; set; } = "HomeHub/1.0 (household wall panel; personal use)";

    /// <summary>
    /// Short on purpose. A scan is a gesture someone is making with a tin in their hand, and a
    /// catalogue that takes five seconds to answer is worse than one that says nothing.
    /// </summary>
    public int TimeoutSeconds { get; set; } = 4;

    /// <summary>
    /// How long an answer — including "not found" — is remembered in memory.
    /// </summary>
    /// <remarks>
    /// Negative results are cached too, and that is the more important half: the camera decodes the
    /// same pack many times a second, and an unknown barcode would otherwise re-ask Open Food Facts
    /// on every frame that got through the client's debounce.
    /// </remarks>
    public int CacheHours { get; set; } = 6;

    /// <summary>Hosts permitted to receive the barcodes the household scans.</summary>
    public List<string> AllowedHosts { get; set; } = [];

    /// <summary>The rule for the lookup service. No credential, and still a destination.</summary>
    public EgressRule LookupRule => EgressRule.Internet(
        "OpenFoodFacts:BaseUrl", AllowedHosts.Count > 0 ? AllowedHosts : ["world.openfoodfacts.org"]);

    public bool IsConfigured =>
        Enabled && !string.IsNullOrWhiteSpace(BaseUrl) && EgressGuard.IsPermitted(BaseUrl, LookupRule);
}
