namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Climate;

/// <summary>
/// Stage 6 climate over HTTP against the simulated provider (default when Home Assistant isn't
/// configured), backed by an isolated in-memory database seeded with five mini-split zones.
/// </summary>
public class ClimateApiTests
{
    [Fact]
    public async Task Zones_lists_seeded_mini_splits()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var zones = await client.GetFromJsonAsync<List<ClimateZoneDto>>("/api/climate/zones");

        Assert.Equal(5, zones!.Count);
        Assert.Equal(new[] { "Living Room", "Bedroom", "Kitchen", "Study", "Loft" }, zones.Select(z => z.Name));
        var living = zones[0];
        Assert.Equal("Cool", living.Mode);
        Assert.True(living.Running);
        Assert.Equal(72, living.SetPointF);
        Assert.False(zones.Single(z => z.Name == "Study").Running); // seeded Off
        Assert.Null(zones.Single(z => z.Name == "Study").SetPointF);
    }

    [Fact]
    public async Task Set_point_changes_and_clamps()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var updated = await (await client.PutAsJsonAsync("/api/climate/zones/1/setpoint", new SetPointInput(68)))
            .Content.ReadFromJsonAsync<ClimateZoneDto>();
        Assert.Equal(68, updated!.SetPointF);

        var tooLow = await client.PutAsJsonAsync("/api/climate/zones/1/setpoint", new SetPointInput(40));
        Assert.Equal(HttpStatusCode.BadRequest, tooLow.StatusCode);
    }

    [Fact]
    public async Task Mode_off_hides_set_point_then_on_restores_running()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var off = await (await client.PutAsJsonAsync("/api/climate/zones/1/mode", new SetModeInput(ClimateMode.Off)))
            .Content.ReadFromJsonAsync<ClimateZoneDto>();
        Assert.False(off!.Running);
        Assert.Null(off.SetPointF);

        var cool = await (await client.PutAsJsonAsync("/api/climate/zones/1/mode", new SetModeInput(ClimateMode.Cool)))
            .Content.ReadFromJsonAsync<ClimateZoneDto>();
        Assert.True(cool!.Running);
        Assert.Equal("Cool", cool.Mode);
    }

    [Fact]
    public async Task All_off_scene_powers_every_zone_down()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/climate/scene", new SceneInput("all-off"));
        Assert.Equal(HttpStatusCode.NoContent, res.StatusCode);

        var zones = await client.GetFromJsonAsync<List<ClimateZoneDto>>("/api/climate/zones");
        Assert.All(zones!, z => Assert.False(z.Running));
    }

    [Fact]
    public async Task Evening_scene_cools_every_zone_to_seventy()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await client.PostAsJsonAsync("/api/climate/scene", new SceneInput("evening"));

        var zones = await client.GetFromJsonAsync<List<ClimateZoneDto>>("/api/climate/zones");
        Assert.All(zones!, z =>
        {
            Assert.Equal("Cool", z.Mode);
            Assert.Equal(70, z.SetPointF);
        });
    }

    [Fact]
    public async Task Unknown_scene_is_rejected()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/climate/scene", new SceneInput("party-mode"));

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }
}
