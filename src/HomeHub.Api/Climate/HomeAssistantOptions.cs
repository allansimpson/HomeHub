namespace HomeHub.Api.Climate;

/// <summary>
/// Home Assistant connection config, bound from the <c>HomeAssistant</c> section. The app talks
/// to HA (not the AC units directly) via a long-lived access token. Secrets never committed:
/// user-secrets in dev, env vars in prod. When <see cref="IsConfigured"/> is false the app uses
/// the simulated climate provider instead.
/// </summary>
public sealed class HomeAssistantOptions
{
    public const string Section = "HomeAssistant";

    /// <summary>LAN base URL, e.g. http://homeassistant.local:8123.</summary>
    public string? BaseUrl { get; set; }

    /// <summary>Long-lived access token.</summary>
    public string? Token { get; set; }

    /// <summary>Entity id applied for the "evening" scene action (a scene or script).</summary>
    public string EveningScene { get; set; } = "scene.evening";

    /// <summary>Optional friendly-name overrides keyed by climate entity id.</summary>
    public Dictionary<string, string> ZoneNames { get; set; } = new();

    public bool IsConfigured =>
        !string.IsNullOrWhiteSpace(BaseUrl) && !string.IsNullOrWhiteSpace(Token);
}
