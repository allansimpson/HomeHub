namespace HomeHub.Api.Sensors;

using HomeHub.Api.Net;

/// <summary>
/// SensorPush cloud credentials + optional sensor→zone naming, bound from configuration section
/// <c>SensorPush</c>. Secrets are never committed: set via user-secrets in dev, environment
/// variables for the systemd service in prod (e.g. <c>SensorPush__Email</c>). When
/// <see cref="IsConfigured"/> is false the app falls back to the simulated provider.
/// </summary>
public sealed class SensorPushOptions
{
    public const string Section = "SensorPush";

    public string? Email { get; set; }
    public string? Password { get; set; }

    /// <summary>Base URL of the SensorPush API (overridable for testing).</summary>
    public string BaseUrl { get; set; } = "https://api.sensorpush.com/api/v1";

    /// <summary>Optional friendly names keyed by SensorPush sensor id; falls back to the device name.</summary>
    public Dictionary<string, string> ZoneNames { get; set; } = new();

    /// <summary>Hosts permitted to receive the household's sensor credentials and readings.</summary>
    /// <remarks>Empty means SensorPush's own host, which is what a household deploying this wants.</remarks>
    public List<string> AllowedHosts { get; set; } = [];

    /// <summary>The rule for this vendor, shared by startup and the request path.</summary>
    /// <remarks>
    /// The account email and password are posted to it, an access token comes back, and the
    /// household's sensor history follows — so the destination is as much a credential boundary as
    /// the password itself.
    /// </remarks>
    public EgressRule Rule => EgressRule.Internet(
        "SensorPush:BaseUrl", AllowedHosts.Count > 0 ? AllowedHosts : ["api.sensorpush.com"]);

    public bool IsConfigured =>
        !string.IsNullOrWhiteSpace(Email) && !string.IsNullOrWhiteSpace(Password)
        && EgressGuard.IsPermitted(BaseUrl, Rule);
}
