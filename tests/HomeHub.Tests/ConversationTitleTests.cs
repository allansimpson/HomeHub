namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Assist;
using Microsoft.Extensions.DependencyInjection;

/// <summary>
/// What a conversation is called: the provisional title, the one the agent suggests, and the one the
/// household types over both.
/// </summary>
public class ConversationTitleTests
{
    private static readonly (string Key, string Name, bool Default)[] OneAgent = [("barnaby", "Barnaby", true)];

    [Fact]
    public async Task The_opening_turn_names_the_chat_before_anything_has_thought_about_it()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(null, null, "Bins tonight?", null, null, null));
        var body = await res.Content.ReadFromJsonAsync<AssistChatResponse>();

        // Instant, true, and needs nothing to be reachable. The agent's suggestion arrives later or
        // not at all, and this is what stands in the meantime.
        Assert.Equal("Bins tonight?", body!.Title);
    }

    [Fact]
    public async Task The_agent_renames_the_chat_once_it_has_answered()
    {
        using var stub = new StubHermes { ChatReply = "Weekly bin collection" };
        using var app = new HubAppFactory { Agents = OneAgent, HermesBaseUrl = stub.BaseUrl };
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(null, null, "Which bin goes out tonight, and what time do they come?",
                null, null, null));
        var body = (await res.Content.ReadFromJsonAsync<AssistChatResponse>())!;

        // Driven directly rather than waiting on the background pass the controller schedules — the
        // scheduling is fire-and-forget by design, and a test that slept on it would be a flaky test
        // about `Task.Run` rather than a test about titles. (`NameConversations` is off in the factory,
        // so there is no background pass here to race with either.)
        var titler = app.Services.GetRequiredService<ConversationTitler>();
        var written = await titler.TitleAsync(
            body.ConversationId, "barnaby", body.Title, "Which bin goes out tonight?", "The green one.",
            CancellationToken.None);

        Assert.Equal("Weekly bin collection", written);

        var detail = await client.GetFromJsonAsync<ConversationDetailDto>(
            $"/api/assist/conversations/{body.ConversationId}");
        Assert.Equal("Weekly bin collection", detail!.Conversation.Title);
    }

    [Fact]
    public async Task Naming_can_be_switched_off_for_a_household_that_would_rather_not_pay_for_it()
    {
        using var stub = new StubHermes { ChatReply = "Weekly bin collection" };
        using var app = new HubAppFactory
        {
            Agents = OneAgent, HermesBaseUrl = stub.BaseUrl, NameConversations = false,
        };
        var client = app.CreateSeededClient();

        await client.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(null, null, "Bins tonight?", null, null, null));

        // One call for the turn, and nothing extra for a title nobody asked to be paid for.
        Assert.Equal(1, stub.ChatCount);
    }

    [Fact]
    public async Task Opening_a_chat_schedules_its_own_naming()
    {
        using var stub = new StubHermes { ChatReply = "Weekly bin collection" };
        using var app = new HubAppFactory
        {
            Agents = OneAgent, HermesBaseUrl = stub.BaseUrl, NameConversations = true,
        };
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(null, null, "Which bin goes out tonight?", null, null, null));
        var body = (await res.Content.ReadFromJsonAsync<AssistChatResponse>())!;

        // The one place the *wiring* is exercised: everything else drives the titler directly. It
        // happens after the response by design, so this waits — bounded, and on the outcome rather
        // than on a duration, so a slow machine is slow rather than red.
        var title = await Eventually(client, body.ConversationId, "Weekly bin collection");

        Assert.Equal("Weekly bin collection", title);
    }

    /// <summary>Re-read a chat's title until it changes, or give up. Two seconds is a long time here.</summary>
    private static async Task<string?> Eventually(HttpClient client, int conversationId, string wanted)
    {
        string? title = null;
        for (var attempt = 0; attempt < 40; attempt++)
        {
            var detail = await client.GetFromJsonAsync<ConversationDetailDto>(
                $"/api/assist/conversations/{conversationId}");
            title = detail?.Conversation.Title;
            if (title == wanted) return title;
            await Task.Delay(50);
        }
        return title;
    }

    [Fact]
    public async Task Naming_a_chat_never_touches_its_session()
    {
        using var stub = new StubHermes { ChatReply = "Bin day" };
        using var app = new HubAppFactory { Agents = OneAgent, HermesBaseUrl = stub.BaseUrl };

        var titler = app.Services.GetRequiredService<ConversationTitler>();
        await titler.SuggestAsync("barnaby", "Which bin goes out tonight?", "The green one.", CancellationToken.None);

        // A sessionless one-shot. With a session id the agent would remember being asked to write a
        // title, and the next reply would arrive in a context with one more exchange in it than the
        // transcript shows.
        Assert.Empty(stub.SeenSessionIds);
    }

    [Fact]
    public async Task A_title_the_household_typed_is_not_overwritten_by_one_in_flight()
    {
        using var stub = new StubHermes { ChatReply = "Weekly bin collection" };
        using var app = new HubAppFactory { Agents = OneAgent, HermesBaseUrl = stub.BaseUrl };
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(null, null, "Bins tonight?", null, null, null));
        var body = (await res.Content.ReadFromJsonAsync<AssistChatResponse>())!;

        var renamed = await client.PatchAsJsonAsync($"/api/assist/conversations/{body.ConversationId}",
            new UpdateConversationRequest(null, null, null, "Rubbish"));
        renamed.EnsureSuccessStatusCode();

        // The naming pass was already running when the rename landed. It sees a title that is no
        // longer the provisional one and leaves it alone — a person's words beat a model's, whichever
        // arrived second.
        var titler = app.Services.GetRequiredService<ConversationTitler>();
        var written = await titler.TitleAsync(
            body.ConversationId, "barnaby", body.Title, "Bins tonight?", "The green one.", CancellationToken.None);

        Assert.Null(written);

        var detail = await client.GetFromJsonAsync<ConversationDetailDto>(
            $"/api/assist/conversations/{body.ConversationId}");
        Assert.Equal("Rubbish", detail!.Conversation.Title);
    }

    [Fact]
    public async Task An_unreachable_agent_leaves_the_provisional_title_alone()
    {
        // The default factory roster points at a port nothing is listening on.
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(null, null, "Boiler fault E24", null, null, null));
        var body = (await res.Content.ReadFromJsonAsync<AssistChatResponse>())!;

        var titler = app.Services.GetRequiredService<ConversationTitler>();
        var written = await titler.TitleAsync(
            body.ConversationId, "barnaby", body.Title, "Boiler fault E24", "…", CancellationToken.None);

        Assert.Null(written);

        var detail = await client.GetFromJsonAsync<ConversationDetailDto>(
            $"/api/assist/conversations/{body.ConversationId}");
        Assert.Equal("Boiler fault E24", detail!.Conversation.Title);
    }

    [Fact]
    public async Task A_model_that_answered_with_a_paragraph_is_ignored_rather_than_cut_down()
    {
        using var stub = new StubHermes
        {
            ChatReply = "Certainly! Here is a title for your conversation, based on the exchange you "
                      + "provided, which appears to concern household waste collection schedules.",
        };
        using var app = new HubAppFactory { Agents = OneAgent, HermesBaseUrl = stub.BaseUrl };

        var titler = app.Services.GetRequiredService<ConversationTitler>();
        var suggestion = await titler.SuggestAsync("barnaby", "Bins?", "The green one.", CancellationToken.None);

        // Half a sentence reads worse than the opening turn it was meant to improve on.
        Assert.Null(suggestion);
    }

    [Fact]
    public async Task Renaming_a_chat_to_nothing_is_refused()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(null, null, "Bins tonight?", null, null, null));
        var body = (await res.Content.ReadFromJsonAsync<AssistChatResponse>())!;

        var renamed = await client.PatchAsJsonAsync($"/api/assist/conversations/{body.ConversationId}",
            new UpdateConversationRequest(null, null, null, "   "));

        // Accepting-and-ignoring would look like the rename failed to save.
        Assert.Equal(HttpStatusCode.BadRequest, renamed.StatusCode);
    }

    [Fact]
    public async Task A_swipe_does_not_rename_anything()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(null, null, "Bins tonight?", null, null, null));
        var body = (await res.Content.ReadFromJsonAsync<AssistChatResponse>())!;

        await client.PatchAsJsonAsync($"/api/assist/conversations/{body.ConversationId}",
            new UpdateConversationRequest(true, null, null));

        var detail = await client.GetFromJsonAsync<ConversationDetailDto>(
            $"/api/assist/conversations/{body.ConversationId}");
        Assert.Equal("Bins tonight?", detail!.Conversation.Title);
    }
}

