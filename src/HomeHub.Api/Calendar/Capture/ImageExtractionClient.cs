namespace HomeHub.Api.Calendar.Capture;

using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;

/// <summary>An image, already normalised, on its way to be read.</summary>
/// <param name="Base64">The bytes, base64, with no data-URL prefix.</param>
/// <param name="MediaType">Its sniffed media type — never the one a caller claimed.</param>
public sealed record NormalizedImage(string Base64, string MediaType);

/// <summary>
/// The one path from HomeHub to the private image-extractor listener.
/// </summary>
/// <remarks>
/// Controllers do not know Hermes wire details, and nothing above this layer knows the extractor
/// exists as anything but a service. This owns authentication, the timeout, the concurrency bound,
/// the session header, the failure taxonomy and the transcript cleanup.
/// </remarks>
public interface IImageExtractionClient
{
    /// <summary>Whether a reading can be attempted at all.</summary>
    bool IsAvailable { get; }

    /// <summary>
    /// Read one image in one trusted mode, and return an untrusted proposal.
    /// </summary>
    /// <remarks>
    /// The proposal has been shape-checked and nothing more. Every string in it is data a stranger
    /// printed, and remains so until HomeHub's validators and a person have both had a look.
    /// </remarks>
    Task<ImageExtractionResult<T>> ExtractAsync<T>(
        ImageAnalysisMode mode,
        NormalizedImage image,
        string instruction,
        CancellationToken ct)
        where T : class;
}

/// <inheritdoc />
public sealed class ImageExtractionClient : IImageExtractionClient, IDisposable
{
    private readonly HttpClient _http;
    private readonly ImageExtractorOptions _options;
    private readonly ILogger<ImageExtractionClient> _logger;
    private readonly SemaphoreSlim _slots;

    public ImageExtractionClient(
        HttpClient http,
        IOptions<ImageExtractorOptions> options,
        ILogger<ImageExtractionClient> logger)
    {
        ArgumentNullException.ThrowIfNull(options);
        _http = http;
        _options = options.Value;
        _logger = logger;
        _slots = new SemaphoreSlim(Math.Max(1, _options.MaxConcurrent), Math.Max(1, _options.MaxConcurrent));
    }

    public bool IsAvailable => _options.Configured;

