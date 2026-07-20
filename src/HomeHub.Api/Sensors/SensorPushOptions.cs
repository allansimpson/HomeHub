namespace HomeHub.Api.Sensors;

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

    public bool IsConfigured => !string.IsNullOrWhiteSpace(Email) && !string.IsNullOrWhiteSpace(Password);
}
