namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;

/// <summary>
/// AUDIT A1 — the bearer scheme for callers that are programs.
/// </summary>
/// <remarks>
/// The voice bridge is why this exists: it calls the API server-to-server from Python, has no
/// browser and therefore nowhere to keep a session cookie, and would have taken a 401 on every
/// request the moment <c>[Authorize]</c> became the default.
/// </remarks>
public class ServiceTokenTests
{
    private const string Token = "test-service-token-not-a-real-credential";

    private static HubAppFactory WithBridge() =>
        new() { ServiceTokens = { ["voice-bridge"] = Token } };

    private static HttpClient Bearing(HubAppFactory app, string token)
    {
        var client = app.CreateAnonymousClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return client;
    }

    [Fact]
    public async Task A_configured_token_is_admitted()
    {
        using var app = WithBridge();

        var res = await Bearing(app, Token).GetAsync("/api/climate/zones");

        Assert.True(res.IsSuccessStatusCode, $"answered {res.StatusCode}");
    }

    [Fact]
    public async Task An_unknown_token_is_refused()
    {
        using var app = WithBridge();

        var res = await Bearing(app, "not-the-token").GetAsync("/api/climate/zones");

        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    /// <summary>
    /// With no tokens configured the scheme authorises nobody.
    /// </summary>
    /// <remarks>
    /// A deployment that never sets one should be closed, not open. Worth pinning because the
    /// opposite — an empty allowlist meaning "allow everything" — is a common and quiet mistake.
    /// </remarks>
    [Fact]
    public async Task With_no_tokens_configured_nothing_is_admitted()
    {
        using var app = new HubAppFactory();

        var res = await Bearing(app, Token).GetAsync("/api/climate/zones");

        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    /// <summary>
    /// A service has no <c>ProfileId</c>, so it cannot reach anything scoped to a member.
    /// </summary>
    /// <remarks>
    /// This is the reason the bridge got its own scheme rather than being bound to a household
    /// member's session: a headless daemon holding somebody's identity would file its actions into
    /// their Assist history and their calendar. Here it reaches house state and stops there — and,
    /// critically, the member-scoped endpoints do not fall back to "whichever profile is first".
    /// </remarks>
    [Fact]
    public async Task A_service_gets_no_members_data()
    {
        using var app = WithBridge();
        // Give Astrid something to find, as her own signed-in session.
        var astrid = app.CreateSeededClient(profileId: 1);
        await astrid.PostAsJsonAsync("/api/assist/chat",
            new Api.Assist.AssistChatRequest(null, null, "Private", null, null, null));

        var asService = await Bearing(app, Token)
            .GetFromJsonAsync<Api.Assist.ConversationListDto>("/api/assist/conversations");

        Assert.Empty(asService!.Conversations);
    }

    /// <summary>A service may not administer the household.</summary>
    /// <remarks>
    /// The admin policy names the cookie scheme and requires a household role, so a machine
    /// credential fails it on both counts. Reading the thermostat is one thing; deciding who lives
    /// here is another.
    /// </remarks>
    [Fact]
    public async Task A_service_cannot_touch_the_roster()
    {
        using var app = WithBridge();

        var res = await Bearing(app, Token)
            .PostAsJsonAsync("/api/profiles", new Api.Profiles.CreateProfileRequest("Intruder", "I"));

        Assert.True(
            res.StatusCode is HttpStatusCode.Forbidden or HttpStatusCode.Unauthorized,
            $"answered {res.StatusCode}");
    }
}
