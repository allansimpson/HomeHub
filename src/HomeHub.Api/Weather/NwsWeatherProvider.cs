namespace HomeHub.Api.Weather;

using System.Collections.Concurrent;
using System.Globalization;
using System.Net.Http.Json;
using System.Text.RegularExpressions;
using HomeHub.Api.Alerts;
using Microsoft.Extensions.Options;

/// <summary>
/// US National Weather Service client (api.weather.gov): resolves the point → forecast URLs,
/// then pulls hourly + daily forecast + active alerts. Key-free but requires an identifying
/// User-Agent. Only used behind <see cref="IWeatherProvider"/>. Forecast temperatures already
/// arrive in Fahrenheit; wind is parsed from NWS's "8 mph" strings.
/// </summary>
public sealed partial class NwsWeatherProvider : IWeatherProvider
{
    private readonly HttpClient _http;
    private readonly ILogger<NwsWeatherProvider> _logger;

    // Forecast URLs are stable per point; cache them to avoid a /points call every refresh.
    private static readonly ConcurrentDictionary<string, (string Forecast, string Hourly)> PointCache = new();

    public NwsWeatherProvider(HttpClient http, IOptions<WeatherOptions> options, ILogger<NwsWeatherProvider> logger)
    {
        _http = http;
        _logger = logger;
        var opts = options.Value;
        _http.BaseAddress = new Uri(opts.BaseUrl.TrimEnd('/') + "/");
        // NWS requires a descriptive User-Agent and prefers the geo+json media type.
        _http.DefaultRequestHeaders.UserAgent.ParseAdd(opts.UserAgent);
        _http.DefaultRequestHeaders.Accept.ParseAdd("application/geo+json");
    }

    public async Task<ProviderWeather> GetWeatherAsync(double latitude, double longitude, CancellationToken ct)
    {
        var (forecastUrl, hourlyUrl) = await ResolvePointAsync(latitude, longitude, ct);

        var hourly = await _http.GetFromJsonAsync<ForecastResponse>(hourlyUrl, ct);
        var daily = await _http.GetFromJsonAsync<ForecastResponse>(forecastUrl, ct);
        var alerts = await _http.GetFromJsonAsync<AlertsResponse>(
            $"alerts/active?point={Coord(latitude)},{Coord(longitude)}", ct);

        var current = BuildCurrent(hourly, daily);
        var hourlyDtos = BuildHourly(hourly);
        var dailyDtos = BuildDaily(daily);
        var alertDtos = BuildAlerts(alerts);

        return new ProviderWeather(current, hourlyDtos, dailyDtos, alertDtos);
    }

    private async Task<(string Forecast, string Hourly)> ResolvePointAsync(double lat, double lon, CancellationToken ct)
    {
        var key = $"{Coord(lat)},{Coord(lon)}";
        if (PointCache.TryGetValue(key, out var cached)) return cached;

        var point = await _http.GetFromJsonAsync<PointsResponse>($"points/{key}", ct)
            ?? throw new InvalidOperationException("NWS points lookup returned no data.");
        var forecast = point.Properties?.Forecast
            ?? throw new InvalidOperationException("NWS points response missing forecast URL.");
        var hourly = point.Properties?.ForecastHourly ?? forecast;

        var resolved = (forecast, hourly);
        PointCache[key] = resolved;
        return resolved;
    }

    private static CurrentWeatherDto BuildCurrent(ForecastResponse? hourly, ForecastResponse? daily)
    {
        var now = hourly?.Properties?.Periods?.FirstOrDefault();
        var today = daily?.Properties?.Periods?.FirstOrDefault(p => p.IsDaytime)
            ?? daily?.Properties?.Periods?.FirstOrDefault();
        var tonight = daily?.Properties?.Periods?.FirstOrDefault(p => !p.IsDaytime);

        return new CurrentWeatherDto(
            TempF: now?.Temperature,
            Condition: now?.ShortForecast,
            HighF: today?.Temperature,
            LowF: tonight?.Temperature,
            Humidity: now?.RelativeHumidity?.Value,
            WindMph: ParseWind(now?.WindSpeed),
            FeelsLikeF: null);
    }

