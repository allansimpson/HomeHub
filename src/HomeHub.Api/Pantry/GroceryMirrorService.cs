namespace HomeHub.Api.Pantry;

using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using HomeHub.Api.Data;
using HomeHub.Api.Tasks;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

/// <summary>
/// Projects the household's <see cref="GroceryLine"/>s into a Microsoft To Do list, and reads
/// completions back (PANTRY_DATA_CONTRACT §4).
/// </summary>
/// <remarks>
/// <b>HomeHub owns the list; To Do is the projection.</b> That direction is the whole design
/// (DECISIONS P8) and it decides every conflict below: provenance is never overwritten by a
/// down-sync, and a task completed in To Do runs the same check path the panel does — which is what
/// makes ticking something off in an aisle put stock back on the shelf at home.
/// <para>
/// <b>Never drop, never duplicate</b> (PANTRY_BEHAVIOURS §8). Both are enforced by dedupe on
/// <see cref="GroceryLine.TodoTaskId"/> rather than hoped for, and a failed push leaves
/// <see cref="GroceryLine.MirrorPending"/> set so it survives a restart. When the mirror is down the
/// strip turns amber in place and states what it will do next; it does not silently give up.
/// </para>
/// </remarks>
public sealed class GroceryMirrorService
{
    /// <summary>Access tokens live ~1h; refresh a little early, matching the Tasks provider.</summary>
    private static readonly TimeSpan TokenLifetime = TimeSpan.FromMinutes(55);

    private static readonly ConcurrentDictionary<int, (string Token, DateTime AcquiredUtc)> Tokens = new();

    /// <summary>Set by write paths so the background loop syncs on the next tick instead of waiting.</summary>
    private static int _dirty;

    private readonly IServiceScopeFactory _scopes;
    private readonly HttpClient _http;
    private readonly MicrosoftTodoOptions _options;
    private readonly TimeProvider _clock;
    private readonly ILogger<GroceryMirrorService> _logger;

    public GroceryMirrorService(
        IServiceScopeFactory scopes,
        HttpClient http,
        IOptions<MicrosoftTodoOptions> options,
        TimeProvider clock,
        ILogger<GroceryMirrorService> logger)
    {
        _scopes = scopes;
        _http = http;
        _options = options.Value;
        _clock = clock;
        _logger = logger;
    }

    /// <summary>Nudge the background loop. Cheap and idempotent — callers do not await the sync.</summary>
    public void RequestSync() => Interlocked.Exchange(ref _dirty, 1);

    internal static bool TakeDirty() => Interlocked.Exchange(ref _dirty, 0) == 1;

    /// <summary>
    /// The strip's four states. <b>All four are supported</b> — mirroring off is a normal way to run
    /// the section, not a degraded one (PANTRY_BEHAVIOURS §8).
    /// </summary>
    public async Task<MirrorStatusDto> StatusAsync(CancellationToken ct)
    {
        using var scope = _scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();

        var settings = await db.GroceryMirror.FirstOrDefaultAsync(m => m.Id == 1, ct);
        var queued = await db.GroceryLines.CountAsync(l => l.MirrorPending, ct);

        if (settings?.TodoListId is null || settings.OwnerProfileId is null)
        {
            return new MirrorStatusDto("Off", null, null, null, null, 0, null);
        }

        var owner = await db.Profiles
            .Where(p => p.Id == settings.OwnerProfileId)
            .Select(p => p.Name)
            .FirstOrDefaultAsync(ct);

        // The owning profile leaving is its own state: the list is still the household's, but nobody
        // can reach it until a new owner is named. Silently stopping would be the worst option.
        var link = await db.MicrosoftAccountLinks
            .FirstOrDefaultAsync(l => l.ProfileId == settings.OwnerProfileId, ct);
        if (owner is null || link is null)
        {
            return new MirrorStatusDto(
                "SignInExpired", settings.TodoListName, owner, settings.LastSyncedUtc,
                settings.LastAttemptUtc, queued,
                owner is null
                    ? "The profile that owned this mirror is gone. Pick someone to own it."
                    : "Microsoft sign-in expired.");
        }

        if (settings.ConsecutiveFailures > 0)
        {
            return new MirrorStatusDto(
                "Failing", settings.TodoListName, owner, settings.LastSyncedUtc,
                settings.LastAttemptUtc, queued,
                settings.LastError ?? "Couldn't reach Microsoft To Do.");
        }

        return new MirrorStatusDto(
            "Healthy", settings.TodoListName, owner, settings.LastSyncedUtc,
            settings.LastAttemptUtc, queued, null);
    }

