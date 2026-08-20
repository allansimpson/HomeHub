namespace HomeHub.Tests;

using System.Net.Http.Json;
using HomeHub.Api.Meals;
using HomeHub.Api.Notifications;

/// <summary>
/// The Meals notification rate rules (MEALS_BEHAVIOURS §4), which the spec says matter more than
/// the visuals.
/// </summary>
public class MealNotificationTests
{
    /// <summary>
    /// Sign a profile in at the panel and return it plus somebody else.
    /// </summary>
    /// <remarks>
    /// The active profile is set explicitly rather than read: a seeded panel has nobody signed in,
    /// and "the change was made here" is only meaningful when somebody is. With no active profile
    /// every attributed change is genuinely news, which is the right behaviour and the wrong setup
    /// for a test about staying quiet.
    /// </remarks>
    private static async Task<(int Me, int Them)> SignInAsync(HttpClient client)
    {
        var profiles = (await client.GetFromJsonAsync<List<ProfileRow>>("/api/profiles"))!;
        var me = profiles[0].Id;
        await client.PutAsJsonAsync("/api/settings/active-profile", new { profileId = me });
        return (me, profiles.First(p => p.Id != me).Id);
    }

    /// <summary>
    /// A second client, signed in as the other member.
    /// </summary>
    /// <remarks>
    /// Before AUDIT A1, "somebody else changed this" was expressed by putting their id in the
    /// request body. That is exactly what A1.2 removed — attribution now comes from the session —
    /// so a test about somebody else's change has to actually be somebody else.
    /// </remarks>
    private static HttpClient TheirClient(HubAppFactory app, int them) => app.CreateSeededClient(them);

    private sealed record ProfileRow(int Id, string Name);
    private sealed record FeedRow(List<FeedItem> Items);
    private sealed record FeedItem(string Source, string Headline, string? Route);

    private static async Task<List<FeedItem>> MealNoticesAsync(HttpClient client) =>
        ((await client.GetFromJsonAsync<FeedRow>("/api/notifications"))!)
            .Items.Where(i => i.Source == NotificationSources.Meals).ToList();

    private static Task<HttpResponseMessage> AddRecipeAsync(HttpClient client, string title) =>
        client.PostAsJsonAsync("/api/recipes", new RecipeInput(title));

    /// <summary>
    /// The governing rule: nothing in this section notifies anyone about their own action. On a
    /// single shared feed that means a change made by whoever is at the panel stays silent.
    /// </summary>
    [Fact]
    public async Task My_own_change_never_notifies_me()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var (me, _) = await SignInAsync(client);

        await AddRecipeAsync(client, "Mine");

