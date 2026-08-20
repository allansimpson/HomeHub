namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;

/// <summary>
/// Boots the real app in-memory (no SQL connection string configured, so the app starts
/// without a database — proving the shell serves even when the DB is unreachable) and
/// verifies the health endpoint responds ok.
/// </summary>
public class HealthEndpointTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory;

    public HealthEndpointTests(WebApplicationFactory<Program> factory) => _factory = factory;

    [Fact]
    public async Task Health_returns_ok()
    {
        var client = _factory.CreateClient();

        var response = await client.GetAsync("/api/health");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("ok", body.GetProperty("status").GetString());
        Assert.Equal("HomeHub.Api", body.GetProperty("service").GetString());
    }

    [Fact]
    public async Task Deep_health_fails_readiness_without_a_verified_database()
    {
        var client = _factory.CreateClient();

        var response = await client.GetAsync("/api/health?deep=true");

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
    }
    /*
     * Which build is this?
     *
     * `version` has been the SDK's default 1.0.0.0 on every build this project has ever produced, so
     * it answers that question with a constant. Establishing the age of a running API therefore
     * meant inferring it from how many migrations it thought were pending — which is how a TEST box
     * ran the new panel in front of the old server for a day with every health check saying "ok".
     *
     * These assert the fields exist and carry something, not what they contain: the commit is
     * whatever the checkout is on, and a build made where git will not answer legitimately falls
     * back to the timestamp alone.
     */
    [Fact]
    public async Task Health_says_which_build_it_is()
    {
        using var app = new HubAppFactory();
        var client = app.CreateAnonymousClient();

        var body = await client.GetFromJsonAsync<JsonElement>("/api/health");

        var build = body.GetProperty("build").GetString();
        Assert.False(string.IsNullOrWhiteSpace(build));
        // "unstamped" is what a build with neither a commit nor a timestamp reports. The timestamp is
        // written unconditionally, so seeing this means the csproj target did not run at all.
        Assert.NotEqual("unstamped", build);
    }

    /// <summary>
    /// The newest migration compiled into the binary — the field that tells an old API from a
    /// fully-migrated new one, which a pending count of zero cannot.
    /// </summary>
    [Fact]
    public async Task Health_names_the_migration_it_was_built_with()
    {
        using var app = new HubAppFactory();
        var client = app.CreateAnonymousClient();

        var body = await client.GetFromJsonAsync<JsonElement>("/api/health");

        var head = body.GetProperty("migrationHead").GetString();
        Assert.False(string.IsNullOrWhiteSpace(head));
        // Migration ids are timestamp-ordered, so the newest sorts last. Asserting it is *a* known
        // migration rather than a specific one keeps this from needing an edit per migration.
        Assert.Matches(@"^\d{14}_", head!);
    }
}
