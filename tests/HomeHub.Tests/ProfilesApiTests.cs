namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
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
    public async Task Set_pin_then_verify_correct_and_wrong()
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

        var good = await client.PostAsJsonAsync("/api/profiles/1/verify-pin", new VerifyPinRequest("1234"));
        var goodResult = await good.Content.ReadFromJsonAsync<VerifyPinResult>();
        Assert.True(goodResult!.Success);

        var bad = await client.PostAsJsonAsync("/api/profiles/1/verify-pin", new VerifyPinRequest("0000"));
        var badResult = await bad.Content.ReadFromJsonAsync<VerifyPinResult>();
        Assert.False(badResult!.Success);
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
        var client = app.CreateSeededClient();
        await client.PutAsJsonAsync("/api/profiles/2/pin", new SetPinRequest("4321"));

        VerifyPinResult? last = null;
        for (var i = 0; i < 5; i++)
        {
            var res = await client.PostAsJsonAsync("/api/profiles/2/verify-pin", new VerifyPinRequest("0000"));
            last = await res.Content.ReadFromJsonAsync<VerifyPinResult>();
        }

        // The 5th failure trips the lockout cooldown.
        Assert.False(last!.Success);
        Assert.NotNull(last.LockedForSeconds);
        Assert.True(last.LockedForSeconds > 0);
    }

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