        Assert.Empty(await MealNoticesAsync(client));
    }

    [Fact]
    public async Task Someone_elses_new_recipe_notifies_once()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var (_, them) = await SignInAsync(client);

        await AddRecipeAsync(TheirClient(app, them), "Laksa");

        var notice = Assert.Single(await MealNoticesAsync(client));
        Assert.Contains("Laksa", notice.Headline);
        Assert.StartsWith("/meals/recipes/", notice.Route);
    }

    /// <summary>
    /// One per recipe per day, collapsed — a recipe tuned across an evening is one piece of news,
    /// not six.
    /// </summary>
    [Fact]
    public async Task Repeated_edits_to_one_recipe_collapse_to_a_single_notice()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var (_, them) = await SignInAsync(client);
        var theirs = TheirClient(app, them);
        var recipe = (await (await AddRecipeAsync(client, "Ragu")).Content.ReadFromJsonAsync<RecipeDto>())!;

        for (var i = 0; i < 4; i++)
        {
            await theirs.PutAsJsonAsync($"/api/recipes/{recipe.Id}",
                new RecipeInput("Ragu", Servings: 4 + i));
        }

        Assert.Single(await MealNoticesAsync(client));
    }

    /// <summary>
    /// A write with no <c>ModifiedByProfileId</c> in the body still says nothing — because the body
    /// was never what decided.
    /// </summary>
    /// <remarks>
    /// This began as "an unattributed write has nobody to name". Since AUDIT A1 every HTTP write has
    /// an actor, because every HTTP request has a session — genuinely unattributed writes are now
    /// only the background ones (the importer, a hosted service), and <c>MealNotifier</c>'s null
    /// guard still covers those. What this asserts today is the more useful half: sending a null
    /// author does not make a change anonymous, and it is still the caller's own change, so it
    /// stays silent.
    /// </remarks>
    [Fact]
    public async Task A_write_with_no_author_in_the_body_is_still_silent()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        // At the panel, so this client's own fixture writes stay silent and the only notice
        // that can appear is the one under test (AUDIT A1.2 made every HTTP write attributed).
        await SignInAsync(client);

        await AddRecipeAsync(client, "From a script");

        Assert.Empty(await MealNoticesAsync(client));
    }

    /// <summary>
    /// Plan changes notify only for today or tomorrow. Next Thursday is not worth interrupting
    /// anyone about — and a panel that announced every future edit would train people to ignore it.
    /// </summary>
    [Theory]
    [InlineData(0, true)]   // tonight
    [InlineData(1, true)]   // tomorrow
    [InlineData(2, false)]  // the day after — silent
    [InlineData(6, false)]  // next week — silent
    public async Task Plan_changes_notify_only_for_today_or_tomorrow(int dayOffset, bool expected)
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var (_, them) = await SignInAsync(client);
        var recipe = (await (await AddRecipeAsync(client, "Curry")).Content.ReadFromJsonAsync<RecipeDto>())!;
        var date = DateOnly.FromDateTime(DateTime.Now).AddDays(dayOffset);

        await TheirClient(app, them).PutAsJsonAsync("/api/meals/plan",
            new MealPlanInput(date, MealSlot.Dinner, RecipeId: recipe.Id, ProfileId: them));

        Assert.Equal(expected, (await MealNoticesAsync(client)).Count > 0);
    }

    // ---- The evening-before lead-time notice ----

    /// <summary>
    /// The evening these passes run on. Everything below dates itself from here rather than from the
    /// real calendar — the watcher's whole behaviour is "the night before", so a test that pins the
    /// clock and then plans against today is asking two different days the same question.
    /// </summary>
    private static readonly DateOnly LeadTimeDay = new(2026, 8, 1);

    /// <summary>
    /// The one notice that has to fire while nobody is looking at the panel. Driven through the
    /// service's own pass with a fixed clock rather than by waiting for 21:00.
    /// </summary>
    [Theory]
    [InlineData(20, false)] // before the window — nothing yet
    [InlineData(21, true)]  // the window opens
    [InlineData(22, true)]  // still inside it, and the dedupe key stops a second notice
    [InlineData(23, false)] // closed
    public async Task The_lead_time_notice_fires_only_inside_the_evening_window(int hour, bool expected)
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        await SignInAsync(client);
        // The night after the pinned pass, not the night after today: the watcher looks for "tomorrow"
        // by *its* clock, so a real-today date only lined up on 1 August 2026 and the test failed on
        // every other day of its life.
        var tomorrow = LeadTimeDay.AddDays(1);

        var recipe = (await (await client.PostAsJsonAsync("/api/recipes",
            new RecipeInput("Overnight Ragu", PrepNote: "Pork out tonight to thaw", TotalMinutes: 200)))
            .Content.ReadFromJsonAsync<RecipeDto>())!;
        await client.PutAsJsonAsync("/api/meals/plan",
            new MealPlanInput(tomorrow, MealSlot.Dinner, RecipeId: recipe.Id));

        await app.RunLeadTimePassAsync(new DateTimeOffset(2026, 8, 1, hour, 5, 0, TimeSpan.Zero));

        Assert.Equal(expected, (await MealNoticesAsync(client)).Count > 0);
    }

    /// <summary>Fires once for a night, however many passes run inside the window.</summary>
    [Fact]
    public async Task The_lead_time_notice_fires_once_however_many_passes_run()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        // At the panel, so this client's own fixture writes stay silent and the only notice
        // that can appear is the one under test (AUDIT A1.2 made every HTTP write attributed).
        await SignInAsync(client);
        // The night after the pinned pass, not the night after today: the watcher looks for "tomorrow"
        // by *its* clock, so a real-today date only lined up on 1 August 2026 and the test failed on
        // every other day of its life.
        var tomorrow = LeadTimeDay.AddDays(1);
        var recipe = (await (await client.PostAsJsonAsync("/api/recipes",
            new RecipeInput("Overnight Ragu", PrepNote: "Pork out tonight")))
            .Content.ReadFromJsonAsync<RecipeDto>())!;
        await client.PutAsJsonAsync("/api/meals/plan",
            new MealPlanInput(tomorrow, MealSlot.Dinner, RecipeId: recipe.Id));

        for (var i = 0; i < 5; i++)
        {
            await app.RunLeadTimePassAsync(new DateTimeOffset(2026, 8, 1, 21, i * 10, 0, TimeSpan.Zero));
        }

        Assert.Single(await MealNoticesAsync(client));
    }

    /// <summary>
    /// A quick dish with no note says nothing. The notice exists for things that need starting
    /// early, and firing on every planned night would make it worthless.
    /// </summary>
    [Fact]
    public async Task An_ordinary_dish_produces_no_lead_time_notice()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        // At the panel, so this client's own fixture writes stay silent and the only notice
        // that can appear is the one under test (AUDIT A1.2 made every HTTP write attributed).
        await SignInAsync(client);
        // The night after the pinned pass, not the night after today: the watcher looks for "tomorrow"
        // by *its* clock, so a real-today date only lined up on 1 August 2026 and the test failed on
        // every other day of its life.
        var tomorrow = LeadTimeDay.AddDays(1);
        var recipe = (await (await client.PostAsJsonAsync("/api/recipes",
            new RecipeInput("Sheet Pan Sausages", TotalMinutes: 35)))
            .Content.ReadFromJsonAsync<RecipeDto>())!;
        await client.PutAsJsonAsync("/api/meals/plan",
            new MealPlanInput(tomorrow, MealSlot.Dinner, RecipeId: recipe.Id));

        await app.RunLeadTimePassAsync(new DateTimeOffset(2026, 8, 1, 21, 5, 0, TimeSpan.Zero));

        Assert.Empty(await MealNoticesAsync(client));
    }

    /// <summary>A fork is an addition, not an edit — the original was never touched.</summary>
    [Fact]
    public async Task Forking_announces_the_new_recipe_not_a_change_to_the_original()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var (_, them) = await SignInAsync(client);
        var original = (await (await AddRecipeAsync(client, "Chicken Piccata")).Content.ReadFromJsonAsync<RecipeDto>())!;

        await TheirClient(app, them).PostAsJsonAsync($"/api/recipes/{original.Id}/fork",
            new ForkRecipeInput("Chicken Piccata - ours"));

        var notice = Assert.Single(await MealNoticesAsync(client));
        Assert.Contains("added", notice.Headline, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("ours", notice.Headline);
    }
}
