namespace HomeHub.Api.Ai;

using System.Text.Json;
using System.Text.RegularExpressions;
using HomeHub.Api.Data;
using HomeHub.Api.Tasks;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

/// <summary>
/// The assistant's in-app action layer — turns intent into real changes via the same providers the
/// UI uses, scoped to the signed-in profile. Two entry points share one executor:
///  • <see cref="TryHandleCommandAsync"/> — a deterministic parser (works offline, no model needed);
///  • <see cref="DispatchToolAsync"/> + <see cref="ToolCatalog"/> — OpenAI tool-calling for flexible phrasing.
/// First ability: add an item to a to-do list, resolving the spoken list name to the closest match.
/// </summary>
public sealed partial class AssistantActions
{
    private readonly IServiceProvider _services;
    private readonly ILogger<AssistantActions> _logger;

    public AssistantActions(IServiceProvider services, ILogger<AssistantActions> logger)
    {
        _services = services;
        _logger = logger;
    }

    // Resolved from the request scope so the assistant still constructs when no DB is configured
    // (data endpoints are DB-gated; actions simply report they need it).
    private ITaskProvider? Tasks => _services.GetService<ITaskProvider>();
    private HomeHubDbContext? Db => _services.GetService<HomeHubDbContext>();

    /// <summary>Result of an action: a spoken/written confirmation, and a non-null <see cref="Action"/>
    /// tag ("task") when something changed so the client can refresh the affected screen.</summary>
    public record Outcome(string Message, string? Action)
    {
        public static Outcome Ok(string message, string action) => new(message, action);
        public static Outcome Fail(string message) => new(message, null);
    }

    // ---- Deterministic command parser (offline path) ----

