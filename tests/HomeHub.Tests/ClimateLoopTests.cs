namespace HomeHub.Tests;

using HomeHub.Api.Climate;
using HomeHub.Api.Data;
using HomeHub.Api.Sensors;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;

/// <summary>
/// The control loop, against a stubbed unit seam and a pinned clock.
/// </summary>
/// <remarks>
/// These are the behaviours that cannot be checked by looking at the screen: what the loop does when
/// a probe stops reporting, what it does at eleven at night, and — the one with real consequences for
/// hardware — how often it is willing to write at all. Every case here degrades to *the unit's own
/// thermostat* rather than to nothing, which is the promise the whole section rests on.
/// </remarks>
public class ClimateLoopTests
{
    private static readonly DateTime Noon = new(2026, 7, 20, 12, 0, 0, DateTimeKind.Utc);

    /// <summary>
    /// With Home Assistant live, the seeded stand-in units go and the rooms rebind by name — so a
    /// zone never spends its life writing set points at a unit that does not exist.
    /// </summary>
    [Fact]
    public async Task A_real_provider_replaces_the_seeded_units_and_the_room_rebinds()
    {
        using var world = new LoopWorld();
        await world.SeedAsync(probeF: 74, setPointF: 72, targetF: 72, unitSource: "simulated");
        world.Db.ClimateUnits.Add(new ClimateUnit
        {
            Id = 9, Name = "Master Bedroom", Source = "homeassistant",
            ProviderRef = "climate.master_bedroom", SetPointF = 70, Mode = ClimateMode.Cool,
        });
        await world.Db.SaveChangesAsync();
        world.Units.SourceName = "homeassistant";

        await world.TickAsync(Noon);

        var zone = await world.Db.ClimateZones.SingleAsync();
        Assert.Equal(9, zone.ClimateUnitId);
        Assert.DoesNotContain(world.Db.ClimateUnits, u => u.Source == "simulated");
    }

    [Fact]
    public async Task Corrects_toward_the_target_by_the_correction_step()
    {
        using var world = new LoopWorld();
        await world.SeedAsync(probeF: 76, setPointF: 72, targetF: 72);

        await world.TickAsync(Noon);

        var write = await world.LastWriteAsync();
        Assert.Equal(LoopWriteReason.Correct, write.Reason);
        Assert.Equal(LoopWriteOutcome.Written, write.Outcome);
        // Steady is 2°, and the room is warm, so the *set point* comes down to make the unit work
        // harder — the opposite direction to the one a person would push a target.
        Assert.Equal(70, write.SetPointTo);
    }

    [Fact]
    public async Task Inside_tolerance_it_settles_and_writes_nothing()
    {
        using var world = new LoopWorld();
        await world.SeedAsync(probeF: 72.5, setPointF: 72, targetF: 72);

        await world.TickAsync(Noon);

        var write = await world.LastWriteAsync();
        Assert.Equal(LoopWriteReason.Settle, write.Reason);
        Assert.Equal(LoopWriteOutcome.Skipped, write.Outcome);
        Assert.Empty(world.Units.Writes);
    }

    /// <summary>
    /// Compressor protection, and the acceptance criterion it comes from: no zone is written more
    /// often than its interval, ever.
    /// </summary>
    [Fact]
    public async Task Never_writes_more_often_than_the_minimum_interval()
    {
        using var world = new LoopWorld();
        await world.SeedAsync(probeF: 80, setPointF: 72, targetF: 70);

        // A simulated hour, ticking every minute, with the room stubbornly ten degrees over and the
        // probe reporting throughout — a probe that fell silent partway would hand the room back and
        // stop the loop, which is a different behaviour and has its own test.
        for (var minute = 0; minute < 60; minute++)
        {
            world.AddReading(80, Noon.AddMinutes(minute));
            await world.TickAsync(Noon.AddMinutes(minute));
        }

        var written = await world.Db.LoopWrites
            .Where(w => w.Outcome == LoopWriteOutcome.Written)
            .OrderBy(w => w.AtUtc)
            .ToListAsync();
        Assert.NotEmpty(written);
        for (var i = 1; i < written.Count; i++)
            Assert.True(written[i].AtUtc - written[i - 1].AtUtc >= TimeSpan.FromMinutes(10));
    }

