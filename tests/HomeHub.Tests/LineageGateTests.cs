namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Assist;
using HomeHub.Api.Data;
using HomeHub.Api.Settings;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

/// <summary>
/// Deleting a conversation whose lineage nobody has enumerated — the audit-then-delete order.
/// </summary>
/// <remarks>
/// <para>
/// <b>The hazard is one-way, which is why there is a gate rather than a warning.</b> The lineage table
/// works prospectively: every turn records the session Hermes answered in. That cannot rebuild a chain
/// that already existed, so on a panel upgraded from before it, a conversation that became
/// <c>A → B → C</c> while only <c>A</c> was stored resolves to <c>C</c>. Deleting it tombstones A and
/// C and never B — and B stays on the agent with its messages, permanently, because the local row that
/// pointed anywhere near it is now gone. Audit first and the damage is visible and fixable; delete
/// first and there is nothing left to audit with.
/// </para>
/// <para>
/// So both deletion paths wait on <c>LineageAuditedAtUtc</c>. Retention pauses, because it is
/// automatic and would do this without anybody choosing it; the explicit delete refuses with something
/// a person can act on. Running the report — one request, read-only — releases both for good.
/// </para>
/// </remarks>
public class LineageGateTests
{
    /// <summary>A panel upgraded from before lineage recording: history present, never audited.</summary>
    private static HubAppFactory Unaudited() => new() { AuditedLineage = false };

    private static async Task<int> AnOldConversation(HubAppFactory app, HttpClient client)
    {
        var started = await client.PostAsJsonAsync("/api/assist/chat",
            new { prompt = "Old news", agent = (string?)null });
        started.EnsureSuccessStatusCode();
        var id = (await started.Content.ReadFromJsonAsync<AssistChatResponse>())!.ConversationId;

        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
        var row = db.Conversations.First(c => c.Id == id);
        row.LastAtUtc = DateTime.UtcNow.AddYears(-3);
        row.HermesSessionId = "resolved-tip";
        db.SaveChanges();
        return id;
    }

    private static async Task SetRetention(HttpClient client, int days)
    {
        var policy = await client.PutAsJsonAsync("/api/settings/conversation-policy",
            new SetConversationPolicyRequest(true, days));
        policy.EnsureSuccessStatusCode();
    }

    // ---- Refused until somebody has looked ----

    [Fact]
    public async Task An_explicit_delete_is_refused_before_the_lineage_has_been_audited()
    {
        using var app = Unaudited();
        var client = app.CreateSeededClient();
        var id = await AnOldConversation(app, client);

        var response = await client.PostAsJsonAsync("/api/assist/conversations/delete", new { ids = new[] { id } });

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        // Actionable rather than a bare refusal: the household is one request from being unblocked.
        Assert.Contains("lineage report", await response.Content.ReadAsStringAsync());

        using var scope = app.Services.CreateScope();
        Assert.NotNull(scope.ServiceProvider.GetRequiredService<HomeHubDbContext>()
            .Conversations.FirstOrDefault(c => c.Id == id));
    }

    [Fact]
    public async Task Retention_pauses_before_the_lineage_has_been_audited()
    {
        using var app = Unaudited();
        var client = app.CreateSeededClient();
        var id = await AnOldConversation(app, client);
        await SetRetention(client, 1);

        // The read that would ordinarily sweep it.
        await client.GetFromJsonAsync<ConversationListDto>("/api/assist/conversations");

        using var scope = app.Services.CreateScope();
        Assert.NotNull(scope.ServiceProvider.GetRequiredService<HomeHubDbContext>()
            .Conversations.FirstOrDefault(c => c.Id == id));
    }

    [Fact]
    public async Task The_background_pass_pauses_too()
    {
        using var app = Unaudited();
        var client = app.CreateSeededClient();
        var id = await AnOldConversation(app, client);
        await SetRetention(client, 1);

        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
        var swept = await scope.ServiceProvider.GetRequiredService<AssistRetention>()
            .SweepHouseholdAsync(db.Settings.First(), CancellationToken.None);

        Assert.Equal(0, swept);
        Assert.NotNull(db.Conversations.FirstOrDefault(c => c.Id == id));
    }

    // ---- Released by looking ----

    /*
     * Stamped whatever the verdict. The gate is "somebody has looked", not "it came back clean": a
     * household that has read the damage is making an informed choice, which is the whole difference
     * between this and the silent orphaning it replaces. Blocking on a clean report would also be a
     * dead end — there is no backfill yet, so a damaged lineage would mean nobody could ever delete.
     */
    [Fact]
    public async Task Running_the_report_releases_deletion_for_good()
    {
        using var app = Unaudited();
        var client = app.CreateSeededClient();
        var id = await AnOldConversation(app, client);

        var refused = await client.PostAsJsonAsync("/api/assist/conversations/delete", new { ids = new[] { id } });
        Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);

        var report = await client.GetAsync("/api/assist/lineage/report");
        report.EnsureSuccessStatusCode();

        var allowed = await client.PostAsJsonAsync("/api/assist/conversations/delete", new { ids = new[] { id } });
        Assert.Equal(HttpStatusCode.OK, allowed.StatusCode);

        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
        Assert.Null(db.Conversations.FirstOrDefault(c => c.Id == id));
        Assert.NotNull(db.Settings.First().LineageAuditedAtUtc);
    }

    /* Read-only stays read-only: the report writes one timestamp and nothing else. */
    [Fact]
    public async Task The_report_stamps_once_and_does_not_move_afterwards()
    {
        using var app = Unaudited();
        var client = app.CreateSeededClient();
        await AnOldConversation(app, client);

        (await client.GetAsync("/api/assist/lineage/report")).EnsureSuccessStatusCode();
        DateTime? first;
        using (var scope = app.Services.CreateScope())
            first = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>().Settings.First().LineageAuditedAtUtc;

        (await client.GetAsync("/api/assist/lineage/report")).EnsureSuccessStatusCode();

        using var after = app.Services.CreateScope();
        Assert.Equal(
            first,
            after.ServiceProvider.GetRequiredService<HomeHubDbContext>().Settings.First().LineageAuditedAtUtc);
    }

    // ---- And an ordinary household is not asked about any of this ----

    [Fact]
    public async Task An_audited_household_deletes_as_before()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var id = await AnOldConversation(app, client);

        var response = await client.PostAsJsonAsync("/api/assist/conversations/delete", new { ids = new[] { id } });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }
}
