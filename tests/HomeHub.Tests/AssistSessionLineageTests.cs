namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Assist;
using HomeHub.Api.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

/// <summary>
/// Stage 1 of the Hermes integration: the invariants that hold with no Hermes running at all
/// (HERMES_INTEGRATION.md §10).
///
/// No agent is configured here, so every turn is answered by the canned fallback and no Hermes
/// session is ever created. That is the point — these exercise ownership, locking and the ledger,
/// which must be correct before an agent is reachable rather than after.
/// </summary>
public class AssistAgentOwnershipTests
{
    private static readonly (string Key, string Name, bool Default)[] TwoAgents =
    [
        ("barnaby", "Barnaby", true),
        ("geist", "Geist", false),
    ];

    [Fact]
    public async Task An_existing_conversation_keeps_its_agent_when_the_request_names_another()
    {
        using var app = new HubAppFactory { Agents = TwoAgents };
        var client = app.CreateSeededClient();
        await client.PutAsJsonAsync("/api/assist/assignments/1", new SetAgentAssignmentsRequest(["geist"]));

        var started = await Post(client, new AssistChatRequest(null, "barnaby", "Bins tonight?", null, null, null));

        // The panel does this by having a chat screen mounted while the inbox switches agent.
        await Post(client, new AssistChatRequest(started.ConversationId, "geist", "And tomorrow?", null, null, null));

        var detail = await client.GetFromJsonAsync<ConversationDetailDto>(
            $"/api/assist/conversations/{started.ConversationId}");

        // Still Barnaby's. A conversation holds a Hermes session id, and Hermes profiles are isolated
        // databases — honouring the request would have sent a Barnaby session to /p/geist.
        Assert.Equal("barnaby", detail!.Conversation.AgentKey);
        Assert.Equal(4, detail.Messages.Count);
    }

    [Fact]
    public async Task The_conversation_stays_in_its_own_agents_list_after_a_mismatched_turn()
    {
        using var app = new HubAppFactory { Agents = TwoAgents };
        var client = app.CreateSeededClient();
        await client.PutAsJsonAsync("/api/assist/assignments/1", new SetAgentAssignmentsRequest(["geist"]));

        var started = await Post(client, new AssistChatRequest(null, "barnaby", "Bins tonight?", null, null, null));
        await Post(client, new AssistChatRequest(started.ConversationId, "geist", "And tomorrow?", null, null, null));

        var barnaby = await client.GetFromJsonAsync<ConversationListDto>(
            "/api/assist/conversations?profileId=1&agent=barnaby");
        var geist = await client.GetFromJsonAsync<ConversationListDto>(
            "/api/assist/conversations?profileId=1&agent=geist");

        Assert.Single(barnaby!.Conversations);
        Assert.Empty(geist!.Conversations);
    }

    [Fact]
    public async Task A_turn_into_a_conversation_whose_agent_was_revoked_is_refused()
    {
        using var app = new HubAppFactory { Agents = TwoAgents };
        var client = app.CreateSeededClient();
        await client.PutAsJsonAsync("/api/assist/assignments/1", new SetAgentAssignmentsRequest(["geist"]));
        var started = await Post(client, new AssistChatRequest(null, "geist", "Explain this stack trace", null, null, null));

        await client.PutAsJsonAsync("/api/assist/assignments/1", new SetAgentAssignmentsRequest([]));

        var res = await client.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(started.ConversationId, null, "Any update?", null, null, null));

        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
    }

    [Fact]
    public async Task Revoking_an_agent_still_leaves_the_transcript_readable()
    {
        using var app = new HubAppFactory { Agents = TwoAgents };
        var client = app.CreateSeededClient();
        await client.PutAsJsonAsync("/api/assist/assignments/1", new SetAgentAssignmentsRequest(["geist"]));
        var started = await Post(client, new AssistChatRequest(null, "geist", "Explain this stack trace", null, null, null));

        await client.PutAsJsonAsync("/api/assist/assignments/1", new SetAgentAssignmentsRequest([]));

        // Revoking removes access, not history. Reading must still work, or "we kept your
        // conversations" stops being true the moment an admin changes their mind.
        var detail = await client.GetAsync($"/api/assist/conversations/{started.ConversationId}");
        Assert.Equal(HttpStatusCode.OK, detail.StatusCode);
    }

    [Fact]
    public async Task Concurrent_turns_into_one_conversation_do_not_interleave()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var started = await Post(client, new AssistChatRequest(null, null, "Bins tonight?", null, null, null));

        // A spoken turn and a typed turn arriving together is ordinary on a shared panel.
        var sends = Enumerable.Range(0, 5).Select(i => client.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(started.ConversationId, null, $"Follow-up {i}", null, null, null)));
        var responses = await Task.WhenAll(sends);

        Assert.All(responses, r => r.EnsureSuccessStatusCode());

        var detail = await client.GetFromJsonAsync<ConversationDetailDto>(
            $"/api/assist/conversations/{started.ConversationId}");

        // Two rows per turn, and every one accounted for.
        Assert.Equal(12, detail!.Messages.Count);
        Assert.Equal(6, detail.Messages.Count(m => m.Role == "user"));
        Assert.Equal(6, detail.Messages.Count(m => m.Role == "assistant"));
    }

    private static async Task<AssistChatResponse> Post(HttpClient client, AssistChatRequest req)
    {
        var res = await client.PostAsJsonAsync("/api/assist/chat", req);
        res.EnsureSuccessStatusCode();
        return (await res.Content.ReadFromJsonAsync<AssistChatResponse>())!;
    }
}