    /// <summary>
    /// The probe is the truth, so losing it is not a reason to keep steering from the last thing it
    /// said. The room goes back to the unit's own sensor, holding the target by its own measurement.
    /// </summary>
    [Fact]
    public async Task A_silent_probe_hands_the_room_back_to_its_unit()
    {
        using var world = new LoopWorld();
        await world.SeedAsync(probeF: 76, setPointF: 68, targetF: 72, readingAgeMinutes: 20);

        await world.TickAsync(Noon);

        var write = await world.LastWriteAsync();
        Assert.Equal(LoopWriteReason.ProbeLost, write.Reason);
        Assert.Equal(72, write.SetPointTo); // the target, written *as* the set point
        var zone = await world.Db.ClimateZones.SingleAsync();
        Assert.NotNull(zone.HandedBackAtUtc);
    }

    [Fact]
    public async Task A_recovered_probe_resumes_on_the_next_reading()
    {
        using var world = new LoopWorld();
        await world.SeedAsync(probeF: 76, setPointF: 68, targetF: 72, readingAgeMinutes: 20);
        await world.TickAsync(Noon);

        world.AddReading(76, Noon.AddMinutes(1));
        await world.TickAsync(Noon.AddMinutes(1));

        var zone = await world.Db.ClimateZones.SingleAsync();
        Assert.Null(zone.HandedBackAtUtc);
        Assert.Contains(world.Db.LoopWrites, w => w.Reason == LoopWriteReason.Resume);
    }

    /// <summary>Quiet hours suppress the machine's chatter — the room still reads, it just isn't written.</summary>
    [Fact]
    public async Task Inside_quiet_hours_the_loop_reads_and_does_not_write()
    {
        using var world = new LoopWorld();
        var elevenPm = new DateTime(2026, 7, 20, 23, 0, 0, DateTimeKind.Utc);
        await world.SeedAsync(probeF: 78, setPointF: 72, targetF: 72, atUtc: elevenPm);

        await world.TickAsync(elevenPm);

        Assert.Empty(world.Units.Writes);
        Assert.Equal(LoopWriteReason.QuietStart, (await world.LastWriteAsync()).Reason);
    }

    /// <summary>…but never the household's. A person acting during quiet hours writes.</summary>
    [Fact]
    public async Task A_person_acting_during_quiet_hours_writes_immediately()
    {
        using var world = new LoopWorld();
        var elevenPm = new DateTime(2026, 7, 20, 23, 0, 0, DateTimeKind.Utc);
        await world.SeedAsync(probeF: 78, setPointF: 72, targetF: 72, atUtc: elevenPm);
        await world.TickAsync(elevenPm);
        Assert.Empty(world.Units.Writes);

        await world.ApplyAsync(elevenPm.AddMinutes(1));

        Assert.Single(world.Units.Writes);
    }

    [Fact]
    public async Task A_paused_room_is_left_exactly_as_it_stands()
    {
        using var world = new LoopWorld();
        await world.SeedAsync(probeF: 80, setPointF: 72, targetF: 70, paused: true);

        await world.TickAsync(Noon);

        Assert.Empty(world.Units.Writes);
        Assert.Empty(world.Db.LoopWrites);
    }

    /// <summary>
    /// The probe is fine — it is the unit that is missing — so the reading keeps updating and only
    /// the write is marked. Thirty minutes of this is what marks the room degraded.
    /// </summary>
    [Fact]
    public async Task An_unreachable_unit_is_recorded_and_retried()
    {
        using var world = new LoopWorld();
        await world.SeedAsync(probeF: 78, setPointF: 72, targetF: 72);
        world.Units.Fail = true;

        await world.TickAsync(Noon);

        var write = await world.LastWriteAsync();
        Assert.Equal(LoopWriteOutcome.Unreachable, write.Outcome);
        Assert.NotNull(write.Error);
        var zone = await world.Db.ClimateZones.SingleAsync();
        Assert.Equal(Noon, zone.UnreachableSinceUtc);
    }

    // -----------------------------------------------------------------------