    private static IReadOnlyList<HourlyDto> BuildHourly(ForecastResponse? hourly)
    {
        var periods = hourly?.Properties?.Periods ?? [];
        return periods.Take(12)
            .Select(p => new HourlyDto(
                p.StartTime.ToLocalTime().ToString("h tt", CultureInfo.InvariantCulture),
                p.Temperature,
                p.ShortForecast))
            .ToList();
    }

    private static IReadOnlyList<DailyDto> BuildDaily(ForecastResponse? daily)
    {
        var periods = daily?.Properties?.Periods ?? [];
        var byDate = periods
            .GroupBy(p => p.StartTime.ToLocalTime().Date)
            .OrderBy(g => g.Key)
            .Take(7);

        var today = DateTime.Now.Date;
        var result = new List<DailyDto>();
        foreach (var day in byDate)
        {
            var dayPeriod = day.FirstOrDefault(p => p.IsDaytime);
            var nightPeriod = day.FirstOrDefault(p => !p.IsDaytime);
            var representative = dayPeriod ?? day.First();
            var condition = representative.ShortForecast ?? "";
            result.Add(new DailyDto(
                Day: day.Key == today ? "TODAY" : day.Key.ToString("dddd", CultureInfo.InvariantCulture).ToUpperInvariant(),
                Condition: condition,
                HighF: dayPeriod?.Temperature ?? day.Max(p => p.Temperature),
                LowF: nightPeriod?.Temperature ?? day.Min(p => p.Temperature),
                Severe: IsSevereText(condition)));
        }
        return result;
    }

    private static IReadOnlyList<ProviderWeatherAlert> BuildAlerts(AlertsResponse? alerts)
    {
        var features = alerts?.Features ?? [];
        return features
            .Where(f => f.Properties is not null)
            .Select(f =>
            {
                var p = f.Properties!;
                var detail = p.Headline ?? p.Description ?? p.Event ?? "Weather alert";
                return new ProviderWeatherAlert(
                    Id: f.Id ?? p.Event ?? Guid.NewGuid().ToString(),
                    Event: p.Event ?? "Weather Alert",
                    Severity: MapSeverity(p.Severity),
                    Message: Truncate(detail, 280),
                    ExpiresUtc: p.Expires?.UtcDateTime);
            })
            .ToList();
    }

    private static AlertSeverity MapSeverity(string? nws) => nws switch
    {
        "Extreme" or "Severe" => AlertSeverity.Severe,
        "Moderate" => AlertSeverity.Warning,
        _ => AlertSeverity.Info,
    };

    private static bool IsSevereText(string text) =>
        text.Contains("Severe", StringComparison.OrdinalIgnoreCase)
        || text.Contains("Storm", StringComparison.OrdinalIgnoreCase)
        || text.Contains("Warning", StringComparison.OrdinalIgnoreCase);

    private static double? ParseWind(string? windSpeed)
    {
        if (string.IsNullOrWhiteSpace(windSpeed)) return null;
        var match = DigitsRegex().Match(windSpeed);
        return match.Success && double.TryParse(match.Value, out var v) ? v : null;
    }

    private static string Coord(double c) => c.ToString("0.####", CultureInfo.InvariantCulture);

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];

    [GeneratedRegex(@"\d+")]
    private static partial Regex DigitsRegex();

    // ---- NWS response shapes (partial; case-insensitive web JSON) ----
    private sealed record PointsResponse(PointsProps? Properties);
    private sealed record PointsProps(string? Forecast, string? ForecastHourly);
    private sealed record ForecastResponse(ForecastProps? Properties);
    private sealed record ForecastProps(List<Period>? Periods);
    private sealed record Period(
        int Number,
        string? Name,
        DateTimeOffset StartTime,
        bool IsDaytime,
        double? Temperature,
        string? TemperatureUnit,
        string? ShortForecast,
        string? WindSpeed,
        ValueContainer? RelativeHumidity);
    private sealed record ValueContainer(double? Value);
    private sealed record AlertsResponse(List<AlertFeature>? Features);
    private sealed record AlertFeature(string? Id, AlertProps? Properties);
    private sealed record AlertProps(
        string? Event,
        string? Severity,
        string? Headline,
        string? Description,
        DateTimeOffset? Expires,
        DateTimeOffset? Onset);
}