    /// <summary>Choose the list and the owning profile. A null list id turns mirroring off.</summary>
    public async Task ConfigureAsync(MirrorSettingsInput input, CancellationToken ct)
    {
        using var scope = _scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();

        var settings = await db.GroceryMirror.FirstOrDefaultAsync(m => m.Id == 1, ct)
            ?? Track(db, new GroceryMirrorSettings { Id = 1 });

        var changingList = settings.TodoListId != input.TodoListId;
        settings.TodoListId = string.IsNullOrWhiteSpace(input.TodoListId) ? null : input.TodoListId;
        settings.TodoListName = string.IsNullOrWhiteSpace(input.TodoListName) ? null : input.TodoListName;
        settings.OwnerProfileId = input.OwnerProfileId;
        settings.ConsecutiveFailures = 0;
        settings.LastError = null;

        if (changingList)
        {
            // Task ids belong to the list they were created in. Pointing at a different list without
            // clearing them would leave every line dedupe-matched against a task that isn't there,
            // and the new list would come up empty for ever.
            await db.GroceryLines.ForEachAsync(l => { l.TodoTaskId = null; l.MirrorPending = true; }, ct);
        }

        await db.SaveChangesAsync(ct);
        RequestSync();
    }

    /// <summary>Delete a line's mirrored task, best-effort, before the line goes.</summary>
    public async Task ForgetAsync(GroceryLine line, CancellationToken ct)
    {
        if (line.TodoTaskId is null) return;
        try
        {
            using var scope = _scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
            var (settings, link) = await ResolveAsync(db, ct);
            if (settings?.TodoListId is null || link is null) return;

            await SendAsync<object>(
                link, HttpMethod.Delete, $"/me/todo/lists/{settings.TodoListId}/tasks/{line.TodoTaskId}", null, ct);
        }
        catch (Exception ex)
        {
            // A task we cannot delete is litter in someone's To Do list, not a reason to refuse to
            // delete the line here. The list HomeHub owns stays authoritative.
            _logger.LogWarning(ex, "Grocery mirror: could not delete task {TaskId}", line.TodoTaskId);
        }
    }

    /// <summary>
    /// One full round trip: push everything pending, then read completions back.
    /// </summary>
    /// <returns>False when the mirror is off or unreachable — the caller records the failure.</returns>
    public async Task<bool> SyncAsync(CancellationToken ct)
    {
        using var scope = _scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();

        var (settings, link) = await ResolveAsync(db, ct);
        if (settings?.TodoListId is null || link is null) return false;

        var now = _clock.GetUtcNow().UtcDateTime;
        settings.LastAttemptUtc = now;

        try
        {
            await PushAsync(db, settings, link, ct);
            await PullAsync(db, settings, link, ct);

            settings.LastSyncedUtc = _clock.GetUtcNow().UtcDateTime;
            settings.ConsecutiveFailures = 0;
            settings.LastError = null;
            await db.SaveChangesAsync(ct);
            return true;
        }
        catch (Exception ex)
        {
            settings.ConsecutiveFailures++;
            settings.LastError = Summarise(ex);
            await db.SaveChangesAsync(ct);
            _logger.LogWarning(ex, "Grocery mirror sync failed (attempt {Count})", settings.ConsecutiveFailures);
            return false;
        }
    }

