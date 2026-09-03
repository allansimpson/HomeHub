namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using HomeHub.Api.Ai;
using HomeHub.Api.Assist;
using HomeHub.Api.Data;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using static HomeHub.Tests.StubHermes;

/// <summary>
/// The boundary between HomeHub and Hermes: HomeHub selects an <b>agent</b>, and nothing else.
/// </summary>
public class HermesAbstractionTests
{
    /// <summary>
    /// The chat request body names no model, provider, tier or route.
    /// </summary>
    /// <remarks>
    /// Asserted against the bytes on the wire rather than against a config object, because every
    /// previous version of this boundary leaked by adding a *field* that looked harmless. Hermes
    /// defaults a missing model to the listener's own profile, so omitting it is the mechanism by
    /// which the endpoint selects the agent — not an optimisation.
    /// </remarks>
    [Fact]
    public async Task A_chat_request_names_no_model_provider_or_route()
    {
        var captured = await CaptureChatBodyAsync();

        using var doc = JsonDocument.Parse(captured);
        var root = doc.RootElement;

        foreach (var banned in (string[])["model", "provider", "model_options", "route", "tier", "service_tier"])
            Assert.False(root.TryGetProperty(banned, out _), $"the request must not carry '{banned}'");

        // What it *does* carry.
        Assert.True(root.TryGetProperty("messages", out var messages));
        Assert.Equal(JsonValueKind.Array, messages.ValueKind);
        Assert.True(root.TryGetProperty("stream", out _));
    }

    [Fact]
    public async Task A_spoken_turn_sends_the_same_request_as_a_typed_one()
    {
        var typed = await CaptureChatBodyAsync(spoken: false);
        var spoken = await CaptureChatBodyAsync(spoken: true);

        // Speech is a HomeHub modality — STT, TTS, cancellation, UX timing. It is not a model
        // selector, and the earlier "fast route for spoken turns" design is gone for good.
        Assert.Equal(typed, spoken);
    }

    /// <summary>Run one turn against a stub gateway and hand back the exact body HomeHub sent.</summary>
    private static async Task<string> CaptureChatBodyAsync(bool spoken = false)
    {
        using var gateway = new StubHermes();
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(null, "barnaby", "Bins tonight?", null, null, null, spoken));
        res.EnsureSuccessStatusCode();

        Assert.NotNull(gateway.LastChatBody);
        return gateway.LastChatBody!;
    }
}

/// <summary>
/// Two agents are two gateways. A session id belongs to the listener that issued it and to no other.
/// </summary>
public class HermesProfileIsolationTests
{
    private static readonly (string Key, string Name, bool Default)[] TwoAgents =
        [("barnaby", "Barnaby", true), ("geist", "Geist", false)];

    [Fact]
    public async Task Each_agents_turns_go_only_to_its_own_gateway()
    {
        using var barnaby = new StubHermes();
        using var geist = new StubHermes();
        using var app = new HubAppFactory
        {
            Agents = TwoAgents,
            AgentBaseUrls = new() { ["barnaby"] = barnaby.BaseUrl, ["geist"] = geist.BaseUrl },
        };
        var client = app.CreateSeededClient();
        await client.PutAsJsonAsync("/api/assist/assignments/1", new SetAgentAssignmentsRequest(["geist"]));

        await client.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(null, "barnaby", "Bins tonight?", null, null, null));
        await client.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(null, "geist", "Explain this stack trace", null, null, null));

        Assert.Equal(1, barnaby.ChatCount);
        Assert.Equal(1, geist.ChatCount);
    }

    [Fact]
    public async Task A_conversations_session_id_never_reaches_the_other_gateway()
    {
        using var barnaby = new StubHermes { SessionId = "barnaby-session-1" };
        using var geist = new StubHermes { SessionId = "geist-session-1" };
        using var app = new HubAppFactory
        {
            Agents = TwoAgents,
            AgentBaseUrls = new() { ["barnaby"] = barnaby.BaseUrl, ["geist"] = geist.BaseUrl },
        };
        var client = app.CreateSeededClient();
        await client.PutAsJsonAsync("/api/assist/assignments/1", new SetAgentAssignmentsRequest(["geist"]));

        var res = await client.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(null, "barnaby", "Bins tonight?", null, null, null));
        var started = (await res.Content.ReadFromJsonAsync<AssistChatResponse>())!;

        // The panel does this by leaving a chat screen mounted while the inbox switches agent.
        await client.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(started.ConversationId, "geist", "And tomorrow?", null, null, null));

        // Geist saw only its own conversation's turn — never Barnaby's session id.
        Assert.DoesNotContain(geist.SeenSessionIds, id => id.StartsWith("barnaby-", StringComparison.Ordinal));
        Assert.Contains(barnaby.SeenSessionIds, id => id == "barnaby-session-1");
    }

    [Fact]
    public async Task A_deletion_is_only_ever_sent_to_the_owning_gateway()
    {
        using var barnaby = new StubHermes { SessionId = "barnaby-session-1" };
        using var geist = new StubHermes { SessionId = "geist-session-1" };
        using var app = new HubAppFactory
        {
            Agents = TwoAgents,
            AgentBaseUrls = new() { ["barnaby"] = barnaby.BaseUrl, ["geist"] = geist.BaseUrl },
        };
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(null, "barnaby", "Bins tonight?", null, null, null));
        var started = (await res.Content.ReadFromJsonAsync<AssistChatResponse>())!;

        await client.PostAsJsonAsync("/api/assist/conversations/delete",
            new DeleteConversationsRequest([started.ConversationId]));

        // Never both "just in case": a Barnaby id is meaningless to Geist's database, so asking
        // could only succeed by coincidence.
        Assert.NotEmpty(barnaby.DeletedSessionIds);
        Assert.Empty(geist.DeletedSessionIds);
    }
}

