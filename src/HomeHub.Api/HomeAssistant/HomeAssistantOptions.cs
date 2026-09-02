namespace HomeHub.Api.HomeAssistant;

using HomeHub.Api.Net;

/// <summary>
/// Home Assistant connection config, bound from the <c>HomeAssistant</c> section. The app talks
/// to HA (not the AC units or the robot directly) via a long-lived access token.
/// Secrets never committed: user-secrets in dev, env vars in prod. When <see cref="IsConfigured"/>
/// is false the app uses the simulated climate provider and reports the Litter-Robot as not connected.
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

    /// <summary>
    /// The exact origins — scheme, host and port — Home Assistant may be reached at.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>A private address proves where a listener is, not what it is.</b> The reach check that came
    /// first stopped this bearer leaving the house and did nothing about the house itself: any device
    /// on the LAN that answers on the configured address receives a long-lived token with
    /// service-call permission, the household's state, and the commands that change it. A typo, a
    /// re-used DHCP lease, a second device claiming the same mDNS name — none of those are exotic,
    /// and all of them satisfy "has an RFC1918 address".
    /// </para>
    /// <para>
    /// Empty means loopback only. A household running Home Assistant on another box — which is the
    /// ordinary arrangement — names its origin here, and that naming is the approval. It must be an
    /// <c>https</c> origin: see <see cref="RefuseDestination"/>.
    /// </para>
    /// </remarks>
    public List<string> AllowedOrigins { get; set; } = [];

    /// <summary>The rule for Home Assistant, shared by startup, availability and the connection.</summary>
    public EgressRule Rule => AllowedOrigins.Count > 0
        ? EgressRule.Origins("HomeAssistant:BaseUrl", AllowedOrigins)
        : EgressRule.Loopback("HomeAssistant:BaseUrl");

    /// <summary>The reason this configuration may not be used, or null when it may.</summary>
    /// <remarks>
    /// <para>
    /// Both halves live in <see cref="EgressGuard"/> now — <b>where</b> the listener is, by exact
    /// origin, and <b>whether anything authenticates it</b>, by requiring https off loopback. This
    /// class stated the second itself for one round, which is one rule in two places and exactly how
    /// two places drift apart. Every credentialed destination needs the same answer, so it is asked
    /// once.
    /// </para>
    /// <para>
    /// <b>There was an acknowledgement flag here and it has been removed.</b> It let a deployment
    /// record that it accepted a readable bearer on its own network, which is a different thing from
    /// making the bearer safe: an exact origin stops the traffic being rerouted and does not
    /// authenticate the machine that answers there, so a device taking that address by DHCP lease, or
    /// claiming the name, still receives a long-lived service-call token. Accepting a risk is not
    /// closing it, and the transport is the thing to correct rather than the gate.
    /// </para>
    /// </remarks>
    public string? RefuseDestination() => EgressGuard.Refuse(BaseUrl, Rule);

    /// <summary>
    /// Configured, and pointing somewhere it is allowed to point.
    /// </summary>
    /// <remarks>
    /// A URL and a token used to be the whole condition. A destination that fails now reads as an
    /// unconfigured integration, so the panel falls back to its simulated climate rather than posting
    /// a service-call token at it.
    /// </remarks>
    public bool IsConfigured =>
        !string.IsNullOrWhiteSpace(BaseUrl) && !string.IsNullOrWhiteSpace(Token)
        && RefuseDestination() is null;
}
