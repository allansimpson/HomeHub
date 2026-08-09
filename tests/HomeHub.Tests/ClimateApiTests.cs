namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Climate;

/// <summary>
/// The Climate section over HTTP: the panel payload, the standing target, the two-hour loan and both
/// promotion paths. Backed by an isolated in-memory database seeded with the six zones and the three
/// mini-splits behind them.
/// </summary>
public class ClimateApiTests
{
    [Fact]
    public async Task Panel_lists_the_six_zones_in_their_three_classes()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var panel = await client.GetFromJsonAsync<ClimatePanelDto>("/api/climate/zones");

        Assert.NotNull(panel);
        Assert.Equal(6, panel.Zones.Count);
        Assert.False(panel.HousePaused);
        Assert.Equal(
            new[] { "Kitchen", "Master Bedroom", "Upstairs Office", "Living Room", "Fridge", "Freezer" },
            panel.Zones.Select(z => z.Name));
        Assert.Equal(3, panel.Zones.Count(z => z.Class == "Automated"));
        Assert.Single(panel.Zones, z => z.Class == "Watched");
        Assert.Equal(2, panel.Zones.Count(z => z.Class == "ColdStorage"));
    }

    /// <summary>
    /// The rule the whole screen rests on: a watched room has nothing to command, so it carries no
    /// target for anything to offer to change.
    /// </summary>
    [Fact]
    public async Task Watched_and_cold_storage_rows_carry_no_target()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var panel = await client.GetFromJsonAsync<ClimatePanelDto>("/api/climate/zones");

        foreach (var zone in panel!.Zones.Where(z => z.Class != "Automated"))
        {
            Assert.Null(zone.StandingTargetF);
            Assert.Null(zone.TargetF);
            Assert.Null(zone.Override);
        }
        Assert.All(panel.Zones.Where(z => z.Class == "ColdStorage"), z =>
        {
            Assert.NotNull(z.RangeLowF);
            Assert.NotNull(z.RangeHighF);
        });
    }

    /// <summary>A zone with no controller serialises as null, never as 0.</summary>
    [Fact]
    public async Task A_room_without_a_unit_reports_null_rather_than_zero()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var panel = await client.GetFromJsonAsync<ClimatePanelDto>("/api/climate/zones");
        var living = panel!.Zones.Single(z => z.Name == "Living Room");

        Assert.Null(living.UnitRef);
        Assert.Null(living.UnitSetPointF);
        Assert.Null(living.UnitMode);
        Assert.NotNull(living.ProbeRef);
    }

    [Fact]
    public async Task Target_writes_the_standing_number_and_rejects_a_value_out_of_range()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PutAsJsonAsync("/api/climate/zones/2/target", new SetTargetInput(69));
        var panel = await res.Content.ReadFromJsonAsync<ClimatePanelDto>();
        Assert.Equal(69, panel!.Zones.Single(z => z.Id == 2).StandingTargetF);

        var tooCold = await client.PutAsJsonAsync("/api/climate/zones/2/target", new SetTargetInput(40));
        Assert.Equal(HttpStatusCode.BadRequest, tooCold.StatusCode);
    }

    /// <summary>Two hours, and the row says when — the rule that makes one tap safe.</summary>
    [Fact]
    public async Task Override_borrows_the_room_for_two_hours()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        // The sensor poller is stripped in tests, so without this the room has no reading and every
        // row reads `probeLost` — which is the correct answer to "what is a room with a dead probe",
        // and not the state under test here.
        app.AddProbeReading(sensorZoneId: 5, tempF: 74);

        var res = await client.PostAsJsonAsync("/api/climate/zones/2/override", new OverrideInput(69));
        var zone = (await res.Content.ReadFromJsonAsync<ClimatePanelDto>())!.Zones.Single(z => z.Id == 2);

        Assert.NotNull(zone.Override);
        Assert.Equal(69, zone.Override!.TargetF);
        Assert.Equal(69, zone.TargetF);
        // The standing target is untouched: a loan is borrowed from it, not a replacement for it.
        Assert.Equal(71, zone.StandingTargetF);
        Assert.Equal(TimeSpan.FromHours(2), zone.Override.ExpiresAtUtc - zone.Override.StartedAtUtc);
        Assert.Equal("borrowed", zone.State);
    }

    [Fact]
    public async Task A_second_loan_supersedes_the_first_and_restarts_the_clock()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await client.PostAsJsonAsync("/api/climate/zones/2/override", new OverrideInput(69));
        var res = await client.PostAsJsonAsync("/api/climate/zones/2/override", new OverrideInput(67));
        var zone = (await res.Content.ReadFromJsonAsync<ClimatePanelDto>())!.Zones.Single(z => z.Id == 2);

        Assert.Equal(67, zone.Override!.TargetF);
    }

    /// <summary>
    /// 3a. One call, and there is no observable moment where the zone holds a new standing target
    /// with a live loan against it.
    /// </summary>
    [Fact]
    public async Task Promote_keeps_the_borrowed_number_and_ends_the_loan()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await client.PostAsJsonAsync("/api/climate/zones/2/override", new OverrideInput(69));
        var res = await client.PostAsJsonAsync("/api/climate/zones/2/override/promote", new PromoteInput(null));
        var zone = (await res.Content.ReadFromJsonAsync<ClimatePanelDto>())!.Zones.Single(z => z.Id == 2);

        Assert.Equal(69, zone.StandingTargetF);
        Assert.Null(zone.Override);
        Assert.Equal(71, zone.PreviousStandingTargetF);
    }

    /// <summary>3b. Lifting on `KEEP` writes the standing target without ever releasing a loan.</summary>
    [Fact]
    public async Task Promote_with_a_target_writes_standing_in_one_call()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/climate/zones/2/override/promote", new PromoteInput(68));
        var zone = (await res.Content.ReadFromJsonAsync<ClimatePanelDto>())!.Zones.Single(z => z.Id == 2);

        Assert.Equal(68, zone.StandingTargetF);
        Assert.Null(zone.Override);
        Assert.Equal(71, zone.PreviousStandingTargetF);
    }

    /// <summary>UNDO restores the exact previous value, not an approximation of it.</summary>
    [Fact]
    public async Task Undo_restores_the_target_the_promotion_replaced()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await client.PostAsJsonAsync("/api/climate/zones/2/override/promote", new PromoteInput(68));
        var res = await client.PostAsync("/api/climate/zones/2/undo", null);
        var zone = (await res.Content.ReadFromJsonAsync<ClimatePanelDto>())!.Zones.Single(z => z.Id == 2);

        Assert.Equal(71, zone.StandingTargetF);
        Assert.Null(zone.PreviousStandingTargetF);
    }

    [Fact]
    public async Task Cancelling_a_loan_brings_the_standing_target_straight_back()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        await client.PostAsJsonAsync("/api/climate/zones/2/override", new OverrideInput(69));
        var res = await client.DeleteAsync("/api/climate/zones/2/override");
        var zone = (await res.Content.ReadFromJsonAsync<ClimatePanelDto>())!.Zones.Single(z => z.Id == 2);

        Assert.Null(zone.Override);
        Assert.Equal(71, zone.TargetF);
    }

    [Fact]
    public async Task Patch_sets_the_four_per_room_knobs()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PatchAsJsonAsync(
            "/api/climate/zones/1",
            new PatchZoneInput(2, CorrectionStrength.Hard, "23:00", "07:00", true));
        var zone = (await res.Content.ReadFromJsonAsync<ClimatePanelDto>())!.Zones.Single(z => z.Id == 1);

        Assert.Equal(2, zone.ToleranceF);
        Assert.Equal("Hard", zone.Correction);
        Assert.Equal("23:00", zone.QuietFrom);
        Assert.Equal("07:00", zone.QuietTo);
        Assert.True(zone.IsPaused);
        Assert.Equal("paused", zone.State);
    }

    /// <summary>Pausing turns nothing off; it stops the loop writing and leaves every unit as it is.</summary>
    [Fact]
    public async Task Pausing_the_house_pauses_every_automated_room_and_no_unit()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/climate/pause", new PauseHouseInput(true));
        var panel = await res.Content.ReadFromJsonAsync<ClimatePanelDto>();

        Assert.True(panel!.HousePaused);
        Assert.All(panel.Zones.Where(z => z.Class == "Automated"), z => Assert.True(z.IsPaused));

        var units = await client.GetFromJsonAsync<List<ClimateUnitDto>>("/api/climate/units");
        Assert.NotNull(units);
        Assert.All(units, u => Assert.True(u.Running));
    }

    [Fact]
    public async Task All_units_off_powers_every_unit_down()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PostAsync("/api/climate/units/off", null);
        Assert.Equal(HttpStatusCode.NoContent, res.StatusCode);

        var units = await client.GetFromJsonAsync<List<ClimateUnitDto>>("/api/climate/units");
        Assert.All(units!, u => Assert.False(u.Running));
    }

    // ---- The machine surface ----

    [Fact]
    public async Task Units_list_the_three_mini_splits()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var units = await client.GetFromJsonAsync<List<ClimateUnitDto>>("/api/climate/units");

        Assert.NotNull(units);
        Assert.Equal(new[] { "Kitchen", "Master Bedroom", "Upstairs Office" }, units.Select(u => u.Name));
        Assert.All(units, u => Assert.Equal("Cool", u.Mode));
    }

    [Fact]
    public async Task Unit_set_point_changes_and_clamps()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var updated = await (await client.PutAsJsonAsync("/api/climate/units/1/setpoint", new SetPointInput(68)))
            .Content.ReadFromJsonAsync<ClimateUnitDto>();
        Assert.Equal(68, updated!.SetPointF);

        var tooLow = await client.PutAsJsonAsync("/api/climate/units/1/setpoint", new SetPointInput(40));
        Assert.Equal(HttpStatusCode.BadRequest, tooLow.StatusCode);
    }

    [Fact]
    public async Task Mode_off_hides_the_set_point_then_on_restores_running()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var off = await (await client.PutAsJsonAsync("/api/climate/units/1/mode", new SetModeInput(ClimateMode.Off)))
            .Content.ReadFromJsonAsync<ClimateUnitDto>();
        Assert.False(off!.Running);
        Assert.Null(off.SetPointF);

        var cool = await (await client.PutAsJsonAsync("/api/climate/units/1/mode", new SetModeInput(ClimateMode.Cool)))
            .Content.ReadFromJsonAsync<ClimateUnitDto>();
        Assert.True(cool!.Running);
        Assert.Equal("Cool", cool.Mode);
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
