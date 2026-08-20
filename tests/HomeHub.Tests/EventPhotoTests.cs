namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Calendar;
using HomeHub.Api.Calendar.Capture;
using HomeHub.Api.Data;
using HomeHub.Api.Settings;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

/// <summary>
/// Keeping the photograph an engagement was read from (E3).
/// </summary>
/// <remarks>
/// This is the one part of the feature that reverses a rule stated elsewhere in the app —
/// <c>Assist/Attachments.cs</c> keeps no attachment bytes at all — so the conditions it holds under
/// are worth pinning: kept on the write and never on the attach, only in formats the panel can draw,
/// shared between engagements read off one flyer, and governed by a household switch.
/// </remarks>
public class EventPhotoTests
{
    /// <summary>A one-pixel PNG, which is the smallest thing that survives the sniffer.</summary>
    private const string PngBase64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    /// <summary>Bytes that are not an image the panel could ever render — HEIC's case, in miniature.</summary>
    private const string NotAnImageBase64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

    private static CalendarEventInput FromAFlyer(
        string title = "Summer Camp Open House",
        string? photo = PngBase64,
        DateTime? takenUtc = null) =>
        new(
            title,
            new DateTime(2026, 9, 14, 0, 0, 0, DateTimeKind.Utc),
            new DateTime(2026, 9, 15, 0, 0, 0, DateTimeKind.Utc),
            null, null, null,
            IsAllDay: true,
            PhotoBase64: photo,
            PhotoTakenUtc: takenUtc,
            FromPhoto: true);

    private static async Task<CalendarEventDto> CreateAsync(HttpClient client, CalendarEventInput input)
    {
        var res = await client.PostAsJsonAsync("/api/calendar/events", input);
        res.EnsureSuccessStatusCode();
        return (await res.Content.ReadFromJsonAsync<CalendarEventDto>())!;
    }

    [Fact]
    public async Task A_kept_photograph_comes_back_with_the_event_and_can_be_fetched()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var created = await CreateAsync(client, FromAFlyer(takenUtc: new DateTime(2026, 8, 12, 9, 30, 0, DateTimeKind.Utc)));

        Assert.True(created.FromPhoto);
        Assert.True(created.HasPhoto);
        Assert.Equal(new DateTime(2026, 8, 12, 9, 30, 0, DateTimeKind.Utc), created.PhotoTakenUtc);

