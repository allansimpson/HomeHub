namespace HomeHub.Api.Calendar;

using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using HomeHub.Api.Calendar.Capture;
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

    /// <summary>
    /// Forget a profile's cached access token, after its link has been re-authorised.
    /// </summary>
    /// <remarks>
    /// Access tokens are cached for 55 minutes, so without this a freshly re-linked account would
    /// keep failing with the old credentials for up to an hour — and look like the re-link had not
    /// worked.
    /// </remarks>
    public static void ForgetToken(int profileId) => Tokens.TryRemove(profileId, out _);

    private readonly HttpClient _http;
    private readonly HomeHubDbContext _db;
    private readonly GoogleCalendarOptions _options;
    private readonly ILogger<GoogleCalendarProvider> _logger;
    /// <summary>Kept photographs, so a sync that prunes engagements can release theirs.</summary>
    private readonly EventPhotoStore _photos;

    public GoogleCalendarProvider(
        HttpClient http, HomeHubDbContext db, IOptions<GoogleCalendarOptions> options,
        EventPhotoStore photos, ILogger<GoogleCalendarProvider> logger)
    {
        _http = http;
        _db = db;
        _options = options.Value;
        _photos = photos;
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
            // A caller that went away is not a Google failure — see MicrosoftTodoProvider.
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
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
            IsAllDay = input.IsAllDay,
            Location = input.Location,
            Notes = input.Notes,
            OwnerTags = input.OwnersCsv,
            Mark = input.NormalizedMark,
            // Local like Mark — Google has nowhere to put either — and create-time only.
            FromPhoto = input.FromPhoto,
            PhotoFile = input.PhotoFile,
            PhotoTakenUtc = input.PhotoTakenUtc,
            CreatedUtc = DateTime.UtcNow,
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
        entity.IsAllDay = input.IsAllDay;
        entity.Location = input.Location;
        entity.Notes = input.Notes;
        entity.OwnerTags = input.OwnersCsv;
        entity.Mark = input.NormalizedMark;
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

        // A revoked token deliberately propagates as GoogleAuthException rather than being swallowed
        // into an empty list. "This account has no calendars" and "we could not ask this account"
        // are different facts, and only one of them tells you to go and sign in again. The controller
        // turns it into a 409 the settings screen can render honestly.
        var all = await FetchCalendarsAsync(link, ct);

        var rows = await _db.SyncedCalendars.Where(s => s.ProfileId == profileId).ToDictionaryAsync(s => s.GoogleCalendarId, ct);
        // Not yet configured → everything reads as selected (matches the sync default).
        return all
            .Select(c => new SyncCalendarDto(
                c.Id!,
                c.Summary ?? c.Id!,
                !link.CalendarsConfigured || rows.ContainsKey(c.Id!),
                rows.TryGetValue(c.Id!, out var row) ? row.Icon : null,
                CanWrite(c.AccessRole),
                c.Primary == true || c.Id == link.PrimaryCalendarId))
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
        // Carry icons across the rebuild: toggling a calendar off and on again is a visibility change,
        // not a request to forget which icon it was given.
        var icons = existing.Where(s => s.Icon is not null).ToDictionary(s => s.GoogleCalendarId, s => s.Icon);
        _db.SyncedCalendars.RemoveRange(existing);
        foreach (var cid in chosen)
            _db.SyncedCalendars.Add(new SyncedCalendar
            {
                ProfileId = profileId,
                GoogleCalendarId = cid,
                CalendarName = byId[cid],
                Icon = icons.TryGetValue(cid, out var icon) ? icon : null,
            });
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
                    // Which field Google sent *is* the answer, so a synced row carries the fact
                    // rather than leaving the panel to infer it from the boundaries.
                    ev.IsAllDay = g.Start?.Date is not null;
                    ev.Location = g.Location;
                    ev.Notes = g.Description;
                    ev.GoogleCalendarId = cal.Id;
                    ev.CalendarName = cal.Summary;
                    ev.GoogleEventType = g.EventType;
                    ev.GoogleBirthdayType = g.BirthdayProperties?.Type;
                    ev.UpdatedUtc = DateTime.UtcNow;
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
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
        var prunedAPhotograph = false;
        foreach (var ev in byId.Values)
        {
            if (_db.Entry(ev).State is EntityState.Deleted or EntityState.Added) continue;
            var calId = ev.GoogleCalendarId;
            if (calId is null || !selectedIds.Contains(calId) || (fetchedIds.Contains(calId) && !seen.Contains(ev.GoogleId!)))
            {
                if (ev.PhotoFile is not null) prunedAPhotograph = true;
                _db.CalendarEvents.Remove(ev);
            }
        }

        // Always persist — upserts must save even when nothing was pruned (e.g. the first sync into an
        // empty cache), otherwise new events never reach the DB the outer query reads.
        await _db.SaveChangesAsync(ct);

        /*
         * Tidy the photographs those rows were holding.
         *
         * <b>The one deletion path nobody walks.</b> A person removing an engagement releases its
         * photograph on the way out; a sync removes engagements without anybody pressing anything —
         * a calendar deselected here, an event deleted on somebody's phone — and until now the files
         * stayed on disk for ever with nothing on any screen pointing at them. A photograph of the
         * household's post outliving every reference to it is precisely the leak this feature must
         * not have.
         *
         * Only when a pruned row actually held one, so an ordinary sync — which is most of them —
         * costs nothing at all. The set is read back from the database rather than inferred from
         * what went, because one flyer can back four engagements and the file is shared.
         */
        if (prunedAPhotograph)
        {
            var referenced = await _db.CalendarEvents
                .Where(e => e.PhotoFile != null)
                .Select(e => e.PhotoFile!)
                .Distinct()
                .ToListAsync(ct);
            _photos.Sweep(referenced.ToHashSet(StringComparer.Ordinal), DateTime.UtcNow);
        }
    }

    private async Task<List<GCalendar>> FetchCalendarsAsync(GoogleAccountLink link, CancellationToken ct)
    {
        var list = await SendAsync<GCalendarList>(link, HttpMethod.Get, "/users/me/calendarList", null, ct);
        return (list?.Items ?? []).Where(c => c.Id is not null).ToList();
    }

    /// <summary>
    /// Store a calendar's icon, creating the row when the profile has never made an explicit
    /// selection.
    /// </summary>
    /// <remarks>
    /// The subtlety is that <see cref="SyncedCalendar"/> rows exist only once a profile has *chosen*
    /// calendars. Before that, <see cref="GetCalendarsAsync"/> reports every calendar as selected via
    /// the <c>!CalendarsConfigured</c> branch while the table is still empty — so a freshly linked
    /// account has no row to hang an icon on, and the old code returned silently. The panel showed
    /// the mark optimistically, the API answered 204, and the choice was gone on the next read.
    ///
    /// <para>Creating the row in that state cannot change what is displayed: with
    /// <c>CalendarsConfigured == false</c> every calendar is selected regardless of rows, and
    /// <see cref="SyncProfileRangeAsync"/> applies no restriction either.</para>
    ///
    /// <para>Once a profile *has* chosen, a missing row means the calendar was deliberately
    /// deselected. That is reported as a failure rather than fixed by creating a row, because doing
    /// so would silently make a hidden calendar visible — a bigger surprise than the refusal.</para>
    /// </remarks>
    public async Task<bool> SetCalendarIconAsync(int profileId, string calendarId, string? icon, CancellationToken ct)
    {
        var trimmed = string.IsNullOrWhiteSpace(icon) ? null : icon.Trim();

        var row = await _db.SyncedCalendars.FirstOrDefaultAsync(
            s => s.ProfileId == profileId && s.GoogleCalendarId == calendarId, ct);

        if (row is null)
        {
            var link = await ResolveLinkAsync(profileId, ct);
            if (link is null) return false;
            // Explicitly chosen calendars ⇒ a missing row is a deselected calendar, not a gap.
            if (link.CalendarsConfigured) return false;

            var name = (await FetchCalendarsAsync(link, ct))
                .FirstOrDefault(c => c.Id == calendarId)?.Summary ?? calendarId;
            row = new SyncedCalendar { ProfileId = profileId, GoogleCalendarId = calendarId, CalendarName = name };
            _db.SyncedCalendars.Add(row);
        }

        row.Icon = trimmed;
        await _db.SaveChangesAsync(ct);
        return true;
    }

    /// <summary>Only these roles may create an event; Google's other roles are read-only.</summary>
    private static bool CanWrite(string? accessRole) => accessRole is "owner" or "writer" or null;

    /// <summary>Resolve the calendar a new event goes to: the caller's preferred id, else the link's primary.</summary>
    private async Task<(string Id, string? Name)> ResolveTargetCalendarAsync(GoogleAccountLink link, string? preferredCalendarId, CancellationToken ct)
    {
        var all = await FetchCalendarsAsync(link, ct);
        // A read-only calendar is not a target: fall through to the primary rather than posting an
        // event Google will refuse.
        GCalendar? Match(string? id) => id is null ? null : all.FirstOrDefault(c => c.Id == id && CanWrite(c.AccessRole));
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
        if (!res.IsSuccessStatusCode)
        {
            // Google explains itself in the body — `invalid_grant`, "Token has been expired or
            // revoked", and so on. `EnsureSuccessStatusCode` throws that away and leaves only
            // "400 (Bad Request)", which says nothing about what to do. Same treatment the API calls
            // in SendAsync already get.
            var err = await res.Content.ReadAsStringAsync(ct);
            if (err.Length > 500) err = err[..500];
            throw new GoogleAuthException(
                $"Google refused the refresh token for profile {link.ProfileId}: {(int)res.StatusCode} — {err}");
        }
        var token = await res.Content.ReadFromJsonAsync<TokenResponse>(ct);
        var access = token?.AccessToken ?? throw new InvalidOperationException("Google token refresh returned no access_token.");
        Tokens[link.ProfileId] = (access, DateTime.UtcNow);
        return access;
    }

    /// <summary>
    /// The event as Google wants it — a timed event, or an all-day one.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>All-day is a different shape, not a different time.</b> Google distinguishes the two by
    /// which field is present: a timed event carries <c>dateTime</c>, an all-day event carries a
    /// bare <c>date</c>. Sending midnight-to-midnight as a <c>dateTime</c> produces an event every
    /// other device in the house renders at 00:00 — or, once its own offset is applied, on the
    /// evening before. That is why <see cref="CalendarEvent.IsAllDay"/> had to become a stored flag:
    /// nothing else survives the round trip.
    /// </para>
    /// <para>
    /// <b>The dates are read back in the same zone they were written in.</b> <c>date</c> is a local
    /// calendar date with no offset, so this is the exact inverse of <see cref="GTime.EffectiveUtc"/>
    /// — which anchors a bare date to local midnight — and the pair round-trips as long as the
    /// server and the panel share a timezone, which in a house they do. Google's end date is
    /// <b>exclusive</b>, and so is <see cref="CalendarEventInput.EndUtc"/> for an all-day event, so
    /// the conversion is the same on both ends.
    /// </para>
    /// </remarks>
    internal static object ToGoogle(CalendarEventInput input) => input.IsAllDay
        ? new
        {
            summary = input.Title,
            location = input.Location,
            description = input.Notes,
            start = new { date = LocalDate(input.StartUtc) },
            end = new { date = LocalDate(input.EndUtc) },
        }
        : new
        {
            summary = input.Title,
            location = input.Location,
            description = input.Notes,
            start = new { dateTime = Iso(input.StartUtc), timeZone = "UTC" },
            end = new { dateTime = Iso(input.EndUtc), timeZone = "UTC" },
        };

    private static string Iso(DateTime utc) =>
        DateTime.SpecifyKind(utc, DateTimeKind.Utc).ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);

    /// <summary>The calendar date a UTC instant falls on locally, as Google's bare <c>date</c>.</summary>
    private static string LocalDate(DateTime utc) =>
        DateTime.SpecifyKind(utc, DateTimeKind.Utc).ToLocalTime().ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    // ---- Google response shapes (partial) ----
    // OAuth token endpoint returns snake_case (access_token); map it explicitly.
    private sealed record TokenResponse([property: JsonPropertyName("access_token")] string? AccessToken);
    private sealed record GCalendarList(List<GCalendar>? Items);
    /// <summary><c>AccessRole</c> is this account's role on the calendar: owner/writer can add events;
    /// reader/freeBusyReader cannot (holiday calendars and other people's shared ones).</summary>
    private sealed record GCalendar(string? Id, string? Summary, bool? Primary, string? AccessRole);
    private sealed record GEventList(List<GEvent>? Items);
    private sealed record GEvent(
        string? Id, string? Summary, string? Location, string? Description, GTime? Start, GTime? End,
        string? EventType, GBirthdayProperties? BirthdayProperties);

    /// <summary>Present only on <c>eventType: "birthday"</c> events; <c>Type</c> separates the anniversaries.</summary>
    private sealed record GBirthdayProperties(string? Type);
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

/// <summary>
/// Google refused the refresh token — the account link needs re-authorising.
/// </summary>
/// <remarks>
/// Its own type because it needs its own treatment: this is not a transient upstream failure to be
/// retried, and it is not a bug in this app. It means a person has to sign in again, so callers
/// degrade to "not connected" rather than surfacing a 500 on a screen that has nothing to do with
/// Google. Google's own explanation (<c>invalid_grant</c>, "Token has been expired or revoked")
/// travels in the message.
/// </remarks>
public sealed class GoogleAuthException : Exception
{
    public GoogleAuthException(string message) : base(message) { }
}
