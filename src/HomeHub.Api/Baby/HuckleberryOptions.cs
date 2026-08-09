namespace HomeHub.Api.Baby;

/// <summary>
/// Huckleberry display config, bound from the <c>Huckleberry</c> section. There are no credentials
/// here by design: Huckleberry's own login lives in Home Assistant's config flow, so HomeHub holds
/// only the HA token (see <c>HomeAssistant</c> section) and never a second credential store.
/// </summary>
public sealed class HuckleberryOptions
{
    public const string Section = "Huckleberry";

    /// <summary>Kill switch. HA config still gates the provider independently.</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>
    /// Explicit child entity-id slugs (the <c>{child}</c> in <c>sensor.{child}_sleep</c>). Leave
    /// empty to auto-discover from HA's entity list; pin them here if discovery picks up something
    /// it shouldn't.
    /// </summary>
    public List<string> Children { get; set; } = new();

    /// <summary>Display-name overrides keyed by child slug, when the profile sensor's name isn't what you'd call them.</summary>
    public Dictionary<string, string> ChildNames { get; set; } = new();

    /// <summary>Calendar entity id pattern for a child's history; <c>{0}</c> is the child slug.</summary>
    public string CalendarEntityFormat { get; set; } = "calendar.{0}_events";

    /// <summary>
    /// How long a fetched snapshot stays fresh. The panel polls ~15s (Stage H3); this keeps a burst
    /// of requests from becoming a burst of HA calls. Tightened when H4 brings live push.
    /// </summary>
    public int CacheSeconds { get; set; } = 10;
}
