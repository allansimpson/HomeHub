namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Controllers;
using HomeHub.Api.Profiles;

/// <summary>
/// Stage 1 profile lifecycle + PIN behaviour, exercised through the real HTTP pipeline against
/// an isolated in-memory database. Each test gets a fresh, seeded app so they never interfere.
/// </summary>
public class ProfilesApiTests
{
    [Fact]
    public async Task Seeds_the_viking_household()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var profiles = await client.GetFromJsonAsync<List<ProfileDto>>("/api/profiles");

        Assert.NotNull(profiles);
        Assert.Equal(new[] { "Astrid", "Ragnar", "Leif" }, profiles!.Select(p => p.Name));
        Assert.All(profiles, p => Assert.False(p.HasPin));
    }

    [Fact]
    public async Task Seed_grants_exactly_one_admin()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var profiles = await client.GetFromJsonAsync<List<ProfileDto>>("/api/profiles");
        Assert.NotNull(profiles);

        // The seed ships against live rows via UpdateData, so it grants the one thing that is
        // inert to be wrong about — an extra Admin on a LAN panel — and guesses nothing else.
        Assert.Single(profiles!, p => p.Role == nameof(ProfileRole.Admin));
        Assert.Equal(1, profiles!.Single(p => p.Role == nameof(ProfileRole.Admin)).Id);
    }

    [Fact]
    public async Task New_profiles_start_as_a_member()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var created = await (await client.PostAsJsonAsync("/api/profiles", new CreateProfileRequest("Sigrid", "S")))
            .Content.ReadFromJsonAsync<ProfileDto>();

        Assert.Equal(nameof(ProfileRole.Member), created!.Role);
    }

    [Fact]
    public async Task Role_is_editable()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PutAsJsonAsync(
            "/api/profiles/3",
            new UpdateProfileRequest("Leif", "L", false, true, 2, ProfileRole.Admin));

        var updated = await res.Content.ReadFromJsonAsync<ProfileDto>();
        Assert.Equal(nameof(ProfileRole.Admin), updated!.Role);
    }

    [Fact]
    public async Task An_update_that_omits_the_role_leaves_it_alone()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await client.PutAsJsonAsync(
            "/api/profiles/3",
            new UpdateProfileRequest("Leif", "L", false, true, 2, ProfileRole.Admin));

        // A rename from a client that predates the column — or any payload that simply doesn't
        // mention it. Silence must not quietly revoke the grant.
        var res = await client.PutAsJsonAsync(
            "/api/profiles/3",
            new UpdateProfileRequest("Leif Jr", "L", false, true, 2));

        var updated = await res.Content.ReadFromJsonAsync<ProfileDto>();
        Assert.Equal("Leif Jr", updated!.Name);
        Assert.Equal(nameof(ProfileRole.Admin), updated.Role);
    }

    [Fact]
    public async Task Role_serializes_as_a_string_not_an_ordinal()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        await client.PutAsJsonAsync(
            "/api/profiles/3",
            new UpdateProfileRequest("Leif", "L", false, true, 2, ProfileRole.Admin));

        // The client TS union mirrors this by name (PROJECT.md §8); an ordinal would silently
        // break that lockstep.
        var raw = await client.GetStringAsync("/api/profiles");
        Assert.Contains("\"role\":\"Admin\"", raw);
    }

    /// <summary>
    /// Setting a PIN makes it the thing that signs you in — right one in, wrong one out.
    /// </summary>
    /// <remarks>
    /// This used to POST <c>verify-pin</c>, which returned a boolean the browser could ignore
    /// (AUDIT A1). That endpoint is gone; the PIN is now checked by <c>POST /api/session</c>, where
    /// getting it right mints the cookie and getting it wrong is a 401 rather than a 200 saying
    /// <c>false</c>. Same coverage, but of a lock that actually holds.
    /// </remarks>
    [Fact]
    public async Task Set_pin_then_sign_in_correct_and_wrong()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var set = await client.PutAsJsonAsync("/api/profiles/1/pin", new SetPinRequest("1234"));
        Assert.Equal(HttpStatusCode.NoContent, set.StatusCode);

        // The list now reports a PIN is set, but never leaks the hash.
        var profiles = await client.GetFromJsonAsync<List<ProfileDto>>("/api/profiles");
        var astrid = profiles!.Single(p => p.Id == 1);
        Assert.True(astrid.HasPin);
        Assert.True(astrid.RequirePinWhenIdle);

        var fresh = app.CreateAnonymousClient();
        var good = await fresh.PostAsJsonAsync("/api/session", new { profileId = 1, pin = "1234" });
        Assert.Equal(HttpStatusCode.OK, good.StatusCode);

        var wrong = app.CreateAnonymousClient();
        var bad = await wrong.PostAsJsonAsync("/api/session", new { profileId = 1, pin = "0000" });
        Assert.Equal(HttpStatusCode.Unauthorized, bad.StatusCode);
    }

    /// <summary>A profile with a PIN cannot be signed in to without it.</summary>
    /// <remarks>
    /// The gap the old design left: <c>verify-pin</c> could simply not be called. Here, omitting the
    /// PIN is not a way past the PIN.
    /// </remarks>
    [Fact]
    public async Task A_profile_with_a_pin_cannot_be_signed_in_to_without_one()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        await client.PutAsJsonAsync("/api/profiles/1/pin", new SetPinRequest("1234"));

        var res = await app.CreateAnonymousClient().PostAsJsonAsync("/api/session", new { profileId = 1 });

        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    [Fact]
    public async Task Rejects_pin_that_is_not_four_digits()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var tooShort = await client.PutAsJsonAsync("/api/profiles/1/pin", new SetPinRequest("12"));
        Assert.Equal(HttpStatusCode.BadRequest, tooShort.StatusCode);

        var notDigits = await client.PutAsJsonAsync("/api/profiles/1/pin", new SetPinRequest("abcd"));
        Assert.Equal(HttpStatusCode.BadRequest, notDigits.StatusCode);
    }

    [Fact]
    public async Task Locks_out_after_repeated_wrong_pins()
    {
        using var app = new HubAppFactory();
        var admin = app.CreateSeededClient();
        await admin.PutAsJsonAsync("/api/profiles/2/pin", new SetPinRequest("4321"));

        var attacker = app.CreateAnonymousClient();
        SignInFailure? last = null;
        for (var i = 0; i < 5; i++)
        {
            var res = await attacker.PostAsJsonAsync("/api/session", new { profileId = 2, pin = "0000" });
            last = await res.Content.ReadFromJsonAsync<SignInFailure>();
        }

        // The 5th failure trips the lockout cooldown.
        Assert.NotNull(last);
        Assert.NotNull(last!.RetryAfterSeconds);
        Assert.True(last.RetryAfterSeconds > 0);
    }

    /// <summary>
    /// The lockout is one counter, not one per endpoint that checks a PIN.
    /// </summary>
    /// <remarks>
    /// It used to be a private static dictionary inside this controller. The sign-in endpoint needs
    /// the same counter, and two of them would mean five attempts *each* — with the one an attacker
    /// picks being whichever was overlooked. This asserts that a profile already locked out by
    /// failed sign-ins is refused even with the right PIN, which is only true if both share
    /// <c>PinLockout</c>.
    /// </remarks>
    [Fact]
    public async Task The_lockout_survives_switching_to_the_correct_pin()
    {
        using var app = new HubAppFactory();
        var admin = app.CreateSeededClient();
        await admin.PutAsJsonAsync("/api/profiles/2/pin", new SetPinRequest("4321"));

        var attacker = app.CreateAnonymousClient();
        for (var i = 0; i < 5; i++)
            await attacker.PostAsJsonAsync("/api/session", new { profileId = 2, pin = "0000" });

        var withTheRealPin = await attacker.PostAsJsonAsync("/api/session", new { profileId = 2, pin = "4321" });

        Assert.Equal(HttpStatusCode.Unauthorized, withTheRealPin.StatusCode);
    }

    /// <summary>
    /// Changing your own PIN means proving you know the one you have — a session is not proof.
    /// </summary>
    /// <remarks>
    /// The wall panel holds a persistent session all day, so before this anybody standing at an
    /// unlocked kitchen screen could set a member's PIN to four digits only they knew. There was
    /// also no way to *change* a PIN at all: the only route to different digits was clear-then-set,
    /// which asked for nothing either.
    /// </remarks>
    [Fact]
    public async Task Changing_your_own_pin_asks_for_the_current_one()
    {
        using var app = new HubAppFactory();
        var astrid = app.CreateSeededClient(profileId: 1);
        await astrid.PutAsJsonAsync("/api/profiles/1/pin", new SetPinRequest("1234"));

        // Signed in as herself, and still refused without the PIN in force.
        var silent = await astrid.PutAsJsonAsync("/api/profiles/1/pin", new SetPinRequest("5678"));
        Assert.Equal(HttpStatusCode.Unauthorized, silent.StatusCode);

        var wrong = await astrid.PutAsJsonAsync("/api/profiles/1/pin", new SetPinRequest("5678", "0000"));
        Assert.Equal(HttpStatusCode.Unauthorized, wrong.StatusCode);

        // The old PIN still opens the door — a refused change changes nothing.
        Assert.Equal(
            HttpStatusCode.OK,
            (await app.CreateAnonymousClient().PostAsJsonAsync("/api/session", new { profileId = 1, pin = "1234" })).StatusCode);

        var right = await astrid.PutAsJsonAsync("/api/profiles/1/pin", new SetPinRequest("5678", "1234"));
        Assert.Equal(HttpStatusCode.NoContent, right.StatusCode);

        // And now it is the new one, and only the new one.
        Assert.Equal(
            HttpStatusCode.OK,
            (await app.CreateAnonymousClient().PostAsJsonAsync("/api/session", new { profileId = 1, pin = "5678" })).StatusCode);
        Assert.Equal(
            HttpStatusCode.Unauthorized,
            (await app.CreateAnonymousClient().PostAsJsonAsync("/api/session", new { profileId = 1, pin = "1234" })).StatusCode);
    }

    /// <summary>
    /// Removing your own PIN asks for it too — or the re-entry above would be theatre.
    /// </summary>
    /// <remarks>
    /// Clear-then-set is a change of PIN with two taps. If only one half of the pair asked, the
    /// household would be protected by whichever half an attacker did not choose.
    /// </remarks>
    [Fact]
    public async Task Removing_your_own_pin_asks_for_it_first()
    {
        using var app = new HubAppFactory();
        var ragnar = app.CreateSeededClient(profileId: 2);
        await ragnar.PutAsJsonAsync("/api/profiles/2/pin", new SetPinRequest("4321"));

        Assert.Equal(HttpStatusCode.Unauthorized, (await ragnar.DeleteAsync("/api/profiles/2/pin")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await Clear(ragnar, 2, "0000")).StatusCode);

        var profiles = await ragnar.GetFromJsonAsync<List<ProfileDto>>("/api/profiles");
        Assert.True(profiles!.Single(p => p.Id == 2).HasPin);

        Assert.Equal(HttpStatusCode.NoContent, (await Clear(ragnar, 2, "4321")).StatusCode);
        var after = await ragnar.GetFromJsonAsync<List<ProfileDto>>("/api/profiles");
        Assert.False(after!.Single(p => p.Id == 2).HasPin);
    }

    /// <summary>
    /// An administrator resetting somebody else's PIN is not asked for it — that is the household's
    /// recovery path for a PIN nobody can remember.
    /// </summary>
    [Fact]
    public async Task An_admin_can_reset_another_members_forgotten_pin()
    {
        using var app = new HubAppFactory();
        var ragnar = app.CreateSeededClient(profileId: 2);
        await ragnar.PutAsJsonAsync("/api/profiles/2/pin", new SetPinRequest("4321"));

        var admin = app.CreateSeededClient(profileId: 1);
        var reset = await admin.PutAsJsonAsync("/api/profiles/2/pin", new SetPinRequest("1111"));
        Assert.Equal(HttpStatusCode.NoContent, reset.StatusCode);

        Assert.Equal(
            HttpStatusCode.OK,
            (await app.CreateAnonymousClient().PostAsJsonAsync("/api/session", new { profileId = 2, pin = "1111" })).StatusCode);
    }

    /// <summary>
    /// Guessing the current PIN here counts against the same lockout as guessing it at the Lock
    /// screen — this is not a quieter door to knock on.
    /// </summary>
    [Fact]
    public async Task Wrong_current_pins_share_the_sign_in_lockout()
    {
        using var app = new HubAppFactory();
        var leif = app.CreateSeededClient(profileId: 3);
        await leif.PutAsJsonAsync("/api/profiles/3/pin", new SetPinRequest("1111"));

        for (var i = 0; i < 5; i++)
            await leif.PutAsJsonAsync("/api/profiles/3/pin", new SetPinRequest("2222", "0000"));

        // The lockout is now running, so even the right PIN is refused — at both endpoints, because
        // there is one counter rather than one each.
        var withTheRealPin = await leif.PutAsJsonAsync("/api/profiles/3/pin", new SetPinRequest("2222", "1111"));
        Assert.Equal(HttpStatusCode.Unauthorized, withTheRealPin.StatusCode);
        var failure = await withTheRealPin.Content.ReadFromJsonAsync<SignInFailure>();
        Assert.True(failure!.RetryAfterSeconds > 0);

        var atTheLockScreen = await app.CreateAnonymousClient()
            .PostAsJsonAsync("/api/session", new { profileId = 3, pin = "1111" });
        Assert.Equal(HttpStatusCode.Unauthorized, atTheLockScreen.StatusCode);
    }

    /// <summary>DELETE with a body — see <see cref="ClearPinRequest"/> for why the PIN travels there.</summary>
    private static Task<HttpResponseMessage> Clear(HttpClient client, int profileId, string currentPin) =>
        client.SendAsync(new HttpRequestMessage(HttpMethod.Delete, $"/api/profiles/{profileId}/pin")
        {
            Content = JsonContent.Create(new ClearPinRequest(currentPin)),
        });

    [Fact]
    public async Task Create_rename_and_delete_profile()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var created = await (await client.PostAsJsonAsync("/api/profiles", new CreateProfileRequest("Sigrid", "S")))
            .Content.ReadFromJsonAsync<ProfileDto>();
        Assert.NotNull(created);
        Assert.Equal("Sigrid", created!.Name);
        Assert.Equal("S", created.Initial);

        var afterCreate = await client.GetFromJsonAsync<List<ProfileDto>>("/api/profiles");
        Assert.Equal(4, afterCreate!.Count);

        var rename = await client.PutAsJsonAsync(
            $"/api/profiles/{created.Id}",
            new UpdateProfileRequest("Sigrun", "S", false, true, created.DisplayOrder));
        Assert.Equal(HttpStatusCode.OK, rename.StatusCode);
        var renamed = await rename.Content.ReadFromJsonAsync<ProfileDto>();
        Assert.Equal("Sigrun", renamed!.Name);

        var delete = await client.DeleteAsync($"/api/profiles/{created.Id}");
        Assert.Equal(HttpStatusCode.NoContent, delete.StatusCode);

        var afterDelete = await client.GetFromJsonAsync<List<ProfileDto>>("/api/profiles");
        Assert.Equal(3, afterDelete!.Count);
    }

    [Fact]
    public async Task Clearing_pin_removes_lock_requirement()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        await client.PutAsJsonAsync("/api/profiles/3/pin", new SetPinRequest("1111"));

        var clear = await client.DeleteAsync("/api/profiles/3/pin");
        Assert.Equal(HttpStatusCode.NoContent, clear.StatusCode);

        var profiles = await client.GetFromJsonAsync<List<ProfileDto>>("/api/profiles");
        var leif = profiles!.Single(p => p.Id == 3);
        Assert.False(leif.HasPin);
        Assert.False(leif.RequirePinWhenIdle);
        Assert.True(leif.StayLoggedIn);
    }
}
