namespace HomeHub.Api.Calendar;

using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using HomeHub.Api.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

/// <summary>
/// Real Google Calendar (v3) provider. Each profile links its own Google account
/// (<see cref="GoogleAccountLink"/>); the panel shows the *active* profile's selected calendars,
/// mirroring how Microsoft To Do handles per-profile lists. Events are mirrored into the local
/// <see cref="CalendarEvent"/> table as an offline cache, tagged with the owning profile + calendar.
/// Only used behind <see cref="ICalendarProvider"/>, and only when the OAuth app is configured.
/// Owner tags (WHO chips) stay local — not pushed to Google.
/// </summary>
public sealed class GoogleCalendarProvider : ICalendarProvider, ICalendarListSyncProvider
{
    private static readonly TimeSpan TokenLifetime = TimeSpan.FromMinutes(55);

    // Access tokens are cached per profile (a profile == one Google account).
    private static readonly ConcurrentDictionary<int, (string Token, DateTime AcquiredUtc)> Tokens = new();

    private readonly HttpClient _http;
    private readonly HomeHubDbContext _db;
    private readonly GoogleCalendarOptions _options;
    private readonly ILogger<GoogleCalendarProvider> _logger;

    public GoogleCalendarProvider(
        HttpClient http, HomeHubDbContext db, IOptions<GoogleCalendarOptions> options, ILogger<GoogleCalendarProvider> logger)
    {
        _http = http;
        _db = db;
        _options = options.Value;
        _logger = logger;
    }

    public string Source => "google";

    public async Task<IReadOnlyList<CalendarEvent>> ListAsync(int? profileId, DateTime fromUtc, DateTime toUtc, CancellationToken ct)
    {
        // Sync the requested profile's calendars (or every linked profile's when unscoped), then
        // serve the cache. Each profile's sync is isolated so one failing account can't blank another.
        var links = await ResolveLinksAsync(profileId, ct);

        // A scoped profile with no linked account must show nothing — drop any Google events cached
        // under it (e.g. left over from the earlier shared-token setup). Only when we KNOW there's no
        // link (not merely offline), so a linked-but-unreachable account keeps serving its cache.
        if (profileId is { } orphanPid && links.Count == 0)
        {
            var orphans = await _db.CalendarEvents.Where(e => e.Source == Source && e.ProfileId == orphanPid).ToListAsync(ct);
            if (orphans.Count > 0)
            {
                _db.CalendarEvents.RemoveRange(orphans);
                await _db.SaveChangesAsync(ct);
            }
        }

        foreach (var link in links)
        {
            try { await SyncProfileRangeAsync(link, fromUtc, toUtc, ct); }
            catch (Exception ex) { _logger.LogWarning(ex, "Google Calendar sync failed for profile {Profile}; serving cache.", link.ProfileId); }
        }

        // Only Google-sourced rows; scope to the profile when given (stale "local" seed rows never surface).
        var query = _db.CalendarEvents.Where(e => e.Source == Source && e.StartUtc < toUtc && e.EndUtc > fromUtc);
        if (profileId is { } pid) query = query.Where(e => e.ProfileId == pid);
        return await query.OrderBy(e => e.StartUtc).ToListAsync(ct);
    }

    public async Task<CalendarEvent?> GetAsync(int id, CancellationToken ct) =>
        await _db.CalendarEvents.FindAsync([id], ct);

    public async Task<CalendarEvent> CreateAsync(CalendarEventInput input, CancellationToken ct)
    {
        var entity = new CalendarEvent
        {
            Source = Source,
            ProfileId = input.ProfileId,
            Title = input.Title.Trim(),
            StartUtc = input.StartUtc,
            EndUtc = input.EndUtc,
            Location = input.Location,
            Notes = input.Notes,
            OwnerTags = input.OwnersCsv,
            UpdatedUtc = DateTime.UtcNow,
        };

        var link = input.ProfileId is { } pid ? await ResolveLinkAsync(pid, ct) : null;
        if (link is not null)
        {
            var (calendarId, calendarName) = await ResolveTargetCalendarAsync(link, input.GoogleCalendarId, ct);
            entity.GoogleCalendarId = calendarId;
            entity.CalendarName = calendarName;
            var created = await SendAsync<GEvent>(link, HttpMethod.Post,
                $"/calendars/{Uri.EscapeDataString(calendarId)}/events", ToGoogle(input), ct);
            entity.GoogleId = created?.Id;
        }
        // No linked account → persists locally (no GoogleId), still visible on the panel.

        _db.CalendarEvents.Add(entity);
        await _db.SaveChangesAsync(ct);
        return entity;
    }