/// <summary>The keys are server-side only, and stay there.</summary>
public class HermesSecretTests
{
    [Fact]
    public void The_roster_type_carries_no_credential()
    {
        // Agent is what every layer above the client passes around. If it had a key property, the key
        // would be one careless serialisation from a log line or a response body.
        var properties = typeof(Agent).GetProperties().Select(p => p.Name).ToList();
        Assert.DoesNotContain(properties, n => n.Contains("Key", StringComparison.OrdinalIgnoreCase)
            && !n.Equals("Key", StringComparison.Ordinal));
        Assert.DoesNotContain(properties, n => n.Contains("Secret", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(properties, n => n.Contains("Token", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task No_api_response_contains_the_configured_key()
    {
        const string secret = "test-key-not-a-real-credential";
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        foreach (var path in (string[])
            ["/api/assist/conversations?profileId=1", "/api/assist/agents?profileId=1", "/api/assist/assignments/1", "/api/settings"])
        {
            var body = await client.GetStringAsync(path);
            Assert.DoesNotContain(secret, body, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task An_auth_failure_reports_the_agent_but_never_the_credential()
    {
        using var gateway = new StubHermes { ChatStatus = HttpStatusCode.Unauthorized };
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(null, "barnaby", "Bins tonight?", null, null, null));
        res.EnsureSuccessStatusCode();
        var body = await res.Content.ReadAsStringAsync();

        // The household gets a plain unavailable message; the operator detail is in the log.
        Assert.DoesNotContain("test-key-not-a-real-credential", body, StringComparison.Ordinal);
        Assert.Contains("unreachable", body, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void An_agent_with_no_key_is_accepted_so_the_panel_still_starts()
    {
        // **This used to fail validation.** Once validation began running at startup, that turned
        // "Geist has no key yet" into "the panel does not boot" — taking the climate, the calendar
        // and the litter box down over an agent nobody had finished setting up. A wall panel that
        // runs the house must not be hostage to an optional assistant.
        //
        // And it need not be: an unconfigured agent is a state the system already models properly.
        // It lists in the roster, reports `configured: false`, and a turn falls back to the canned
        // reply. Startup logs which agents are in that state; nothing stops.
        var options = new HermesOptions
        {
            Agents = new(StringComparer.OrdinalIgnoreCase)
            {
                ["barnaby"] = new() { Name = "Barnaby", BaseUrl = "http://127.0.0.1:8642", Default = true, ApiKey = "k" },
                ["geist"] = new() { Name = "Geist", BaseUrl = "http://127.0.0.1:8643" },
            },
        };

        Assert.True(new HermesOptionsValidator().Validate(null, options).Succeeded);
    }

    [Fact]
    public void The_options_validator_still_rejects_an_agent_that_cannot_work_at_all()
    {
        // The distinction the rule above turns on: a missing key is a thing that gets *added later*,
        // so the panel waits. A missing or malformed address is a mistake in a tracked file that no
        // later step fixes — and an agent with no address cannot even be listed honestly.
        var options = new HermesOptions
        {
            Agents = new(StringComparer.OrdinalIgnoreCase)
            {
                ["barnaby"] = new() { Name = "Barnaby", BaseUrl = "", Default = true, ApiKey = "k" },
                ["geist"] = new() { Name = "Geist", BaseUrl = "not-a-url", ApiKey = "k" },
            },
        };

        var result = new HermesOptionsValidator().Validate(null, options);

        Assert.True(result.Failed);
        Assert.Contains(result.Failures, f => f.Contains("BaseUrl", StringComparison.Ordinal));
        // Actionable without printing a secret — the message names settings, never values.
        Assert.DoesNotContain(result.Failures, f => f.Contains("Bearer", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void The_options_validator_requires_exactly_one_default_agent()
    {
        var two = new HermesOptions
        {
            Agents = new(StringComparer.OrdinalIgnoreCase)
            {
                ["barnaby"] = new() { Name = "B", BaseUrl = "http://127.0.0.1:8642", ApiKey = "k", Default = true },
                ["geist"] = new() { Name = "G", BaseUrl = "http://127.0.0.1:8643", ApiKey = "k", Default = true },
            },
        };
        Assert.True(new HermesOptionsValidator().Validate(null, two).Failed);

        var none = new HermesOptions
        {
            Agents = new(StringComparer.OrdinalIgnoreCase)
            {
                ["barnaby"] = new() { Name = "B", BaseUrl = "http://127.0.0.1:8642", ApiKey = "k" },
            },
        };
        Assert.True(new HermesOptionsValidator().Validate(null, none).Failed);
    }
}

/// <summary>What happens when an agent cannot answer — and, more importantly, what does not.</summary>
public class HermesAvailabilityTests
{
    private static readonly (string Key, string Name, bool Default)[] TwoAgents =
        [("barnaby", "Barnaby", true), ("geist", "Geist", false)];

    [Fact]
    public async Task One_agent_being_down_never_redirects_to_the_other()
    {
        // Barnaby's address points nowhere; Geist's is a live stub.
        using var geist = new StubHermes();
        using var app = new HubAppFactory
        {
            Agents = TwoAgents,
            AgentBaseUrls = new() { ["barnaby"] = "http://127.0.0.1:1", ["geist"] = geist.BaseUrl },
        };
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(null, "barnaby", "Bins tonight?", null, null, null));
        res.EnsureSuccessStatusCode();
        var body = (await res.Content.ReadFromJsonAsync<AssistChatResponse>())!;

        // Geist is a different agent with a different memory. Substituting it would be answering as
        // somebody the household did not ask.
        Assert.Equal(0, geist.ChatCount);
        Assert.Equal("Local", body.Origin);
        Assert.Contains("unreachable", body.Message.Text, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task A_busy_agent_does_not_duplicate_the_turn()
    {
        using var gateway = new StubHermes { ChatStatus = HttpStatusCode.TooManyRequests };
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(null, "barnaby", "Bins tonight?", null, null, null));
        res.EnsureSuccessStatusCode();
        var body = (await res.Content.ReadFromJsonAsync<AssistChatResponse>())!;

        Assert.Equal(1, gateway.ChatCount); // attempted once, never retried into a second run
        Assert.Contains("something else", body.Message.Text, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Deterministic_house_actions_work_with_every_agent_offline()
    {
        using var app = new HubAppFactory
        {
            Agents = TwoAgents,
            AgentBaseUrls = new() { ["barnaby"] = "http://127.0.0.1:1", ["geist"] = "http://127.0.0.1:1" },
        };
        var client = app.CreateSeededClient();

        // The action layer resolves a list from the lists this member already has, so one has to
        // exist before "add X to the grocery list" can mean anything.
        using (var scope = app.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
            db.Tasks.Add(new HomeHub.Api.Tasks.TaskItem
            {
                ProfileId = 1, Title = "Milk", Source = "local", ListName = "Grocery List",
            });
            db.SaveChanges();
        }

        var res = await client.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(null, "barnaby", "Add basil to the grocery list", null, null, null));
        res.EnsureSuccessStatusCode();
        var body = (await res.Content.ReadFromJsonAsync<AssistChatResponse>())!;

        // The house did it, with no model involved and nothing reachable. That is the whole point of
        // keeping this path.
        Assert.Equal("Local", body.Origin);
        Assert.Equal("task", body.Message.Action);
        Assert.Contains("Basil", body.Message.Text, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task An_unknown_agent_key_from_a_browser_is_refused()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(null, "not-an-agent", "Bins tonight?", null, null, null));

        // The roster is closed. A browser may name an agent; it may never name an address.
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }
}

/// <summary>Deletion is durable and lineage-aware, and it survives the agent being down.</summary>
public class HermesDeletionTests
{
    [Fact]
    public async Task Every_lineage_id_is_queued_and_deleted()
    {
        using var gateway = new StubHermes();
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(null, "barnaby", "Holiday cottage shortlist", null, null, null));
        var started = (await res.Content.ReadFromJsonAsync<AssistChatResponse>())!;

        // Two prior compressions the conversation has already been through.
        using (var scope = app.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
            db.HermesSessionReferences.AddRange(
                new HermesSessionReference { ConversationId = started.ConversationId, AgentKey = "barnaby", SessionId = "s-A", DiscoveredAtUtc = DateTime.UtcNow },
                new HermesSessionReference { ConversationId = started.ConversationId, AgentKey = "barnaby", SessionId = "s-B", DiscoveredAtUtc = DateTime.UtcNow });
            db.SaveChanges();
        }

        await client.PostAsJsonAsync("/api/assist/conversations/delete",
            new DeleteConversationsRequest([started.ConversationId]));

        // Ancestors go too. Deleting only the newest is what would leave most of a long conversation
        // on the agent while the tombstone reported success.
        Assert.Contains("s-A", gateway.DeletedSessionIds);
        Assert.Contains("s-B", gateway.DeletedSessionIds);
    }

    /*
     * A tombstone that has given up must still be a tombstone that tries again.
     *
     * The drain used to exclude rows once `Attempts >= MaxAttempts`, which made "never discarded" true
     * and beside the point: a Hermes that was down for a day, or a gateway whose credential was
     * rotated and then fixed, left the household's transcripts on the agent for ever with nothing that
     * would ever retry. The threshold still means something — past it the backoff widens to a day and
     * the warning is logged — but it no longer means stop.
     */
    [Fact]
    public async Task A_tombstone_past_its_attempt_limit_is_still_retried()
    {
        using var app = new HubAppFactory { HermesBaseUrl = "http://127.0.0.1:1" };
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(null, "barnaby", "Boiler quotes", null, null, null));
        var started = (await res.Content.ReadFromJsonAsync<AssistChatResponse>())!;

        using (var scope = app.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
            db.Conversations.First(c => c.Id == started.ConversationId).HermesSessionId = "s-unreachable";
            db.SaveChanges();
        }

        (await client.PostAsJsonAsync("/api/assist/conversations/delete",
            new DeleteConversationsRequest([started.ConversationId]))).EnsureSuccessStatusCode();

        // A row that has spent its budget, and whose next attempt is due.
        using (var scope = app.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
            foreach (var row in db.HermesSessionDeletions.Where(d => d.CompletedAtUtc == null))
            {
                row.Attempts = SessionDeletionWorker.MaxAttempts + 3;
                row.NextAttemptUtc = DateTime.UtcNow.AddMinutes(-1);
            }
            db.SaveChanges();
        }

        var before = AttemptsOf(app);
        await app.Services.GetRequiredService<SessionDeletionWorker>().DrainAsync(CancellationToken.None);

        // Tried again, and scheduled to be tried again after that.
        Assert.True(AttemptsOf(app) > before, "A tombstone past its attempt limit was never retried.");
        using (var scope = app.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
            Assert.All(
                db.HermesSessionDeletions.Where(d => d.CompletedAtUtc == null).ToList(),
                row => Assert.NotNull(row.NextAttemptUtc));
        }
    }

    private static int AttemptsOf(HubAppFactory app)
    {
        using var scope = app.Services.CreateScope();
        return scope.ServiceProvider.GetRequiredService<HomeHubDbContext>()
            .HermesSessionDeletions.Where(d => d.CompletedAtUtc == null).Sum(d => d.Attempts);
    }

    [Fact]
    public async Task An_agent_that_is_down_leaves_a_retryable_tombstone()
    {
        using var app = new HubAppFactory { HermesBaseUrl = "http://127.0.0.1:1" };
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(null, "barnaby", "Boiler quotes", null, null, null));
        var started = (await res.Content.ReadFromJsonAsync<AssistChatResponse>())!;

        using (var scope = app.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
            var convo = db.Conversations.First(c => c.Id == started.ConversationId);
            convo.HermesSessionId = "s-unreachable";
            db.SaveChanges();
        }

        var deleted = await client.PostAsJsonAsync("/api/assist/conversations/delete",
            new DeleteConversationsRequest([started.ConversationId]));
        deleted.EnsureSuccessStatusCode();

        using (var scope = app.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();

            // The household's copy is gone immediately — the promise to the person deleting is kept.
            Assert.Empty(db.Conversations.Where(c => c.Id == started.ConversationId));

            // And the obligation survives, so the transcript is not orphaned by an outage.
            var pending = db.HermesSessionDeletions
                .Where(d => d.ConversationId == started.ConversationId && d.CompletedAtUtc == null)
                .ToList();
            Assert.Contains(pending, d => d.SessionId == "s-unreachable");
            Assert.All(pending, d => Assert.Equal("barnaby", d.AgentKey));
        }
    }

    [Fact]
    public async Task A_404_completes_that_id_because_the_outcome_already_holds()
    {
        using var gateway = new StubHermes { DeleteStatus = HttpStatusCode.NotFound };
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(null, "barnaby", "Gone already", null, null, null));
        var started = (await res.Content.ReadFromJsonAsync<AssistChatResponse>())!;

        await client.PostAsJsonAsync("/api/assist/conversations/delete",
            new DeleteConversationsRequest([started.ConversationId]));

        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
        var rows = db.HermesSessionDeletions.Where(d => d.ConversationId == started.ConversationId).ToList();

        Assert.NotEmpty(rows);
        Assert.All(rows, d => Assert.NotNull(d.CompletedAtUtc));
    }

    /*
     * <b>H2b.</b> A conversation's tombstone names the sessions HomeHub knew about at the moment it
     * was written. Hermes can rotate a session into a child by compression at any point up to and
     * including that moment — including after a deletion was authorised but before the delete request
     * actually ran — and the local anchor that would have revealed the child is gone the instant the
     * conversation row is removed. The tombstone for the old session is then the only thing left that
     * points anywhere near the new one, so the drain follows it: before working the queue, it re-reads
     * each due agent's session index and queues a descendant a tombstoned session has grown, however
     * many passes it takes to reach it.
     */
    [Fact]
    public async Task A_session_that_compressed_before_the_delete_request_has_its_child_queued_too()
    {
        // The agent's actual state by the time the delete request arrives: "A" already ended in
        // compression and rotated into "B". HomeHub's own row still names only "A" — nothing told it
        // about the rotation, because only a chat turn would have.
        using var gateway = new StubHermes
        {
            SessionId = "A",
            Sessions = [new StubSession("A", EndReason: "compression"), new StubSession("B", Parent: "A")],
        };
        using var app = new HubAppFactory { HermesBaseUrl = gateway.BaseUrl };
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(null, "barnaby", "Boiler quotes", null, null, null));
        var started = (await res.Content.ReadFromJsonAsync<AssistChatResponse>())!;

        (await client.PostAsJsonAsync("/api/assist/conversations/delete",
            new DeleteConversationsRequest([started.ConversationId]))).EnsureSuccessStatusCode();

        // "A" is gone — the delete request's own immediate drain reached it. "B" is queued but not
        // yet attempted: it was discovered by that same pass, after the row list it was working from
        // had already been read.
        using (var scope = app.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
            var rows = db.HermesSessionDeletions
                .Where(d => d.ConversationId == started.ConversationId).ToList();

            var a = Assert.Single(rows, d => d.SessionId == "A");
            Assert.NotNull(a.CompletedAtUtc);

            var b = Assert.Single(rows, d => d.SessionId == "B");
            Assert.Null(b.CompletedAtUtc);
        }
        Assert.Contains("A", gateway.DeletedSessionIds);
        Assert.DoesNotContain("B", gateway.DeletedSessionIds);

        // The next pass reaches it.
        await app.Services.GetRequiredService<SessionDeletionWorker>().DrainAsync(CancellationToken.None);

        Assert.Contains("B", gateway.DeletedSessionIds);
        using (var scope = app.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
            Assert.NotNull(db.HermesSessionDeletions.Single(d => d.SessionId == "B").CompletedAtUtc);
        }
    }
}
