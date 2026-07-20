namespace HomeHub.Tests;

using System.Net.Http.Json;
using HomeHub.Api.Settings;

/// <summary>Stage 1 household settings: defaults, updates, and the active-profile switch.</summary>
public class SettingsApiTests
{
    [Fact]
    public async Task Returns_seeded_defaults()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var settings = await client.GetFromJsonAsync<SettingsDto>("/api/settings");

        Assert.NotNull(settings);
        Assert.Equal(5, settings!.IdleTimeoutMinutes);
        Assert.True(settings.IdleDimmingEnabled);
        Assert.Equal("auto", settings.DaylightBoost);
        Assert.Null(settings.ActiveProfileId);
    }

    [Fact]
    public async Task Updates_timeout_dimming_and_daylight()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var updated = await (await client.PutAsJsonAsync(
            "/api/settings",
            new UpdateSettingsRequest(10, false, "on")))
            .Content.ReadFromJsonAsync<SettingsDto>();

        Assert.Equal(10, updated!.IdleTimeoutMinutes);
        Assert.False(updated.IdleDimmingEnabled);
        Assert.Equal("on", updated.DaylightBoost);

        // Invalid daylight value falls back to "auto".
        var coerced = await (await client.PutAsJsonAsync(
            "/api/settings",
            new UpdateSettingsRequest(10, false, "nonsense")))
            .Content.ReadFromJsonAsync<SettingsDto>();
        Assert.Equal("auto", coerced!.DaylightBoost);

        // Persisted across requests.
        var reloaded = await client.GetFromJsonAsync<SettingsDto>("/api/settings");
        Assert.Equal(10, reloaded!.IdleTimeoutMinutes);
        Assert.False(reloaded.IdleDimmingEnabled);
    }

    [Fact]
    public async Task Sets_and_clears_the_active_profile()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var set = await (await client.PutAsJsonAsync(
            "/api/settings/active-profile",
            new SetActiveProfileRequest(2)))
            .Content.ReadFromJsonAsync<SettingsDto>();
        Assert.Equal(2, set!.ActiveProfileId);

        // A non-existent profile id is ignored (cleared), not an error — the panel may race a delete.
        var stale = await (await client.PutAsJsonAsync(
            "/api/settings/active-profile",
            new SetActiveProfileRequest(999)))
            .Content.ReadFromJsonAsync<SettingsDto>();
        Assert.Null(stale!.ActiveProfileId);
    }
}
