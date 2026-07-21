namespace HomeHub.Api.Tasks;

using System.Collections.Concurrent;
using System.Globalization;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using HomeHub.Api.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

/// <summary>
/// Microsoft To Do provider via Graph. Each profile links its own Microsoft account (refresh
/// token in <see cref="MicrosoftAccountLink"/>); tasks are read/written per profile with silent
/// token refresh, and mirrored into the local <see cref="TaskItem"/> table as an offline cache.
/// "Everyone" aggregates across linked profiles; writes go to the task's owning profile. Only
/// used behind <see cref="ITaskProvider"/> and only when Graph is configured.
/// </summary>
public sealed class MicrosoftTodoProvider : ITaskProvider
{
    private static readonly TimeSpan TokenLifetime = TimeSpan.FromMinutes(55);

    private readonly HttpClient _http;
    private readonly HomeHubDbContext _db;
    private readonly MicrosoftTodoOptions _options;
    private readonly ILogger<MicrosoftTodoProvider> _logger;

    private static readonly ConcurrentDictionary<int, (string Token, DateTime AcquiredUtc)> Tokens = new();
    private static readonly ConcurrentDictionary<int, string> ListIds = new();

    public MicrosoftTodoProvider(
        HttpClient http, HomeHubDbContext db, IOptions<MicrosoftTodoOptions> options, ILogger<MicrosoftTodoProvider> logger)
    {
        _http = http;
        _db = db;
        _options = options.Value;
        _logger = logger;
    }

    public string Source => "microsoft";

    public async Task<IReadOnlyList<TaskItem>> ListAsync(int? profileId, CancellationToken ct)
    {
        var links = await _db.MicrosoftAccountLinks
            .Where(l => profileId == null || l.ProfileId == profileId)
            .ToListAsync(ct);

        foreach (var link in links)
        {
            try { await SyncProfileAsync(link, ct); }
            catch (Exception ex) { _logger.LogWarning(ex, "Graph sync failed for profile {Profile}; serving cache.", link.ProfileId); }
        }

        var query = _db.Tasks.AsQueryable();
        if (profileId is { } pid) query = query.Where(t => t.ProfileId == pid);
        return await query
            .OrderBy(t => t.Completed)
            .ThenBy(t => t.DueUtc ?? DateTime.MaxValue)
            .ThenBy(t => t.CreatedUtc)
            .ToListAsync(ct);
    }

    public async Task<TaskItem?> GetAsync(int id, CancellationToken ct) =>
        await _db.Tasks.FindAsync([id], ct);

    public async Task<TaskItem> CreateAsync(TaskCreateInput input, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var task = new TaskItem
        {
            ProfileId = input.ProfileId,
            Source = Source,
            Title = input.Title.Trim(),
            Note = input.Note,
            DueUtc = input.DueUtc,
            CreatedUtc = now,
            UpdatedUtc = now,
        };

        var link = await _db.MicrosoftAccountLinks.FindAsync([input.ProfileId], ct);
        if (link is not null)
        {
            var listId = await ResolveListAsync(link, ct);
            var created = await SendAsync<GraphTask>(link, HttpMethod.Post,
                $"/me/todo/lists/{listId}/tasks", ToGraph(task), ct);
            task.GraphId = created?.Id;
        }

        _db.Tasks.Add(task);
        await _db.SaveChangesAsync(ct);
        return task;
    }

    public async Task<TaskItem?> SetCompletedAsync(int id, bool completed, int? baseVersion, CancellationToken ct)
    {
        var task = await _db.Tasks.FindAsync([id], ct);
        if (task is null) return null;
        if (baseVersion is { } v && v != task.Version) throw new ConcurrencyConflictException(TaskItemDto.From(task));
        task.Completed = completed;
        task.CompletedAtUtc = completed ? DateTime.UtcNow : null;
        task.UpdatedUtc = DateTime.UtcNow;
        task.Version++;

        var link = await _db.MicrosoftAccountLinks.FindAsync([task.ProfileId], ct);
        if (link is not null && !string.IsNullOrEmpty(task.GraphId))
        {
            var listId = await ResolveListAsync(link, ct);
            await SendAsync<GraphTask>(link, HttpMethod.Patch,
                $"/me/todo/lists/{listId}/tasks/{task.GraphId}",
                new { status = completed ? "completed" : "notStarted" }, ct);
        }
        await _db.SaveChangesAsync(ct);
        return task;
    }

    public async Task<bool> DeleteAsync(int id, int? baseVersion, CancellationToken ct)
    {
        var task = await _db.Tasks.FindAsync([id], ct);
        if (task is null) return false;
        if (baseVersion is { } v && v != task.Version) throw new ConcurrencyConflictException(TaskItemDto.From(task));

        var link = await _db.MicrosoftAccountLinks.FindAsync([task.ProfileId], ct);
        if (link is not null && !string.IsNullOrEmpty(task.GraphId))
        {
            var listId = await ResolveListAsync(link, ct);
            await SendAsync<object>(link, HttpMethod.Delete, $"/me/todo/lists/{listId}/tasks/{task.GraphId}", null, ct);
        }
        _db.Tasks.Remove(task);
        await _db.SaveChangesAsync(ct);
        return true;
    }

