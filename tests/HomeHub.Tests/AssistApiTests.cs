namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Assist;
using HomeHub.Api.Data;
using HomeHub.Api.Settings;
using Microsoft.Extensions.DependencyInjection;

/// <summary>
/// Assist — the chat system. With no AI keys configured (the test environment) the router degrades to
/// the built-in simulated assistant, so every turn here still produces a real reply and a real row:
/// what these exercise is the *ledger*, which is the half HomeHub owns.
/// </summary>
public class AssistApiTests
{
    // No profileId: the member comes from the session the test client holds (AUDIT A1.2).
    private static AssistChatRequest Turn(string prompt, int? conversationId = null) =>
        new(conversationId, null, prompt, null, null, null);

    [Fact]
    public async Task A_turn_without_a_conversation_id_starts_one()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/assist/chat", Turn("How many teaspoons in a tablespoon?"));
        res.EnsureSuccessStatusCode();
        var body = await res.Content.ReadFromJsonAsync<AssistChatResponse>();

        Assert.NotNull(body);
        Assert.True(body!.ConversationId > 0);
        // The opening turn titles the chat — there is no NEW CHAT button to name it with.
        Assert.Equal("How many teaspoons in a tablespoon?", body.Title);
        Assert.Equal("assistant", body.Message.Role);
        Assert.NotEmpty(body.Message.Text);
    }

    [Fact]
    public async Task Both_turns_are_persisted_and_read_back_in_order()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var started = await Post(client, Turn("How many teaspoons in a tablespoon?"));
        var detail = await client.GetFromJsonAsync<ConversationDetailDto>(
            $"/api/assist/conversations/{started.ConversationId}");

        Assert.NotNull(detail);
        Assert.Equal(2, detail!.Messages.Count);
        Assert.Equal("user", detail.Messages[0].Role);
        Assert.Equal("assistant", detail.Messages[1].Role);
        // The origin tag survives the round-trip — it is the privacy affordance, not decoration.
        Assert.Equal("Local", detail.Messages[1].Origin);
    }

    [Fact]
    public async Task A_second_turn_appends_to_the_same_conversation()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var first = await Post(client, Turn("How many teaspoons in a tablespoon?"));
        var second = await Post(client, Turn("And in a cup?", first.ConversationId));

        Assert.Equal(first.ConversationId, second.ConversationId);

        var detail = await client.GetFromJsonAsync<ConversationDetailDto>(
            $"/api/assist/conversations/{first.ConversationId}");
        Assert.Equal(4, detail!.Messages.Count);
    }

    /// <summary>
    /// The list is scoped to whoever is signed in, and a query parameter cannot change that.
    /// </summary>
    /// <remarks>
    /// This test used to pass <c>?profileId=</c> to choose whose chats to read, which is precisely
    /// what AUDIT A1 called the worst instance of the pattern — it was asserting the scoping worked
    /// while demonstrating that anyone could pick any scope. Now each member signs in and gets their
    /// own, and the last two assertions are the point: naming somebody else in the URL does nothing,
    /// because nothing reads it.
    /// </remarks>
    [Fact]
    public async Task The_list_is_scoped_to_the_signed_in_member()
    {
        using var app = new HubAppFactory();
        var astridClient = app.CreateSeededClient(profileId: 1);
        var ragnarClient = app.CreateSeededClient(profileId: 2);

        await Post(astridClient, Turn("Astrid's question"));
        await Post(ragnarClient, Turn("Ragnar's question"));

        var astrid = await astridClient.GetFromJsonAsync<ConversationListDto>("/api/assist/conversations");
        var ragnar = await ragnarClient.GetFromJsonAsync<ConversationListDto>("/api/assist/conversations");

        Assert.Single(astrid!.Conversations);
        Assert.Single(ragnar!.Conversations);
        Assert.Equal("Astrid's question", astrid.Conversations[0].Title);
        Assert.Equal("Ragnar's question", ragnar.Conversations[0].Title);

        // The old attack, verbatim: ask for someone else's list by naming them. It is ignored.
        var spoofed = await ragnarClient.GetFromJsonAsync<ConversationListDto>(
            "/api/assist/conversations?profileId=1");
        Assert.Single(spoofed!.Conversations);
        Assert.Equal("Ragnar's question", spoofed.Conversations[0].Title);
    }

    [Fact]
    public async Task Opening_a_conversation_marks_it_read()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var started = await Post(client, Turn("Bins tonight?"));

        // Force it unread the way a reply arriving from a phone would.
        var patched = await client.PatchAsJsonAsync(
            $"/api/assist/conversations/{started.ConversationId}", new UpdateConversationRequest(null, null, false));
        patched.EnsureSuccessStatusCode();

        var before = await client.GetFromJsonAsync<ConversationListDto>("/api/assist/conversations?profileId=1");
        Assert.True(before!.Conversations[0].Unread);

        await client.GetFromJsonAsync<ConversationDetailDto>($"/api/assist/conversations/{started.ConversationId}");

        var after = await client.GetFromJsonAsync<ConversationListDto>("/api/assist/conversations?profileId=1");
        Assert.False(after!.Conversations[0].Unread);
    }

    [Fact]
    public async Task Pinned_chats_sort_above_the_rest()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var older = await Post(client, Turn("First"));
        await Post(client, Turn("Second"));

        await client.PatchAsJsonAsync(
            $"/api/assist/conversations/{older.ConversationId}", new UpdateConversationRequest(true, null, null));

        var list = await client.GetFromJsonAsync<ConversationListDto>("/api/assist/conversations?profileId=1");

        // "First" is the older chat and would sort second on recency alone.
        Assert.Equal("First", list!.Conversations[0].Title);
        Assert.True(list.Conversations[0].Pinned);
    }

    [Fact]
    public async Task Archiving_moves_a_chat_out_of_the_list_and_into_the_count()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var started = await Post(client, Turn("Dishwasher error E24"));
        await client.PatchAsJsonAsync(
            $"/api/assist/conversations/{started.ConversationId}", new UpdateConversationRequest(null, true, null));

        var list = await client.GetFromJsonAsync<ConversationListDto>("/api/assist/conversations?profileId=1");
        Assert.Empty(list!.Conversations);
        Assert.Equal(1, list.ArchivedCount);

        var archived = await client.GetFromJsonAsync<List<ConversationDto>>(
            "/api/assist/conversations/archived?profileId=1");
        Assert.NotNull(archived);
        Assert.Single(archived);
        Assert.NotNull(archived[0].ArchivedAtUtc);
    }

    [Fact]
    public async Task A_reply_into_an_archived_chat_brings_it_back()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var started = await Post(client, Turn("Boiler service quotes"));
        await client.PatchAsJsonAsync(
            $"/api/assist/conversations/{started.ConversationId}", new UpdateConversationRequest(null, true, null));

        await Post(client, Turn("Any update?", started.ConversationId));

        var list = await client.GetFromJsonAsync<ConversationListDto>("/api/assist/conversations?profileId=1");
        Assert.Single(list!.Conversations);
        Assert.Equal(0, list.ArchivedCount);
    }

    [Fact]
    public async Task Deleting_removes_the_chat_and_its_transcript()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var a = await Post(client, Turn("One"));
        var b = await Post(client, Turn("Two"));

        var res = await client.PostAsJsonAsync("/api/assist/conversations/delete",
            new DeleteConversationsRequest([a.ConversationId, b.ConversationId]));
        res.EnsureSuccessStatusCode();
        var body = await res.Content.ReadFromJsonAsync<DeleteConversationsResponse>();

        Assert.Equal(2, body!.Deleted);
        // No agent is configured in tests, so no Hermes session was ever opened to remove.
        Assert.Equal(0, body.AgentTranscriptsRemoved);

        var list = await client.GetFromJsonAsync<ConversationListDto>("/api/assist/conversations?profileId=1");
        Assert.Empty(list!.Conversations);

        var gone = await client.GetAsync($"/api/assist/conversations/{a.ConversationId}");
        Assert.Equal(HttpStatusCode.NotFound, gone.StatusCode);
    }

    [Fact]
    public async Task Search_matches_transcripts_and_reports_per_match()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await Post(client, Turn("Move the piano tuner to Friday"));
        await Post(client, Turn("Can we swap piano to Tuesdays?"));
        await Post(client, Turn("Bins tonight"));

        var results = await client.GetFromJsonAsync<SearchResultsDto>(
            "/api/assist/search?profileId=1&q=piano");

        Assert.NotNull(results);
        Assert.Equal(2, results!.Conversations);
        Assert.All(results.Hits, h => Assert.Contains("piano", h.Snippet, StringComparison.OrdinalIgnoreCase));
        // The offset points at the term inside the snippet, so the highlight lands on the right one.
        Assert.All(results.Hits, h =>
            Assert.Equal("piano", h.Snippet.Substring(h.MatchStart, h.MatchLength), ignoreCase: true));
    }

    [Fact]
    public async Task Search_covers_the_archive()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var started = await Post(client, Turn("Holiday cottage shortlist"));
        await client.PatchAsJsonAsync(
            $"/api/assist/conversations/{started.ConversationId}", new UpdateConversationRequest(null, true, null));

        var results = await client.GetFromJsonAsync<SearchResultsDto>(
            "/api/assist/search?profileId=1&q=cottage");

        Assert.NotEmpty(results!.Hits);
        Assert.True(results.Hits[0].Archived);
    }

    [Fact]
    public async Task Search_ignores_a_term_too_short_to_narrow_anything()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        await Post(client, Turn("Bins tonight"));

        var results = await client.GetFromJsonAsync<SearchResultsDto>("/api/assist/search?profileId=1&q=b");

        Assert.Empty(results!.Hits);
    }

    [Fact]
    public async Task A_wildcard_in_the_term_is_matched_literally()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        await Post(client, Turn("Bins tonight"));

        // Unescaped, `%%` would match every message the household has ever sent.
        var results = await client.GetFromJsonAsync<SearchResultsDto>("/api/assist/search?profileId=1&q=%25%25");

        Assert.Empty(results!.Hits);
    }

    [Fact]
    public async Task Storing_switched_off_answers_but_writes_nothing()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var policy = await client.PutAsJsonAsync("/api/settings/conversation-policy",
            new SetConversationPolicyRequest(false, 30));
        policy.EnsureSuccessStatusCode();

        var res = await client.PostAsJsonAsync("/api/assist/chat", Turn("How many teaspoons in a tablespoon?"));
        res.EnsureSuccessStatusCode();
        var body = await res.Content.ReadFromJsonAsync<AssistChatResponse>();

        // The reply still arrives — storing off means "keep nothing", not "answer nothing".
        Assert.NotEmpty(body!.Message.Text);
        Assert.Equal(0, body.ConversationId);

        var list = await client.GetFromJsonAsync<ConversationListDto>("/api/assist/conversations?profileId=1");
        Assert.Empty(list!.Conversations);
        Assert.False(list.StoreConversations);
    }

    [Fact]
    public async Task A_turn_needs_a_prompt_or_an_image()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/assist/chat", Turn("   "));

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [Fact]
    public async Task A_turn_into_a_conversation_that_no_longer_exists_is_a_404()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/assist/chat", Turn("Still there?", 4242));

        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    [Fact]
    public async Task The_roster_always_offers_a_default_agent()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var agents = await client.GetFromJsonAsync<List<AgentDto>>("/api/assist/agents?profileId=1");

        // The test roster is *configured* — an address and a key — but points nowhere reachable.
        // `Configured` says exactly that and no more: reachability is what a turn discovers.
        Assert.NotNull(agents);
        Assert.Single(agents);
        Assert.Equal("barnaby", agents[0].Key);
        Assert.True(agents[0].IsDefault);
        Assert.True(agents[0].Configured);
    }

    [Fact]
    public async Task Expired_conversations_are_swept_on_read()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var started = await Post(client, Turn("Old news"));

        // Age it past the window rather than waiting 31 days for the assertion.
        using (var scope = app.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
            var row = db.Conversations.First(c => c.Id == started.ConversationId);
            row.LastAtUtc = DateTime.UtcNow.AddDays(-45);
            db.SaveChanges();
        }

        var list = await client.GetFromJsonAsync<ConversationListDto>("/api/assist/conversations?profileId=1");

        Assert.Empty(list!.Conversations);
    }

    [Fact]
    public async Task A_retention_of_never_sweeps_nothing()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var started = await Post(client, Turn("Old news"));

        var policy = await client.PutAsJsonAsync("/api/settings/conversation-policy",
            new SetConversationPolicyRequest(true, 0));
        policy.EnsureSuccessStatusCode();

        using (var scope = app.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
            var row = db.Conversations.First(c => c.Id == started.ConversationId);
            row.LastAtUtc = DateTime.UtcNow.AddYears(-3);
            db.SaveChanges();
        }

        var list = await client.GetFromJsonAsync<ConversationListDto>("/api/assist/conversations?profileId=1");

        // Never is a real answer, not a very long window: nothing ages out, at any age.
        Assert.Single(list!.Conversations);
        Assert.Equal(0, list.RetentionDays);
    }

    [Fact]
    public async Task Never_is_not_the_same_switch_as_storing_nothing()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await client.PutAsJsonAsync("/api/settings/conversation-policy",
            new SetConversationPolicyRequest(true, 0));

        var res = await client.PostAsJsonAsync("/api/assist/chat", Turn("Keep this"));
        var body = await res.Content.ReadFromJsonAsync<AssistChatResponse>();

        // Storing stays on. "Keep everything forever" and "keep nothing" are opposite answers, and one
        // must not be reachable only by accidentally choosing the other.
        Assert.True(body!.ConversationId > 0);
    }

    private static async Task<AssistChatResponse> Post(HttpClient client, AssistChatRequest req)
    {
        var res = await client.PostAsJsonAsync("/api/assist/chat", req);
        res.EnsureSuccessStatusCode();
        return (await res.Content.ReadFromJsonAsync<AssistChatResponse>())!;
    }
}

