namespace HomeHub.Api.HomeAssistant;

/// <summary>
/// Home Assistant connection config, bound from the <c>HomeAssistant</c> section. The app talks
/// to HA (not the AC units or the Huckleberry backend directly) via a long-lived access token.
/// Secrets never committed: user-secrets in dev, env vars in prod. When <see cref="IsConfigured"/>
/// is false the app uses the simulated climate provider and reports Huckleberry as not connected.
/// </summary>
/// <remarks>
/// Lives here rather than under <c>Climate</c> because HA is now shared infrastructure: climate
/// (Stage 6) and Huckleberry (Stage H2) both ride <see cref="HomeAssistantClient"/>. The
/// climate-specific members below stay on this type because they are HA-entity config, not
/// domain config.
/// </remarks>
public sealed class HomeAssistantOptions
{
    public const string Section = "HomeAssistant";

    /// <summary>LAN base URL, e.g. http://homeassistant.local:8123.</summary>
    public string? BaseUrl { get; set; }

    /// <summary>Long-lived access token. Needs service-call permission (Gate H0.4).</summary>
    public string? Token { get; set; }

    /// <summary>Entity id applied for the "evening" scene action (a scene or script).</summary>
    public string EveningScene { get; set; } = "scene.evening";

    /// <summary>Optional friendly-name overrides keyed by climate entity id.</summary>
    public Dictionary<string, string> ZoneNames { get; set; } = new();

    /// <summary>Per-request timeout for HA calls; HA is on the LAN, so this is a hang guard.</summary>
    public int TimeoutSeconds { get; set; } = 15;

    public bool IsConfigured =>
        !string.IsNullOrWhiteSpace(BaseUrl) && !string.IsNullOrWhiteSpace(Token);
}
