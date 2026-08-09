namespace HomeHub.Tests;

using System.Net.Http.Json;
using HomeHub.Api.Assist;
using HomeHub.Api.Data;
using Microsoft.Extensions.DependencyInjection;
using static HomeHub.Tests.StubHermes;

/// <summary>
/// The §3.1 lineage repair report.
/// </summary>
/// <remarks>
/// <para>
/// The report's whole job is to be <b>believed</b> — a clean result is what unlocks the backfill,
/// retention deletion and D4's stronger delete-modal wording. So these tests are mostly about the
/// ways it could be wrong in the reassuring direction: an agent that never answered counted as
/// having nothing wrong, a lineage nobody claims quietly dropped, a fork read as a rotation.
/// </para>
/// <para>
/// Every scenario is built as a session graph on a real gateway rather than as a unit test of the
/// walker, because the shapes that matter — an orphan, a branch, a loop — are properties of the
/// graph the agent reports, and a hand-fed walker would only prove the walker matches itself.
/// </para>
/// </remarks>
public class LineageAuditTests
{
    private static async Task<LineageReport> ReportAsync(HubAppFactory app) =>
        (await app.CreateSeededClient().GetFromJsonAsync<LineageReport>("/api/assist/lineage/report"))!;

    /// <summary>Give the conversation a Hermes session id, as a real turn would have.</summary>
    private static void Anchor(HubAppFactory app, string sessionId, string agentKey = "barnaby", int profileId = 1)
    {
        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
        db.Conversations.Add(new Conversation
        {
            ProfileId = profileId,
            AgentKey = agentKey,
            Title = "A conversation",
            HermesSessionId = sessionId,
            StartedAtUtc = DateTime.UtcNow,
            LastAtUtc = DateTime.UtcNow,
        });
        db.SaveChanges();
    }

    private static AgentLineageReport Barnaby(LineageReport r) => r.Agents.Single(a => a.AgentKey == "barnaby");

    // ---- the healthy case ----

    [Fact]
    public async Task An_intact_compression_chain_maps_to_its_conversation_and_reports_clean()
    {
        // A → B → C, the legacy rotation shape: each parent ended in compression.
        using var gateway = new StubHermes
        {
            Sessions =
            [
                new StubSession("A", EndReason: "compression"),
                new StubSession("B", Parent: "A", EndReason: "compression"),
                new StubSession("C", Parent: "B"),
            ],
        };
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        Anchor(app, "C"); // HomeHub knows only the newest id — the D2 situation §3.1 describes

        var report = await ReportAsync(app);
        var b = Barnaby(report);

        // All three resolve to one lineage and one conversation, including B — the middle session
        // that a resolve-only reconciliation never reveals, and the entire reason for enumerating.
        Assert.Equal(3, b.Counts.VerifiedAndMapped);
        Assert.Equal(2, b.Counts.LegacyCompressionChildren);
        Assert.Empty(b.BlockingReasons);
        Assert.True(report.Clean);
    }

    [Fact]
    public async Task An_in_place_deployment_has_one_session_per_conversation_and_reports_clean()
    {
        // What the deployed profiles actually do: compression rewrites in place, nothing rotates.
        using var gateway = new StubHermes { Sessions = [new StubSession("only")] };
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        Anchor(app, "only");

        var report = await ReportAsync(app);

        Assert.Equal(1, Barnaby(report).Counts.VerifiedAndMapped);
        Assert.Equal(0, Barnaby(report).Counts.LegacyCompressionChildren);
        Assert.True(report.Clean);
    }

    // ---- the ways it must refuse to be clean ----

    [Fact]
    public async Task A_namespaced_session_no_conversation_claims_is_provably_our_orphan()
    {
        // Created under HomeHub's namespace, so ownership is not a judgement call — the id says so.
        // This is a real retention gap: nothing would ever delete it, and nothing records it exists.
        using var gateway = new StubHermes
        {
            Sessions = [new StubSession("homehub_barnaby_" + new string('a', 32))],
        };
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };

        var report = await ReportAsync(app);
        var b = Barnaby(report);

