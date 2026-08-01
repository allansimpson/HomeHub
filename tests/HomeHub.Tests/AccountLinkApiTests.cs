namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Controllers;

/// <summary>
/// The account-linking endpoints over HTTP. The interesting surface is <c>start</c>'s
/// <c>returnPath</c>: it steers a redirect the panel issues *after* a successful token exchange, so
/// an unvalidated value would be an open redirect wearing the panel's identity.
/// </summary>
public class AccountLinkApiTests
{
    [Fact]
    public async Task Status_reports_every_provider_for_a_profile()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var status = await client.GetFromJsonAsync<List<LinkStatusDto>>("/api/link/status?profileId=1");

        Assert.Equal(2, status!.Count);
        Assert.Contains(status, s => s.Provider == "google");
        Assert.Contains(status, s => s.Provider == "microsoft");
        // Nothing is linked on a fresh household, and the tests run with no provider credentials.
        Assert.All(status, s => Assert.False(s.Linked));
    }

    [Fact]
    public async Task Status_is_per_profile_not_global()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        // The whole point of the member view: asking about someone who is not the active profile is
        // a legitimate question with its own answer.
        var second = await client.GetFromJsonAsync<List<LinkStatusDto>>("/api/link/status?profileId=2");

        Assert.Equal(2, second!.Count);
        Assert.All(second, s => Assert.False(s.Linked));
    }

    [Theory]
    [InlineData("https://evil.example.com/steal")]      // absolute, different origin
    [InlineData("//evil.example.com/steal")]            // protocol-relative — starts with a slash, still leaves
    [InlineData("/settings//evil.example.com")]         // slips a protocol-relative segment past a naive prefix check
    [InlineData("/dashboard")]                          // same origin but outside settings
    [InlineData("/settings/../../etc")]                 // traversal
    [InlineData("\\\\evil.example.com")]                // backslashes, which some parsers fold to slashes
    public async Task Start_refuses_a_return_path_that_could_leave_the_panel(string returnPath)
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PostAsync(
            $"/api/link/google/start?profileId=1&returnPath={Uri.EscapeDataString(returnPath)}", null);

        // A 400 specifically — not the 501 that an unconfigured provider would give, which would
        // mean the guard never ran and only the missing credentials saved us.
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [Fact]
    public async Task Start_still_rejects_a_missing_profile()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PostAsync("/api/link/google/start?profileId=0", null);

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [Fact]
    public async Task Start_accepts_a_safe_return_path()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PostAsync(
            "/api/link/google/start?profileId=1&returnPath=%2Fsettings%2Fmember%3Fprofile%3D1", null);

        // Deliberately "not 400" rather than a specific success code. What happens past the guard
        // depends on whether the machine running the tests has Google credentials in user-secrets —
        // 200 with a consent URL if so, 501 if not. Asserting either would make this test pass or
        // fail on developer configuration rather than on the thing it is checking, which is only
        // that a legitimate return path is not rejected.
        Assert.NotEqual(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [Fact]
    public async Task Unlinking_a_profile_that_was_never_linked_is_not_an_error()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.DeleteAsync("/api/link/google?profileId=3");

        Assert.Equal(HttpStatusCode.NoContent, res.StatusCode);
    }

    [Fact]
    public async Task Unlinking_an_unknown_provider_is_rejected()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.DeleteAsync("/api/link/facebook?profileId=1");

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }
}
