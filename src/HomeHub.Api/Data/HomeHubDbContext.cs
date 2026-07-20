namespace HomeHub.Api.Data;

using HomeHub.Api.Alerts;
using HomeHub.Api.Profiles;
using HomeHub.Api.Sensors;
using HomeHub.Api.Settings;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// The application's own database context. Entities are added by their owning stage. This
/// context owns and migrates the <c>HomeHub</c> database only; it must never touch anything
/// else on the shared SQL Server instance.
/// </summary>
public class HomeHubDbContext : DbContext
{
    public HomeHubDbContext(DbContextOptions<HomeHubDbContext> options) : base(options)
    {
    }

    /// <summary>Household members (Stage 1). PIN is opt-in per profile.</summary>
    public DbSet<Profile> Profiles => Set<Profile>();

    /// <summary>Single household-level settings row (Stage 1); extended by later stages.</summary>
    public DbSet<HouseholdSettings> Settings => Set<HouseholdSettings>();

    /// <summary>Tracked rooms/appliances (Stage 2).</summary>
    public DbSet<SensorZone> SensorZones => Set<SensorZone>();

    /// <summary>Owned reading history, written by the poller (Stage 2).</summary>
    public DbSet<SensorReading> SensorReadings => Set<SensorReading>();

    /// <summary>Configurable alert rules evaluated by the alert engine (Stage 2).</summary>
    public DbSet<AlertThreshold> AlertThresholds => Set<AlertThreshold>();

    /// <summary>Raised alerts, type-agnostic and reused by later stages (Stage 2).</summary>
    public DbSet<ActiveAlert> ActiveAlerts => Set<ActiveAlert>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);

        // ---- Stage 1: Profiles ----
        modelBuilder.Entity<Profile>(entity =>
        {
            entity.Property(p => p.Name).HasMaxLength(40).IsRequired();
            entity.Property(p => p.Initial).HasMaxLength(2).IsRequired();
            entity.Property(p => p.PinHash).HasMaxLength(256);
            entity.HasIndex(p => p.DisplayOrder);

            // Seed a household of Viking ancestry. All PIN-opt-in off / stay-signed-in on by
            // default (no seeded PIN hashes — PINs are set from Settings at runtime). Rename
            // or replace these via the profile CRUD flow.
            entity.HasData(
                new Profile { Id = 1, Name = "Astrid", Initial = "A", RequirePinWhenIdle = false, StayLoggedIn = true, DisplayOrder = 0 },
                new Profile { Id = 2, Name = "Ragnar", Initial = "R", RequirePinWhenIdle = false, StayLoggedIn = true, DisplayOrder = 1 },
                new Profile { Id = 3, Name = "Leif", Initial = "L", RequirePinWhenIdle = false, StayLoggedIn = true, DisplayOrder = 2 });
        });

        // ---- Stage 1: Household settings (singleton row, id 1) ----
        modelBuilder.Entity<HouseholdSettings>(entity =>
        {
            entity.HasData(new HouseholdSettings
            {
                Id = 1,
                IdleTimeoutMinutes = 5,
                IdleDimmingEnabled = true,
                ActiveProfileId = null,
            });
        });

        // ---- Stage 2: Sensor zones + readings ----
        modelBuilder.Entity<SensorZone>(entity =>
        {
            entity.Property(z => z.Name).HasMaxLength(60).IsRequired();
            entity.Property(z => z.Source).HasMaxLength(30).IsRequired();
            entity.Property(z => z.ProviderRef).HasMaxLength(120).IsRequired();
            entity.HasIndex(z => new { z.Source, z.ProviderRef }).IsUnique();
            entity.HasIndex(z => z.DisplayOrder);

            // Seed the confirmed household zones. Provider refs match SimulatedSensorProvider so
            // seeded zones receive readings out of the box; swap Source/ProviderRef when real
            // SensorPush sensors are mapped.
            entity.HasData(
                new SensorZone { Id = 1, Name = "Freezer", Source = "simulated", ProviderRef = "sim-freezer", Category = SensorCategory.FoodSafety, DisplayOrder = 0 },
                new SensorZone { Id = 2, Name = "Fridge", Source = "simulated", ProviderRef = "sim-fridge", Category = SensorCategory.FoodSafety, DisplayOrder = 1 },
                new SensorZone { Id = 3, Name = "Living Room", Source = "simulated", ProviderRef = "sim-living", Category = SensorCategory.Ambient, DisplayOrder = 2 },
                new SensorZone { Id = 4, Name = "Kitchen", Source = "simulated", ProviderRef = "sim-kitchen", Category = SensorCategory.Ambient, DisplayOrder = 3 },
                new SensorZone { Id = 5, Name = "Bedroom", Source = "simulated", ProviderRef = "sim-bedroom", Category = SensorCategory.Ambient, DisplayOrder = 4 });
        });

        modelBuilder.Entity<SensorReading>(entity =>
        {
            entity.HasOne(r => r.Zone)
                .WithMany(z => z.Readings)
                .HasForeignKey(r => r.ZoneId)
                .OnDelete(DeleteBehavior.Cascade);
            entity.HasIndex(r => new { r.ZoneId, r.TimestampUtc });
        });

        // ---- Stage 2: Alert thresholds + active alerts ----
        modelBuilder.Entity<AlertThreshold>(entity =>
        {
            entity.HasOne(t => t.Zone)
                .WithMany()
                .HasForeignKey(t => t.ZoneId)
                .OnDelete(DeleteBehavior.Cascade);

            // Default rules: food-safety temp ceilings (severe freezer, warning fridge) and
            // ambient humidity ceilings. Sustained 10 min so a brief door-open doesn't nag.
            entity.HasData(
                new AlertThreshold { Id = 1, ZoneId = 1, Metric = AlertMetric.Temperature, Direction = AlertDirection.Above, Value = 10, DurationMinutes = 10, Severity = AlertSeverity.Severe, Enabled = true },
                new AlertThreshold { Id = 2, ZoneId = 2, Metric = AlertMetric.Temperature, Direction = AlertDirection.Above, Value = 40, DurationMinutes = 10, Severity = AlertSeverity.Warning, Enabled = true },
                new AlertThreshold { Id = 3, ZoneId = 3, Metric = AlertMetric.Humidity, Direction = AlertDirection.Above, Value = 65, DurationMinutes = 10, Severity = AlertSeverity.Warning, Enabled = true },
                new AlertThreshold { Id = 4, ZoneId = 4, Metric = AlertMetric.Humidity, Direction = AlertDirection.Above, Value = 65, DurationMinutes = 10, Severity = AlertSeverity.Warning, Enabled = true },
                new AlertThreshold { Id = 5, ZoneId = 5, Metric = AlertMetric.Humidity, Direction = AlertDirection.Above, Value = 65, DurationMinutes = 10, Severity = AlertSeverity.Warning, Enabled = true });
        });

        modelBuilder.Entity<ActiveAlert>(entity =>
        {
            entity.Property(a => a.Type).HasMaxLength(30).IsRequired();
            entity.Property(a => a.DedupeKey).HasMaxLength(80).IsRequired();
            entity.Property(a => a.Message).HasMaxLength(300).IsRequired();
            entity.Property(a => a.Source).HasMaxLength(80).IsRequired();
            entity.HasIndex(a => new { a.Type, a.ClearedAtUtc });
        });
    }
}
