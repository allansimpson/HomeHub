namespace HomeHub.Tests;

using System.Net;
using HomeHub.Api.Ai;
using Microsoft.Extensions.Options;

/// <summary>
/// RR-04 — where household speech and the cloud credential are permitted to go.
/// </summary>
/// <remarks>
/// <para>
/// <c>Voice:Stt:CloudAudioEgressAcknowledged</c> says audio may leave the LAN. It does not say who may
/// receive it, and that gap was the finding: <c>Ai:OpenAiBaseUrl</c> was an arbitrary string with no
/// validation, and <see cref="OpenAISpeechToText"/> posts raw audio and an <c>Authorization: Bearer</c>
/// header to it. A mistyped host or an edited scheme sent the household's speech, and the credential
/// that pays for it, somewhere nobody chose.
/// </para>
/// <para>
/// Checked in three places and tested in all three: the policy itself, the startup validator that
/// refuses a deployment, and the request path that refuses to build a message at all.
/// </para>
/// </remarks>
public class CloudSpeechEndpointTests
{
    // ---- The policy ----

    [Fact]
    public void The_providers_own_host_is_permitted_by_default()
    {
        Assert.Null(CloudSpeechEndpoint.Refuse("https://api.openai.com"));
    }

    [Theory]
    [InlineData("http://api.openai.com", "https")]
    [InlineData("ftp://api.openai.com", "https")]
    public void Cleartext_and_other_schemes_are_refused(string url, string expected)
    {
        var refusal = CloudSpeechEndpoint.Refuse(url);

        Assert.NotNull(refusal);
        Assert.Contains(expected, refusal);
    }

    /*
     * HTTPS to the wrong host is still the wrong host, and it is the failure a typo actually produces.
     * A scheme check alone would have passed every one of these.
     */
    [Theory]
    [InlineData("https://api.openai.com.attacker.example")]
    [InlineData("https://api-openai.com")]
    [InlineData("https://apiopenai.com")]
    [InlineData("https://192.0.2.10")]
    [InlineData("https://transcribe.internal")]
    public void An_unintended_host_is_refused_however_much_it_resembles_the_right_one(string url)
    {
        var refusal = CloudSpeechEndpoint.Refuse(url);

        Assert.NotNull(refusal);
        Assert.Contains("not an allowed destination", refusal);
    }

    /* Userinfo is the classic way to make a URL *read* as one host and resolve at another. */
    [Fact]
    public void Userinfo_is_refused_rather_than_ignored()
    {
        Assert.Contains("userinfo", CloudSpeechEndpoint.Refuse("https://api.openai.com@attacker.example")!);
    }

    [Theory]
    [InlineData("https://api.openai.com?to=elsewhere")]
    [InlineData("https://api.openai.com#elsewhere")]
    public void A_query_or_fragment_is_refused(string url)
    {
        Assert.Contains("query string or fragment", CloudSpeechEndpoint.Refuse(url)!);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(null)]
    [InlineData("api.openai.com")]
    [InlineData("not a url at all")]
    public void An_absent_or_unparseable_destination_is_refused(string? url)
    {
        Assert.NotNull(CloudSpeechEndpoint.Refuse(url));
    }

    /* A deployment using an OpenAI-compatible endpoint elsewhere says so explicitly, or not at all. */
    [Fact]
    public void An_explicitly_allowed_host_is_permitted_and_only_that_host()
    {
        string[] allowed = ["whisper.house.lan"];

        Assert.Null(CloudSpeechEndpoint.Refuse("https://whisper.house.lan", allowed));
        Assert.NotNull(CloudSpeechEndpoint.Refuse("https://api.openai.com", allowed));
        Assert.NotNull(CloudSpeechEndpoint.Refuse("http://whisper.house.lan", allowed));
    }

    /* The refusal is logged and shown; it names the host and never the credential. */
    [Fact]
    public void A_refusal_never_names_the_credential()
    {
        var refusal = CloudSpeechEndpoint.Refuse("https://attacker.example/v1?key=sk-secret-value");

        Assert.NotNull(refusal);
        Assert.DoesNotContain("sk-secret-value", refusal);
    }

    // ---- The startup validator ----

    private static IEnumerable<string> Errors(AiOptions options, bool deployment = true) =>
        new AiOptionsValidator(deployment).Validate(null, options).Failures ?? [];

