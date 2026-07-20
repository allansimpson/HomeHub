namespace HomeHub.Api.Calendar;

using System.Globalization;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using HomeHub.Api.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

/// <summary>
/// Real Google Calendar (v3) provider: silent OAuth refresh → access token, then events
/// list/insert/patch/delete against the household calendar. The local <see cref="CalendarEvent"/>
/// table is kept as an offline cache (upserted on list, mirrored on write). Only used behind
/// <see cref="ICalendarProvider"/>; active only when <see cref="GoogleCalendarOptions.IsConfigured"/>.
/// Owner tags stay local (not pushed to Google) per the Stage 4 decision.
/// </summary>
public sealed class GoogleCalendarProvider : ICalendarProvider
{
    private static readonly TimeSpan TokenLifetime = TimeSpan.FromMinutes(55);

    private readonly HttpClient _http;
    private readonly HomeHubDbContext _db;
    private readonly GoogleCalendarOptions _options;
    private readonly ILogger<GoogleCalendarProvider> _logger;
    private readonly SemaphoreSlim _authLock = new(1, 1);

    private string? _accessToken;
    private DateTime _tokenAcquiredUtc;

    public GoogleCalendarProvider(
        HttpClient http, HomeHubDbContext db, IOptions<GoogleCalendarOptions> options, ILogger<GoogleCalendarProvider> logger)
    {
        _http = http;
        _db = db;
        _options = options.Value;
        _logger = logger;
    }

    public string Source => "google";

    public async Task<IReadOnlyList<CalendarEvent>> ListAsync(DateTime fromUtc, DateTime toUtc, CancellationToken ct)
    {
        try
        {
            await EnsureAuthedAsync(ct);
            var url = $"{_options.ApiBaseUrl}/calendars/{Uri.EscapeDataString(_options.CalendarId)}/events"
                + $"?singleEvents=true&orderBy=startTime&timeMin={Iso(fromUtc)}&timeMax={Iso(toUtc)}";
            var response = await SendAsync(HttpMethod.Get, url, null, ct);
            var list = await response.Content.ReadFromJsonAsync<GEventList>(ct);
            await UpsertCacheAsync(list?.Items ?? [], ct);
        }
        catch (Exception ex)
        {
            // Offline / API failure — fall back to the cached rows for the range.
            _logger.LogWarning(ex, "Google Calendar list failed; serving cached events.");
        }

        return await _db.CalendarEvents
            .Where(e => e.StartUtc < toUtc && e.EndUtc > fromUtc)
            .OrderBy(e => e.StartUtc)
            .ToListAsync(ct);
    }

    public async Task<CalendarEvent?> GetAsync(int id, CancellationToken ct) =>
        await _db.CalendarEvents.FindAsync([id], ct);

    public async Task<CalendarEvent> CreateAsync(CalendarEventInput input, CancellationToken ct)
    {
        var entity = new CalendarEvent
        {
            Source = Source,
            Title = input.Title.Trim(),
            StartUtc = input.StartUtc,
            EndUtc = input.EndUtc,
            Location = input.Location,
            Notes = input.Notes,
            OwnerTags = input.OwnersCsv,
            UpdatedUtc = DateTime.UtcNow,
        };

        await EnsureAuthedAsync(ct);
        var url = $"{_options.ApiBaseUrl}/calendars/{Uri.EscapeDataString(_options.CalendarId)}/events";
        var response = await SendAsync(HttpMethod.Post, url, ToGoogle(input), ct);
        var created = await response.Content.ReadFromJsonAsync<GEvent>(ct);
        entity.GoogleId = created?.Id;

        _db.CalendarEvents.Add(entity);
        await _db.SaveChangesAsync(ct);
        return entity;
    }

    public async Task<CalendarEvent?> UpdateAsync(int id, CalendarEventInput input, CancellationToken ct)
    {
        var entity = await _db.CalendarEvents.FindAsync([id], ct);
        if (entity is null) return null;

        entity.Title = input.Title.Trim();
        entity.StartUtc = input.StartUtc;
        entity.EndUtc = input.EndUtc;
        entity.Location = input.Location;
        entity.Notes = input.Notes;
        entity.OwnerTags = input.OwnersCsv;
        entity.UpdatedUtc = DateTime.UtcNow;

        if (!string.IsNullOrEmpty(entity.GoogleId))
        {
            await EnsureAuthedAsync(ct);
            var url = $"{_options.ApiBaseUrl}/calendars/{Uri.EscapeDataString(_options.CalendarId)}/events/{entity.GoogleId}";
            await SendAsync(HttpMethod.Patch, url, ToGoogle(input), ct);
        }
        await _db.SaveChangesAsync(ct);
        return entity;
    }

