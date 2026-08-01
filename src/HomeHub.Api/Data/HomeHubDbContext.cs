namespace HomeHub.Api.Data;

using HomeHub.Api.Alerts;
using HomeHub.Api.Calendar;
using HomeHub.Api.Cats;
using HomeHub.Api.Climate;
using HomeHub.Api.Meals;
using HomeHub.Api.Notifications;
using HomeHub.Api.Pantry;
using HomeHub.Api.Profiles;
using HomeHub.Api.Sensors;
using HomeHub.Api.Settings;
using HomeHub.Api.Tasks;
using HomeHub.Api.Weather;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;

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

    /// <summary>Single-row cache of last-known weather for offline reads (Stage 3).</summary>
    public DbSet<WeatherCache> WeatherCache => Set<WeatherCache>();

    /// <summary>Calendar events — local store / Google offline cache (Stage 4).</summary>
    public DbSet<CalendarEvent> CalendarEvents => Set<CalendarEvent>();

    /// <summary>Per-profile tasks — local store / Microsoft To Do offline cache (Stage 5).</summary>
    public DbSet<TaskItem> Tasks => Set<TaskItem>();

    /// <summary>Per-profile Microsoft account links for To Do sync (Stage 5).</summary>
    public DbSet<MicrosoftAccountLink> MicrosoftAccountLinks => Set<MicrosoftAccountLink>();

    /// <summary>Which Microsoft To Do lists each profile has chosen to sync (spec 13 · choose-lists).</summary>
    public DbSet<SyncedList> SyncedLists => Set<SyncedList>();

    /// <summary>Per-profile Google account links for calendar sync.</summary>
    public DbSet<GoogleAccountLink> GoogleAccountLinks => Set<GoogleAccountLink>();

    /// <summary>Which Google calendars each profile has chosen to display.</summary>
    public DbSet<SyncedCalendar> SyncedCalendars => Set<SyncedCalendar>();

    /// <summary>Climate zones — simulated store / Home Assistant offline cache (Stage 6).</summary>
    public DbSet<ClimateZone> ClimateZones => Set<ClimateZone>();

    /// <summary>Litter-Robot auto-recovery attempts — the 24h cap's memory and the flaky-vs-broken audit trail.</summary>
    public DbSet<LitterRobotRecovery> LitterRobotRecoveries => Set<LitterRobotRecovery>();

    /// <summary>The one notification queue behind the live cards, the drawer and the inbox.</summary>
    public DbSet<Notification> Notifications => Set<Notification>();

    /// <summary>Which sources are allowed to notify.</summary>
    public DbSet<NotificationSourceSetting> NotificationSources => Set<NotificationSourceSetting>();

    /// <summary>The household's own recipe folder — owned outright, not a cache (Stage M1).</summary>
    public DbSet<Recipe> Recipes => Set<Recipe>();

    /// <summary>Ingredient lines; raw text authoritative, parsed fields best-effort (Stage M1).</summary>
    public DbSet<RecipeIngredient> RecipeIngredients => Set<RecipeIngredient>();

    /// <summary>Instruction steps, in position order (Stage M1).</summary>
    public DbSet<RecipeStep> RecipeSteps => Set<RecipeStep>();

    /// <summary>Free-text tags driving the recipe folder's filters (Stage M1).</summary>
    public DbSet<RecipeTag> RecipeTags => Set<RecipeTag>();

    /// <summary>The week plan — one entry per recipe on a date + slot (Stage M1, widened in M3).</summary>
    public DbSet<MealPlanEntry> MealPlanEntries => Set<MealPlanEntry>();

    /// <summary>Named templates that expand into an arrangement of recipes (MEALS_GROUPS §3).</summary>
    public DbSet<Meal> Meals => Set<Meal>();

    /// <summary>A recipe's role and place within a saved meal.</summary>
    public DbSet<MealComponent> MealComponents => Set<MealComponent>();

    /// <summary>What the house has — one row per thing the household names, not per package (Stage M5).</summary>
    public DbSet<PantryItem> PantryItems => Set<PantryItem>();

    /// <summary>The pantry ledger. Four screens read nothing else — see <see cref="PantryEvent"/>.</summary>
    public DbSet<PantryEvent> PantryEvents => Set<PantryEvent>();

    /// <summary>Barcodes the panel knows how to name. Ships empty and is grown by `NAME IT`.</summary>
    public DbSet<ProductCatalogueEntry> ProductCatalogue => Set<ProductCatalogueEntry>();

    /// <summary>The recipe-ingredient → pantry-item join that makes the stock check possible.</summary>
    public DbSet<IngredientAlias> IngredientAliases => Set<IngredientAlias>();

    /// <summary>The household's own grocery list. Microsoft To Do is a projection of this.</summary>
    public DbSet<GroceryLine> GroceryLines => Set<GroceryLine>();

    /// <summary>Which nights want a grocery line — several per row after a merge.</summary>
    public DbSet<GroceryLineSourceRef> GroceryLineSources => Set<GroceryLineSourceRef>();

    /// <summary>Single household row (id 1) naming the mirrored To Do list and its token owner.</summary>
    public DbSet<GroceryMirrorSettings> GroceryMirror => Set<GroceryMirrorSettings>();

    /// <summary>Orders that arrived, pending review. Nothing is written until `PUT n AWAY`.</summary>
    public DbSet<OrderImport> OrderImports => Set<OrderImport>();

    public DbSet<OrderImportLine> OrderImportLines => Set<OrderImportLine>();

    /// <summary>Plan entries whose stock check was dismissed with "Leave it, I'll sort it".</summary>
    public DbSet<StockCheckDismissal> StockCheckDismissals => Set<StockCheckDismissal>();

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
            // DedupeKey holds "nws:<full NWS alert URL>" for weather alerts (~140 chars); 80 truncated it.
            entity.Property(a => a.DedupeKey).HasMaxLength(256).IsRequired();
            // NWS event + headline can exceed 300; give it headroom so long alerts aren't clipped.
            entity.Property(a => a.Message).HasMaxLength(500).IsRequired();
            entity.Property(a => a.Source).HasMaxLength(80).IsRequired();
            entity.HasIndex(a => new { a.Type, a.ClearedAtUtc });
        });

        // ---- Stage 3: Weather cache (singleton row, fixed id 1 — not identity) ----
        modelBuilder.Entity<WeatherCache>(entity =>
        {
            entity.Property(w => w.Id).ValueGeneratedNever();
            entity.Property(w => w.PayloadJson).IsRequired();
        });

        // ---- Stage 4: Calendar events ----
        modelBuilder.Entity<CalendarEvent>(entity =>
        {
            entity.Property(e => e.Title).HasMaxLength(200).IsRequired();
            entity.Property(e => e.Source).HasMaxLength(20).IsRequired();
            entity.Property(e => e.GoogleId).HasMaxLength(200);
            entity.Property(e => e.Location).HasMaxLength(300);
            entity.Property(e => e.Notes).HasMaxLength(2000);
            entity.Property(e => e.OwnerTags).HasMaxLength(120);
            entity.Property(e => e.GoogleCalendarId).HasMaxLength(200);
            entity.Property(e => e.CalendarName).HasMaxLength(200);
            entity.Property(e => e.Mark).HasMaxLength(40);
            entity.HasIndex(e => e.StartUtc);
            entity.HasIndex(e => e.GoogleId);
            entity.HasIndex(e => new { e.ProfileId, e.StartUtc });
        });

        // ---- Stage 5: Tasks + Microsoft account links ----
        modelBuilder.Entity<TaskItem>(entity =>
        {
            entity.Property(t => t.Title).HasMaxLength(300).IsRequired();
            entity.Property(t => t.Source).HasMaxLength(20).IsRequired();
            entity.Property(t => t.GraphId).HasMaxLength(200);
            entity.Property(t => t.GraphListId).HasMaxLength(200);
            entity.Property(t => t.ListName).HasMaxLength(100);
            entity.Property(t => t.Note).HasMaxLength(2000);
            entity.HasIndex(t => new { t.ProfileId, t.Completed });
            entity.HasIndex(t => t.GraphId);
        });

        modelBuilder.Entity<MicrosoftAccountLink>(entity =>
        {
            entity.HasKey(l => l.ProfileId);
            entity.Property(l => l.ProfileId).ValueGeneratedNever();
            entity.Property(l => l.RefreshToken).IsRequired();
            entity.Property(l => l.ListId).HasMaxLength(200);
        });

        modelBuilder.Entity<SyncedList>(entity =>
        {
            entity.HasKey(s => new { s.ProfileId, s.GraphListId });
            entity.Property(s => s.GraphListId).HasMaxLength(200);
            entity.Property(s => s.ListName).HasMaxLength(100).IsRequired();
        });

        modelBuilder.Entity<GoogleAccountLink>(entity =>
        {
            entity.HasKey(l => l.ProfileId);
            entity.Property(l => l.ProfileId).ValueGeneratedNever();
            entity.Property(l => l.RefreshToken).IsRequired();
            entity.Property(l => l.PrimaryCalendarId).HasMaxLength(200);
        });

        modelBuilder.Entity<SyncedCalendar>(entity =>
        {
            entity.HasKey(s => new { s.ProfileId, s.GoogleCalendarId });
            entity.Property(s => s.GoogleCalendarId).HasMaxLength(200);
            entity.Property(s => s.CalendarName).HasMaxLength(200).IsRequired();
        });

        // ---- Stage 6: Climate zones ----
        modelBuilder.Entity<ClimateZone>(entity =>
        {
            entity.Property(z => z.Name).HasMaxLength(60).IsRequired();
            entity.Property(z => z.Source).HasMaxLength(30).IsRequired();
            entity.Property(z => z.ProviderRef).HasMaxLength(160).IsRequired();
            entity.Property(z => z.FanMode).HasMaxLength(30);
            entity.HasIndex(z => new { z.Source, z.ProviderRef }).IsUnique();
            entity.HasIndex(z => z.DisplayOrder);

            // Seed simulated mini-split zones (swapped for HA climate.* entities when configured).
            entity.HasData(
                new ClimateZone { Id = 1, Name = "Living Room", Source = "simulated", ProviderRef = "sim-living", CurrentTempF = 74, SetPointF = 72, Mode = ClimateMode.Cool, FanMode = "Quiet", DisplayOrder = 0 },
                new ClimateZone { Id = 2, Name = "Bedroom", Source = "simulated", ProviderRef = "sim-bedroom", CurrentTempF = 71, SetPointF = 70, Mode = ClimateMode.Cool, FanMode = "Auto", DisplayOrder = 1 },
                new ClimateZone { Id = 3, Name = "Kitchen", Source = "simulated", ProviderRef = "sim-kitchen", CurrentTempF = 73, SetPointF = 73, Mode = ClimateMode.Fan, FanMode = "Auto", DisplayOrder = 2 },
                new ClimateZone { Id = 4, Name = "Study", Source = "simulated", ProviderRef = "sim-study", CurrentTempF = 72, SetPointF = 72, Mode = ClimateMode.Off, DisplayOrder = 3 },
                new ClimateZone { Id = 5, Name = "Loft", Source = "simulated", ProviderRef = "sim-loft", CurrentTempF = 72, SetPointF = 72, Mode = ClimateMode.Off, DisplayOrder = 4 });
        });

        // ---- Litter-Robot auto-recovery attempts ----
        modelBuilder.Entity<LitterRobotRecovery>(entity =>
        {
            entity.Property(r => r.Slug).HasMaxLength(120).IsRequired();
            entity.Property(r => r.FaultCode).HasMaxLength(20).IsRequired();
            entity.Property(r => r.ResultingCode).HasMaxLength(20);
            entity.Property(r => r.Detail).HasMaxLength(300);
            // The rolling-24h cap query is (slug, started) — index it, since the recovery loop runs it
            // on every tick that finds a fault.
            entity.HasIndex(r => new { r.Slug, r.StartedAtUtc });
        });

        // ---- Notifications ----
        modelBuilder.Entity<Notification>(entity =>
        {
            entity.Property(n => n.Source).HasMaxLength(40).IsRequired();
            entity.Property(n => n.Label).HasMaxLength(80).IsRequired();
            entity.Property(n => n.Severity).HasMaxLength(20).IsRequired();
            entity.Property(n => n.Accent).HasMaxLength(20).IsRequired();
            entity.Property(n => n.Headline).HasMaxLength(300).IsRequired();
            entity.Property(n => n.Meta).HasMaxLength(200);
            entity.Property(n => n.Route).HasMaxLength(200);
            entity.Property(n => n.DedupeKey).HasMaxLength(200).IsRequired();
            // One row per occurrence, enforced rather than hoped for: the alert feed is re-polled
            // every 30s and the app restarts, and neither may tell the household the same thing twice.
            entity.HasIndex(n => n.DedupeKey).IsUnique();
            // The list is always "newest first, last seven days".
            entity.HasIndex(n => n.AtUtc);
        });

        modelBuilder.Entity<NotificationSourceSetting>(entity =>
        {
            entity.Property(s => s.Source).HasMaxLength(40).IsRequired();
            entity.HasIndex(s => s.Source).IsUnique();
        });

        // ---- Stage M1: Meals — recipes + week plan ----
        modelBuilder.Entity<Recipe>(entity =>
        {
            // Lengths come from MealFieldLimits so the controllers can reject overlong input against
            // the same numbers — see that file for why a literal here would be a latent 500.
            entity.Property(r => r.Title).HasMaxLength(MealFieldLimits.Title).IsRequired();
            entity.Property(r => r.Description).HasMaxLength(MealFieldLimits.Description);
            entity.Property(r => r.SourceUrl).HasMaxLength(MealFieldLimits.Url);
            entity.Property(r => r.SourceName).HasMaxLength(MealFieldLimits.SourceName);
            entity.Property(r => r.YieldText).HasMaxLength(MealFieldLimits.YieldText);
            entity.Property(r => r.ImagePath).HasMaxLength(MealFieldLimits.ImagePath);
            entity.Property(r => r.ImageSourceUrl).HasMaxLength(MealFieldLimits.Url);
            entity.Property(r => r.IncompleteReason).HasMaxLength(MealFieldLimits.IncompleteReason);
            entity.Property(r => r.PrepNote).HasMaxLength(MealFieldLimits.PrepNote);
            // ModifiedByProfileId is an id, not a relationship. Left unconstrained on purpose: a
            // deleted profile must not take the recipe with it, nor block its own deletion, and the
            // read path already treats an unresolvable id as "no attribution" (RecipesController).
            entity.HasIndex(r => r.Title);
            // The folder's default query is "not archived, by title".
            entity.HasIndex(r => new { r.IsArchived, r.Title });
            // SourceUrl is deliberately NOT indexed. It is nvarchar(1000) = 2000 bytes, over SQL
            // Server's 1700-byte nonclustered key limit: the index would be created with a warning
            // and then fail inserts for any URL past ~850 characters. When Stage M2 wants
            // import-dedupe it should add an indexed hash column rather than shortening the URL,
            // since long tracking tails are exactly what recipe links carry.
        });

        modelBuilder.Entity<RecipeIngredient>(entity =>
        {
            entity.Property(i => i.RawText).HasMaxLength(MealFieldLimits.IngredientRawText).IsRequired();
            entity.Property(i => i.Unit).HasMaxLength(MealFieldLimits.Unit);
            entity.Property(i => i.Name).HasMaxLength(MealFieldLimits.IngredientName);
            entity.Property(i => i.Note).HasMaxLength(MealFieldLimits.Note);
            entity.Property(i => i.SectionHeading).HasMaxLength(MealFieldLimits.SectionHeading);
            // Quantities are fractional ("0.5 cup") but never precise enough to want floating point.
            entity.Property(i => i.Quantity).HasPrecision(9, 3);
            entity.HasOne(i => i.Recipe)
                .WithMany(r => r.Ingredients)
                .HasForeignKey(i => i.RecipeId)
                .OnDelete(DeleteBehavior.Cascade);
            entity.HasIndex(i => new { i.RecipeId, i.Position });
        });

        modelBuilder.Entity<RecipeStep>(entity =>
        {
            entity.Property(s => s.Text).HasMaxLength(MealFieldLimits.StepText).IsRequired();
            entity.Property(s => s.SectionHeading).HasMaxLength(MealFieldLimits.SectionHeading);
            entity.HasOne(s => s.Recipe)
                .WithMany(r => r.Steps)
                .HasForeignKey(s => s.RecipeId)
                .OnDelete(DeleteBehavior.Cascade);
            entity.HasIndex(s => new { s.RecipeId, s.Position });
        });

        modelBuilder.Entity<RecipeTag>(entity =>
        {
            entity.Property(t => t.Tag).HasMaxLength(MealFieldLimits.Tag).IsRequired();
            entity.HasOne(t => t.Recipe)
                .WithMany(r => r.Tags)
                .HasForeignKey(t => t.RecipeId)
                .OnDelete(DeleteBehavior.Cascade);
            // A recipe carries a given tag once; the tag list is also queried on its own for the filter row.
            entity.HasIndex(t => new { t.RecipeId, t.Tag }).IsUnique();
            entity.HasIndex(t => t.Tag);
        });

        modelBuilder.Entity<MealPlanEntry>(entity =>
        {
            entity.Property(e => e.FreeText).HasMaxLength(MealFieldLimits.FreeText);
            // NOT unique any more. A night can hold a main, a side and a dessert (MEALS_GROUPS §6.1),
            // so (Date, Slot) identifies an *arrangement* rather than a row. The index stays because
            // every read is still "the entries on this slot" — it is the uniqueness that had to go,
            // not the lookup. Ordering within the slot is Position.
            entity.HasIndex(e => new { e.Date, e.Slot, e.Position });
            // Deleting a planned recipe does NOT wipe the plan: RecipesController first rewrites those
            // entries to free text so "what we ate on Tuesday" survives. Cascade is the backstop for a
            // delete that bypasses the controller — the alternative, a restrict, would fail the delete
            // outright and leave no way to remove a recipe that was ever planned.
            entity.HasOne(e => e.Recipe)
                .WithMany()
                .HasForeignKey(e => e.RecipeId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<Meal>(entity =>
        {
            entity.Property(m => m.Name).HasMaxLength(MealFieldLimits.Title).IsRequired();
            entity.Property(m => m.PrepNote).HasMaxLength(MealFieldLimits.PrepNote);
            entity.Property(m => m.Cuisine).HasMaxLength(MealFieldLimits.Tag);
            entity.HasIndex(m => new { m.IsArchived, m.Name });
        });

        modelBuilder.Entity<MealComponent>(entity =>
        {
            entity.HasOne(c => c.Meal)
                .WithMany(m => m.Components)
                .HasForeignKey(c => c.MealId)
                .OnDelete(DeleteBehavior.Cascade);
            // Deleting a recipe removes it from any meal that used it, but never deletes the meal —
            // MEALS_GROUPS §3 is explicit that deleting a meal doesn't delete its recipes, and the
            // reverse holds too. A meal that loses a component is still a meal.
            entity.HasOne(c => c.Recipe)
                .WithMany()
                .HasForeignKey(c => c.RecipeId)
                .OnDelete(DeleteBehavior.Cascade);
            entity.HasIndex(c => new { c.MealId, c.Position });
            // A recipe appears at most once in a given meal — "garlic toast twice" is a servings
            // change, not a second component.
            entity.HasIndex(c => new { c.MealId, c.RecipeId }).IsUnique();
        });

        // ---- Stage M5: Pantry, grocery and imports ----
        modelBuilder.Entity<PantryItem>(entity =>
        {
            entity.Property(i => i.Name).HasMaxLength(PantryFieldLimits.ItemName).IsRequired();
            entity.Property(i => i.Unit).HasMaxLength(PantryFieldLimits.Unit);
            entity.Property(i => i.CatalogueRef).HasMaxLength(PantryFieldLimits.Barcode);
            // Counts are fractional ("0.5 lb") but never want floating point, same as recipe amounts.
            entity.Property(i => i.Quantity).HasPrecision(9, 3);
            // The default read is "not archived, grouped by location, alphabetical inside".
            entity.HasIndex(i => new { i.IsArchived, i.Location, i.Name });
            entity.HasIndex(i => i.CatalogueRef);
        });

        modelBuilder.Entity<PantryEvent>(entity =>
        {
            entity.Property(e => e.Delta).HasPrecision(9, 3);
            entity.Property(e => e.ResultingQuantity).HasPrecision(9, 3);
            // Archiving an item must not orphan its ledger, and the item is archived rather than
            // deleted precisely so this cascade never fires in normal use.
            entity.HasOne(e => e.Item)
                .WithMany(i => i.Events)
                .HasForeignKey(e => e.PantryItemId)
                .OnDelete(DeleteBehavior.Cascade);
            // "The events for this item, newest first" is every read of this table.
            entity.HasIndex(e => new { e.PantryItemId, e.AtUtc });
            // Deduction idempotency per plan entry, and the whole-import / whole-run undo.
            entity.HasIndex(e => new { e.SourceKind, e.SourceId });
            // Two phones scanning the same delivery both add; the same phone retrying does not
            // (DECISIONS PG7). Enforced rather than checked, because the check would race itself.
            entity.HasIndex(e => new { e.ScanRunId, e.ScanSequence })
                .IsUnique()
                .HasFilter("[ScanRunId] IS NOT NULL");
        });

        modelBuilder.Entity<ProductCatalogueEntry>(entity =>
        {
            entity.Property(c => c.Barcode).HasMaxLength(PantryFieldLimits.Barcode).IsRequired();
            entity.Property(c => c.Name).HasMaxLength(PantryFieldLimits.ItemName).IsRequired();
            entity.Property(c => c.DefaultUnit).HasMaxLength(PantryFieldLimits.Unit);
            entity.Property(c => c.PackSize).HasPrecision(9, 3);
            // A barcode may carry one global entry and one household entry; the household's wins.
            entity.HasIndex(c => new { c.Barcode, c.Scope }).IsUnique();
        });

        modelBuilder.Entity<IngredientAlias>(entity =>
        {
            entity.Property(a => a.Alias).HasMaxLength(PantryFieldLimits.Alias).IsRequired();
            entity.HasOne(a => a.Item)
                .WithMany()
                .HasForeignKey(a => a.PantryItemId)
                .OnDelete(DeleteBehavior.Cascade);
            // One alias points at one item — the second claim on a name is a correction of the
            // first, not a fork, and two answers would make the check non-deterministic.
            entity.HasIndex(a => a.Alias).IsUnique();
        });

        modelBuilder.Entity<GroceryLine>(entity =>
        {
            entity.Property(g => g.Text).HasMaxLength(PantryFieldLimits.GroceryText).IsRequired();
            entity.Property(g => g.Unit).HasMaxLength(PantryFieldLimits.Unit);
            entity.Property(g => g.Quantity).HasPrecision(9, 3);
            entity.Property(g => g.TodoTaskId).HasMaxLength(PantryFieldLimits.TodoTaskId);
            // Archiving a pantry item must not take the shopping list with it; the line still reads.
            entity.HasOne(g => g.Item)
                .WithMany()
                .HasForeignKey(g => g.PantryItemId)
                .OnDelete(DeleteBehavior.SetNull);
            entity.HasIndex(g => g.CheckedAtUtc);
            // The mirror's dedupe key in both directions (PANTRY_BEHAVIOURS §8).
            entity.HasIndex(g => g.TodoTaskId);
        });

        modelBuilder.Entity<GroceryLineSourceRef>(entity =>
        {
            entity.Property(s => s.RecipeTitle).HasMaxLength(MealFieldLimits.Title);
            entity.HasOne(s => s.Line)
                .WithMany(g => g.Sources)
                .HasForeignKey(s => s.GroceryLineId)
                .OnDelete(DeleteBehavior.Cascade);
            // RecipeId is an id, not a relationship: a deleted recipe leaves the shopping list
            // readable via RecipeTitle rather than taking the line with it.
            entity.HasIndex(s => s.GroceryLineId);
        });

        modelBuilder.Entity<GroceryMirrorSettings>(entity =>
        {
            entity.Property(m => m.Id).ValueGeneratedNever();
            entity.Property(m => m.TodoListId).HasMaxLength(PantryFieldLimits.TodoTaskId);
            entity.Property(m => m.TodoListName).HasMaxLength(PantryFieldLimits.TodoListName);
            entity.Property(m => m.LastError).HasMaxLength(300);
            // Mirroring off is a supported state, so the row seeds with no list chosen.
            entity.HasData(new GroceryMirrorSettings { Id = 1 });
        });

        modelBuilder.Entity<OrderImport>(entity =>
        {
            entity.Property(i => i.VendorLabel).HasMaxLength(PantryFieldLimits.VendorLabel);
            entity.Property(i => i.RawPayload).HasMaxLength(PantryFieldLimits.RawPayload);
            entity.HasIndex(i => new { i.Status, i.CreatedUtc });
            // The delivery-cadence sentence on 9b reads the last three applied imports by date.
            entity.HasIndex(i => i.DeliveredAtUtc);
        });

        modelBuilder.Entity<OrderImportLine>(entity =>
        {
            entity.Property(l => l.RawText).HasMaxLength(PantryFieldLimits.RawText).IsRequired();
            entity.Property(l => l.ProposedName).HasMaxLength(PantryFieldLimits.ItemName);
            entity.Property(l => l.ProposedUnit).HasMaxLength(PantryFieldLimits.Unit);
            entity.Property(l => l.ProposedQuantity).HasPrecision(9, 3);
            entity.Property(l => l.GuessFromPounds).HasPrecision(9, 3);
            entity.HasOne(l => l.Import)
                .WithMany(i => i.Lines)
                .HasForeignKey(l => l.ImportId)
                .OnDelete(DeleteBehavior.Cascade);
            entity.HasIndex(l => new { l.ImportId, l.Position });
        });

        modelBuilder.Entity<StockCheckDismissal>(entity =>
        {
            // One dismissal per plan entry: dismissing twice is dismissing once.
            entity.HasIndex(d => d.PlanEntryId).IsUnique();
        });

        ApplyUtcDateTimes(modelBuilder);
    }

    /// <summary>
    /// SQL Server's <c>datetime2</c> carries no kind, so values read back are
    /// <see cref="DateTimeKind.Unspecified"/> and serialize to JSON without a trailing "Z". The SPA
    /// then parses them as *local* time and the value drifts by the UTC offset — enough to shift an
    /// evening event onto the next day. Force every DateTime column to round-trip as UTC so what we
    /// store and what we send are unambiguous. (DateTime → DateTime, so no schema change.)
    /// </summary>
    private static void ApplyUtcDateTimes(ModelBuilder modelBuilder)
    {
        var utc = new ValueConverter<DateTime, DateTime>(
            v => v.Kind == DateTimeKind.Utc ? v : v.ToUniversalTime(),
            v => DateTime.SpecifyKind(v, DateTimeKind.Utc));

        var utcNullable = new ValueConverter<DateTime?, DateTime?>(
            v => v.HasValue && v.Value.Kind != DateTimeKind.Utc ? v.Value.ToUniversalTime() : v,
            v => v.HasValue ? DateTime.SpecifyKind(v.Value, DateTimeKind.Utc) : v);

        foreach (var entityType in modelBuilder.Model.GetEntityTypes())
        {
            foreach (var property in entityType.GetProperties())
            {
                if (property.ClrType == typeof(DateTime)) property.SetValueConverter(utc);
                else if (property.ClrType == typeof(DateTime?)) property.SetValueConverter(utcNullable);
            }
        }
    }
}
