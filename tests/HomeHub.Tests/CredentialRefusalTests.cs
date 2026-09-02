namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Auth;

/// <summary>
/// HH-03 — a 401 that refuses a credential is marked; a 401 that refuses a session is not.
/// </summary>
/// <remarks>
/// <para>
/// <b>Both are 401 and the panel has to do opposite things about them.</b> A mistyped PIN means "say
/// that PIN is not right and stay where you are"; a cookie that is gone means "lock, drop to the
/// picker, and stop drawing the household's private screens over a session that does not exist".
/// </para>
/// <para>
/// The client used to guess by path and method — <c>PUT</c>/<c>DELETE</c> on
/// <c>/profiles/{id}/pin</c> were excused wholesale — which is true of one of the two ways those
/// routes answer 401 and false of the other. A member changing their PIN on a panel whose cookie has
/// expired is the ordinary way to reach the false one. These tests assert the server's half of the
/// contract that replaced the guess.
/// </para>
/// </remarks>
public class CredentialRefusalTests
{
    private static bool IsMarked(HttpResponseMessage res) =>
        res.Headers.TryGetValues(CredentialRefusal.HeaderName, out var values)
        && values.Contains(CredentialRefusal.HeaderValue);

    /// <summary>
    /// Give a seeded profile a PIN, which is the precondition every refusal below needs.
    /// </summary>
    /// <remarks>
    /// The seed ships no PINs — a household starts open — so a "wrong PIN" test against a seeded
    /// profile would otherwise be testing a profile that has nothing to get wrong. Set through the
    /// real endpoint rather than the database, so the hash is the one sign-in will check.
    /// </remarks>
    private static async Task GivePin(HubAppFactory app, int profileId, string pin)
    {
        var client = app.CreateAnonymousClient();
        HubAppFactory.SignIn(client, profileId);
        using var res = await client.PutAsJsonAsync($"/api/profiles/{profileId}/pin", new { pin });
        res.EnsureSuccessStatusCode();
    }

    // ---- Marked: the credential was refused ----

    [Fact]
    public async Task A_wrong_PIN_at_sign_in_is_marked_as_a_credential_refusal()
    {
        using var app = new HubAppFactory();
        await GivePin(app, 2, "1234");

        using var res = await app.CreateAnonymousClient().PostAsJsonAsync(
            "/api/session", new { profileId = 2, pin = "0000", remember = true });

        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        Assert.True(IsMarked(res), "A wrong PIN says nothing about the session that carried it.");
    }

    [Fact]
    public async Task An_unknown_profile_at_sign_in_is_marked_too()
    {
        using var app = new HubAppFactory();
        var client = app.CreateAnonymousClient();

        using var res = await client.PostAsJsonAsync(
            "/api/session", new { profileId = 9999, pin = "1234", remember = true });

        // Deliberately the same answer as a wrong PIN, so it must carry the same mark — otherwise the
        // panel would lock on a mistyped profile id and the enumeration defence would leak through the
        // header instead of the body.
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        Assert.True(IsMarked(res));
    }

    [Fact]
    public async Task A_wrong_current_PIN_when_changing_one_is_marked()
    {
        using var app = new HubAppFactory();
        await GivePin(app, 2, "1234");
        var client = app.CreateAnonymousClient();
        HubAppFactory.SignIn(client, 2, "1234");

        using var res = await client.PutAsJsonAsync(
            "/api/profiles/2/pin", new { pin = "5678", currentPin = "0000" });

        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        Assert.True(IsMarked(res), "Re-entering the wrong PIN is not a lost session.");
    }

    // ---- Unmarked: the session was refused ----

    /*
     * The finding. This request is refused because there is no session, not because the digits were
     * wrong, and the panel must lock. Under the path-based guess it was excused and nothing noticed.
     */
    [Fact]
    public async Task A_PIN_route_reached_without_a_session_is_not_marked()
    {
        using var app = new HubAppFactory();

        using var res = await app.CreateAnonymousClient().PutAsJsonAsync(
            "/api/profiles/2/pin", new { pin = "5678", currentPin = "1234" });

        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        Assert.False(IsMarked(res), "No session is a lost session, whatever route discovered it.");
    }

    [Fact]
    public async Task Clearing_a_PIN_without_a_session_is_not_marked_either()
    {
        using var app = new HubAppFactory();

        using var res = await app.CreateAnonymousClient().SendAsync(new HttpRequestMessage(
            HttpMethod.Delete, "/api/profiles/2/pin")
        {
            Content = JsonContent.Create(new { currentPin = "1234" }),
        });

        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        Assert.False(IsMarked(res));
    }

    [Theory]
    [InlineData("/api/tasks")]
    [InlineData("/api/settings")]
    [InlineData("/api/profiles/detail")]
    public async Task An_ordinary_authenticated_read_without_a_session_is_not_marked(string path)
    {
        using var app = new HubAppFactory();

        using var res = await app.CreateAnonymousClient().GetAsync(path);

        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        Assert.False(IsMarked(res));
    }

    /*
     * The mark is fail-closed by absence: anything the server does not explicitly mark is read by the
     * client as a lost session. This states the invariant the client depends on, so a future endpoint
     * that answers 401 cannot silently opt into being excused.
     */
    [Fact]
    public async Task Nothing_marks_a_401_by_accident()
    {
        using var app = new HubAppFactory();
        var client = app.CreateAnonymousClient();

        foreach (var path in new[] { "/api/tasks", "/api/pantry", "/api/assist/conversations" })
        {
            using var res = await client.GetAsync(path);
            Assert.False(IsMarked(res), $"{path} marked a 401 that is not a credential refusal.");
        }
    }
}
