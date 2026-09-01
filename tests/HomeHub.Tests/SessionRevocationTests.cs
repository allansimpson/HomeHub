namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Controllers;
using HomeHub.Api.Data;
using HomeHub.Api.Profiles;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

/// <summary>
/// H2: an issued cookie stops working the moment the authority it was minted against changes.
/// </summary>
/// <remarks>
/// The finding was that it did not. The role travelled in a cookie with a 400-day sliding lifetime
/// and was trusted for all of it, so demoting an administrator changed the database and nothing else:
/// the demoted principal kept administrator authority — including deleting profiles and editing
/// roles — for as long as it kept using the panel, and anyone holding a copy of that cookie kept it
/// too. Deleting the profile outright did not help either; the claims outlived the row.
///
/// Every test here holds a cookie minted *before* the revocation and proves the next privileged
/// request fails. That ordering is the whole point — a test that signed in afterwards would pass
/// against the original defect.
///
/// <b>Assert against endpoints that actually authenticate.</b> `GET /api/profiles` and
/// `GET /api/session` are both `[AllowAnonymous]`, because the picker needs the roster before anybody
/// is signed in and "am I signed in" has to be answerable when the answer is no. The first draft of
/// these tests used them and passed cheerfully while the cookie was being rejected exactly as
/// intended — the reject worked and the endpoint did not care. `GET /api/session` is still useful
/// here, but for what it *reports*: a rejected principal makes it answer with no profile.
/// </remarks>
public class SessionRevocationTests
{
    private static async Task RevokeAsync(HubAppFactory app, int profileId, Action<Profile> change)
    {
        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
        var profile = await db.Profiles.FirstAsync(p => p.Id == profileId);
        change(profile);
        await db.SaveChangesAsync();
    }

    [Fact]
    public async Task A_demoted_administrator_loses_admin_access_on_the_next_request()
    {
        using var app = new HubAppFactory();
        var stale = app.CreateSeededClient();

        // Works before the demotion, so the assertion after it is about the demotion rather than
        // about the endpoint being unreachable for some other reason.
        Assert.Equal(HttpStatusCode.NoContent, (await stale.DeleteAsync("/api/profiles/3")).StatusCode);

        await RevokeAsync(app, 1, p => { p.Role = ProfileRole.Member; p.SecurityVersion++; });

        var after = await stale.DeleteAsync("/api/profiles/2");
        Assert.Equal(HttpStatusCode.Unauthorized, after.StatusCode);
    }

    /// <summary>
    /// The case the finding named explicitly: the profile row is gone and the cookie still asserts
    /// its id, name and role.
    /// </summary>
    [Fact]
    public async Task A_deleted_profiles_cookie_stops_working()
    {
        using var app = new HubAppFactory();
        var admin = app.CreateSeededClient();
        var member = app.CreateSeededClient(profileId: 2);

        Assert.Equal(2, (await member.GetFromJsonAsync<SessionDto>("/api/session"))!.ProfileId);

        var deleted = await admin.DeleteAsync("/api/profiles/2");
        deleted.EnsureSuccessStatusCode();

        // Nothing was bumped here — the row simply no longer exists, and a principal that cannot be
        // found is refused rather than assumed still good.
        var after = await member.GetFromJsonAsync<SessionDto>("/api/session");
        Assert.Null(after!.ProfileId);
    }

    [Fact]
    public async Task Changing_a_pin_revokes_sessions_opened_against_the_old_one()
    {
        using var app = new HubAppFactory();
        // Two devices signed in as the same member — the phone in a pocket, and the one in hand.
        var otherDevice = app.CreateSeededClient(profileId: 2);
        var thisDevice = app.CreateSeededClient(profileId: 2);

        var set = await thisDevice.PutAsJsonAsync("/api/profiles/2/pin", new SetPinRequest("4821"));
        set.EnsureSuccessStatusCode();

        // The usual reason to change a PIN is that somebody else knows it, so the session opened
        // against the old one must not outlive it.
        var stale = await otherDevice.GetFromJsonAsync<SessionDto>("/api/session");
        Assert.Null(stale!.ProfileId);
    }

    /// <summary>
    /// <b>Revoking every session must not revoke the one doing the revoking.</b>
    /// </summary>
    /// <remarks>
    /// Found by the existing suite rather than by design: bumping the version on a PIN change signed
    /// the member out by their own successful action — the request returned 204 and the next one
    /// 401'd, mid-flow, with nothing to explain it. The acting device is re-issued, which is the
    /// ordinary shape of "change your password, stay signed in here, sign out everywhere else".
    /// </remarks>
    [Fact]
    public async Task The_device_that_changed_the_pin_stays_signed_in()
    {
        using var app = new HubAppFactory();
        var thisDevice = app.CreateSeededClient(profileId: 2);

        var set = await thisDevice.PutAsJsonAsync("/api/profiles/2/pin", new SetPinRequest("4821"));
        set.EnsureSuccessStatusCode();

        var still = await thisDevice.GetFromJsonAsync<SessionDto>("/api/session");
        Assert.Equal(2, still!.ProfileId);
    }

    /// <summary>
    /// An administrator who demotes themselves is re-issued as what they now are, not as what they
    /// were.
    /// </summary>
    [Fact]
    public async Task Demoting_yourself_reissues_the_lower_role_rather_than_keeping_the_old_one()
    {
        using var app = new HubAppFactory();
        var admin = app.CreateSeededClient();

        /*
         * Somebody else is made an administrator first, and that is not tidiness.
         *
         * `HouseholdAdminHandler` grants the admin policy to *everyone* when the roster contains no
         * administrator at all — a deliberate, logged bootstrap escape hatch so a household cannot
         * lock itself out of its own panel. Demoting the only administrator therefore leaves the
         * demoted member still able to do administrator things, correctly, and a test that did it
         * that way would report this fix as broken when it is the other rule working.
         */
        var promote = await admin.PutAsJsonAsync("/api/profiles/2",
            new UpdateProfileRequest("Eleanor", "E", false, true, 1, ProfileRole.Admin));
        promote.EnsureSuccessStatusCode();

        var demote = await admin.PutAsJsonAsync("/api/profiles/1",
            new UpdateProfileRequest("Aiden", "A", false, true, 0, ProfileRole.Member));
        demote.EnsureSuccessStatusCode();

        // Still signed in — the session survives — but no longer an administrator, so the admin-only
        // write is refused. Both halves matter: a re-issue that kept the old claims would be worse
        // than not re-issuing at all.
        var session = await admin.GetFromJsonAsync<SessionDto>("/api/session");
        Assert.Equal(1, session!.ProfileId);
        Assert.False(session.IsAdmin);

        var stillAdmin = await admin.DeleteAsync("/api/profiles/3");
        Assert.NotEqual(HttpStatusCode.NoContent, stillAdmin.StatusCode);
    }
}