    public async Task<ImageExtractionResult<T>> ExtractAsync<T>(
        ImageAnalysisMode mode,
        NormalizedImage image,
        string instruction,
        CancellationToken ct)
        where T : class
    {
        ArgumentNullException.ThrowIfNull(image);
        if (!IsAvailable)
            return ImageExtraction.Failed<T>(ImageExtractionStatus.Unavailable, true, "not configured");

        // Bounded here as well as at the listener. A photograph waiting a moment is a background
        // courtesy delayed; readings queued without limit are a way to discover the admission cap the
        // hard way.
        if (!await _slots.WaitAsync(TimeSpan.FromSeconds(20), ct))
            return ImageExtraction.Failed<T>(ImageExtractionStatus.Busy, true, "no local slot");

        string? sessionId = null;
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
        budget.CancelAfter(TimeSpan.FromSeconds(Math.Clamp(_options.TimeoutSeconds, 5, 180)));

        try
        {
            /*
             * The request, and everything deliberately absent from it.
             *
             * No `model`, `provider`, `route` or tier — those live inside the extractor profile, which
             * is what makes its no-tools, no-memory guarantees the profile's to keep rather than ours
             * to re-assert per call. No `X-Hermes-Session-Key`, so nothing persists across readings.
             * No `tools: []` and no `response_format`: both are ignored by this Hermes version, and a
             * control that does nothing is worse than none — it invites somebody to rely on it.
             */
            var body = new
            {
                messages = new[]
                {
                    new
                    {
                        role = "user",
                        content = new object[]
                        {
                            new { type = "text", text = instruction },
                            new { type = "image_url", image_url = new { url = $"data:{image.MediaType};base64,{image.Base64}" } },
                        },
                    },
                },
                stream = false,
            };

            using var response = await _http.PostAsJsonAsync("v1/chat/completions", body, budget.Token);

            // Captured before anything else can fail. A run that errored still created a session, and
            // the transcript we most want gone is the one whose result was never even used.
            sessionId = response.Headers.TryGetValues("X-Hermes-Session-Id", out var ids)
                ? ids.FirstOrDefault()
                : null;

            if (!response.IsSuccessStatusCode)
            {
                var status = response.StatusCode switch
                {
                    HttpStatusCode.TooManyRequests or HttpStatusCode.ServiceUnavailable => ImageExtractionStatus.Busy,
                    // Our own credential or address is wrong. An internal fault, and never phrased to
                    // the household as though the photograph were at fault.
                    HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden => ImageExtractionStatus.Unavailable,
                    _ => ImageExtractionStatus.ModelRunFailed,
                };
                _logger.LogWarning("Image extraction refused: {Status}.", (int)response.StatusCode);
                return ImageExtraction.Failed<T>(status, await ForgetAsync(sessionId), $"http {(int)response.StatusCode}");
            }

            var completion = await response.Content.ReadFromJsonAsync<ExtractorCompletion>(ExtractionJson.Options, budget.Token);
            var choice = completion?.Choices is { Count: > 0 } choices ? choices[0] : null;

            /*
             * A completed envelope is not a completed run.
             *
             * Hermes answers 200 with `finish_reason=error`, or with `hermes.failed`, when the model
             * or provider behind it fell over — an expired provider token does exactly this. Parsing
             * that as empty output would report "I can't find a date or a time on that one" about a
             * photograph nothing ever looked at, which is the same wrong diagnosis, in the same words,
             * that a missing endpoint once produced.
             */
            if (choice?.FinishReason == "error" || completion?.Hermes?.Failed == true)
            {
                _logger.LogWarning("Image extraction run failed inside a 200 envelope ({Reason}).", choice?.FinishReason);
                return ImageExtraction.Failed<T>(ImageExtractionStatus.ModelRunFailed, await ForgetAsync(sessionId), "run failed");
            }

            var content = choice?.Message?.Content;
            if (string.IsNullOrWhiteSpace(content))
                return ImageExtraction.Failed<T>(ImageExtractionStatus.MalformedOutput, await ForgetAsync(sessionId), "empty");

            T? proposal;
            try
            {
                proposal = ExtractionJson.ParseOne<T>(content);
            }
            catch (JsonException)
            {
                proposal = null;
            }

            if (proposal is null)
            {
                // Logged as a count, never as content: the answer is a stranger's printed words, and
                // a log is the one place they would sit unread and unbounded.
                _logger.LogInformation("An extraction answered in a shape that could not be read.");
                return ImageExtraction.Failed<T>(ImageExtractionStatus.MalformedOutput, await ForgetAsync(sessionId), "not one object");
            }

            return new ImageExtractionResult<T>(ImageExtractionStatus.Success, proposal, await ForgetAsync(sessionId));
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            return ImageExtraction.Failed<T>(ImageExtractionStatus.Cancelled, await ForgetAsync(sessionId), "cancelled");
        }
        catch (OperationCanceledException)
        {
            _logger.LogWarning("An extraction ran past {Seconds}s and was given up on.", _options.TimeoutSeconds);
            return ImageExtraction.Failed<T>(ImageExtractionStatus.TimedOut, await ForgetAsync(sessionId), "timed out");
        }
        catch (HttpRequestException ex)
        {
            _logger.LogWarning(ex, "The image extractor was unreachable.");
            return ImageExtraction.Failed<T>(ImageExtractionStatus.Unavailable, await ForgetAsync(sessionId), "unreachable");
        }
        finally
        {
            _slots.Release();
        }
    }

    /// <summary>
    /// Delete the disposable session a reading created. Returns whether it went.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Called on every path that could have created one — success, refusal, failed run, malformed
    /// answer, timeout and cancellation alike. A session with no id to delete counts as clean, because
    /// there is nothing left behind to fail at removing.
    /// </para>
    /// <para>
    /// <b>What this does and does not claim.</b> It removes the session row and its messages. It is
    /// not a claim about provider retention, logs, request dumps or backups, which are governed
    /// separately — and the result is reported rather than acted on: a cleanup failure never makes an
    /// invalid answer valid, and never causes a side effect.
    /// </para>
    /// <para>
    /// Deliberately not bound to the caller's cancellation. A household that walked away mid-reading
    /// is the case where cleaning up matters most, and tying it to their attention span would skip it
    /// exactly then.
    /// </para>
    /// </remarks>
    private async Task<bool> ForgetAsync(string? sessionId)
    {
        if (string.IsNullOrWhiteSpace(sessionId)) return true;

        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            using var res = await _http.DeleteAsync($"api/sessions/{Uri.EscapeDataString(sessionId)}", timeout.Token);
            // Already gone is the outcome asked for.
            if (res.StatusCode == HttpStatusCode.NotFound) return true;
            if (res.IsSuccessStatusCode) return true;

            _logger.LogWarning("An extraction transcript could not be deleted: {Status}.", (int)res.StatusCode);
            return false;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "An extraction transcript could not be deleted.");
            return false;
        }
    }

    public void Dispose() => _slots.Dispose();

    /// <summary>The envelope, trimmed to what decides whether a run actually succeeded.</summary>
    private sealed record ExtractorCompletion(
        [property: JsonPropertyName("choices")] IReadOnlyList<ExtractorChoice>? Choices,
        [property: JsonPropertyName("hermes")] HermesMeta? Hermes);

    private sealed record ExtractorChoice(
        [property: JsonPropertyName("message")] ExtractorMessage? Message,
        [property: JsonPropertyName("finish_reason")] string? FinishReason);

    private sealed record ExtractorMessage(
        [property: JsonPropertyName("content")] string? Content);

    private sealed record HermesMeta(
        [property: JsonPropertyName("failed")] bool Failed);
}