    /// <summary>
    /// Up: create, complete and re-open tasks from local changes.
    /// </summary>
    /// <remarks>
    /// <b>Provenance is deliberately not in the title.</b> §4 puts it in the task body instead, so a
    /// phone held up in an aisle reads "Lemons ×3" rather than "Lemons ×3 (Chicken Piccata · Wed ·
    /// Sheet-pan salmon · Fri)". The title is what someone shops from.
    /// </remarks>
    private async Task PushAsync(
        HomeHubDbContext db, GroceryMirrorSettings settings, MicrosoftAccountLink link, CancellationToken ct)
    {
        var pending = await db.GroceryLines
            .Include(l => l.Sources)
            .Where(l => l.MirrorPending)
            .ToListAsync(ct);

        foreach (var line in pending)
        {
            var body = new GraphTaskWrite(
                Title(line),
                line.CheckedAtUtc is null ? "notStarted" : "completed",
                new GraphBodyWrite(Provenance(line), "text"));

            if (line.TodoTaskId is null)
            {
                var created = await SendAsync<GraphTask>(
                    link, HttpMethod.Post, $"/me/todo/lists/{settings.TodoListId}/tasks", body, ct);
                line.TodoTaskId = created?.Id;
            }
            else
            {
                await SendAsync<GraphTask>(
                    link, HttpMethod.Patch,
                    $"/me/todo/lists/{settings.TodoListId}/tasks/{line.TodoTaskId}", body, ct);
            }

            line.MirrorPending = false;
        }

        await db.SaveChangesAsync(ct);
    }

    /// <summary>
    /// Down: a task completed in To Do checks the line here, and a task added there becomes a
    /// <see cref="GroceryLineSource.Hand"/> line.
    /// </summary>
    /// <remarks>
    /// The completion path deliberately does <b>not</b> write the pantry event itself — it sets
    /// <see cref="GroceryLine.CheckedAtUtc"/> and lets the ledger call happen here on the same terms
    /// as the panel's, so BUILD_ORDER's acceptance ("completing the same task in To Do produces the
    /// same pantry event, once") holds by construction rather than by two code paths agreeing.
    /// </remarks>
    private async Task PullAsync(
        HomeHubDbContext db, GroceryMirrorSettings settings, MicrosoftAccountLink link, CancellationToken ct)
    {
        var remote = await SendAsync<GraphTaskCollection>(
            link, HttpMethod.Get, $"/me/todo/lists/{settings.TodoListId}/tasks?$top=200", null, ct);
        var tasks = remote?.Value ?? [];

        var lines = await db.GroceryLines.Include(l => l.Sources).ToListAsync(ct);
        var byTaskId = lines.Where(l => l.TodoTaskId is not null)
            .ToDictionary(l => l.TodoTaskId!, l => l);

        var ledger = new PantryLedger(db, _clock);
        var now = _clock.GetUtcNow().UtcDateTime;

        foreach (var task in tasks)
        {
            if (task.Id is null) continue;

            if (byTaskId.TryGetValue(task.Id, out var line))
            {
                // Last write wins per line. A local change still waiting to go up is not overwritten
                // by the stale state it is about to replace.
                if (line.MirrorPending) continue;

                var completedThere = string.Equals(task.Status, "completed", StringComparison.OrdinalIgnoreCase);
                if (completedThere && line.CheckedAtUtc is null)
                {
                    line.CheckedAtUtc = now;
                    ReturnStock(db, ledger, line, null);
                }
                else if (!completedThere && line.CheckedAtUtc is not null)
                {
                    line.CheckedAtUtc = null;
                    await UndoReturnAsync(db, ledger, line, ct);
                }
                continue;
            }

            // Added in To Do. Dedupe on the id we have never seen *and* on the text, so a task
            // created from a line whose id we failed to record does not become a second row.
            if (string.IsNullOrWhiteSpace(task.Title)) continue;
            var (text, quantity) = SplitTitle(task.Title);
            var key = IngredientNormaliser.Normalise(text);
            var existing = lines.FirstOrDefault(l =>
                l.TodoTaskId is null && key.Length > 0 && IngredientNormaliser.Normalise(l.Text) == key);

            if (existing is not null)
            {
                existing.TodoTaskId = task.Id;
                continue;
            }

            var added = new GroceryLine
            {
                Text = text,
                Quantity = quantity,
                SourceKind = GroceryLineSource.Hand,
                CreatedUtc = now,
                TodoTaskId = task.Id,
                CheckedAtUtc = string.Equals(task.Status, "completed", StringComparison.OrdinalIgnoreCase)
                    ? now
                    : null,
            };
            added.Sources.Add(new GroceryLineSourceRef
            {
                RecipeTitle = "Microsoft To Do",
                CreatedUtc = now,
            });
            db.GroceryLines.Add(added);
            lines.Add(added);
        }

        await db.SaveChangesAsync(ct);
    }