        Assert.Equal(1, b.Counts.UnmatchedHomeHubSession);
        Assert.Equal(0, b.Counts.LegacyAmbiguous);
        Assert.False(report.Clean);
    }

    [Fact]
    public async Task A_pre_namespacing_session_is_ambiguous_rather_than_claimed_as_ours()
    {
        // `api-…` proves only that something used the API server. Counting it as a HomeHub orphan
        // would be inventing evidence — and counting it as somebody else's would be the same mistake
        // pointing the other way. Both block; only one of them is ours to fix.
        using var gateway = new StubHermes { Sessions = [new StubSession("api-7c3c87dc9c01cdf7")] };
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };

        var report = await ReportAsync(app);
        var b = Barnaby(report);

        Assert.Equal(1, b.Counts.LegacyAmbiguous);
        Assert.Equal(0, b.Counts.UnmatchedHomeHubSession);
        Assert.False(report.Clean);
        Assert.Contains(report.BlockingReasons, r => r.Contains("cannot be established"));
    }

    [Fact]
    public async Task A_lineage_no_conversation_claims_blocks_the_report()
    {
        using var gateway = new StubHermes
        {
            Sessions = [new StubSession("orphaned-root", EndReason: "compression"),
                        new StubSession("orphaned-child", Parent: "orphaned-root")],
        };
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        // No Anchor — nothing in HomeHub points at either session.

        var report = await ReportAsync(app);
        var b = Barnaby(report);

        // Nothing would ever delete these, and nothing records that they exist. Retention would run,
        // report success, and leave two transcripts on the agent indefinitely.
        // Generic ids, so these are ambiguous rather than provably HomeHub's — see the two tests above.
        Assert.Equal(2, b.Counts.LegacyAmbiguous);
        Assert.False(report.Clean);
    }

    [Fact]
    public async Task A_parent_the_agent_does_not_have_is_reported_as_a_broken_chain()
    {
        // The child survives with parent_session_id pointing at a row that is gone — exactly what
        // Hermes leaves behind when an ancestor is deleted, and unreconstructable by design.
        using var gateway = new StubHermes { Sessions = [new StubSession("survivor", Parent: "long-gone")] };
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        Anchor(app, "survivor");

        var report = await ReportAsync(app);
        var b = Barnaby(report);

        Assert.Equal(1, b.Counts.BrokenParentChain);
        Assert.False(report.Clean);
        Assert.Contains(b.Findings, f => f.Kind == nameof(LineageClass.BrokenParentChain)
                                      && f.Detail.Contains("long-gone"));
    }

    [Fact]
    public async Task Two_children_of_one_parent_are_reported_as_a_branch_not_a_rotation()
    {
        // A compression chain is linear. Two children means §3's "HomeHub does not fork, so deleting
        // every descendant cannot destroy a deliberate branch" has stopped being true.
        using var gateway = new StubHermes
        {
            Sessions =
            [
                new StubSession("root", EndReason: "compression"),
                new StubSession("left", Parent: "root"),
                new StubSession("right", Parent: "root"),
            ],
        };
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        Anchor(app, "left");

        var report = await ReportAsync(app);
        var b = Barnaby(report);

        Assert.Equal(2, b.Counts.UnexpectedBranchOrFork);
        Assert.Equal(0, b.Counts.LegacyCompressionChildren); // neither child is a plain rotation
        Assert.False(report.Clean);
    }

    [Fact]
    public async Task A_child_of_a_session_that_did_not_compress_is_reported_without_guessing_what_it_is()
    {
        // A fork and a delegate child look identical on this wire — no kind field — and they need
        // opposite handling: a delegate is cascade-deleted with its parent, a fork must not be.
        using var gateway = new StubHermes
        {
            Sessions = [new StubSession("parent", EndReason: "completed"),
                        new StubSession("child", Parent: "parent")],
        };
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        Anchor(app, "parent");

        var report = await ReportAsync(app);
        var finding = Assert.Single(Barnaby(report).Findings,
            f => f.Kind == nameof(LineageClass.UnexpectedBranchOrFork));

        // The report names both possibilities and the evidence, and picks neither.
        Assert.Contains("fork or delegate", finding.Detail);
        Assert.Contains("completed", finding.Detail);
        Assert.False(report.Clean);
    }

    [Fact]
    public async Task A_parent_chain_that_loops_is_reported_rather_than_hanging()
    {
        // Should be impossible. A repair tool that spins forever on impossible data is worse than
        // one that says so.
        using var gateway = new StubHermes
        {
            Sessions = [new StubSession("x", Parent: "y"), new StubSession("y", Parent: "x")],
        };
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        Anchor(app, "x");

        var report = await ReportAsync(app);

        Assert.Equal(2, Barnaby(report).Counts.Cycle);
        Assert.False(report.Clean);
    }

    [Fact]
    public async Task One_lineage_claimed_by_two_conversations_is_a_conflict()
    {
        using var gateway = new StubHermes
        {
            Sessions = [new StubSession("shared-root", EndReason: "compression"),
                        new StubSession("shared-child", Parent: "shared-root")],
        };
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        Anchor(app, "shared-root");
        Anchor(app, "shared-child");

        var report = await ReportAsync(app);
        var b = Barnaby(report);

        // Deleting either conversation would take the other's transcript with it.
        Assert.Equal(2, b.Counts.MultipleConversationConflict);
        Assert.Equal(0, b.Counts.VerifiedAndMapped);
        Assert.False(report.Clean);
    }

    [Fact]
    public async Task A_conversation_spanning_two_lineages_is_a_conflict()
    {
        using var gateway = new StubHermes
        {
            Sessions = [new StubSession("root-one"), new StubSession("root-two")],
        };
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        Anchor(app, "root-one");

        // A second, unrelated root attached to the same conversation by a lineage reference.
        using (var scope = app.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
            var id = db.Conversations.Single().Id;
            db.HermesSessionReferences.Add(new HermesSessionReference
            { ConversationId = id, AgentKey = "barnaby", SessionId = "root-two", IsCurrent = false,
              DiscoveredAtUtc = DateTime.UtcNow });
            db.HermesSessionReferences.Add(new HermesSessionReference
            { ConversationId = id, AgentKey = "barnaby", SessionId = "root-one", IsCurrent = true,
              DiscoveredAtUtc = DateTime.UtcNow });
            db.SaveChanges();
        }

        var report = await ReportAsync(app);

        Assert.Equal(2, Barnaby(report).Counts.MultipleRootConflict);
        Assert.False(report.Clean);
    }

    // ---- what it must not touch, and must not claim ----

    [Fact]
    public async Task Sessions_HomeHub_did_not_create_are_counted_and_left_alone()
    {
        using var gateway = new StubHermes
        {
            Sessions = [new StubSession("ours"), new StubSession("theirs", Source: "cli")],
        };
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        Anchor(app, "ours");

        var report = await ReportAsync(app);
        var b = Barnaby(report);

        // Counted so the totals reconcile — a report that silently dropped them would be clean by
        // construction — but never mapped, and never a reason to block.
        Assert.Equal(1, b.Counts.NonHomeHubSource);
        Assert.Equal(1, b.Counts.VerifiedAndMapped);
        Assert.True(report.Clean);
    }

    [Fact]
    public async Task A_lineage_climbing_into_someone_elses_session_blocks_rather_than_mapping()
    {
        // Deleting "every descendant" here would reach a session made at the CLI.
        using var gateway = new StubHermes
        {
            Sessions = [new StubSession("cli-root", Source: "cli", EndReason: "compression"),
                        new StubSession("ours", Parent: "cli-root")],
        };
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        Anchor(app, "ours");

        var report = await ReportAsync(app);

        Assert.Equal(1, Barnaby(report).Counts.ForeignAncestor);
        Assert.False(report.Clean);
    }

    [Fact]
    public async Task An_agent_that_cannot_be_read_blocks_the_verdict_rather_than_being_skipped()
    {
        // The tempting alternative — report on the agents that answered — produces a clean result
        // for a household whose other agent is holding every transcript it ever had.
        using var app = new HubAppFactory { HermesBaseUrl = "http://127.0.0.1:1" };

        var report = await ReportAsync(app);

        Assert.False(Barnaby(report).Reachable);
        Assert.False(report.Clean);
        Assert.Contains(report.BlockingReasons, r => r.Contains("could not be read"));
    }

    [Fact]
    public async Task The_report_writes_nothing()
    {
        using var gateway = new StubHermes
        {
            // Deliberately the damaged shapes: if anything in here were tempted to "fix" what it
            // found, this is where it would.
            Sessions = [new StubSession("orphan", Parent: "gone"), new StubSession("unclaimed")],
        };
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        Anchor(app, "orphan");

        using (var scope = app.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
            var id = db.Conversations.Single().Id;
            db.HermesSessionReferences.Add(new HermesSessionReference
            { ConversationId = id, AgentKey = "barnaby", SessionId = "orphan", IsCurrent = true,
              DiscoveredAtUtc = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc) });
            db.SaveChanges();
        }

        // Field values, not row counts. A backfill that ran early would most likely *add* a reference
        // or flip IsCurrent — both of which a count comparison would miss entirely.
        string Snapshot()
        {
            using var s = app.Services.CreateScope();
            var db = s.ServiceProvider.GetRequiredService<HomeHubDbContext>();
            var convos = db.Conversations.OrderBy(c => c.Id)
                .Select(c => $"{c.Id}|{c.AgentKey}|{c.HermesSessionId}|{c.ArchivedAtUtc}");
            var refs = db.HermesSessionReferences.OrderBy(r => r.Id)
                .Select(r => $"{r.ConversationId}|{r.AgentKey}|{r.SessionId}|{r.IsCurrent}|{r.DiscoveredAtUtc:O}");
            return string.Join(";", convos) + "//" + string.Join(";", refs);
        }

        var before = Snapshot();
        await ReportAsync(app);
        await ReportAsync(app); // twice — a report that repaired on first run would differ on second

        Assert.Equal(before, Snapshot());

        // And nothing was deleted on the agent: the report never calls DELETE, so a session it
        // classified as unclaimed is still there to be classified again.
        Assert.Empty(gateway.DeletedSessionIds);
    }

    [Fact]
    public async Task The_report_carries_no_session_content()
    {
        using var gateway = new StubHermes { Sessions = [new StubSession("ours")] };
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        Anchor(app, "ours");

        var raw = await app.CreateSeededClient().GetStringAsync("/api/assist/lineage/report");

        // It reads every session on the agent, including ones HomeHub does not own, purely to
        // classify them. Copying their titles or previews into a report would be a worse privacy
        // trade than the one this exists to fix.
        Assert.DoesNotContain("must not copy", raw, StringComparison.Ordinal);
    }

    // ---- the gate ----

    [Fact]
    public async Task The_delete_modal_may_not_promise_completeness_until_the_report_is_clean()
    {
        using var gateway = new StubHermes { Sessions = [new StubSession("unclaimed")] };
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };

        var dirty = await ReportAsync(app);

        Assert.False(dirty.Clean);
        Assert.Contains("may remain on the agent", dirty.PermittedDeleteCopy);

        // And the stronger wording becomes available only once nothing is unexplained.
        using var healthy = new StubHermes { Sessions = [new StubSession("ours")] };
        using var app2 = new HubAppFactory { HermesBaseUrl = healthy.BaseUrl };
        Anchor(app2, "ours");

        var clean = await ReportAsync(app2);

        Assert.True(clean.Clean);
        Assert.DoesNotContain("may remain on the agent", clean.PermittedDeleteCopy);
        // The memory caveat is true either way — D4 — and survives a clean report.
        Assert.Contains("long-term memory may remain", clean.PermittedDeleteCopy);
    }

    // ---- enumeration mechanics ----

    [Fact]
    public async Task The_index_is_paged_rather_than_read_in_one_request()
    {
        // 250 sessions at a page size of 200: two requests, and the second is short, which is what
        // ends the loop. `has_more` is not a field on this index.
        using var gateway = new StubHermes
        {
            Sessions = [.. Enumerable.Range(0, 250).Select(i => new StubSession($"s{i}"))],
        };
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };

        var report = await ReportAsync(app);

        Assert.Equal(250, Barnaby(report).SessionsSeen);
        Assert.Equal(2, Barnaby(report).PagesRead);
        Assert.Equal(2, gateway.SessionPageReads);
    }
}
