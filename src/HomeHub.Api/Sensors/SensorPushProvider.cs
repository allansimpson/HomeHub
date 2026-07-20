namespace HomeHub.Api.Sensors;

using System.Net.Http.Json;
using Microsoft.Extensions.Options;

/// <summary>
/// Direct SensorPush cloud client (auth → access token → sensors → latest samples). Only ever
/// used behind <see cref="ISensorProvider"/>; no UI or logic references it. Active only when
/// credentials are configured. Temperatures are requested in Fahrenheit to match the rest of the
/// app. Access tokens are short-lived, so they are cached and refreshed on demand.
/// </summary>
public sealed class SensorPushProvider : ISensorProvider
{
    private static readonly TimeSpan TokenLifetime = TimeSpan.FromMinutes(25);

    private readonly HttpClient _http;
    private readonly SensorPushOptions _options;
    private readonly ILogger<SensorPushProvider> _logger;
    private readonly SemaphoreSlim _authLock = new(1, 1);

    private string? _accessToken;
    private DateTime _tokenAcquiredUtc;

    public SensorPushProvider(HttpClient http, IOptions<SensorPushOptions> options, ILogger<SensorPushProvider> logger)
    {
        _http = http;
        _options = options.Value;
        _logger = logger;
        if (!string.IsNullOrWhiteSpace(_options.BaseUrl))
            _http.BaseAddress = new Uri(_options.BaseUrl.TrimEnd('/') + "/");
    }

    public string Source => "sensorpush";

    public async Task<IReadOnlyList<ProviderZone>> GetZonesAsync(CancellationToken ct)
    {
        await EnsureAuthedAsync(ct);
        var sensors = await PostAuthedAsync<Dictionary<string, SensorInfo>>("devices/sensors", new { }, ct);
        if (sensors is null) return [];

        return sensors
            .Where(kv => kv.Value.Active ?? true)
            .Select(kv => new ProviderZone(
                kv.Key,
                _options.ZoneNames.GetValueOrDefault(kv.Key) ?? kv.Value.Name ?? kv.Key))
            .ToList();
    }

    public async Task<IReadOnlyList<ProviderReading>> GetLatestReadingsAsync(
        IReadOnlyList<string> providerRefs, CancellationToken ct)
    {
        if (providerRefs.Count == 0) return [];
        await EnsureAuthedAsync(ct);

        var body = new
        {
            limit = 1,
            sensors = providerRefs,
            measures = new[] { "temperature", "humidity" },
        };
        var samples = await PostAuthedAsync<SamplesResponse>("samples", body, ct);
        if (samples?.Sensors is null) return [];

        var readings = new List<ProviderReading>();
        foreach (var (sensorId, list) in samples.Sensors)
        {
            var latest = list.FirstOrDefault();
            if (latest is null) continue;
            readings.Add(new ProviderReading(
                sensorId,
                latest.Temperature ?? 0,
                latest.Humidity ?? 0,
                latest.Observed?.UtcDateTime ?? DateTime.UtcNow));
        }
        return readings;
    }

    private async Task EnsureAuthedAsync(CancellationToken ct)
    {
        if (_accessToken is not null && DateTime.UtcNow - _tokenAcquiredUtc < TokenLifetime) return;

        await _authLock.WaitAsync(ct);
        try
        {
            if (_accessToken is not null && DateTime.UtcNow - _tokenAcquiredUtc < TokenLifetime) return;

            var authorize = await _http.PostAsJsonAsync(
                "oauth/authorize",
                new { email = _options.Email, password = _options.Password },
                ct);
            authorize.EnsureSuccessStatusCode();
            var authorization = (await authorize.Content.ReadFromJsonAsync<AuthorizeResponse>(ct))?.Authorization
                ?? throw new InvalidOperationException("SensorPush authorize returned no authorization code.");

            var token = await _http.PostAsJsonAsync("oauth/accesstoken", new { authorization }, ct);
            token.EnsureSuccessStatusCode();
            _accessToken = (await token.Content.ReadFromJsonAsync<AccessTokenResponse>(ct))?.AccessToken
                ?? throw new InvalidOperationException("SensorPush accesstoken returned no token.");
            _tokenAcquiredUtc = DateTime.UtcNow;
        }
        finally
        {
            _authLock.Release();
        }
    }

    private async Task<T?> PostAuthedAsync<T>(string path, object body, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, path)
        {
            Content = JsonContent.Create(body),
        };
        req.Headers.TryAddWithoutValidation("Authorization", _accessToken);
        using var res = await _http.SendAsync(req, ct);
        res.EnsureSuccessStatusCode();
        return await res.Content.ReadFromJsonAsync<T>(ct);
    }

    private sealed record AuthorizeResponse(string? Authorization);
    private sealed record AccessTokenResponse(string? AccessToken);
    private sealed record SensorInfo(string? Name, bool? Active);
    private sealed record SamplesResponse(Dictionary<string, List<Sample>>? Sensors);
    private sealed record Sample(DateTimeOffset? Observed, double? Temperature, double? Humidity);
}