    [Fact]
    public void A_deployment_with_a_key_and_a_bad_destination_will_not_start()
    {
        Assert.NotEmpty(Errors(new AiOptions
        {
            OpenAiApiKey = "sk-test", OpenAiBaseUrl = "http://api.openai.com",
        }));
    }

    [Fact]
    public void A_deployment_with_a_key_and_the_providers_host_starts()
    {
        Assert.Empty(Errors(new AiOptions { OpenAiApiKey = "sk-test" }));
    }

    /* No credential means no destination to get wrong; failing over an unused default is noise. */
    [Fact]
    public void A_deployment_with_no_cloud_credential_is_not_asked_about_a_destination()
    {
        Assert.Empty(Errors(new AiOptions { OpenAiBaseUrl = "http://anything.example" }));
    }

    [Fact]
    public void A_developer_is_not_stopped_at_startup()
    {
        Assert.Empty(Errors(
            new AiOptions { OpenAiApiKey = "sk-test", OpenAiBaseUrl = "http://localhost:9000" },
            deployment: false));
    }

    // ---- Availability, which is the fail-closed half ----

    /*
     * The check that holds in Development, where startup validation is deliberately lenient: a
     * destination that is not permitted reads as no cloud engine at all, so `SttRouter` skips it and
     * no request is ever built.
     */
    [Theory]
    [InlineData("http://api.openai.com")]
    [InlineData("https://attacker.example")]
    [InlineData("")]
    public void A_key_alone_no_longer_makes_cloud_speech_available(string baseUrl)
    {
        var options = new AiOptions { OpenAiApiKey = "sk-test", OpenAiBaseUrl = baseUrl };

        Assert.False(options.CloudSpeechConfigured);
    }

    [Fact]
    public void A_key_and_a_permitted_destination_together_do()
    {
        Assert.True(new AiOptions { OpenAiApiKey = "sk-test" }.CloudSpeechConfigured);
    }

    // ---- The request path ----

    /// <summary>Records every request it is asked to send, and sends none of them.</summary>
    private sealed class RecordingHandler : HttpMessageHandler
    {
        public List<Uri?> Sent { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Sent.Add(request.RequestUri);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("""{"text":"hello"}""", System.Text.Encoding.UTF8, "application/json"),
            });
        }
    }

    private static (OpenAISpeechToText Stt, RecordingHandler Handler) CloudStt(string baseUrl, params string[] allowed)
    {
        var handler = new RecordingHandler();
        var options = new AiOptions
        {
            OpenAiApiKey = "sk-test", OpenAiBaseUrl = baseUrl, OpenAiAllowedHosts = [.. allowed],
        };
        return (new OpenAISpeechToText(new HttpClient(handler), Options.Create(options)), handler);
    }

    /*
     * Checked at the request too, not only at startup and in `IsAvailable`. This method is the one
     * place in the app that puts raw household audio and a bearer credential on the wire, so a caller
     * that reached it without going through `SttRouter` must not inherit no check at all.
     */
    [Fact]
    public async Task Audio_is_never_sent_to_a_destination_that_is_not_permitted()
    {
        var (stt, handler) = CloudStt("https://attacker.example");

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            stt.TranscribeAsync(new MemoryStream([1, 2, 3]), "a.webm", "audio/webm", CancellationToken.None));

        Assert.Empty(handler.Sent);
    }

    [Fact]
    public async Task Audio_is_never_sent_over_cleartext()
    {
        var (stt, handler) = CloudStt("http://api.openai.com");

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            stt.TranscribeAsync(new MemoryStream([1, 2, 3]), "a.webm", "audio/webm", CancellationToken.None));

        Assert.Empty(handler.Sent);
    }

    [Fact]
    public async Task A_permitted_destination_is_used_and_is_the_one_configured()
    {
        var (stt, handler) = CloudStt("https://whisper.house.lan", "whisper.house.lan");

        var text = await stt.TranscribeAsync(
            new MemoryStream([1, 2, 3]), "a.webm", "audio/webm", CancellationToken.None);

        Assert.Equal("hello", text);
        Assert.Equal(
            new Uri("https://whisper.house.lan/v1/audio/transcriptions"),
            Assert.Single(handler.Sent));
    }
}
