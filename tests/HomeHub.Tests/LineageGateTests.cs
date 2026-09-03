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

    /// <summary>
    /// The app serialises enums as strings; the default reader wants numbers. One place, so a test
    /// asserting on a state is asserting on what the panel would actually receive.
    /// </summary>
    private static readonly System.Text.Json.JsonSerializerOptions AsTheApiWrites =
        new(System.Text.Json.JsonSerializerDefaults.Web)
        {
            Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() },
        };

    private static async Task<LineageReconciliation> ReadReconciliation(HttpResponseMessage response) =>
        (await response.Content.ReadFromJsonAsync<LineageReconciliation>(AsTheApiWrites))!;

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
        // Actionable rather than a bare refusal: it names the step that would change the answer.
        Assert.Contains("Reconcile the lineage", await response.Content.ReadAsStringAsync());

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

    // ---- Released only by a clean reconciliation ----

    /*
     * <b>An earlier version released deletion the moment somebody opened the report, clean or not.</b>
     * That mistook being informed for being safe: an administrator reading that transcripts will be
     * orphaned is not a reason to orphan them, and an irreversible action does not become reversible
     * by being announced. Blocked stays blocked.
     */
    [Fact]
    public async Task An_unclean_reconciliation_leaves_deletion_refused()
    {
        using var app = Unaudited();
        var client = app.CreateSeededClient();
        var id = await AnOldConversation(app, client);

        var reconciled = await client.PostAsync("/api/assist/lineage/reconcile", null);
        reconciled.EnsureSuccessStatusCode();
        var outcome = await ReadReconciliation(reconciled);

        // The seeded household has no reachable agent, so the audit cannot vouch for anything.
        Assert.False(outcome.Clean);
        Assert.Equal(LineageState.Blocked, outcome.State);

        var refused = await client.PostAsJsonAsync("/api/assist/conversations/delete", new { ids = new[] { id } });
        Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);

        using var scope = app.Services.CreateScope();
        Assert.NotNull(scope.ServiceProvider.GetRequiredService<HomeHubDbContext>()
            .Conversations.FirstOrDefault(c => c.Id == id));
    }

    /*
     * And the report itself changes nothing. A GET that alters global destructive authority is one a
     * refresh, a preview or a crawler can trigger; one revision of this stamped the gate on the way
     * through.
     */
    [Fact]
    public async Task Reading_the_report_changes_no_authority()
    {
        using var app = Unaudited();
        var client = app.CreateSeededClient();
        var id = await AnOldConversation(app, client);

        (await client.GetAsync("/api/assist/lineage/report")).EnsureSuccessStatusCode();

        using (var scope = app.Services.CreateScope())
        {
            var settings = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>().Settings.First();
            Assert.Equal(LineageState.NotAudited, settings.LineageState);
            Assert.Null(settings.LineageAuditedAtUtc);
        }

        var refused = await client.PostAsJsonAsync("/api/assist/conversations/delete", new { ids = new[] { id } });
        Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
    }

    // ---- The deliberate override ----

    [Fact]
    public async Task Accepting_the_risk_requires_confirming_the_exact_unresolved_sessions()
    {
        using var app = Unaudited();
        var client = app.CreateSeededClient();

        var wrong = await client.PostAsJsonAsync("/api/assist/lineage/accept-risk",
            new AcceptLineageRiskRequest(["a-session-nobody-mentioned"]));

        Assert.Equal(HttpStatusCode.Conflict, wrong.StatusCode);

        using var scope = app.Services.CreateScope();
        Assert.Equal(
            LineageState.NotAudited,
            scope.ServiceProvider.GetRequiredService<HomeHubDbContext>().Settings.First().LineageState);
    }

    [Fact]
    public async Task Accepting_the_risk_releases_manual_deletion_and_records_who_did_it()
    {
        using var app = Unaudited();
        var client = app.CreateSeededClient();
        var id = await AnOldConversation(app, client);

        var reconciled = await client.PostAsync("/api/assist/lineage/reconcile", null);
        var unresolved = (await ReadReconciliation(reconciled)).UnresolvedSessionIds;

        var accepted = await client.PostAsJsonAsync("/api/assist/lineage/accept-risk",
            new AcceptLineageRiskRequest(unresolved));
        accepted.EnsureSuccessStatusCode();

        var deleted = await client.PostAsJsonAsync("/api/assist/conversations/delete", new { ids = new[] { id } });
        Assert.Equal(HttpStatusCode.OK, deleted.StatusCode);

        using var scope = app.Services.CreateScope();
        var settings = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>().Settings.First();
        Assert.Equal(LineageState.RiskAccepted, settings.LineageState);
        // Auditable: an acceptance nobody can attribute is not a record of a decision.
        Assert.Equal(1, settings.LineageRiskAcceptedByProfileId);
        Assert.NotNull(settings.LineageRiskAcceptedAtUtc);
    }

    /*
     * The distinction the fourth state exists for. Somebody accepting a named risk for a conversation
     * they are deleting is a decision; a timer acting on that acceptance for every conversation in the
     * household for ever is a different one, and nobody made it.
     */
    [Fact]
    public async Task Accepting_the_risk_does_not_start_background_retention()
    {
        using var app = Unaudited();
        var client = app.CreateSeededClient();
        var id = await AnOldConversation(app, client);
        await SetRetention(client, 1);

        var reconciled = await client.PostAsync("/api/assist/lineage/reconcile", null);
        var unresolved = (await ReadReconciliation(reconciled)).UnresolvedSessionIds;
        (await client.PostAsJsonAsync("/api/assist/lineage/accept-risk",
            new AcceptLineageRiskRequest(unresolved))).EnsureSuccessStatusCode();

        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
        var swept = await scope.ServiceProvider.GetRequiredService<AssistRetention>()
            .SweepHouseholdAsync(db.Settings.First(), CancellationToken.None);

        Assert.Equal(0, swept);
        Assert.NotNull(db.Conversations.FirstOrDefault(c => c.Id == id));
    }

    [Fact]
    public async Task A_member_who_is_not_an_administrator_cannot_accept_the_risk()
    {
        using var app = Unaudited();
        var member = app.CreateSeededClient(2);

        var response = await member.PostAsJsonAsync("/api/assist/lineage/accept-risk",
            new AcceptLineageRiskRequest([]));

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    /* A routine re-run must not quietly undo a deliberate override. */
    [Fact]
    public async Task Reconciling_again_does_not_revoke_an_acceptance()
    {
        using var app = Unaudited();
        var client = app.CreateSeededClient();

        var first = await client.PostAsync("/api/assist/lineage/reconcile", null);
        var unresolved = (await ReadReconciliation(first)).UnresolvedSessionIds;
        (await client.PostAsJsonAsync("/api/assist/lineage/accept-risk",
            new AcceptLineageRiskRequest(unresolved))).EnsureSuccessStatusCode();

        (await client.PostAsync("/api/assist/lineage/reconcile", null)).EnsureSuccessStatusCode();

        using var scope = app.Services.CreateScope();
        Assert.Equal(
            LineageState.RiskAccepted,
            scope.ServiceProvider.GetRequiredService<HomeHubDbContext>().Settings.First().LineageState);
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