    public async Task<CalendarEvent?> UpdateAsync(int id, CalendarEventInput input, int? baseVersion, CancellationToken ct)
    {
        var entity = await _db.CalendarEvents.FindAsync([id], ct);
        if (entity is null) return null;
        if (baseVersion is { } v && v != entity.Version) throw new ConcurrencyConflictException(CalendarEventDto.From(entity));

        entity.Title = input.Title.Trim();
        entity.StartUtc = input.StartUtc;
        entity.EndUtc = input.EndUtc;
        entity.Location = input.Location;
        entity.Notes = input.Notes;
        entity.OwnerTags = input.OwnersCsv;
        entity.UpdatedUtc = DateTime.UtcNow;
        entity.Version++;

        var link = entity.ProfileId is { } pid ? await ResolveLinkAsync(pid, ct) : null;
        if (link is not null && !string.IsNullOrEmpty(entity.GoogleId) && !string.IsNullOrEmpty(entity.GoogleCalendarId))
        {
            await SendAsync<GEvent>(link, HttpMethod.Patch,
                $"/calendars/{Uri.EscapeDataString(entity.GoogleCalendarId)}/events/{entity.GoogleId}", ToGoogle(input), ct);
        }
        await _db.SaveChangesAsync(ct);
        return entity;
    }

    public async Task<bool> DeleteAsync(int id, int? baseVersion, CancellationToken ct)
    {
        var entity = await _db.CalendarEvents.FindAsync([id], ct);
        if (entity is null) return false;
        if (baseVersion is { } v && v != entity.Version) throw new ConcurrencyConflictException(CalendarEventDto.From(entity));

        var link = entity.ProfileId is { } pid ? await ResolveLinkAsync(pid, ct) : null;
        if (link is not null && !string.IsNullOrEmpty(entity.GoogleId) && !string.IsNullOrEmpty(entity.GoogleCalendarId))
        {
            // Treat 404/410 as success — the event is already gone upstream, which is the goal.
            await SendAsync<object>(link, HttpMethod.Delete,
                $"/calendars/{Uri.EscapeDataString(entity.GoogleCalendarId)}/events/{entity.GoogleId}", null, ct,
                tolerateMissing: true);
        }
        _db.CalendarEvents.Remove(entity);
        await _db.SaveChangesAsync(ct);
        return true;
    }

    // ---- List-sync capability (choose which calendars display) ----

    public async Task<IReadOnlyList<SyncCalendarDto>> GetCalendarsAsync(int profileId, CancellationToken ct)
    {
        var link = await ResolveLinkAsync(profileId, ct);
        if (link is null) return [];
        var all = await FetchCalendarsAsync(link, ct);

        var selected = (await _db.SyncedCalendars.Where(s => s.ProfileId == profileId).Select(s => s.GoogleCalendarId).ToListAsync(ct)).ToHashSet();
        // Not yet configured → everything reads as selected (matches the sync default).
        return all
            .Select(c => new SyncCalendarDto(c.Id!, c.Summary ?? c.Id!, !link.CalendarsConfigured || selected.Contains(c.Id!)))
            .ToList();
    }

    public async Task SetSelectedCalendarsAsync(int profileId, IReadOnlyList<string> selectedCalendarIds, CancellationToken ct)
    {
        var link = await _db.GoogleAccountLinks.FindAsync([profileId], ct);
        if (link is null) return; // no linked account for this profile — nothing to select

        var all = await FetchCalendarsAsync(link, ct);
        var byId = all.Where(c => c.Id is not null).ToDictionary(c => c.Id!, c => c.Summary ?? c.Id!);
        var chosen = selectedCalendarIds.Where(byId.ContainsKey).Distinct().ToList();

        var existing = await _db.SyncedCalendars.Where(s => s.ProfileId == profileId).ToListAsync(ct);
        _db.SyncedCalendars.RemoveRange(existing);
        foreach (var cid in chosen)
            _db.SyncedCalendars.Add(new SyncedCalendar { ProfileId = profileId, GoogleCalendarId = cid, CalendarName = byId[cid] });
        link.CalendarsConfigured = true;

        // Immediately drop cached events from deselected calendars (the next sync would prune anyway).
        var stale = await _db.CalendarEvents
            .Where(e => e.Source == Source && e.ProfileId == profileId && e.GoogleCalendarId != null && !chosen.Contains(e.GoogleCalendarId))
            .ToListAsync(ct);
        _db.CalendarEvents.RemoveRange(stale);
        await _db.SaveChangesAsync(ct);
    }

    // ---- Sync ----