        var photo = await client.GetAsync(new Uri($"/api/calendar/events/{created.Id}/photo", UriKind.Relative));
        Assert.Equal(HttpStatusCode.OK, photo.StatusCode);
        Assert.Equal("image/png", photo.Content.Headers.ContentType?.MediaType);
    }

    [Fact]
    public async Task Another_member_cannot_fetch_a_profile_owned_photograph()
    {
        using var app = new HubAppFactory();
        var owner = app.CreateSeededClient(profileId: 1);
        var created = await CreateAsync(owner, FromAFlyer());
        using (var scope = app.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
            var owned = await db.CalendarEvents.FindAsync(created.Id);
            owned!.ProfileId = 1;
            await db.SaveChangesAsync();
        }
        var otherMember = app.CreateSeededClient(profileId: 2);

        var response = await otherMember.GetAsync(
            new Uri($"/api/calendar/events/{created.Id}/photo", UriKind.Relative));

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task A_screenshot_with_no_exif_is_kept_without_inventing_a_taken_date()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var created = await CreateAsync(client, FromAFlyer(takenUtc: null));

        Assert.True(created.HasPhoto);
        // Null is the answer the detail screen needs: it says ADDED rather than passing off a file's
        // timestamp as the moment somebody pointed a camera at something.
        Assert.Null(created.PhotoTakenUtc);
    }

    [Fact]
    public async Task A_format_the_panel_cannot_draw_is_not_kept_and_the_engagement_still_lands()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var created = await CreateAsync(client, FromAFlyer(photo: NotAnImageBase64));

        // Provenance survives; the bytes do not. Losing the engagement over the photograph would be
        // the wrong trade entirely.
        Assert.True(created.FromPhoto);
        Assert.False(created.HasPhoto);

        var photo = await client.GetAsync(new Uri($"/api/calendar/events/{created.Id}/photo", UriKind.Relative));
        Assert.Equal(HttpStatusCode.NotFound, photo.StatusCode);
    }

    [Fact]
    public async Task Retention_switched_off_keeps_the_provenance_and_drops_the_picture()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        using (var scope = app.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
            var settings = await db.Settings.FirstAsync(s => s.Id == 1);
            settings.KeepEventPhotos = false;
            await db.SaveChangesAsync();
        }

        var created = await CreateAsync(client, FromAFlyer());

        Assert.True(created.FromPhoto);
        Assert.False(created.HasPhoto);
    }

    [Fact]
    public async Task One_flyer_backing_several_engagements_shares_a_file_that_outlives_the_first_delete()
    {
        // The sibling case: four dates off one term letter, one photograph between them. Deleting one
        // must not take the picture away from the other three.
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var first = await CreateAsync(client, FromAFlyer("First date"));
        var second = await CreateAsync(client, FromAFlyer("Second date"));

        var delete = await client.DeleteAsync(new Uri($"/api/calendar/events/{first.Id}", UriKind.Relative));
        Assert.Equal(HttpStatusCode.NoContent, delete.StatusCode);

        var survivor = await client.GetAsync(new Uri($"/api/calendar/events/{second.Id}/photo", UriKind.Relative));
        Assert.Equal(HttpStatusCode.OK, survivor.StatusCode);
    }

    [Fact]
    public async Task The_last_engagement_to_go_takes_the_photograph_with_it()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var first = await CreateAsync(client, FromAFlyer("First date"));
        var second = await CreateAsync(client, FromAFlyer("Second date"));
        // Read the name while a row still holds it — after the last delete there is nothing to ask.
        var fileName = PhotoFileOf(app, second.Id);
        Assert.NotNull(fileName);

        await client.DeleteAsync(new Uri($"/api/calendar/events/{first.Id}", UriKind.Relative));
        await client.DeleteAsync(new Uri($"/api/calendar/events/{second.Id}", UriKind.Relative));

        // Nothing references it now, so nothing is left on disk to reference.
        using var scope = app.Services.CreateScope();
        var store = scope.ServiceProvider.GetRequiredService<HomeHub.Api.Calendar.Capture.EventPhotoStore>();
        Assert.Null(store.Resolve(fileName));
    }

    [Fact]
    public async Task An_ordinary_typed_engagement_carries_no_provenance()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var start = new DateTime(2026, 9, 14, 18, 0, 0, DateTimeKind.Utc);

        var created = await CreateAsync(client, new CalendarEventInput("Dinner", start, start.AddHours(2), null, null, null));

        Assert.False(created.FromPhoto);
        Assert.False(created.HasPhoto);
    }

    [Fact]
    public async Task A_caller_cannot_hang_someone_elses_photograph_on_an_event_of_its_own()
    {
        // PhotoFile is server-resolved. A caller that sends one is ignored rather than trusted, or a
        // guessed filename would be a way to attach another household member's flyer to anything.
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();
        var theirs = await CreateAsync(client, FromAFlyer("Theirs"));
        var stolen = PhotoFileOf(app, theirs.Id);
        Assert.NotNull(stolen);

        var start = new DateTime(2026, 9, 20, 18, 0, 0, DateTimeKind.Utc);
        var mine = await CreateAsync(client, new CalendarEventInput(
            "Mine", start, start.AddHours(1), null, null, null, PhotoFile: stolen));

        Assert.False(mine.HasPhoto);
    }

    /// <summary>The stored filename, read straight from the row — never exposed over the API.</summary>
    private static string? PhotoFileOf(HubAppFactory app, int eventId)
    {
        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
        return db.CalendarEvents.AsNoTracking().First(e => e.Id == eventId).PhotoFile;
    }
    /*
     * The ADDED half of the source label.
     *
     * A screenshot carries no EXIF, so there is no TAKEN date to show and the file's own timestamp is
     * not an answer. `CreatedUtc` is what the label falls back to, and it has to be a real moment
     * rather than `UpdatedUtc` — which answers a different question and moves every time somebody
     * corrects the time of the engagement.
     */
    [Fact]
    public async Task An_engagement_records_when_it_was_written_down()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var before = DateTime.UtcNow.AddSeconds(-1);
        var created = await CreateAsync(client, FromAFlyer(takenUtc: null));

        Assert.NotNull(created.CreatedUtc);
        Assert.InRange(created.CreatedUtc!.Value, before, DateTime.UtcNow.AddSeconds(1));
        // The screenshot case: nothing to say about when a camera was pointed at anything.
        Assert.Null(created.PhotoTakenUtc);
    }

    [Fact]
    public async Task Editing_an_engagement_does_not_move_when_it_was_written_down()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var created = await CreateAsync(client, FromAFlyer());
        var stamped = created.CreatedUtc;

        var edit = new CalendarEventInput(
            "Summer Camp Open House (moved)",
            created.StartUtc,
            created.EndUtc,
            null, null, null,
            IsAllDay: true);
        var res = await client.PutAsJsonAsync($"/api/calendar/events/{created.Id}", edit);
        res.EnsureSuccessStatusCode();
        var updated = (await res.Content.ReadFromJsonAsync<CalendarEventDto>())!;

        Assert.Equal(stamped, updated.CreatedUtc);
    }

    /*
     * Retention, and the one thing the switch must not do.
     *
     * Turning it off stops new engagements keeping their flyer. It does not reach back and delete the
     * ones already kept — a privacy control that silently removed things the household had been
     * relying on would be a worse surprise than the one it exists to prevent.
     */
    [Fact]
    public async Task Turning_retention_off_stops_keeping_new_photographs_and_leaves_old_ones_alone()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var kept = await CreateAsync(client, FromAFlyer("Before"));
        Assert.True(kept.HasPhoto);

        var off = await client.PutAsJsonAsync("/api/settings/event-photo-policy", new SetEventPhotoPolicyRequest(false));
        off.EnsureSuccessStatusCode();
        Assert.False((await off.Content.ReadFromJsonAsync<SettingsDto>())!.KeepEventPhotos);

        var after = await CreateAsync(client, FromAFlyer("After"));
        // Still says where it came from — provenance is a fact about the engagement, not about bytes.
        Assert.True(after.FromPhoto);
        Assert.False(after.HasPhoto);

        // And the one written before the switch is untouched.
        var reloaded = await client.GetFromJsonAsync<CalendarEventDto>($"/api/calendar/events/{kept.Id}");
        Assert.True(reloaded!.HasPhoto);
    }
    /*
     * The deletions nobody performs.
     *
     * A person removing an engagement releases its photograph on the way out. A *sync* does not — it
     * prunes rows wholesale when a calendar is deselected or an event is deleted on somebody's phone
     * — and those files used to stay on disk for ever with nothing pointing at them. A photograph of
     * the household's post outliving every reference to it is the leak this feature must not have.
     */
    /// <summary>
    /// A store of its own, in a directory of its own.
    /// </summary>
    /// <remarks>
    /// <b>The sweep is a whole-directory operation, so it cannot share one.</b> These tests first
    /// used the app's store, which writes under the content root — the same physical directory for
    /// every test in the run. A sweep with an empty reference set then deleted files belonging to
    /// tests executing in parallel, and because the filename is a content hash of the same fixture
    /// PNG, they were all fighting over one name. It passed by luck and failed the moment timings
    /// moved.
    /// </remarks>
    private static EventPhotoStore IsolatedStore(out string directory)
    {
        directory = Directory.CreateTempSubdirectory("homehub-photo-sweep").FullName;
        var options = Microsoft.Extensions.Options.Options.Create(new EventCaptureOptions { PhotoPath = directory });
        return new EventPhotoStore(options, new SweepTestEnvironment(directory), NullLogger<EventPhotoStore>.Instance);
    }

    /// <summary>Only <c>ContentRootPath</c> is ever read, and only when no explicit path is set.</summary>
    private sealed class SweepTestEnvironment : IHostEnvironment
    {
        public SweepTestEnvironment(string root) => ContentRootPath = root;
        public string ApplicationName { get; set; } = "HomeHub.Tests";
        public string ContentRootPath { get; set; }
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
        public string EnvironmentName { get; set; } = "Test";
    }

    [Fact]
    public async Task The_sweep_takes_photographs_nothing_points_at_any_more()
    {
        var store = IsolatedStore(out var directory);
        try
        {
            var fileName = await store.KeepAsync(PngBase64, CancellationToken.None);
            Assert.NotNull(fileName);
            // Aged past the grace, which is what an orphan left by a sync prune always is.
            File.SetLastWriteTimeUtc(Path.Combine(directory, fileName!), DateTime.UtcNow.AddDays(-2));

            // Still referenced: the sweep must not touch it, however old the file is.
            Assert.Equal(0, store.Sweep(new HashSet<string>(StringComparer.Ordinal) { fileName! }, DateTime.UtcNow));
            Assert.NotNull(store.Resolve(fileName));

            // Now nothing points at it — which is what a sync prune leaves behind.
            Assert.Equal(1, store.Sweep(new HashSet<string>(StringComparer.Ordinal), DateTime.UtcNow));
            Assert.Null(store.Resolve(fileName));
        }
        finally
        {
            Directory.Delete(directory, true);
        }
    }

    /*
     * The window between writing a file and committing the row that points at it. A sweep that ran
     * inside it would delete a photograph somebody was in the middle of confirming, which is a far
     * worse failure than leaving an orphan around for another hour.
     */
    [Fact]
    public async Task The_sweep_spares_a_photograph_too_young_to_have_been_referenced_yet()
    {
        var store = IsolatedStore(out var directory);
        try
        {
            var fileName = await store.KeepAsync(PngBase64, CancellationToken.None);
            Assert.NotNull(fileName);

            // Unreferenced, but written moments ago — inside the grace, so it stays.
            Assert.Equal(0, store.Sweep(new HashSet<string>(StringComparer.Ordinal), DateTime.UtcNow));
            Assert.NotNull(store.Resolve(fileName));
        }
        finally
        {
            Directory.Delete(directory, true);
        }
    }

    /*
     * One flyer, four dates, one file — the name is a hash of its contents. Undoing or deleting one
     * of the four must not take the photograph away from the other three, and neither must the sweep.
     */
    [Fact]
    public async Task A_photograph_shared_by_several_engagements_survives_losing_one_of_them()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var first = await CreateAsync(client, FromAFlyer("14 September"));
        var second = await CreateAsync(client, FromAFlyer("20 September"));

        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
        var store = scope.ServiceProvider.GetRequiredService<EventPhotoStore>();
        var fileName = (await db.CalendarEvents.FindAsync(first.Id))!.PhotoFile!;
        // Content-addressed: both engagements point at the same file.
        Assert.Equal(fileName, (await db.CalendarEvents.FindAsync(second.Id))!.PhotoFile);

        (await client.DeleteAsync($"/api/calendar/events/{first.Id}")).EnsureSuccessStatusCode();
        Assert.NotNull(store.Resolve(fileName));

        (await client.DeleteAsync($"/api/calendar/events/{second.Id}")).EnsureSuccessStatusCode();
        Assert.Null(store.Resolve(fileName));
    }
}
