namespace HomeHub.Api.Data;

using HomeHub.Api.Profiles;
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
                FreezerWarnAboveCelsius = 10,
                HumidityWarnAbovePercent = 65,
                ActiveProfileId = null,
            });
        });
    }
}