    private async Task SyncProfileRangeAsync(GoogleAccountLink link, DateTime fromUtc, DateTime toUtc, CancellationToken ct)
    {
        var all = (await FetchCalendarsAsync(link, ct)).Where(c => c.Id is not null).ToList();

        // Once the profile has chosen calendars, restrict to those (may be none); else sync all.
        if (link.CalendarsConfigured)
        {
            var selected = (await _db.SyncedCalendars.Where(s => s.ProfileId == link.ProfileId).Select(s => s.GoogleCalendarId).ToListAsync(ct)).ToHashSet();
            all = all.Where(c => selected.Contains(c.Id!)).ToList();
        }

        var selectedIds = all.Select(c => c.Id!).ToHashSet(StringComparer.Ordinal);

        // Preload this profile's cached rows in-range, indexed by Google event id. Any *pre-existing*
        // duplicates (same id twice) are collapsed here — keep the first, delete the rest. Using this
        // as the upsert target also means a repeated id within one sync updates the same row instead
        // of inserting a second (a DB lookup wouldn't see rows added-but-not-yet-saved this round).
        var existingRows = await _db.CalendarEvents
            .Where(e => e.Source == Source && e.ProfileId == link.ProfileId && e.GoogleId != null && e.StartUtc < toUtc && e.EndUtc > fromUtc)
            .ToListAsync(ct);
        var byId = new Dictionary<string, CalendarEvent>(StringComparer.Ordinal);
        foreach (var row in existingRows)
            if (!byId.TryAdd(row.GoogleId!, row)) _db.CalendarEvents.Remove(row);

        var seen = new HashSet<string>(StringComparer.Ordinal);
        var fetchedIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var cal in all)
        {
            try
            {
                var url = $"/calendars/{Uri.EscapeDataString(cal.Id!)}/events"
                    + $"?singleEvents=true&orderBy=startTime&timeMin={Iso(fromUtc)}&timeMax={Iso(toUtc)}";
                var list = await SendAsync<GEventList>(link, HttpMethod.Get, url, null, ct);
                fetchedIds.Add(cal.Id!);
                foreach (var g in list?.Items ?? [])
                {
                    if (g.Id is null || g.Start?.EffectiveUtc is not { } startUtc) continue;
                    seen.Add(g.Id);
                    if (!byId.TryGetValue(g.Id, out var ev))
                    {
                        ev = new CalendarEvent { GoogleId = g.Id, ProfileId = link.ProfileId, Source = Source, Title = "" };
                        _db.CalendarEvents.Add(ev);
                        byId[g.Id] = ev;
                    }
                    ev.Title = g.Summary ?? "(untitled)";
                    ev.StartUtc = startUtc;
                    ev.EndUtc = g.End?.EffectiveUtc ?? startUtc.AddHours(1);
                    ev.Location = g.Location;
                    ev.Notes = g.Description;
                    ev.GoogleCalendarId = cal.Id;
                    ev.CalendarName = cal.Summary;
                    ev.UpdatedUtc = DateTime.UtcNow;
                }
            }
            catch (Exception ex)
            {
                // One calendar failing (e.g. Google's synthesized "Birthdays" calendar, which the API
                // won't serve events for, or a transient permission blip) must not blank the others or
                // wrongly prune its cache. Skip it this round; its events stay put.
                _logger.LogWarning(ex, "Google calendar {Calendar} fetch failed; keeping its cached events.", cal.Id);
            }
        }

        // Prune from the collapsed set: drop rows on a now-deselected calendar, or that a *successfully
        // fetched* calendar no longer returns (deleted upstream). Rows on a calendar that failed to
        // fetch this round are kept (seen would be incomplete for it).
        foreach (var ev in byId.Values)
        {
            if (_db.Entry(ev).State is EntityState.Deleted or EntityState.Added) continue;
            var calId = ev.GoogleCalendarId;
            if (calId is null || !selectedIds.Contains(calId) || (fetchedIds.Contains(calId) && !seen.Contains(ev.GoogleId!)))
                _db.CalendarEvents.Remove(ev);
        }