    public async Task<bool> DeleteAsync(int id, CancellationToken ct)
    {
        var entity = await _db.CalendarEvents.FindAsync([id], ct);
        if (entity is null) return false;

        if (!string.IsNullOrEmpty(entity.GoogleId))
        {
            await EnsureAuthedAsync(ct);
            var url = $"{_options.ApiBaseUrl}/calendars/{Uri.EscapeDataString(_options.CalendarId)}/events/{entity.GoogleId}";
            await SendAsync(HttpMethod.Delete, url, null, ct);
        }
        _db.CalendarEvents.Remove(entity);
        await _db.SaveChangesAsync(ct);
        return true;
    }

    private async Task UpsertCacheAsync(IReadOnlyList<GEvent> items, CancellationToken ct)
    {
        foreach (var g in items)
        {
            if (g.Id is null || g.Start?.EffectiveUtc is not { } startUtc) continue;
            var endUtc = g.End?.EffectiveUtc ?? startUtc.AddHours(1);

            var existing = await _db.CalendarEvents.FirstOrDefaultAsync(e => e.GoogleId == g.Id, ct);
            if (existing is null)
            {
                _db.CalendarEvents.Add(new CalendarEvent
                {
                    GoogleId = g.Id,
                    Source = Source,
                    Title = g.Summary ?? "(untitled)",
                    StartUtc = startUtc,
                    EndUtc = endUtc,
                    Location = g.Location,
                    Notes = g.Description,
                    UpdatedUtc = DateTime.UtcNow,
                });
            }
            else
            {
                existing.Title = g.Summary ?? existing.Title;
                existing.StartUtc = startUtc;
                existing.EndUtc = endUtc;
                existing.Location = g.Location;
                existing.Notes = g.Description;
                existing.UpdatedUtc = DateTime.UtcNow;
            }
        }
        await _db.SaveChangesAsync(ct);
    }

    private static object ToGoogle(CalendarEventInput input) => new
    {
        summary = input.Title,
        location = input.Location,
        description = input.Notes,
        start = new { dateTime = Iso(input.StartUtc), timeZone = "UTC" },
        end = new { dateTime = Iso(input.EndUtc), timeZone = "UTC" },
    };

    private async Task<HttpResponseMessage> SendAsync(HttpMethod method, string url, object? body, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(method, url);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _accessToken);
        if (body is not null) req.Content = JsonContent.Create(body);
        var res = await _http.SendAsync(req, ct);
        res.EnsureSuccessStatusCode();
        return res;
    }

    private async Task EnsureAuthedAsync(CancellationToken ct)
    {
        if (_accessToken is not null && DateTime.UtcNow - _tokenAcquiredUtc < TokenLifetime) return;
        await _authLock.WaitAsync(ct);
        try
        {
            if (_accessToken is not null && DateTime.UtcNow - _tokenAcquiredUtc < TokenLifetime) return;
            var form = new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["client_id"] = _options.ClientId!,
                ["client_secret"] = _options.ClientSecret!,
                ["refresh_token"] = _options.RefreshToken!,
                ["grant_type"] = "refresh_token",
            });
            var res = await _http.PostAsync(_options.TokenUrl, form, ct);
            res.EnsureSuccessStatusCode();
            var token = await res.Content.ReadFromJsonAsync<TokenResponse>(ct);
            _accessToken = token?.AccessToken ?? throw new InvalidOperationException("Google token refresh returned no access_token.");
            _tokenAcquiredUtc = DateTime.UtcNow;
        }
        finally
        {
            _authLock.Release();
        }
    }

    private static string Iso(DateTime utc) =>
        DateTime.SpecifyKind(utc, DateTimeKind.Utc).ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);

    // ---- Google response shapes (partial) ----
    private sealed record TokenResponse(string? AccessToken);
    private sealed record GEventList(List<GEvent>? Items);
    private sealed record GEvent(string? Id, string? Summary, string? Location, string? Description, GTime? Start, GTime? End);
    private sealed record GTime(DateTimeOffset? DateTime, DateTime? Date)
    {
        /// <summary>Timed events use dateTime; all-day events use date (midnight).</summary>
        public DateTime? EffectiveUtc =>
            DateTime?.UtcDateTime ?? (Date is { } d ? System.DateTime.SpecifyKind(d, DateTimeKind.Utc) : null);
    }
}