/// <summary>
/// Making a model's answer usable as a title — the sanitiser, without a gateway in the way.
/// </summary>
public class AssistTitleCleanTests
{
    [Theory]
    [InlineData("Bin day", "Bin day")]
    [InlineData("\"Bin day\"", "Bin day")]
    [InlineData("“Bin day”", "Bin day")]
    [InlineData("Title: Bin day", "Bin day")]
    [InlineData("- Bin day", "Bin day")]
    [InlineData("Bin day.", "Bin day")]
    [InlineData("  Bin   day  ", "Bin day")]
    public void The_usual_ways_of_ignoring_reply_with_the_title_only(string raw, string expected)
    {
        Assert.Equal(expected, AssistTitle.Clean(raw));
    }

    [Fact]
    public void A_question_keeps_its_question_mark()
    {
        // Part of the fragment, unlike a trailing full stop, which is noise on a heading.
        Assert.Equal("Which bin tonight?", AssistTitle.Clean("Which bin tonight?"));
    }

    [Fact]
    public void A_colon_inside_the_title_survives()
    {
        // Only a short leading label is stripped — "Boiler" is the subject, not a preamble.
        Assert.Equal("Boiler: annual service", AssistTitle.Clean("Boiler: annual service"));
    }

    [Fact]
    public void The_first_line_is_the_answer_when_a_model_thought_out_loud()
    {
        Assert.Equal("Bin day", AssistTitle.Clean("Bin day\n\nLet me know if you'd like another."));
    }

    [Fact]
    public void Nothing_usable_is_null_rather_than_a_best_effort()
    {
        Assert.Null(AssistTitle.Clean(""));
        Assert.Null(AssistTitle.Clean("   "));
        Assert.Null(AssistTitle.Clean(new string('x', AssistTitle.MaxGeneratedLength + 1)));
    }
}