    /// <summary>The return trip, identical to the panel's — see <c>GroceryController.Check</c>.</summary>
    private static void ReturnStock(HomeHubDbContext db, PantryLedger ledger, GroceryLine line, int? byProfileId)
    {
        if (line.PantryItemId is not { } itemId) return;
        var item = db.PantryItems.FirstOrDefault(i => i.Id == itemId);
        if (item is null) return;

        ledger.Record(
            item, PantryEventKind.CheckedOff, byProfileId,
            delta: item.Tracking == TrackingClass.Counted ? line.Quantity ?? 1 : null,
            setState: item.Tracking == TrackingClass.Estimated ? EstimateState.Plenty : null,
            sourceKind: PantryEventSource.GroceryLine, sourceId: line.Id);
    }

    private static async Task UndoReturnAsync(
        HomeHubDbContext db, PantryLedger ledger, GroceryLine line, CancellationToken ct)
    {
        var evt = await db.PantryEvents
            .Where(e => e.SourceKind == PantryEventSource.GroceryLine
                && e.SourceId == line.Id
                && e.UndoneByEventId == null
                && e.Kind == PantryEventKind.CheckedOff)
            .OrderByDescending(e => e.Id)
            .FirstOrDefaultAsync(ct);
        if (evt is not null) await ledger.UndoAsync(evt.Id, null, ct);
    }

    /// <summary>`Lemons ×3` — the shopper's line, and nothing else.</summary>
    internal static string Title(GroceryLine line) =>
        line.Quantity is { } q && q > 1
            ? $"{line.Text} ×{(q == decimal.Truncate(q) ? decimal.Truncate(q) : q)}"
            : line.Text;

    /// <summary>Read a title back apart, so a `×3` typed in To Do survives the round trip.</summary>
    internal static (string Text, decimal? Quantity) SplitTitle(string title)
    {
        var marker = title.LastIndexOf('×');
        if (marker <= 0) return (title.Trim(), null);
        var tail = title[(marker + 1)..].Trim();
        return decimal.TryParse(tail, System.Globalization.NumberStyles.Number,
            System.Globalization.CultureInfo.InvariantCulture, out var q)
            ? (title[..marker].Trim(), q)
            : (title.Trim(), null);
    }

    /// <summary>The task body: where provenance goes, so the title stays shoppable.</summary>
    internal static string Provenance(GroceryLine line)
    {
        var parts = line.Sources
            .OrderBy(s => s.ForDate ?? DateOnly.MaxValue)
            .Select(s => s.ForDate is { } d && s.RecipeTitle is { } t ? $"{t} · {d:ddd}" : s.RecipeTitle)
            .Where(s => !string.IsNullOrWhiteSpace(s))
            .ToList();
        return parts.Count == 0 ? "Added on the HomeHub panel." : string.Join("  ·  ", parts!);
    }

    private static string Summarise(Exception ex)
    {
        var message = ex.Message;
        return message.Length > 200 ? message[..200] : message;
    }

    private static GroceryMirrorSettings Track(HomeHubDbContext db, GroceryMirrorSettings settings)
    {
        db.GroceryMirror.Add(settings);
        return settings;
    }

    private static async Task<(GroceryMirrorSettings? Settings, MicrosoftAccountLink? Link)> ResolveAsync(
        HomeHubDbContext db, CancellationToken ct)
    {
        var settings = await db.GroceryMirror.FirstOrDefaultAsync(m => m.Id == 1, ct);
        if (settings?.OwnerProfileId is null) return (settings, null);
        var link = await db.MicrosoftAccountLinks
            .FirstOrDefaultAsync(l => l.ProfileId == settings.OwnerProfileId, ct);
        return (settings, link);
    }

