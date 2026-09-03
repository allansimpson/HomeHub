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
    /// <remarks>
    /// <b>"Must stay off" was a sentence in a comment, and a deployment could bind it to true.</b>
    /// The fetcher takes a URL a household member types and follows it; with this on, both address
    /// defences are gone and an authenticated recipe import becomes a way to make the server request
    /// anything on its own loopback or LAN — the admin panel of a router, a database, Home Assistant,
    /// the Hermes gateway. It is now refused at startup outside Development and the automated Test
    /// environment, so the comment is enforced rather than trusted. See
    /// <see cref="MealsOptionsValidator"/>.
    /// </remarks>
    public bool AllowPrivateAddresses { get; set; }
}

/// <summary>
/// Refuses to start a deployment that has re-armed the recipe fetcher's SSRF primitive.
/// </summary>
/// <remarks>
/// The one setting in this file that is a security boundary rather than a preference, so it is the
/// one with a validator. Development and the automated Test environment are exempt for the reason the
/// setting exists at all: a test needs to point the fetcher at a stub on loopback, and a developer
/// needs the same. A deployment does not.
/// </remarks>
public sealed class MealsOptionsValidator(bool requiresDeploymentSafeguards)
    : Microsoft.Extensions.Options.IValidateOptions<MealsOptions>
{
    public Microsoft.Extensions.Options.ValidateOptionsResult Validate(string? name, MealsOptions options)
    {
        if (!requiresDeploymentSafeguards || !options.AllowPrivateAddresses)
            return Microsoft.Extensions.Options.ValidateOptionsResult.Success;

        return Microsoft.Extensions.Options.ValidateOptionsResult.Fail(
            "Meals:AllowPrivateAddresses lets the recipe fetcher reach this machine and this network, "
            + "so a household member pasting a link could make the server request anything on it. It "
            + "exists for local stub servers in tests and must be unset in a deployment.");
    }
}