/// <summary>
/// The search snippet — the window around a match that the design draws with a brass underline
/// (`…confirmed the piano tuner for Friday 1 PM…`).
/// </summary>
public class AssistSnippetTests
{
    [Fact]
    public void Short_text_is_returned_whole_with_no_ellipses()
    {
        var (snippet, start) = HomeHub.Api.Controllers.AssistController.Snippet("Bins tonight", "bins");

        Assert.Equal("Bins tonight", snippet);
        Assert.Equal(0, start);
    }

    [Fact]
    public void A_match_in_the_middle_is_windowed_on_both_sides()
    {
        var text = new string('a', 200) + " piano " + new string('b', 200);

        var (snippet, start) = HomeHub.Api.Controllers.AssistController.Snippet(text, "piano");

        Assert.StartsWith("…", snippet);
        Assert.EndsWith("…", snippet);
        Assert.Equal("piano", snippet.Substring(start, 5));
    }

    [Fact]
    public void Newlines_are_flattened_so_the_snippet_stays_one_line()
    {
        var (snippet, _) = HomeHub.Api.Controllers.AssistController.Snippet("first line\npiano second", "piano");

        Assert.DoesNotContain('\n', snippet);
    }

    [Fact]
    public void The_offset_lands_on_the_matched_occurrence_not_the_first_in_the_window()
    {
        // A term appearing twice must not be highlighted on whichever copy a naive re-search finds.
        var (snippet, start) = HomeHub.Api.Controllers.AssistController.Snippet("piano and piano again", "piano");

        Assert.Equal("piano", snippet.Substring(start, 5));
        Assert.Equal(0, start);
    }
}
