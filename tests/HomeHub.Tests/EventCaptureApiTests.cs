namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Calendar.Capture;

/// <summary>
/// The read-photo endpoint (E2): what it answers, and what it refuses to do.
/// </summary>
public class EventCaptureApiTests
{
    private static string CreateKeyRingDirectory()
    {
        var path = Path.Combine(
            Path.GetTempPath(), "homehub-tests", "keys-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }

    [Fact]
    public void Production_refuses_to_start_without_the_isolated_image_extractor()
    {
        var tls = TestTlsCertificate.Create();
        using var app = new HubAppFactory
        {
            EnvironmentName = "Production",
            Settings = new()
            {
                ["ConnectionStrings:HomeHub"] =
                    "Server=127.0.0.1,1;Database=unreachable;User Id=x;Password=x;Connect Timeout=1;TrustServerCertificate=true",
                ["DataProtection:KeyPath"] = CreateKeyRingDirectory(),
                ["Server:CertPath"] = tls.CertificatePath,
                ["Server:KeyPath"] = tls.KeyPath,
            },
        };

        var error = Assert.ThrowsAny<Exception>(() => app.CreateAnonymousClient());

        Assert.Contains("ImageExtractor", error.ToString(), StringComparison.Ordinal);
    }

    /// <summary>A reading that never happened, so the suite cannot reach a provider.</summary>
    private sealed class StubExtractor(ExtractionResult result) : IEventExtractor
    {
        public bool IsAvailable => true;

        /// <summary>What the endpoint passed down, for the tests that care about the request.</summary>
        public ExtractionRequest? Seen { get; private set; }

        public Task<ExtractionResult> ReadAsync(ExtractionRequest request, CancellationToken ct)
        {
            Seen = request;
            return Task.FromResult(result);
        }
    }

    private static DraftEvent Draft(string title = "Summer Camp Open House") =>
        new("0", title, new DateOnly(2026, 9, 14), AllDay: true, null, null, "The Old Hall", null, [], ["year"]);

    /*
     * The default reader is now the *house agent*, not a vision vendor — so "nothing configured" has
     * to be asked for explicitly. A panel with an agent can read photographs out of the box, which is
     * the point of that change: the image already reaches that agent on the ordinary chat turn, so
     * reading it there adds no destination and no bill.
     *
     * This asks for the vendor path with no key, which is the one combination that genuinely has no
     * reader behind it.
     */
    [Fact]
    public async Task A_panel_with_no_reader_says_so_rather_than_blaming_the_photograph()
    {
        // "There is no date on that" would be a lie about a picture that may be perfectly clear, so
        // the endpoint reports that it could not look at all.
        using var app = new HubAppFactory
        {
            Settings = new() { ["EventCapture:Provider"] = "openai", ["EventCapture:ApiKey"] = "" },
        };
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/calendar/read-photo",
            new ReadPhotoRequest("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "image/png", "2026-08-12", null));

        var body = await res.Content.ReadFromJsonAsync<ReadPhotoResponse>();
        Assert.False(body!.Available);
        Assert.Empty(body.Events);
    }

    [Fact]
    public async Task A_reading_comes_back_as_drafts_with_their_assumptions_on_them()
    {
        var stub = new StubExtractor(new ExtractionResult(ExtractionConfidence.Partial, [Draft()], null));
        using var app = new HubAppFactory { EventExtractor = stub };
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/calendar/read-photo",
            new ReadPhotoRequest("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "image/png", "2026-08-12", "here's the camp flyer"));

        var body = await res.Content.ReadFromJsonAsync<ReadPhotoResponse>();
        Assert.True(body!.Available);
        Assert.Equal("Partial", body.Confidence);
        var draft = Assert.Single(body.Events);
        Assert.Equal("Summer Camp Open House", draft.Title);
        Assert.True(draft.AllDay);
        Assert.Contains("year", draft.Assumed);
    }

    [Fact]
    public async Task The_panels_own_date_and_the_members_words_reach_the_reading()
    {
        // Both matter and neither is the server's to invent: today anchors an unstated year, and the
        // typed message is the difference between "the camp one" and "the concert one".
        var stub = new StubExtractor(ExtractionResult.Nothing("nothing"));
        using var app = new HubAppFactory { EventExtractor = stub };
        var client = app.CreateSeededClient();

        await client.PostAsJsonAsync("/api/calendar/read-photo",
            new ReadPhotoRequest("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "image/png", "2026-12-30", "the camp flyer"));

        Assert.Equal(new DateOnly(2026, 12, 30), stub.Seen!.LocalToday);
        Assert.Equal("the camp flyer", stub.Seen.Context);
        Assert.Equal("image/jpeg", stub.Seen.MediaType);
    }

    [Fact]
    public async Task A_request_with_no_photograph_is_refused()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/calendar/read-photo",
            new ReadPhotoRequest(null, "image/jpeg", "2026-08-12", null));

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [Fact]
    public async Task A_photograph_past_the_ceiling_is_refused_before_anything_reads_it()
    {
        var stub = new StubExtractor(ExtractionResult.Nothing("nothing"));
        using var app = new HubAppFactory { EventExtractor = stub };
        var client = app.CreateSeededClient();

        // Just past ten megabytes once decoded.
        var oversized = new string('A', (EventCaptureLimits.MaxImageBytes * 4 / 3) + 8);
        var res = await client.PostAsJsonAsync("/api/calendar/read-photo",
            new ReadPhotoRequest(oversized, "image/jpeg", "2026-08-12", null));

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Null(stub.Seen);
    }

    [Fact]
    public async Task Reading_a_photograph_writes_nothing_to_the_calendar()
    {
        // The whole shape of this feature: a reading proposes, a person disposes. If this ever fails,
        // a photograph has become a way to write to the household's calendar without asking.
        var stub = new StubExtractor(new ExtractionResult(ExtractionConfidence.Complete, [Draft()], null));
        using var app = new HubAppFactory { EventExtractor = stub };
        var client = app.CreateSeededClient();

        await client.PostAsJsonAsync("/api/calendar/read-photo",
            new ReadPhotoRequest("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "image/png", "2026-08-12", null));

        var events = await client.GetFromJsonAsync<List<HomeHub.Api.Calendar.CalendarEventDto>>(
            "/api/calendar/events?from=2026-09-01T00:00:00Z&to=2026-10-01T00:00:00Z");
        Assert.Empty(events!);
    }

    [Fact]
    public async Task Reading_a_photograph_needs_a_session()
    {
        using var app = new HubAppFactory();
        var client = app.CreateAnonymousClient();

        var res = await client.PostAsJsonAsync("/api/calendar/read-photo",
            new ReadPhotoRequest("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "image/png", "2026-08-12", null));

        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }
    /*
     * The default, pinned.
     *
     * A panel with a configured agent reads photographs out of the box, with no key and no second
     * vendor. That is the whole point of the change and exactly the kind of default that gets
     * reverted by accident, so it is asserted rather than left to the configuration file.
     */
    [Fact]
    public async Task A_panel_with_an_agent_reads_photographs_without_any_extra_credential()
    {
        using var app = new HubAppFactory();
        var client = app.CreateSeededClient();

        var res = await client.PostAsJsonAsync("/api/calendar/read-photo",
            new ReadPhotoRequest("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "image/png", "2026-08-13", null));

        var body = await res.Content.ReadFromJsonAsync<ReadPhotoResponse>();
        Assert.True(body!.Available);
    }
}
