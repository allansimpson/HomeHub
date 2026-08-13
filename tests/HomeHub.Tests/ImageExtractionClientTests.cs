namespace HomeHub.Tests;

using System.Net;
using System.Text;
using System.Text.Json;
using HomeHub.Api.Calendar.Capture;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

/// <summary>
/// The wire contract with the private image-extractor, and the failure taxonomy behind it.
/// </summary>
/// <remarks>
/// <para>
/// <b>These are the tests the qualification asks for before the client is wired to anything.</b> They
/// need no credential and no live listener, which matters: the extractor's key belongs to another
/// account, so a suite that could only run against the real service would not run at all.
/// </para>
/// <para>
/// What they pin is mostly what the request must <i>not</i> contain, and what must happen on the
/// paths nobody looks at — a failed run, a malformed answer, a cancelled caller. The happy path is
/// the one that gets exercised by hand; the others are the ones that quietly rot.
/// </para>
/// </remarks>
public class ImageExtractionClientTests
{
    private const string GoodJson =
        """{"events":[{"title":"Open House","year":null,"month":9,"day":14,"begins":"10:00 AM","ends":null,"where":"The hall","note":null,"lowConfidence":[]}]}""";

    /// <summary>Records what was sent, and answers however the test says.</summary>
    private sealed class Stub : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, string, HttpResponseMessage> _respond;
        public Stub(Func<HttpRequestMessage, string, HttpResponseMessage> respond) => _respond = respond;

