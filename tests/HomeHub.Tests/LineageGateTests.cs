namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Assist;
using HomeHub.Api.Data;
using HomeHub.Api.Settings;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using static HomeHub.Tests.StubHermes;

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

    private static async Task<string> ChallengeFor(HttpClient client)
    {
        var reconciled = await client.PostAsync("/api/assist/lineage/reconcile", null);
        reconciled.EnsureSuccessStatusCode();
        var outcome = await ReadReconciliation(reconciled);
        Assert.False(outcome.Clean);
        Assert.NotNull(outcome.Challenge);
        return outcome.Challenge!;
    }

    /*
     * <b>The finding this replaces.</b> The confirmation used to be the list of unresolved session
     * ids, and an agent that cannot be read enumerates nothing — so that list is empty exactly when
     * there is most to accept, an empty acknowledgement matched it, and an acceptance could be issued
     * having read nothing at all. Matching an enumeration cannot represent a failure *of* enumeration.
     */
    [Fact]
    public async Task An_acceptance_cannot_be_issued_without_a_challenge()
    {
        using var app = Unaudited();
        var client = app.CreateSeededClient();
        var id = await AnOldConversation(app, client);

        // No GET, no reconcile — exactly the probe that passed before.
        var response = await client.PostAsJsonAsync("/api/assist/lineage/accept-risk",
            new AcceptLineageRiskRequest(null, [id]));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);

        var refused = await client.PostAsJsonAsync("/api/assist/conversations/delete", new { ids = new[] { id } });
        Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
    }

    [Fact]
    public async Task A_forged_challenge_is_refused()
    {
        using var app = Unaudited();
        var client = app.CreateSeededClient();
        var id = await AnOldConversation(app, client);

        var response = await client.PostAsJsonAsync("/api/assist/lineage/accept-risk",
            new AcceptLineageRiskRequest("not-a-challenge-this-panel-issued", [id]));

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
    }

    /* A blanket acceptance is not one: the point is knowing what is being deleted. */
    [Fact]
    public async Task An_acceptance_must_name_the_conversations()
    {
        using var app = Unaudited();
        var client = app.CreateSeededClient();
        await AnOldConversation(app, client);
        var challenge = await ChallengeFor(client);

        var response = await client.PostAsJsonAsync("/api/assist/lineage/accept-risk",
            new AcceptLineageRiskRequest(challenge, []));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task An_acceptance_authorises_the_conversations_it_names_and_no_others()
    {
        using var app = Unaudited();
        var client = app.CreateSeededClient();
        var authorised = await AnOldConversation(app, client);
        var other = await AnOldConversation(app, client);
        var challenge = await ChallengeFor(client);

        (await client.PostAsJsonAsync("/api/assist/lineage/accept-risk",
            new AcceptLineageRiskRequest(challenge, [authorised]))).EnsureSuccessStatusCode();

        // The one it did not name is refused, even though an acceptance exists.
        var refused = await client.PostAsJsonAsync("/api/assist/conversations/delete", new { ids = new[] { other } });
        Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);

        var allowed = await client.PostAsJsonAsync("/api/assist/conversations/delete", new { ids = new[] { authorised } });
        Assert.Equal(HttpStatusCode.OK, allowed.StatusCode);
    }

    /* Spent by the act it permitted. An acceptance that survived it would be durable authority again. */
    [Fact]
    public async Task An_acceptance_authorises_one_deletion_only()
    {
        using var app = Unaudited();
        var client = app.CreateSeededClient();
        var first = await AnOldConversation(app, client);
        var challenge = await ChallengeFor(client);

        (await client.PostAsJsonAsync("/api/assist/lineage/accept-risk",
            new AcceptLineageRiskRequest(challenge, [first]))).EnsureSuccessStatusCode();
        (await client.PostAsJsonAsync("/api/assist/conversations/delete",
            new { ids = new[] { first } })).EnsureSuccessStatusCode();

        // A second conversation, and nothing left to authorise it.
        var second = await AnOldConversation(app, client);
        var refused = await client.PostAsJsonAsync("/api/assist/conversations/delete", new { ids = new[] { second } });

        Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
    }

    [Fact]
    public async Task A_challenge_cannot_be_used_twice()
    {
        using var app = Unaudited();
        var client = app.CreateSeededClient();
        var one = await AnOldConversation(app, client);
        var two = await AnOldConversation(app, client);
        var challenge = await ChallengeFor(client);

        (await client.PostAsJsonAsync("/api/assist/lineage/accept-risk",
            new AcceptLineageRiskRequest(challenge, [one]))).EnsureSuccessStatusCode();

        var replayed = await client.PostAsJsonAsync("/api/assist/lineage/accept-risk",
            new AcceptLineageRiskRequest(challenge, [two]));

        Assert.Equal(HttpStatusCode.Conflict, replayed.StatusCode);
    }

    /*
     * The pre-check above (`AnyAsync` before `Add`) is a courtesy, not the guarantee — two requests
     * can both pass it before either has saved. What actually stops a challenge being spent twice is
     * the unique index on Nonce, and a loser hitting *that* has to come back as the same documented
     * Conflict rather than an unhandled 500 — see `AcceptLineageRisk`'s `catch (DbUpdateException)`.
     *
     * <b>Not regression-tested here.</b> Probed directly while writing this: EF Core InMemory does not
     * enforce `HasIndex(...).IsUnique()` at all — inserting two rows with the same Nonce in two
     * ordinary, sequential `SaveChanges` calls succeeds both times, no exception, no race required.
     * The same is true of `HasMaxLength`. Neither is a code defect; both are things only a real
     * relational provider checks, which is exactly the InMemory-vs-SQL-Server gap flagged against this
     * area before — see the remarks on `LineageRiskAcceptanceConcurrencyTests`.
     */

    /*
     * The report changing between authorisation and deletion is the case a stored verdict cannot
     * catch: what was accepted described a lineage, and what matters is whether that is still what
     * deleting would do.
     */
    [Fact]
    public async Task An_acceptance_lapses_when_the_lineage_changes_underneath_it()
    {
        using var app = Unaudited();
        var client = app.CreateSeededClient();
        var id = await AnOldConversation(app, client);
        var challenge = await ChallengeFor(client);

        (await client.PostAsJsonAsync("/api/assist/lineage/accept-risk",
            new AcceptLineageRiskRequest(challenge, [id]))).EnsureSuccessStatusCode();

        // A new anchor appears — a conversation re-sessioned after the administrator read the report.
        using (var scope = app.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
            db.Conversations.First(c => c.Id == id).HermesSessionId = "moved-since-you-looked";
            db.SaveChanges();
        }

        var refused = await client.PostAsJsonAsync("/api/assist/conversations/delete", new { ids = new[] { id } });

        Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
    }

    /*
     * <b>H2a.</b> The report used to fingerprint only its own findings, and a session that maps
     * cleanly — <see cref="LineageClass.VerifiedAndMapped"/> — produces none. So a compression that
     * rotated the anchored session into a child moved nothing the digest was watching: same findings,
     * same fingerprint, and the acceptance granted before it still matched after. Deleting would have
     * tombstoned the old session and dropped the only anchor pointing near the new one, orphaning it
     * for good. The fix folds the observed graph — every session, its parent, and its class — into the
     * digest, so a clean rotation invalidates the acceptance exactly like an adverse one does.
     */
    [Fact]
    public async Task An_acceptance_lapses_when_a_clean_remap_changes_the_graph_underneath_it()
    {
        // An unrelated orphaned session keeps the report unclean, so accept-risk stays reachable
        // while the conversation's own lineage — rooted at "A" — maps cleanly throughout.
        var orphan = "homehub_barnaby_" + new string('a', 32);
        using var gateway = new StubHermes { Sessions = [new StubSession(orphan), new StubSession("A")] };
        using var app = new HubAppFactory { AuditedLineage = false, HermesBaseUrl = gateway.BaseUrl };
        var client = app.CreateSeededClient();

        int id;
        using (var scope = app.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
            db.Conversations.Add(new Conversation
            {
                ProfileId = 1,
                AgentKey = "barnaby",
                Title = "A conversation",
                HermesSessionId = "A",
                StartedAtUtc = DateTime.UtcNow,
                LastAtUtc = DateTime.UtcNow,
            });
            db.SaveChanges();
            id = db.Conversations.Single().Id;
        }

        var challenge = await ChallengeFor(client);
        (await client.PostAsJsonAsync("/api/assist/lineage/accept-risk",
            new AcceptLineageRiskRequest(challenge, [id]))).EnsureSuccessStatusCode();

        // Hermes compresses "A" into a child "B" — a clean rotation, no adverse finding — after the
        // acceptance was granted and before the deletion that would act on it.
        gateway.Sessions =
        [
            new StubSession(orphan),
            new StubSession("A", EndReason: "compression"),
            new StubSession("B", Parent: "A"),
        ];

        var refused = await client.PostAsJsonAsync("/api/assist/conversations/delete", new { ids = new[] { id } });

        Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
        using (var scope = app.Services.CreateScope())
        {
            Assert.NotNull(scope.ServiceProvider.GetRequiredService<HomeHubDbContext>()
                .Conversations.FirstOrDefault(c => c.Id == id));
        }
    }

    /*
     * The household's state never leaves Blocked, which is what keeps an acceptance from reaching the
     * background pass at all: retention reads the enum and an acceptance is not one.
     */
    [Fact]
    public async Task An_acceptance_never_starts_background_retention()
    {
        using var app = Unaudited();
        var client = app.CreateSeededClient();
        var id = await AnOldConversation(app, client);
        await SetRetention(client, 1);
        var challenge = await ChallengeFor(client);

        (await client.PostAsJsonAsync("/api/assist/lineage/accept-risk",
            new AcceptLineageRiskRequest(challenge, [id]))).EnsureSuccessStatusCode();

        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
        Assert.Equal(LineageState.Blocked, db.Settings.First().LineageState);

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
            new AcceptLineageRiskRequest("anything", [1]));

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
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