    private async Task SyncProfileAsync(MicrosoftAccountLink link, CancellationToken ct)
    {
        var listId = await ResolveListAsync(link, ct);
        var response = await SendAsync<GraphTaskList>(link, HttpMethod.Get, $"/me/todo/lists/{listId}/tasks", null, ct);
        foreach (var g in response?.Value ?? [])
        {
            if (g.Id is null) continue;
            var existing = await _db.Tasks.FirstOrDefaultAsync(t => t.GraphId == g.Id, ct);
            var completed = string.Equals(g.Status, "completed", StringComparison.OrdinalIgnoreCase);
            if (existing is null)
            {
                _db.Tasks.Add(new TaskItem
                {
                    ProfileId = link.ProfileId,
                    GraphId = g.Id,
                    Source = Source,
                    Title = g.Title ?? "(untitled)",
                    Note = g.Body?.Content,
                    DueUtc = g.DueDateTime?.EffectiveUtc,
                    Completed = completed,
                    CompletedAtUtc = completed ? DateTime.UtcNow : null,
                    CreatedUtc = DateTime.UtcNow,
                    UpdatedUtc = DateTime.UtcNow,
                });
            }
            else
            {
                existing.Title = g.Title ?? existing.Title;
                existing.Note = g.Body?.Content;
                existing.DueUtc = g.DueDateTime?.EffectiveUtc;
                existing.Completed = completed;
                existing.UpdatedUtc = DateTime.UtcNow;
            }
        }
        await _db.SaveChangesAsync(ct);
    }

    private async Task<string> ResolveListAsync(MicrosoftAccountLink link, CancellationToken ct)
    {
        if (!string.IsNullOrEmpty(link.ListId)) return link.ListId;
        if (ListIds.TryGetValue(link.ProfileId, out var cached)) return cached;

        // Fetch all lists and pick the default client-side — Graph's $filter on wellknownListName
        // is unreliable for the To Do API (frequently 500s), so don't rely on server-side filtering.
        var lists = await SendAsync<GraphListCollection>(link, HttpMethod.Get, "/me/todo/lists", null, ct);
        var all = lists?.Value ?? [];
        var id = (all.FirstOrDefault(l => string.Equals(l.WellknownListName, "defaultList", StringComparison.OrdinalIgnoreCase))
                  ?? all.FirstOrDefault())?.Id
            ?? throw new InvalidOperationException("No To Do list found for the linked account.");
        ListIds[link.ProfileId] = id;
        return id;
    }

    private static object ToGraph(TaskItem task) => new
    {
        title = task.Title,
        body = task.Note is null ? null : new { content = task.Note, contentType = "text" },
        dueDateTime = task.DueUtc is { } due
            ? new { dateTime = due.ToString("yyyy-MM-ddTHH:mm:ss", CultureInfo.InvariantCulture), timeZone = "UTC" }
            : null,
    };

    private async Task<T?> SendAsync<T>(MicrosoftAccountLink link, HttpMethod method, string path, object? body, CancellationToken ct)
    {
        var token = await GetTokenAsync(link, ct);
        using var req = new HttpRequestMessage(method, _options.GraphBaseUrl + path);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        if (body is not null) req.Content = JsonContent.Create(body);
        using var res = await _http.SendAsync(req, ct);
        if (!res.IsSuccessStatusCode)
        {
            // Surface Graph's error body instead of a bare status, so failures are diagnosable.
            var err = await res.Content.ReadAsStringAsync(ct);
            if (err.Length > 500) err = err[..500];
            throw new HttpRequestException(
                $"Graph {method} {path} failed: {(int)res.StatusCode} {res.StatusCode} — {err}", null, res.StatusCode);
        }
        if (res.Content.Headers.ContentLength is 0 or null) return default;
        return await res.Content.ReadFromJsonAsync<T>(ct);
    }

    private async Task<string> GetTokenAsync(MicrosoftAccountLink link, CancellationToken ct)
    {
        if (Tokens.TryGetValue(link.ProfileId, out var cached) && DateTime.UtcNow - cached.AcquiredUtc < TokenLifetime)
            return cached.Token;

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
        var access = token?.AccessToken ?? throw new InvalidOperationException("Microsoft token refresh returned no access_token.");
        Tokens[link.ProfileId] = (access, DateTime.UtcNow);
        return access;
    }

    // ---- Graph response shapes (partial) ----
    // OAuth token endpoint returns snake_case (access_token); map it explicitly — case-insensitive
    // matching alone doesn't bridge the underscore.
    private sealed record TokenResponse([property: JsonPropertyName("access_token")] string? AccessToken);
    private sealed record GraphTaskList(List<GraphTask>? Value);
    private sealed record GraphTask(string? Id, string? Title, string? Status, GraphBody? Body, GraphDue? DueDateTime);
    private sealed record GraphBody(string? Content, string? ContentType);
    private sealed record GraphDue(string? DateTime, string? TimeZone)
    {
        public System.DateTime? EffectiveUtc =>
            System.DateTime.TryParse(DateTime, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var d)
                ? d : null;
    }
    private sealed record GraphListCollection(List<GraphList>? Value);
    private sealed record GraphList(string? Id, string? WellknownListName);
}