        public List<(HttpMethod Method, string Path, string Body)> Seen { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(ct);
            Seen.Add((request.Method, request.RequestUri!.AbsolutePath, body));
            return _respond(request, body);
        }
    }

    private static HttpResponseMessage Completion(string content, string finishReason = "stop", bool hermesFailed = false, string? sessionId = "api-abc123")
    {
        var payload = JsonSerializer.Serialize(new
        {
            choices = new[] { new { message = new { content }, finish_reason = finishReason } },
            hermes = new { failed = hermesFailed },
        });
        var res = new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(payload, Encoding.UTF8, "application/json"),
        };
        if (sessionId is not null) res.Headers.Add("X-Hermes-Session-Id", sessionId);
        return res;
    }

    private static (ImageExtractionClient Client, Stub Handler) Build(
        Func<HttpRequestMessage, string, HttpResponseMessage> respond)
    {
        var handler = new Stub(respond);
        var http = new HttpClient(handler) { BaseAddress = new Uri("http://127.0.0.1:8644/") };
        var options = Options.Create(new ImageExtractorOptions
        {
            BaseUrl = "http://127.0.0.1:8644",
            ApiKey = "test-key",
            Enabled = true,
        });
        return (new ImageExtractionClient(http, options, NullLogger<ImageExtractionClient>.Instance), handler);
    }

    private static NormalizedImage Image() => new("aGVsbG8=", "image/png");

    private static Task<ImageExtractionResult<ReadingReply>> Read(ImageExtractionClient client, string instruction = "read it") =>
        client.ExtractAsync<ReadingReply>(ImageAnalysisMode.Event, Image(), instruction, CancellationToken.None);

    /*
     * The request is defined as much by its absences as its contents.
     *
     * `model`, `provider` and `route` stay inside the extractor profile — naming one here would let
     * HomeHub override the very configuration that carries the no-tools guarantee. A session key would
     * make readings remember each other. And `tools: []` / `response_format` are ignored by this
     * Hermes version, so shipping them would be a control that does nothing while looking like one.
     */
    [Fact]
    public async Task The_request_names_no_model_provider_route_or_session_key()
    {
        var (client, handler) = Build((_, _) => Completion(GoodJson));
        await Read(client);

        var body = handler.Seen[0].Body;
        foreach (var forbidden in new[] { "\"model\"", "\"provider\"", "\"route\"", "\"tier\"", "response_format", "\"tools\"" })
        {
            Assert.DoesNotContain(forbidden, body, StringComparison.OrdinalIgnoreCase);
        }
    }

    [Fact]
    public async Task The_request_carries_the_instruction_and_the_image_and_does_not_stream()
    {
        var (client, handler) = Build((_, _) => Completion(GoodJson));
        await Read(client, "today is 2026-08-13");

        var body = handler.Seen[0].Body;
        Assert.Contains("today is 2026-08-13", body, StringComparison.Ordinal);
        Assert.Contains("data:image/png;base64,aGVsbG8=", body, StringComparison.Ordinal);
        Assert.Contains("\"stream\":false", body.Replace(" ", "", StringComparison.Ordinal), StringComparison.Ordinal);
    }

    /*
     * The one that would have shipped broken. Hermes answers 200 with `finish_reason=error` when the
     * model or provider behind it failed — an expired token does exactly this. Reading that as empty
     * output reports "no date on that one" about a photograph nothing ever looked at.
     */
    [Fact]
    public async Task A_failed_run_inside_a_200_envelope_is_not_an_empty_reading()
    {
        var (client, _) = Build((_, _) => Completion("", finishReason: "error"));
        var result = await Read(client);

        Assert.Equal(ImageExtractionStatus.ModelRunFailed, result.Status);
        Assert.Null(result.Proposal);
    }

    [Fact]
    public async Task Hermes_failure_metadata_is_also_a_failed_run()
    {
        var (client, _) = Build((_, _) => Completion(GoodJson, hermesFailed: true));
        var result = await Read(client);

        Assert.Equal(ImageExtractionStatus.ModelRunFailed, result.Status);
    }

    [Theory]
    [InlineData(HttpStatusCode.TooManyRequests, ImageExtractionStatus.Busy)]
    [InlineData(HttpStatusCode.ServiceUnavailable, ImageExtractionStatus.Busy)]
    // Our own credential is wrong — an internal fault, never phrased as the photograph's.
    [InlineData(HttpStatusCode.Unauthorized, ImageExtractionStatus.Unavailable)]
    [InlineData(HttpStatusCode.InternalServerError, ImageExtractionStatus.ModelRunFailed)]
    public async Task Refusals_map_to_their_own_truthful_status(HttpStatusCode code, ImageExtractionStatus expected)
    {
        var (client, _) = Build((_, _) => new HttpResponseMessage(code));
        var result = await Read(client);

        Assert.Equal(expected, result.Status);
    }

    [Fact]
    public async Task Prose_around_one_object_is_recovered_but_prose_alone_is_not()
    {
        var (fenced, _) = Build((_, _) => Completion("```json\n" + GoodJson + "\n```"));
        Assert.Equal(ImageExtractionStatus.Success, (await Read(fenced)).Status);

        var (prose, _) = Build((_, _) => Completion("There is an open house on the 14th."));
        var result = await Read(prose);
        Assert.Equal(ImageExtractionStatus.MalformedOutput, result.Status);
        Assert.Null(result.Proposal);
    }

    /*
     * The disposable transcript. Hermes creates a session whether or not one was asked for, and it can
     * serialise the inline image into its state database — so the delete is not tidiness, it is the
     * difference between a photograph of the household's post being kept and not.
     */
    [Fact]
    public async Task The_session_is_deleted_on_every_path_that_created_one()
    {
        foreach (var answer in new Func<HttpResponseMessage>[]
        {
            () => Completion(GoodJson),                              // success
            () => Completion("", finishReason: "error"),             // failed run
            () => Completion("not json at all"),                     // malformed
            () => Completion(GoodJson, hermesFailed: true),          // hermes said no
        })
        {
            var (client, handler) = Build((req, _) =>
                req.Method == HttpMethod.Delete ? new HttpResponseMessage(HttpStatusCode.OK) : answer());

            var result = await Read(client);

            var deletes = handler.Seen.Where(s => s.Method == HttpMethod.Delete).ToList();
            Assert.Single(deletes);
            Assert.Equal("/api/sessions/api-abc123", deletes[0].Path);
            Assert.True(result.SessionDeleted);
        }
    }

    [Fact]
    public async Task A_response_with_no_session_counts_as_clean_rather_than_failed()
    {
        var (client, handler) = Build((_, _) => Completion(GoodJson, sessionId: null));
        var result = await Read(client);

        Assert.True(result.SessionDeleted);
        Assert.DoesNotContain(handler.Seen, s => s.Method == HttpMethod.Delete);
    }

    /*
     * A cleanup failure is a privacy and operations condition — reported, retried out of band, and
     * never allowed to change the verdict. It must not turn a good reading bad, and it must certainly
     * not turn a bad one good.
     */
    [Fact]
    public async Task A_cleanup_failure_is_reported_without_altering_the_result()
    {
        var (client, _) = Build((req, _) =>
            req.Method == HttpMethod.Delete
                ? new HttpResponseMessage(HttpStatusCode.InternalServerError)
                : Completion(GoodJson));

        var result = await Read(client);

        Assert.Equal(ImageExtractionStatus.Success, result.Status);
        Assert.NotNull(result.Proposal);
        Assert.False(result.SessionDeleted);
    }

    [Fact]
    public async Task A_reading_is_unavailable_rather_than_attempted_when_the_flag_is_off()
    {
        var handler = new Stub((_, _) => Completion(GoodJson));
        var http = new HttpClient(handler) { BaseAddress = new Uri("http://127.0.0.1:8644/") };
        // Address and key both present, `Enabled` absent — the exact shape the handoff's suggested
        // environment block produces, and the one that must fail closed rather than quietly run.
        var options = Options.Create(new ImageExtractorOptions { BaseUrl = "http://127.0.0.1:8644", ApiKey = "k" });
        var client = new ImageExtractionClient(http, options, NullLogger<ImageExtractionClient>.Instance);

        var result = await Read(client);

        Assert.Equal(ImageExtractionStatus.Unavailable, result.Status);
        Assert.Empty(handler.Seen);
    }
}
