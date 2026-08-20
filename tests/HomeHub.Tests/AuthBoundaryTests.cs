namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Assist;
using HomeHub.Api.Controllers;
using HomeHub.Api.Profiles;

/// <summary>
/// AUDIT A1 — the trust boundary. Before this there was none: every endpoint, including "clear this
/// member's PIN" and "read this member's chat history", was reachable by anything on the LAN.
/// </summary>
/// <remarks>
/// These are written as the attacks the audit described, not as assertions about implementation.
/// Each one is a request that used to succeed.
/// </remarks>
public class AuthBoundaryTests
{
    // ---- The default is closed ----

    /// <summary>
    /// An endpoint that states no policy of its own still requires a session.
    /// </summary>
    /// <remarks>
    /// The fallback policy is the part that has to hold, because it is what protects the endpoint
    /// somebody adds next year without thinking about auth. A per-controller <c>[Authorize]</c>
    /// would leave that one open; this makes forgetting fail closed.
    /// </remarks>
    [Theory]
    [InlineData("/api/assist/conversations")]
    [InlineData("/api/tasks")]
    [InlineData("/api/calendar/upcoming")]
    [InlineData("/api/pantry")]
    [InlineData("/api/settings")]
    [InlineData("/api/climate/zones")]
    public async Task An_anonymous_read_is_refused(string path)
    {
        using var app = new HubAppFactory();

        var res = await app.CreateAnonymousClient().GetAsync(path);

        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    /// <summary>
    /// A 401 rather than a redirect to a sign-in page this app does not serve.
    /// </summary>
    /// <remarks>
    /// Cookie authentication's default is a 302 to <c>/Account/Login</c>. On an API that turns an
    /// actionable status into an HTML body the client tries to parse as JSON, and the real cause —
    /// "you are not signed in" — disappears.
    /// </remarks>
    [Fact]
    public async Task An_unauthenticated_request_gets_a_status_not_a_redirect()
    {
        using var app = new HubAppFactory();

        var res = await app.CreateAnonymousClient().GetAsync("/api/tasks");

        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        Assert.Null(res.Headers.Location);
    }

    // ---- What must stay open ----

    /// <summary>
    /// Health, the roster and the session endpoint answer without one — each for a stated reason.
    /// </summary>
    /// <remarks>
    /// Health because the panel's connection banner and <c>deploy.sh</c> both poll it to tell "up"
    /// from "gone", and a health check that needs a session reports the server as broken for the one
    /// condition it exists to rule out. The roster because the sign-in screen has to draw the picker
    /// before anybody is signed in. The session endpoint because "am I signed in" cannot require
    /// being signed in to ask.
    /// </remarks>
    [Theory]
    [InlineData("/api/health")]
    [InlineData("/api/profiles")]
    [InlineData("/api/session")]
    public async Task The_endpoints_the_sign_in_screen_needs_stay_open(string path)
    {
        using var app = new HubAppFactory();

        var res = await app.CreateAnonymousClient().GetAsync(path);

        Assert.True(res.IsSuccessStatusCode, $"{path} answered {res.StatusCode}");
    }

    /// <summary>
    /// The SPA shell and its assets are served to a browser holding no session.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The regression that took the panel down after A1. The fallback policy authorises every
    /// endpoint that states no policy of its own — and the authorisation middleware applies it to
    /// requests matching <i>no endpoint at all</i>, which is what a static asset is. So
    /// <c>/</c>, <c>/dashboard</c>, <c>/assets/index-*.js</c> and <c>favicon.ico</c> all answered
    /// 401, and Chrome rendered the bodiless status as "This page isn't working". The client that
    /// asks for the PIN could never load, so the cookie that would have let it through could never
    /// be obtained: the app locked everybody out, including itself.
    /// </para>
    /// <para>
    /// Asserted as "not 401" rather than "200" on purpose — CI does not run <c>npm run build</c>, so
    /// <c>wwwroot</c> is empty there and 404 is the honest answer. 404 says "no file"; 401 says "this
    /// deployment cannot be signed in to", and only the second is the bug.
    /// </para>
    /// </remarks>
    [Theory]
    [InlineData("/")]
    [InlineData("/dashboard")]
    [InlineData("/favicon.ico")]
    [InlineData("/icons/manifest.webmanifest")]
    public async Task The_spa_shell_is_served_without_a_session(string path)
    {
        using var app = new HubAppFactory();

        var res = await app.CreateAnonymousClient().GetAsync(path);

        Assert.NotEqual(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    [Fact]
    public async Task A_real_static_asset_is_served_before_the_anonymous_missing_asset_fallback()
    {
        var webRoot = Directory.CreateTempSubdirectory("homehub-static-");
        try
        {
            Directory.CreateDirectory(Path.Combine(webRoot.FullName, "assets"));
            await File.WriteAllTextAsync(Path.Combine(webRoot.FullName, "assets", "probe.js"), "window.probe = true;");
            using var app = new HubAppFactory { WebRootPath = webRoot.FullName };

            var res = await app.CreateAnonymousClient().GetAsync("/assets/probe.js");

            Assert.Equal(HttpStatusCode.OK, res.StatusCode);
            Assert.Equal("window.probe = true;", await res.Content.ReadAsStringAsync());
        }
        finally
        {
            webRoot.Delete(recursive: true);
        }
    }

    /// <summary>
    /// An unknown path under /api is reported missing, never answered with the SPA shell.
    /// </summary>
    /// <remarks>
    /// The other half of making the shell anonymous. The SPA fallback matches
    /// <c>{*path:nonfile}</c>, and a mistyped API route has no file extension either — so an
    /// unguarded fallback answers <c>GET /api/anything</c> with 200 and a page of HTML, which the
    /// client hands to <c>JSON.parse</c>. "Unexpected token &lt;" is a long way from "that route
    /// does not exist".
    /// </remarks>
    [Fact]
    public async Task An_unknown_api_path_is_not_answered_with_the_spa_shell()
    {
        using var app = new HubAppFactory();

        var res = await app.CreateSeededClient().GetAsync("/api/no-such-route");

        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        Assert.NotEqual("text/html", res.Content.Headers.ContentType?.MediaType);
    }

    /// <summary>The roster is readable anonymously, so it must carry nothing but names.</summary>
    [Fact]
    public async Task The_anonymous_roster_leaks_no_secret()
    {
        using var app = new HubAppFactory();
        var admin = app.CreateSeededClient();
        await admin.PutAsJsonAsync("/api/profiles/1/pin", new SetPinRequest("1234"));

        var raw = await app.CreateAnonymousClient().GetStringAsync("/api/profiles");

        Assert.DoesNotContain("pinHash", raw, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("1234", raw, StringComparison.Ordinal);
        // hasPin is the flag the lock screen needs; the hash behind it is not.
        Assert.Contains("hasPin", raw, StringComparison.Ordinal);
    }

    /// <summary>Signed out means signed out, reported rather than refused.</summary>
    [Fact]
    public async Task The_session_endpoint_reports_nobody_rather_than_refusing()
    {
        using var app = new HubAppFactory();

        var session = await app.CreateAnonymousClient().GetFromJsonAsync<SessionDto>("/api/session");

        Assert.NotNull(session);
        Assert.False(session!.SignedIn);
        Assert.Null(session.ProfileId);
    }

    // ---- The attacks the audit listed ----

    /// <summary>
    /// "Clear any household member's PIN. The lock screen is then decorative."
    /// </summary>
    [Fact]
    public async Task A_pin_cannot_be_cleared_anonymously()
    {
        using var app = new HubAppFactory();
        var admin = app.CreateSeededClient();
        await admin.PutAsJsonAsync("/api/profiles/2/pin", new SetPinRequest("4321"));

        var res = await app.CreateAnonymousClient().DeleteAsync("/api/profiles/2/pin");

        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        // Still set — the point is the PIN survived, not merely that the call failed.
        var profiles = await admin.GetFromJsonAsync<List<ProfileDto>>("/api/profiles");
        Assert.True(profiles!.Single(p => p.Id == 2).HasPin);
    }

    /// <summary>A member may manage their own PIN, and nobody else's.</summary>
    [Fact]
    public async Task A_member_cannot_clear_another_members_pin()
    {
        using var app = new HubAppFactory();
        var admin = app.CreateSeededClient(profileId: 1);
        await admin.PutAsJsonAsync("/api/profiles/3/pin", new SetPinRequest("1111"));

        // Ragnar is a Member, not an admin.
        var ragnar = app.CreateSeededClient(profileId: 2);

        Assert.Equal(HttpStatusCode.Forbidden, (await ragnar.DeleteAsync("/api/profiles/3/pin")).StatusCode);
        // His own is his to clear — while he can still say what it is. Being signed in is not that:
        // see `Removing_your_own_pin_asks_for_it_first`.
        await ragnar.PutAsJsonAsync("/api/profiles/2/pin", new SetPinRequest("2222"));
        var clear = new HttpRequestMessage(HttpMethod.Delete, "/api/profiles/2/pin")
        {
            Content = JsonContent.Create(new ClearPinRequest("2222")),
        };
        Assert.Equal(HttpStatusCode.NoContent, (await ragnar.SendAsync(clear)).StatusCode);
    }

    /// <summary>"Read any member's entire chat history with their agent."</summary>
    /// <remarks>
    /// The audit's sharpest example, because <c>profileId</c> was an unvalidated query parameter and
    /// therefore <i>was</i> the authorisation model. Asserted twice over: anonymously, and as another
    /// signed-in member naming the target in the URL.
    /// </remarks>
    [Fact]
    public async Task Another_members_chat_history_is_unreachable()
    {
        using var app = new HubAppFactory();
        var astrid = app.CreateSeededClient(profileId: 1);
        await astrid.PostAsJsonAsync("/api/assist/chat",
            new AssistChatRequest(null, null, "Something private", null, null, null));

        var anonymous = await app.CreateAnonymousClient().GetAsync("/api/assist/conversations?profileId=1");
        Assert.Equal(HttpStatusCode.Unauthorized, anonymous.StatusCode);

        var ragnar = app.CreateSeededClient(profileId: 2);
        var spoofed = await ragnar.GetFromJsonAsync<ConversationListDto>("/api/assist/conversations?profileId=1");
        Assert.Empty(spoofed!.Conversations);
    }

    /// <summary>
    /// Nor by conversation id, which is the obvious way round a scoped list.
    /// </summary>
    /// <remarks>
    /// Ids are small integers. Scoping the list and not the detail endpoint would have made reading
    /// somebody else's chat a matter of counting. <c>NotFound</c> rather than <c>Forbidden</c>:
    /// confirming that a conversation exists but is not yours is itself an answer.
    /// </remarks>
    [Fact]
    public async Task Another_members_conversation_is_unreachable_by_id()
    {
        using var app = new HubAppFactory();
        var astrid = app.CreateSeededClient(profileId: 1);
        var started = await (await astrid.PostAsJsonAsync("/api/assist/chat",
                new AssistChatRequest(null, null, "Something private", null, null, null)))
            .Content.ReadFromJsonAsync<AssistChatResponse>();

        var ragnar = app.CreateSeededClient(profileId: 2);

        var read = await ragnar.GetAsync($"/api/assist/conversations/{started!.ConversationId}");
        Assert.Equal(HttpStatusCode.NotFound, read.StatusCode);

        // And it is still there for its owner — refused, not deleted.
        var mine = await astrid.GetAsync($"/api/assist/conversations/{started.ConversationId}");
        Assert.True(mine.IsSuccessStatusCode);
    }

    /// <summary>"Grant any member any agent."</summary>
    /// <remarks>
    /// Admin-only rather than self-or-admin: granting yourself an agent is precisely the decision
    /// the roster exists to be somebody else's.
    /// </remarks>
    [Fact]
    public async Task A_member_cannot_grant_themselves_an_agent()
    {
        using var app = new HubAppFactory { Agents = [("barnaby", "Barnaby", true), ("geist", "Geist", false)] };
        var ragnar = app.CreateSeededClient(profileId: 2);

        var res = await ragnar.PutAsJsonAsync("/api/assist/assignments/2",
            new SetAgentAssignmentsRequest(["geist"]));

        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
    }

    /// <summary>"Unlink anyone's Google/Microsoft account."</summary>
    [Fact]
    public async Task A_member_cannot_unlink_another_members_account()
    {
        using var app = new HubAppFactory();
        var ragnar = app.CreateSeededClient(profileId: 2);

        var res = await ragnar.DeleteAsync("/api/link/google?profileId=3");

        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
    }

    /// <summary>Profile CRUD is administrators only, so a member cannot promote themselves.</summary>
    [Fact]
    public async Task A_member_cannot_make_themselves_an_admin()
    {
        using var app = new HubAppFactory();
        var ragnar = app.CreateSeededClient(profileId: 2);

        var res = await ragnar.PutAsJsonAsync("/api/profiles/2",
            new UpdateProfileRequest("Ragnar", "R", false, true, 1, ProfileRole.Admin));

        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
    }

    /// <summary>An administrator can do the things a member cannot.</summary>
    /// <remarks>
    /// The counterweight to every test above: a boundary that refused everyone would pass all of
    /// them and be useless.
    /// </remarks>
    [Fact]
    public async Task An_administrator_can_still_administer()
    {
        using var app = new HubAppFactory();
        var astrid = app.CreateSeededClient(profileId: 1);

        Assert.Equal(HttpStatusCode.NoContent,
            (await astrid.PutAsJsonAsync("/api/profiles/3/pin", new SetPinRequest("9999"))).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent,
            (await astrid.DeleteAsync("/api/profiles/3/pin")).StatusCode);

        var created = await astrid.PostAsJsonAsync("/api/profiles", new CreateProfileRequest("Sigrid", "S"));
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
    }

    // ---- Sessions ----

    /// <summary>Signing out closes the session for real, not just in the client's mind.</summary>
    [Fact]
    public async Task Signing_out_ends_access()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        Assert.True((await client.GetAsync("/api/tasks")).IsSuccessStatusCode);

        await client.DeleteAsync("/api/session");

        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/tasks")).StatusCode);
    }

    /// <summary>
    /// A profile that does not exist is refused the same way a wrong PIN is.
    /// </summary>
    /// <remarks>
    /// Distinguishing them would turn sign-in into a way to enumerate profile ids. It buys nothing
    /// for anyone who belongs here — the picker lists the real ones.
    /// </remarks>
    [Fact]
    public async Task An_unknown_profile_is_refused_like_a_wrong_pin()
    {
        using var app = new HubAppFactory();

        var res = await app.CreateAnonymousClient().PostAsJsonAsync("/api/session", new { profileId = 9999 });

        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    /// <summary>
    /// Sign-in is rate limited per caller, independently of the per-profile PIN lockout.
    /// </summary>
    /// <remarks>
    /// <c>PinLockout</c> stops five wrong PINs <i>per profile</i>; it cannot see a caller working
    /// through the roster to stay under five on each. This walks past unknown profile ids, which
    /// never touch the lockout at all, so the only thing that can stop it is the limiter — and
    /// stopping is what it must do.
    /// </remarks>
    [Fact]
    public async Task Sign_in_attempts_are_rate_limited()
    {
        using var app = new HubAppFactory();
        var client = app.CreateAnonymousClient();

        HttpStatusCode last = HttpStatusCode.OK;
        for (var i = 0; i < 25; i++)
        {
            // A different unknown id each time: no single profile accumulates failures, so the
            // lockout never fires and the limiter is unambiguously what answers.
            var res = await client.PostAsJsonAsync("/api/session", new { profileId = 5000 + i });
            last = res.StatusCode;
            if (last == HttpStatusCode.TooManyRequests) break;
        }

        Assert.Equal(HttpStatusCode.TooManyRequests, last);
    }

    /// <summary>Two devices hold two independent sessions.</summary>
    /// <remarks>
    /// The behaviour change at the heart of A1: "who is active" used to be one row on the server, so
    /// opening Assist on a phone changed whose account the kitchen panel was showing.
    /// </remarks>
    [Fact]
    public async Task Two_devices_can_be_two_different_people()
    {
        using var app = new HubAppFactory();
        var panel = app.CreateSeededClient(profileId: 1);
        var phone = app.CreateSeededClient(profileId: 2);

        var onPanel = await panel.GetFromJsonAsync<SessionDto>("/api/session");
        var onPhone = await phone.GetFromJsonAsync<SessionDto>("/api/session");

        Assert.Equal(1, onPanel!.ProfileId);
        Assert.Equal(2, onPhone!.ProfileId);
        Assert.True(onPanel.IsAdmin);
        Assert.False(onPhone.IsAdmin);
    }
}