/// <summary>
/// The compression lineage (HERMES_INTEGRATION.md §3). Hermes ends a session and starts a *child*
/// when it compresses, and both keep their messages — so one conversation can be several Hermes
/// sessions, and deleting only the newest leaves the rest on the server forever.
///
/// No Hermes runs in tests, so these drive <c>HermesSessionReference</c> through the database
/// directly: what is being locked down is the ledger's own behaviour, not the wire.
/// </summary>
public class AssistSessionLineageTests
{
    [Fact]
    public async Task Deleting_a_conversation_takes_its_whole_lineage_with_it()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(null, null, "Holiday cottage shortlist", null, null, null));
        var started = (await res.Content.ReadFromJsonAsync<AssistChatResponse>())!;

        // Stand in for two compressions: A → B → C.
        using (var scope = app.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
            var convo = db.Conversations.First(c => c.Id == started.ConversationId);
            convo.HermesSessionId = "session-C";
            db.HermesSessionReferences.AddRange(
                new HermesSessionReference { ConversationId = convo.Id, AgentKey = "barnaby", SessionId = "session-A", DiscoveredAtUtc = DateTime.UtcNow, IsCurrent = false },
                new HermesSessionReference { ConversationId = convo.Id, AgentKey = "barnaby", SessionId = "session-B", DiscoveredAtUtc = DateTime.UtcNow, IsCurrent = false },
                new HermesSessionReference { ConversationId = convo.Id, AgentKey = "barnaby", SessionId = "session-C", DiscoveredAtUtc = DateTime.UtcNow, IsCurrent = true });
            db.SaveChanges();
        }

        var deleted = await client.PostAsJsonAsync("/api/assist/conversations/delete",
            new DeleteConversationsRequest([started.ConversationId]));
        deleted.EnsureSuccessStatusCode();

        using (var scope = app.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
            // References cascade with the conversation — an orphaned lineage row would be a set of
            // session ids nothing knows how to finish deleting.
            Assert.Empty(db.HermesSessionReferences.Where(r => r.ConversationId == started.ConversationId));
            Assert.Empty(db.Conversations.Where(c => c.Id == started.ConversationId));
        }
    }

    [Fact]
    public async Task A_conversation_can_hold_several_sessions_with_exactly_one_current()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var res = await client.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(null, null, "Boiler quotes", null, null, null));
        var started = (await res.Content.ReadFromJsonAsync<AssistChatResponse>())!;

        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
        db.HermesSessionReferences.AddRange(
            new HermesSessionReference { ConversationId = started.ConversationId, AgentKey = "barnaby", SessionId = "s1", DiscoveredAtUtc = DateTime.UtcNow, IsCurrent = false },
            new HermesSessionReference { ConversationId = started.ConversationId, AgentKey = "barnaby", SessionId = "s2", DiscoveredAtUtc = DateTime.UtcNow, IsCurrent = true });
        await db.SaveChangesAsync();

        var rows = await db.HermesSessionReferences
            .Where(r => r.ConversationId == started.ConversationId).ToListAsync();

        Assert.Equal(2, rows.Count);
        Assert.Single(rows, r => r.IsCurrent);
        // The profile travels with the id: a session id means nothing without knowing whose
        // state.db holds it.
        Assert.All(rows, r => Assert.False(string.IsNullOrWhiteSpace(r.AgentKey)));
    }
}

/// <summary>
/// The per-conversation gate (HERMES_INTEGRATION.md · I4). Keyed on the conversation, never on the
/// Hermes session id — the session id is the value that changes when Hermes compresses, which is the
/// operation the lock exists to protect.
/// </summary>
public class ConversationLockTests
{
    [Fact]
    public async Task One_conversation_admits_one_holder_at_a_time()
    {
        var locks = new ConversationLocks();
        var inside = 0;
        var maxInside = 0;
        var sync = new object();

        await Task.WhenAll(Enumerable.Range(0, 8).Select(async _ =>
        {
            using var gate = await locks.AcquireAsync(42, CancellationToken.None);
            lock (sync) maxInside = Math.Max(maxInside, ++inside);
            await Task.Delay(15);
            lock (sync) inside--;
        }));

        Assert.Equal(1, maxInside);
    }

    [Fact]
    public async Task Different_conversations_do_not_block_each_other()
    {
        var locks = new ConversationLocks();
        using var first = await locks.AcquireAsync(1, CancellationToken.None);

        // Would hang if the gate were global rather than per conversation.
        var second = await locks.AcquireAsync(2, CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(2));
        second.Dispose();

        Assert.True(true);
    }

    [Fact]
    public async Task Releasing_twice_does_not_admit_two_holders()
    {
        var locks = new ConversationLocks();
        var gate = await locks.AcquireAsync(7, CancellationToken.None);
        gate.Dispose();
        gate.Dispose(); // a double dispose must not raise the count above one

        using var next = await locks.AcquireAsync(7, CancellationToken.None);
        var contended = locks.AcquireAsync(7, CancellationToken.None);

        Assert.False(contended.IsCompleted);
    }
}