        // Always persist — upserts must save even when nothing was pruned (e.g. the first sync into an
        // empty cache), otherwise new events never reach the DB the outer query reads.
        await _db.SaveChangesAsync(ct);
    }

    private async Task<List<GCalendar>> FetchCalendarsAsync(GoogleAccountLink link, CancellationToken ct)
    {
        var list = await SendAsync<GCalendarList>(link, HttpMethod.Get, "/users/me/calendarList", null, ct);
        return (list?.Items ?? []).Where(c => c.Id is not null).ToList();
    }

    /// <summary>Resolve the calendar a new event goes to: the caller's preferred id, else the link's primary.</summary>
    private async Task<(string Id, string? Name)> ResolveTargetCalendarAsync(GoogleAccountLink link, string? preferredCalendarId, CancellationToken ct)
    {
        var all = await FetchCalendarsAsync(link, ct);
        GCalendar? Match(string? id) => id is null ? null : all.FirstOrDefault(c => c.Id == id);
        var chosen = Match(preferredCalendarId)
            ?? Match(link.PrimaryCalendarId)
            ?? all.FirstOrDefault(c => c.Primary == true)
            ?? all.FirstOrDefault();
        // Fall back to the literal "primary" alias if the account exposes no list (unlikely).
        return chosen?.Id is { } cid ? (cid, chosen.Summary) : (link.PrimaryCalendarId ?? "primary", null);
    }

    // ---- Account links (persisted, else the single-token fallback) ----

    private async Task<IReadOnlyList<GoogleAccountLink>> ResolveLinksAsync(int? profileId, CancellationToken ct)
    {
        if (profileId is { } pid)
        {
            var one = await ResolveLinkAsync(pid, ct);
            return one is null ? [] : [one];
        }
        // Unscoped: every persisted link (no fallback — it needs a target profile).
        return await _db.GoogleAccountLinks.ToListAsync(ct);
    }

    // Strictly per-profile: a profile shows calendars only when it has its own GoogleAccountLink
    // (same model as Microsoft To Do's per-profile MicrosoftAccountLink). No shared fallback.
    private async Task<GoogleAccountLink?> ResolveLinkAsync(int profileId, CancellationToken ct) =>
        await _db.GoogleAccountLinks.FindAsync([profileId], ct);

    // ---- HTTP + auth ----

    private async Task<T?> SendAsync<T>(GoogleAccountLink link, HttpMethod method, string path, object? body, CancellationToken ct, bool tolerateMissing = false)
    {
        var token = await GetTokenAsync(link, ct);
        using var req = new HttpRequestMessage(method, _options.ApiBaseUrl + path);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        if (body is not null) req.Content = JsonContent.Create(body);
        using var res = await _http.SendAsync(req, ct);
        if (!res.IsSuccessStatusCode)
        {
            if (tolerateMissing && res.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Gone) return default;
            var err = await res.Content.ReadAsStringAsync(ct);
            if (err.Length > 500) err = err[..500];
            throw new HttpRequestException($"Google {method} {path} failed: {(int)res.StatusCode} {res.StatusCode} — {err}", null, res.StatusCode);
        }
        if (res.Content.Headers.ContentLength is 0 or null) return default;
        return await res.Content.ReadFromJsonAsync<T>(ct);
    }

    private async Task<string> GetTokenAsync(GoogleAccountLink link, CancellationToken ct)
    {
        if (Tokens.TryGetValue(link.ProfileId, out var cached) && DateTime.UtcNow - cached.AcquiredUtc < TokenLifetime)
            return cached.Token;

        var form = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["client_id"] = _options.ClientId!,
            ["client_secret"] = _options.ClientSecret!,
            ["refresh_token"] = link.RefreshToken,
            ["grant_type"] = "refresh_token",
        });
        var res = await _http.PostAsync(_options.TokenUrl, form, ct);
        res.EnsureSuccessStatusCode();
        var token = await res.Content.ReadFromJsonAsync<TokenResponse>(ct);
        var access = token?.AccessToken ?? throw new InvalidOperationException("Google token refresh returned no access_token.");
        Tokens[link.ProfileId] = (access, DateTime.UtcNow);
        return access;
    }

    private static object ToGoogle(CalendarEventInput input) => new
    {
        summary = input.Title,
        location = input.Location,
        description = input.Notes,
        start = new { dateTime = Iso(input.StartUtc), timeZone = "UTC" },
        end = new { dateTime = Iso(input.EndUtc), timeZone = "UTC" },
    };

    private static string Iso(DateTime utc) =>
        DateTime.SpecifyKind(utc, DateTimeKind.Utc).ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);

    // ---- Google response shapes (partial) ----
    // OAuth token endpoint returns snake_case (access_token); map it explicitly.
    private sealed record TokenResponse([property: JsonPropertyName("access_token")] string? AccessToken);
    private sealed record GCalendarList(List<GCalendar>? Items);
    private sealed record GCalendar(string? Id, string? Summary, bool? Primary);
    private sealed record GEventList(List<GEvent>? Items);
    private sealed record GEvent(string? Id, string? Summary, string? Location, string? Description, GTime? Start, GTime? End);
    private sealed record GTime(DateTimeOffset? DateTime, DateTime? Date)
    {
        /// <summary>
        /// Timed events carry a full <c>dateTime</c> with an offset, so UTC is exact. All-day events
        /// carry only a bare <c>date</c> ("2026-07-07"), which is a *local calendar date*, not a UTC
        /// instant — treating it as UTC midnight renders it on the previous day for any timezone
        /// behind UTC. Anchor it to local midnight and convert, so the day is preserved.
        /// </summary>
        public DateTime? EffectiveUtc =>
            DateTime?.UtcDateTime
            ?? (Date is { } d ? System.DateTime.SpecifyKind(d, DateTimeKind.Local).ToUniversalTime() : null);
    }
}
