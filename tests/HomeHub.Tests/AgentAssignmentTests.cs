namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Assist;
using Microsoft.Extensions.DependencyInjection;

/// <summary>
/// Multiple agents: the roster, who may reach which, and the header rule that falls out of it.
///
/// These configure a two-agent roster through <see cref="HubAppFactory.Agents"/> — no Hermes is
/// running, so nothing here is reachable, which is exactly the point: access is a household
/// decision and must be decidable with every agent offline.
/// </summary>
public class AgentAssignmentTests
{
    private static readonly (string Key, string Name, bool Default)[] TwoAgents =
    [
        ("barnaby", "Barnaby", true),
        ("geist", "Geist", false),
    ];

    [Fact]
    public async Task A_member_starts_with_the_household_agent_only()
    {
        using var app = new HubAppFactory { Agents = TwoAgents };
        var client = app.CreateSeededClient();

        var agents = await client.GetFromJsonAsync<List<AgentDto>>("/api/assist/agents");

        // Geist is configured but granted to nobody. Absence is not access.
        Assert.NotNull(agents);
        Assert.Single(agents);
        Assert.Equal("barnaby", agents[0].Key);
    }

    [Fact]
    public async Task Assigning_an_agent_puts_it_in_the_switcher()
    {
        using var app = new HubAppFactory { Agents = TwoAgents };
        var client = app.CreateSeededClient();

        var put = await client.PutAsJsonAsync("/api/assist/assignments/1",
            new SetAgentAssignmentsRequest(["geist"]));
        put.EnsureSuccessStatusCode();

        var agents = await client.GetFromJsonAsync<List<AgentDto>>("/api/assist/agents");

        Assert.Equal(2, agents!.Count);
        Assert.Contains(agents, a => a.Key == "geist");
    }

    /// <summary>
    /// A grant reaches the member it was made for and nobody else.
    /// </summary>
    /// <remarks>
    /// Two signed-in clients rather than one client naming two members in the URL (AUDIT A1.2). The
    /// old form could not tell a working scope from a broken one: it asked the same session for both
    /// answers and trusted a query parameter to distinguish them.
    /// </remarks>
    [Fact]
    public async Task An_assignment_is_scoped_to_the_member_it_was_made_for()
    {
        using var app = new HubAppFactory { Agents = TwoAgents };
        var astridClient = app.CreateSeededClient(profileId: 1);
        var ragnarClient = app.CreateSeededClient(profileId: 2);

        await astridClient.PutAsJsonAsync("/api/assist/assignments/1", new SetAgentAssignmentsRequest(["geist"]));

        var astrid = await astridClient.GetFromJsonAsync<List<AgentDto>>("/api/assist/agents");
        var ragnar = await ragnarClient.GetFromJsonAsync<List<AgentDto>>("/api/assist/agents");

        Assert.NotNull(astrid);
        Assert.NotNull(ragnar);
        Assert.Equal(2, astrid.Count);
        Assert.Single(ragnar);
    }

    [Fact]
    public async Task The_household_agent_cannot_be_taken_away()
    {
        using var app = new HubAppFactory { Agents = TwoAgents };
        var client = app.CreateSeededClient();

        // Explicitly ask for nothing. A member with no agent would have an Assist tab that cannot do
        // anything, so the household agent is a floor rather than a grant.
        await client.PutAsJsonAsync("/api/assist/assignments/1", new SetAgentAssignmentsRequest([]));

        var agents = await client.GetFromJsonAsync<List<AgentDto>>("/api/assist/agents");

        Assert.NotNull(agents);
        Assert.Single(agents);
        Assert.Equal("barnaby", agents[0].Key);
        Assert.True(agents[0].IsDefault);
    }

    [Fact]
    public async Task Revoking_an_agent_removes_it_from_the_switcher()
    {
        using var app = new HubAppFactory { Agents = TwoAgents };
        var client = app.CreateSeededClient();

        await client.PutAsJsonAsync("/api/assist/assignments/1", new SetAgentAssignmentsRequest(["geist"]));
        await client.PutAsJsonAsync("/api/assist/assignments/1", new SetAgentAssignmentsRequest([]));

        var agents = await client.GetFromJsonAsync<List<AgentDto>>("/api/assist/agents");
        Assert.Single(agents!);
    }

