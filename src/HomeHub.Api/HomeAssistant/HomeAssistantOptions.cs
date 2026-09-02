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
    /// ordinary arrangement — names its origin here, and that naming is the approval.
    /// </para>
    /// </remarks>
    public List<string> AllowedOrigins { get; set; } = [];

    /// <summary>
    /// Permit an approved origin that is not on loopback and not TLS.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>Off by default, and its absence is the reason cleartext is refused.</b> Over plain HTTP the
    /// bearer travels the LAN in the clear on every poll, and anything on that network can read it and
    /// then issue service calls of its own. TLS is the answer; this exists because Home Assistant on a
    /// household LAN commonly has no certificate, and refusing that outright would take the climate,
    /// the scenes and the sensors off every panel that has one.
    /// </para>
    /// <para>
    /// So it is an explicit, protected, logged decision rather than a default — the same shape as
    /// <c>Voice:Stt:CloudAudioEgressAcknowledged</c>. A deployment that sets it has said out loud that
    /// it accepts a readable token on its own network; one that does not gets TLS or loopback.
    /// </para>
    /// </remarks>
    public bool AcknowledgeCleartextLan { get; set; }

    /// <summary>The rule for Home Assistant, shared by startup, availability and the connection.</summary>
    public EgressRule Rule => AllowedOrigins.Count > 0
        ? EgressRule.Origins("HomeAssistant:BaseUrl", AllowedOrigins)
        : EgressRule.Loopback("HomeAssistant:BaseUrl");

    /// <summary>The reason this configuration may not be used, or null when it may.</summary>
    /// <remarks>
    /// The transport check is separate from <see cref="Rule"/> because it is a question about the
    /// household's acceptance rather than about the destination, and only this class knows the answer.
    /// </remarks>
    public string? RefuseDestination()
    {
        if (EgressGuard.Refuse(BaseUrl, Rule) is { } refusal) return refusal;

        var uri = new Uri(BaseUrl!, UriKind.Absolute);
        if (uri.Scheme == Uri.UriSchemeHttps || uri.IsLoopback || AcknowledgeCleartextLan) return null;

        return "HomeAssistant:BaseUrl uses plain http to a host that is not this machine, so the "
            + "long-lived token travels the network in the clear on every poll. Use https, or set "
            + "HomeAssistant:AcknowledgeCleartextLan=true to accept that on your own network.";
    }

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
