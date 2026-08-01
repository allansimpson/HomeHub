namespace HomeHub.Api.Meals;

/// <summary>
/// Import + image configuration, bound from the <c>Meals</c> section (meals-planning.md D4/D5).
/// </summary>
public sealed class MealsOptions
{
    public const string Section = "Meals";

    /// <summary>
    /// Identifies the panel to the sites it fetches, matching the courtesy already shown to NWS via
    /// <c>Weather:UserAgent</c>. An anonymous fetcher is the shape bot-blockers exist to stop.
    /// </summary>
    public string UserAgent { get; set; } = "HomeHub/1.0 (+recipe import; allansimpson@outlook.com)";

    /// <summary>
    /// Where cached hero images are written. **Never <c>wwwroot</c>** — that directory is the SPA
    /// build output and is replaced wholesale on every deploy, so anything cached there is
    /// destroyed by the next publish (D5). Empty means "beside the content root".
    /// </summary>
    public string ImagePath { get; set; } = string.Empty;

    /// <summary>How long the server will wait for a recipe page before giving up.</summary>
    public int TimeoutSeconds { get; set; } = 10;

    /// <summary>Response ceiling. A recipe page is tens of KB; anything near this is not one.</summary>
    public int MaxResponseBytes { get; set; } = 5 * 1024 * 1024;

    /// <summary>
    /// Redirect budget. Followed by hand rather than by <c>HttpClient</c> so the destination of
    /// <b>every</b> hop can be re-checked — see <see cref="RecipeFetcher"/>.
    /// </summary>
    public int MaxRedirects { get; set; } = 5;

    /// <summary>
    /// Allow the fetcher to reach private/loopback addresses. **Off, and it must stay off in any
    /// real deployment** — it exists so tests can point the fetcher at a local stub server. Turning
    /// it on re-arms the SSRF primitive D4 exists to disarm.
    /// </summary>
    public bool AllowPrivateAddresses { get; set; }
}