    // "add carrots to the grocery list", "put milk on groceries", "add sunscreen to Theo's swim bag"
    [GeneratedRegex(@"^\s*(?:hey\s+\w+[,!\.\s]+)?(?:please\s+|can you\s+|could you\s+)?(?:add|put)\s+(.+?)\s+(?:to|on|onto|in)\s+(?:my|the|our|his|her|their)?\s*(.+?)\s*$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex AddToListRegex();

    /// <summary>Parse the prompt as an in-app command and run it. Returns null when it's not a command
    /// (the caller then routes to the LLM).</summary>
    public async Task<Outcome?> TryHandleCommandAsync(string prompt, int? profileId, CancellationToken ct)
    {
        var m = AddToListRegex().Match(prompt ?? "");
        if (!m.Success) return null;
        var item = CleanItem(m.Groups[1].Value);
        var list = m.Groups[2].Value.Trim();
        if (item.Length == 0 || list.Length == 0) return null;
        return await AddTaskAsync(profileId, list, item, ct);
    }

    private static string CleanItem(string s)
    {
        s = s.Trim().TrimEnd('.', '!', '?').Trim();
        // Drop a leading article so "add a carrot" stores "carrot".
        s = Regex.Replace(s, @"^(?:a|an|some)\s+", "", RegexOptions.IgnoreCase);
        return s.Trim();
    }

    /// <summary>Uppercase the first letter of each word, preserving the rest ("orange juice" →
    /// "Orange Juice", "theo's bag" → "Theo's Bag") so items read tidily on the list.</summary>
    private static string TitleCase(string s) =>
        string.Join(' ', s.Split(' ').Select(w => w.Length == 0 ? w : char.ToUpperInvariant(w[0]) + w[1..]));

    // ---- OpenAI tool-calling ----

    /// <summary>Tool schemas advertised to OpenAI (Chat Completions `tools`).</summary>
    public static readonly IReadOnlyList<object> ToolCatalog = new object[]
    {
        new
        {
            type = "function",
            function = new
            {
                name = "add_task",
                description = "Add an item to one of the signed-in person's to-do lists shown on the panel. "
                    + "The list name is matched to the closest existing list, so a rough name is fine.",
                parameters = new
                {
                    type = "object",
                    properties = new
                    {
                        list = new { type = "string", description = "Which list to add to, e.g. 'grocery' or 'household'." },
                        item = new { type = "string", description = "The item or task text to add." },
                    },
                    required = new[] { "list", "item" },
                },
            },
        },
    };

    /// <summary>Execute a tool call from the model. <paramref name="argumentsJson"/> is the raw JSON string.</summary>
    public async Task<Outcome> DispatchToolAsync(string name, string argumentsJson, int? profileId, CancellationToken ct)
    {
        try
        {
            using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(argumentsJson) ? "{}" : argumentsJson);
            var root = doc.RootElement;
            return name switch
            {
                "add_task" => await AddTaskAsync(profileId, Str(root, "list"), Str(root, "item"), ct),
                _ => Outcome.Fail($"Unknown action \"{name}\"."),
            };
        }
        catch (JsonException)
        {
            return Outcome.Fail("I couldn't read that action's details.");
        }
    }

    private static string Str(JsonElement root, string prop) =>
        root.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

    // ---- The action ----

    public async Task<Outcome> AddTaskAsync(int? profileId, string listQuery, string title, CancellationToken ct)
    {
        title = TitleCase(title.Trim());
        if (title.Length == 0) return Outcome.Fail("I didn't catch what to add.");
        if (profileId is not { } pid) return Outcome.Fail("No one's signed in, so I can't add that — choose a profile first.");
        if (Tasks is not { } tasks || Db is not { } db) return Outcome.Fail("Task actions aren't available — the panel isn't connected to its database.");

        var candidates = await GetListsAsync(tasks, db, pid, ct);
        if (candidates.Count == 0)
            return Outcome.Fail("You don't have any lists on the panel yet — pick some in Config → To-Do lists.");

        var target = ResolveList(listQuery, candidates);
        if (target is null)
        {
            var names = string.Join(", ", candidates.Select(c => c.Name));
            return Outcome.Fail($"I couldn't find a list matching “{listQuery}”. Your lists are: {names}.");
        }

        await tasks.CreateAsync(new TaskCreateInput(pid, title, null, null, target.GraphListId, target.Name), ct);
        return Outcome.Ok($"Added {title} to your {target.Name} list.", "task");
    }

    private sealed record ListCandidate(string? GraphListId, string Name);

    /// <summary>The profile's lists to add to: the synced Microsoft lists when linked, else the
    /// distinct list names on that profile's cached tasks (what the TODO screen shows).</summary>
    private async Task<IReadOnlyList<ListCandidate>> GetListsAsync(ITaskProvider tasks, HomeHubDbContext db, int profileId, CancellationToken ct)
    {
        if (tasks is IListSyncProvider lister)
        {
            try
            {
                var lists = await lister.GetListsAsync(profileId, ct);
                var selected = lists.Where(l => l.Selected).ToList();
                var use = selected.Count > 0 ? selected : lists;
                if (use.Count > 0) return use.Select(l => new ListCandidate(l.GraphListId, l.Name)).ToList();
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Listing To Do lists for an action failed; using cached task lists.");
            }
        }
        var names = await db.Tasks
            .Where(t => t.ProfileId == profileId && t.ListName != null)
            .Select(t => t.ListName!)
            .Distinct()
            .ToListAsync(ct);
        return names.Select(n => new ListCandidate(null, n)).ToList();
    }

    // ---- Fuzzy list resolution ----

    private static ListCandidate? ResolveList(string query, IReadOnlyList<ListCandidate> candidates)
    {
        var q = Normalize(query);
        if (q.Length == 0) return null;
        ListCandidate? best = null;
        double bestScore = 0;
        foreach (var c in candidates)
        {
            var score = Score(q, Normalize(c.Name));
            if (score > bestScore) { bestScore = score; best = c; }
        }
        return bestScore >= 0.45 ? best : null;
    }

    /// <summary>Lowercase, drop the word "list", strip punctuation, collapse spaces — so "Grocery List",
    /// "grocery", and "the groceries" line up.</summary>
    private static string Normalize(string s)
    {
        s = s.ToLowerInvariant();
        s = Regex.Replace(s, @"\blist\b", " ");
        s = Regex.Replace(s, @"[^a-z0-9 ]", " ");
        return Regex.Replace(s, @"\s+", " ").Trim();
    }

    private static double Score(string a, string b)
    {
        if (a.Length == 0 || b.Length == 0) return 0;
        if (a == b) return 1.0;
        if (a.Contains(b) || b.Contains(a)) return 0.85;

        var ta = a.Split(' ', StringSplitOptions.RemoveEmptyEntries).ToHashSet();
        var tb = b.Split(' ', StringSplitOptions.RemoveEmptyEntries).ToHashSet();
        var overlap = ta.Intersect(tb).Count();
        if (overlap > 0) return 0.5 + 0.35 * ((double)overlap / Math.Max(ta.Count, tb.Count));

        // Typo tolerance ("grocary" → "grocery").
        var dist = Levenshtein(a, b);
        return 1.0 - (double)dist / Math.Max(a.Length, b.Length);
    }

    private static int Levenshtein(string a, string b)
    {
        var d = new int[a.Length + 1, b.Length + 1];
        for (var i = 0; i <= a.Length; i++) d[i, 0] = i;
        for (var j = 0; j <= b.Length; j++) d[0, j] = j;
        for (var i = 1; i <= a.Length; i++)
            for (var j = 1; j <= b.Length; j++)
            {
                var cost = a[i - 1] == b[j - 1] ? 0 : 1;
                d[i, j] = Math.Min(Math.Min(d[i - 1, j] + 1, d[i, j - 1] + 1), d[i - 1, j - 1] + cost);
            }
        return d[a.Length, b.Length];
    }
}