    /// <summary>One room, one probe, one stubbed unit, and a clock that goes where it is told.</summary>
    private sealed class LoopWorld : IDisposable
    {
        public HomeHubDbContext Db { get; }
        public StubUnits Units { get; } = new();

        public LoopWorld()
        {
            Db = TestDb.New("climate-loop");
        }

        public async Task SeedAsync(
            double probeF, double setPointF, double targetF,
            int readingAgeMinutes = 1, bool paused = false, DateTime? atUtc = null, string unitSource = "test")
        {
            var now = atUtc ?? Noon;
            Db.Settings.Add(new Api.Settings.HouseholdSettings { Id = 1 });
            Db.SensorZones.Add(new SensorZone { Id = 1, Name = "Master Bedroom", Source = "test", ProviderRef = "p1" });
            var unit = new ClimateUnit
            {
                Id = 1, Name = "Master Bedroom", Source = unitSource, ProviderRef = "u1",
                SetPointF = setPointF, Mode = ClimateMode.Cool,
            };
            Db.ClimateUnits.Add(unit);
            Db.ClimateZones.Add(new ClimateZone
            {
                Id = 1, Name = "Master Bedroom", Class = ZoneClass.Automated,
                SensorZoneId = 1, ClimateUnitId = 1, StandingTargetF = targetF,
                IsPaused = paused, PausedAtUtc = paused ? now : null,
            });
            Db.SensorReadings.Add(new SensorReading
            {
                ZoneId = 1, TimestampUtc = now.AddMinutes(-readingAgeMinutes), TempF = probeF, Humidity = 45,
            });
            await Db.SaveChangesAsync();
            Units.Db = Db;
        }

        public void AddReading(double tempF, DateTime atUtc)
        {
            Db.SensorReadings.Add(new SensorReading { ZoneId = 1, TimestampUtc = atUtc, TempF = tempF, Humidity = 45 });
            Db.SaveChanges();
        }

        public Task TickAsync(DateTime nowUtc) => Loop(nowUtc).TickAsync();

        public Task ApplyAsync(DateTime nowUtc) => Loop(nowUtc).ApplyAsync(1);

        public async Task<LoopWrite> LastWriteAsync() =>
            await Db.LoopWrites.OrderByDescending(w => w.AtUtc).ThenByDescending(w => w.Id).FirstAsync();

        private ClimateLoop Loop(DateTime nowUtc) =>
            new(Db, Units, new PinnedClock(nowUtc), NullLogger<ClimateLoop>.Instance,
                new ClimateBinder(Db, NullLogger<ClimateBinder>.Instance));

        public void Dispose() => Db.Dispose();
    }

    /// <summary>A unit seam that records what it was told, and can be made to fail on demand.</summary>
    private sealed class StubUnits : IClimateProvider
    {
        public HomeHubDbContext? Db { get; set; }
        public List<double> Writes { get; } = [];
        public bool Fail { get; set; }
        public string SourceName { get; set; } = "test";

        public string Source => SourceName;

        public async Task<IReadOnlyList<ClimateUnit>> GetUnitsAsync(CancellationToken ct) =>
            Db is null ? [] : await Db.ClimateUnits.ToListAsync(ct);

        public async Task<ClimateUnit?> SetSetPointAsync(int id, double setPointF, CancellationToken ct)
        {
            if (Fail) throw new HttpRequestException("Home Assistant did not answer.");
            Writes.Add(setPointF);
            var unit = Db is null ? null : await Db.ClimateUnits.FindAsync([id], ct);
            if (unit is not null) unit.SetPointF = setPointF;
            return unit;
        }

        public Task<ClimateUnit?> SetModeAsync(int id, ClimateMode mode, CancellationToken ct) =>
            Task.FromResult<ClimateUnit?>(null);

        public Task ApplySceneAsync(string scene, CancellationToken ct) => Task.CompletedTask;
    }

    /// <summary>
    /// A fixed clock, pinned to UTC so a test can say "eleven at night" and mean it on any machine —
    /// quiet hours are a wall-clock rule, and a CI box in another zone would otherwise decide.
    /// </summary>
    private sealed class PinnedClock(DateTime nowUtc) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => new(nowUtc, TimeSpan.Zero);
        public override TimeZoneInfo LocalTimeZone => TimeZoneInfo.Utc;
    }
}