    [Fact]
    public async Task Revoking_an_agent_leaves_the_conversations_alone()
    {
        using var app = new HubAppFactory { Agents = TwoAgents };
        var client = app.CreateSeededClient();

        await client.PutAsJsonAsync("/api/assist/assignments/1", new SetAgentAssignmentsRequest(["geist"]));
        var chat = await client.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(null, "geist", "How many teaspoons in a tablespoon?", null, null, null));
        chat.EnsureSuccessStatusCode();
        var started = (await chat.Content.ReadFromJsonAsync<AssistChatResponse>())!;

        await client.PutAsJsonAsync("/api/assist/assignments/1", new SetAgentAssignmentsRequest([]));

        // Access is removed; history is not. Deleting is a separate act with a modal in front of it.
        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HomeHub.Api.Data.HomeHubDbContext>();
        Assert.NotNull(db.Conversations.FirstOrDefault(c => c.Id == started.ConversationId));
    }

    [Fact]
    public async Task A_turn_naming_an_unassigned_agent_falls_back_to_the_members_own()
    {
        using var app = new HubAppFactory { Agents = TwoAgents };
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(null, "geist", "How many teaspoons in a tablespoon?", null, null, null));
        res.EnsureSuccessStatusCode();
        var body = await res.Content.ReadFromJsonAsync<AssistChatResponse>();

        var detail = await client.GetFromJsonAsync<ConversationDetailDto>(
            $"/api/assist/conversations/{body!.ConversationId}");

        // The chat is filed under Barnaby, not Geist — naming an agent in a request must not be a way
        // to reach one nobody granted.
        Assert.Equal("barnaby", detail!.Conversation.AgentKey);
    }

    [Fact]
    public async Task Listing_an_unassigned_agent_shows_the_members_own_list_not_that_agents()
    {
        using var app = new HubAppFactory { Agents = TwoAgents };
        var client = app.CreateSeededClient();

        // Astrid has Geist and a chat with it.
        await client.PutAsJsonAsync("/api/assist/assignments/1", new SetAgentAssignmentsRequest(["geist"]));
        await client.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(null, "geist", "Astrid's Geist chat", null, null, null));

        // Ragnar does not, and asking for it by name gets his own list rather than hers — as his
        // own session, which is now the only way to be him.
        var ragnar = await app.CreateSeededClient(profileId: 2).GetFromJsonAsync<ConversationListDto>(
            "/api/assist/conversations?agent=geist");

        Assert.Empty(ragnar!.Conversations);
    }

    [Fact]
    public async Task Chats_are_scoped_per_agent_as_well_as_per_member()
    {
        using var app = new HubAppFactory { Agents = TwoAgents };
        var client = app.CreateSeededClient();

        await client.PutAsJsonAsync("/api/assist/assignments/1", new SetAgentAssignmentsRequest(["geist"]));
        await client.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(null, "barnaby", "Bins tonight", null, null, null));
        await client.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(null, "geist", "Explain this stack trace", null, null, null));

        var barnaby = await client.GetFromJsonAsync<ConversationListDto>(
            "/api/assist/conversations?profileId=1&agent=barnaby");
        var geist = await client.GetFromJsonAsync<ConversationListDto>(
            "/api/assist/conversations?profileId=1&agent=geist");

        // Switching agents switches the entire conversation list.
        Assert.Single(barnaby!.Conversations);
        Assert.Equal("Bins tonight", barnaby.Conversations[0].Title);
        Assert.Single(geist!.Conversations);
        Assert.Equal("Explain this stack trace", geist.Conversations[0].Title);
    }

    [Fact]
    public async Task Unread_with_another_agent_rides_the_roster_so_it_cannot_hide_behind_the_switch()
    {
        using var app = new HubAppFactory { Agents = TwoAgents };
        var client = app.CreateSeededClient();

        await client.PutAsJsonAsync("/api/assist/assignments/1", new SetAgentAssignmentsRequest(["geist"]));
        var chat = await client.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(null, "geist", "Explain this stack trace", null, null, null));
        var started = (await chat.Content.ReadFromJsonAsync<AssistChatResponse>())!;
        await client.PatchAsJsonAsync($"/api/assist/conversations/{started.ConversationId}",
            new UpdateConversationRequest(null, null, false));

        // Read Barnaby's list — Geist's unread count still arrives with it.
        var list = await client.GetFromJsonAsync<ConversationListDto>(
            "/api/assist/conversations?profileId=1&agent=barnaby");

        Assert.Empty(list!.Conversations);
        Assert.Equal(1, list.Agents.Single(a => a.Key == "geist").Unread);
    }

    [Fact]
    public async Task Search_does_not_cross_agents()
    {
        using var app = new HubAppFactory { Agents = TwoAgents };
        var client = app.CreateSeededClient();

        await client.PutAsJsonAsync("/api/assist/assignments/1", new SetAgentAssignmentsRequest(["geist"]));
        await client.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(null, "geist", "Something about pianos", null, null, null));

        var inBarnaby = await client.GetFromJsonAsync<SearchResultsDto>(
            "/api/assist/search?profileId=1&agent=barnaby&q=pianos");
        var inGeist = await client.GetFromJsonAsync<SearchResultsDto>(
            "/api/assist/search?profileId=1&agent=geist&q=pianos");

        Assert.Empty(inBarnaby!.Hits);
        Assert.NotEmpty(inGeist!.Hits);
    }

    [Fact]
    public async Task The_assignment_editor_lists_every_configured_agent_granted_or_not()
    {
        using var app = new HubAppFactory { Agents = TwoAgents };
        var client = app.CreateSeededClient();

        var body = await client.GetFromJsonAsync<AgentAssignmentsDto>("/api/assist/assignments/1");

        Assert.Equal(2, body!.Agents.Count);
        var barnaby = body.Agents.Single(a => a.Key == "barnaby");
        var geist = body.Agents.Single(a => a.Key == "geist");
        Assert.True(barnaby.IsHouseholdAgent);
        Assert.True(barnaby.Assigned);   // the floor
        // Nobody has chosen, so the household agent is what Assist opens on.
        Assert.True(barnaby.IsMemberDefault);
        Assert.False(geist.IsHouseholdAgent);
        Assert.False(geist.Assigned);
        Assert.False(geist.IsMemberDefault);
    }

    [Fact]
    public async Task Assignments_for_a_member_who_does_not_exist_are_a_404()
    {
        using var app = new HubAppFactory { Agents = TwoAgents };
        var client = app.CreateSeededClient();

        var get = await client.GetAsync("/api/assist/assignments/4242");
        var put = await client.PutAsJsonAsync("/api/assist/assignments/4242",
            new SetAgentAssignmentsRequest(["geist"]));

        Assert.Equal(HttpStatusCode.NotFound, get.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, put.StatusCode);
    }

    [Fact]
    public async Task An_agent_key_that_is_not_on_the_roster_is_ignored_rather_than_stored()
    {
        using var app = new HubAppFactory { Agents = TwoAgents };
        var client = app.CreateSeededClient();

        await client.PutAsJsonAsync("/api/assist/assignments/1",
            new SetAgentAssignmentsRequest(["geist", "not-an-agent"]));

        var body = await client.GetFromJsonAsync<AgentAssignmentsDto>("/api/assist/assignments/1");

        Assert.Equal(2, body!.Agents.Count);
        Assert.True(body.Agents.Single(a => a.Key == "geist").Assigned);
    }

    [Fact]
    public async Task Assigning_twice_is_assigning_once()
    {
        using var app = new HubAppFactory { Agents = TwoAgents };
        var client = app.CreateSeededClient();

        await client.PutAsJsonAsync("/api/assist/assignments/1", new SetAgentAssignmentsRequest(["geist"]));
        var second = await client.PutAsJsonAsync("/api/assist/assignments/1",
            new SetAgentAssignmentsRequest(["geist", "geist"]));
        second.EnsureSuccessStatusCode();

        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HomeHub.Api.Data.HomeHubDbContext>();
        Assert.Single(db.ProfileAgents.Where(a => a.ProfileId == 1 && a.AgentKey == "geist"));
    }

    [Fact]
    public async Task The_guest_panel_gets_the_household_agent_and_nothing_else()
    {
        using var app = new HubAppFactory { Agents = TwoAgents };
        var client = app.CreateSeededClient();

        // No profileId: there is nobody for a second agent to have been granted to.
        var agents = await client.GetFromJsonAsync<List<AgentDto>>("/api/assist/agents");

        Assert.NotNull(agents);
        Assert.Single(agents);
        Assert.Equal("barnaby", agents[0].Key);
    }

    // ---- Which of a member's agents Assist opens on ----

    [Fact]
    public async Task A_member_can_be_given_a_default_other_than_the_household_agent()
    {
        using var app = new HubAppFactory { Agents = TwoAgents };
        var client = app.CreateSeededClient();

        await client.PutAsJsonAsync("/api/assist/assignments/1", new SetAgentAssignmentsRequest(["geist"]));
        var put = await client.PutAsJsonAsync("/api/assist/assignments/1/default",
            new SetDefaultAgentRequest("geist"));
        put.EnsureSuccessStatusCode();

        // The switcher's own list is what the panel lands on, so the flag has to move with the choice.
        var agents = await client.GetFromJsonAsync<List<AgentDto>>("/api/assist/agents");
        Assert.NotNull(agents);
        Assert.True(agents.Single(a => a.Key == "geist").IsDefault);
        Assert.False(agents.Single(a => a.Key == "barnaby").IsDefault);
    }

    [Fact]
    public async Task A_default_decides_which_agents_list_an_unqualified_read_returns()
    {
        using var app = new HubAppFactory { Agents = TwoAgents };
        var client = app.CreateSeededClient();

        await client.PutAsJsonAsync("/api/assist/assignments/1", new SetAgentAssignmentsRequest(["geist"]));
        await client.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(null, "geist", "Pianos", null, null, null));
        await client.PutAsJsonAsync("/api/assist/assignments/1/default", new SetDefaultAgentRequest("geist"));

        // No `agent=` in the query — the resolution this exercises is the one a cold panel makes.
        var list = await client.GetFromJsonAsync<ConversationListDto>("/api/assist/conversations?profileId=1");

        Assert.Single(list!.Conversations);
        Assert.Equal("geist", list.Conversations[0].AgentKey);
    }

    [Fact]
    public async Task A_default_naming_an_agent_the_member_does_not_have_is_refused()
    {
        using var app = new HubAppFactory { Agents = TwoAgents };
        var client = app.CreateSeededClient();

        // Choosing a default is a preference among agents somebody already has. It must not grant one.
        var put = await client.PutAsJsonAsync("/api/assist/assignments/1/default",
            new SetDefaultAgentRequest("geist"));

        Assert.Equal(HttpStatusCode.BadRequest, put.StatusCode);

        var agents = await client.GetFromJsonAsync<List<AgentDto>>("/api/assist/agents");
        Assert.Single(agents!);
    }

    [Fact]
    public async Task Revoking_the_agent_somebody_defaulted_to_clears_the_choice()
    {
        using var app = new HubAppFactory { Agents = TwoAgents };
        var client = app.CreateSeededClient();

        await client.PutAsJsonAsync("/api/assist/assignments/1", new SetAgentAssignmentsRequest(["geist"]));
        await client.PutAsJsonAsync("/api/assist/assignments/1/default", new SetDefaultAgentRequest("geist"));
        await client.PutAsJsonAsync("/api/assist/assignments/1", new SetAgentAssignmentsRequest([]));

        // Left in place it would be inert — resolution drops it — but it would silently come back the
        // day the agent was re-assigned, which nobody asked for.
        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HomeHub.Api.Data.HomeHubDbContext>();
        Assert.Null(db.Profiles.Single(p => p.Id == 1).DefaultAgentKey);
    }

    [Fact]
    public async Task Clearing_the_default_returns_the_member_to_the_household_agent()
    {
        using var app = new HubAppFactory { Agents = TwoAgents };
        var client = app.CreateSeededClient();

        await client.PutAsJsonAsync("/api/assist/assignments/1", new SetAgentAssignmentsRequest(["geist"]));
        await client.PutAsJsonAsync("/api/assist/assignments/1/default", new SetDefaultAgentRequest("geist"));
        await client.PutAsJsonAsync("/api/assist/assignments/1/default", new SetDefaultAgentRequest(null));

        var body = await client.GetFromJsonAsync<AgentAssignmentsDto>("/api/assist/assignments/1");

        Assert.True(body!.Agents.Single(a => a.Key == "barnaby").IsMemberDefault);
        Assert.False(body.Agents.Single(a => a.Key == "geist").IsMemberDefault);
    }

    [Fact]
    public async Task A_default_for_a_member_who_does_not_exist_is_a_404()
    {
        using var app = new HubAppFactory { Agents = TwoAgents };
        var client = app.CreateSeededClient();

        var put = await client.PutAsJsonAsync("/api/assist/assignments/4242/default",
            new SetDefaultAgentRequest("barnaby"));

        Assert.Equal(HttpStatusCode.NotFound, put.StatusCode);
    }
}