    // ---- Graph plumbing (mirrors MicrosoftTodoProvider; see that file for the token flow) ----

    private async Task<T?> SendAsync<T>(
        MicrosoftAccountLink link, HttpMethod method, string path, object? body, CancellationToken ct)
    {
        var token = await GetTokenAsync(link, ct);
        using var req = new HttpRequestMessage(method, _options.GraphBaseUrl + path);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        if (body is not null) req.Content = JsonContent.Create(body);
        using var res = await _http.SendAsync(req, ct);

        if (!res.IsSuccessStatusCode)
        {
            var err = await res.Content.ReadAsStringAsync(ct);
            if (err.Length > 300) err = err[..300];
            throw new HttpRequestException(
                $"Graph {method} {path} failed: {(int)res.StatusCode} — {err}", null, res.StatusCode);
        }
        if (res.Content.Headers.ContentLength is 0 or null) return default;
        return await res.Content.ReadFromJsonAsync<T>(ct);
    }

    private async Task<string> GetTokenAsync(MicrosoftAccountLink link, CancellationToken ct)
    {
        if (Tokens.TryGetValue(link.ProfileId, out var cached)
            && _clock.GetUtcNow().UtcDateTime - cached.AcquiredUtc < TokenLifetime)
        {
            return cached.Token;
        }

        var form = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["client_id"] = _options.ClientId!,
            ["client_secret"] = _options.ClientSecret!,
            ["refresh_token"] = link.RefreshToken,
            ["grant_type"] = "refresh_token",
            ["scope"] = _options.Scope,
        });
        var res = await _http.PostAsync(_options.TokenUrl, form, ct);
        res.EnsureSuccessStatusCode();
        var token = await res.Content.ReadFromJsonAsync<TokenResponse>(ct);
        var access = token?.AccessToken
            ?? throw new InvalidOperationException("Microsoft token refresh returned no access_token.");
        Tokens[link.ProfileId] = (access, _clock.GetUtcNow().UtcDateTime);
        return access;
    }

    private sealed record TokenResponse([property: JsonPropertyName("access_token")] string? AccessToken);
    private sealed record GraphTaskCollection(List<GraphTask>? Value);
    private sealed record GraphTask(string? Id, string? Title, string? Status);
    private sealed record GraphTaskWrite(string Title, string Status, GraphBodyWrite Body);
    private sealed record GraphBodyWrite(string Content, string ContentType);
}

/// <summary>
/// Drives the mirror: on change, and a poll every five minutes for down-sync
/// (PANTRY_BEHAVIOURS §8).
/// </summary>
/// <remarks>
/// Backoff is exponential to a <b>30-minute ceiling</b> rather than unbounded, because the failure
/// this is most likely to be riding out is a router reboot, and a mirror that has backed off to
/// four hours is a mirror that looks broken when the network came back.
/// </remarks>
public sealed class GroceryMirrorWorker : BackgroundService
{
    private static readonly TimeSpan Poll = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan Tick = TimeSpan.FromSeconds(20);
    private static readonly TimeSpan MaxBackoff = TimeSpan.FromMinutes(30);

    private readonly GroceryMirrorService _mirror;
    private readonly TimeProvider _clock;

    public GroceryMirrorWorker(GroceryMirrorService mirror, TimeProvider clock)
    {
        _mirror = mirror;
        _clock = clock;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var timer = new PeriodicTimer(Tick, _clock);
        var nextPoll = _clock.GetUtcNow();
        var backoff = TimeSpan.Zero;

        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            var now = _clock.GetUtcNow();
            var due = GroceryMirrorService.TakeDirty() || now >= nextPoll;
            if (!due) continue;

            var ok = await _mirror.SyncAsync(stoppingToken);
            backoff = ok
                ? TimeSpan.Zero
                : TimeSpan.FromTicks(Math.Min(
                    MaxBackoff.Ticks,
                    Math.Max(Poll.Ticks, backoff.Ticks * 2)));
            nextPoll = now + (ok ? Poll : backoff);
        }
    }
}
