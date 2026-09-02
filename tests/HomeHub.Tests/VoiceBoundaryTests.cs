namespace HomeHub.Tests;

using HomeHub.Api.Ai;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

/// <summary>
/// HH-08 — an ordinary local outage must not export the household's speech.
/// </summary>
/// <remarks>
/// <para>
/// Cloud fallback shipped on by default, in this class and in <c>appsettings.json</c>. So a sidecar
/// that was slow to start after a reboot, a model still loading, or one bad request moved recorded
/// household audio off the LAN and into a third party's hands — and the only trace was an engine label
/// on a response somebody would have had to be reading.
/// </para>
/// <para>
/// The tests below are about the two things that fixes: the default, and the deployment gate that
/// stops the default being undone by half a decision.
/// </para>
/// </remarks>
public class VoiceBoundaryTests
{
    /// <summary>An engine that is present and always fails, which is the local outage being modelled.</summary>
    private sealed class FailingStt(bool available = true) : ISpeechToText
    {
        public bool IsAvailable { get; } = available;
        public int Calls { get; private set; }

        public Task<string> TranscribeAsync(Stream audio, string fileName, string contentType, CancellationToken ct)
        {
            Calls++;
            throw new InvalidOperationException("the sidecar is not up yet");
        }
    }

    private sealed class WorkingStt : ISpeechToText
    {
        public bool IsAvailable => true;
        public int Calls { get; private set; }

        public Task<string> TranscribeAsync(Stream audio, string fileName, string contentType, CancellationToken ct)
        {
            Calls++;
            return Task.FromResult("nappy change at four");
        }
    }

    private static SttRouter RouterWith(ISpeechToText local, ISpeechToText cloud, VoiceOptions.SttOptions stt) =>
        new(local, cloud, Options.Create(new VoiceOptions { Stt = stt }), NullLogger<SttRouter>.Instance);

    private static Task<SttResult> Transcribe(SttRouter router) =>
        router.TranscribeAsync(new MemoryStream([1, 2, 3]), "a.wav", "audio/wav", CancellationToken.None);

    // ---- The default ----

    [Fact]
    public void Cloud_fallback_is_off_unless_a_deployment_asks_for_it()
    {
        Assert.False(new VoiceOptions.SttOptions().AllowCloudFallback);
        Assert.False(new VoiceOptions.SttOptions().CloudAudioEgressAcknowledged);
        Assert.False(new VoiceOptions.SttOptions().PermitsCloudAudio);
    }

    /*
     * The finding, as the sequence it actually happened in: local is configured, local fails, and the
     * buffered household audio is replayed to the cloud provider.
     */
    [Fact]
    public async Task A_local_failure_under_the_default_never_reaches_the_cloud()
    {
        var local = new FailingStt();
        var cloud = new WorkingStt();
        var router = RouterWith(local, cloud, new VoiceOptions.SttOptions { LocalEndpoint = "http://127.0.0.1:8080" });

        await Assert.ThrowsAsync<InvalidOperationException>(() => Transcribe(router));

        Assert.Equal(1, local.Calls);
        Assert.Equal(0, cloud.Calls);
        Assert.Equal("local-only", router.Boundary);
    }

    [Fact]
    public async Task An_explicit_opt_in_permits_the_fallback_and_says_the_cloud_ran()
    {
        var router = RouterWith(new FailingStt(), new WorkingStt(), new VoiceOptions.SttOptions
        {
            LocalEndpoint = "http://127.0.0.1:8080",
            AllowCloudFallback = true,
        });

        var result = await Transcribe(router);

        Assert.Equal(SttEngine.Cloud, result.Engine);
        Assert.Equal("cloud-permitted", router.Boundary);
    }

    /*
     * `AnyAvailable` decides whether the panel offers server transcription at all. With local absent
     * and the boundary closed it has to be false — otherwise the panel offers a feature whose only
     * implementation the policy forbids, and the household is told "server STT" for something that
     * will always fail.
     */
    [Fact]
    public void An_unusable_cloud_engine_is_not_counted_as_availability()
    {
        var router = RouterWith(new FailingStt(available: false), new WorkingStt(), new VoiceOptions.SttOptions());

        Assert.False(router.AnyAvailable);
        Assert.True(router.CloudAvailable, "The engine is configured…");
        Assert.False(router.CloudUsable, "…and the policy will not let it run, which is the honest answer.");
    }

    // ---- The deployment gate ----

    private static IEnumerable<string> Errors(VoiceOptions.SttOptions stt, bool deployment = true) =>
        new VoiceOptionsValidator(deployment)
            .Validate(null, new VoiceOptions { Stt = stt })
            .Failures ?? [];

    [Fact]
    public void A_deployment_that_enables_cloud_audio_without_acknowledging_it_will_not_start()
    {
        var errors = Errors(new VoiceOptions.SttOptions { AllowCloudFallback = true }).ToList();

        Assert.Single(errors);
        Assert.Contains("CloudAudioEgressAcknowledged", errors[0]);
    }

    /*
     * `Prefer=cloud` reaches the cloud provider without touching the fallback flag at all, so a gate
     * that only guarded the flag would be walked straight around by the setting whose whole purpose is
     * to route to the cloud first.
     */
    [Fact]
    public void Preferring_the_cloud_needs_the_same_acknowledgement_as_falling_back_to_it()
    {
        Assert.NotEmpty(Errors(new VoiceOptions.SttOptions { Prefer = "cloud" }));
        Assert.Empty(Errors(new VoiceOptions.SttOptions
        {
            Prefer = "cloud", CloudAudioEgressAcknowledged = true,
        }));
    }

    [Fact]
    public void An_acknowledged_deployment_starts()
    {
        Assert.Empty(Errors(new VoiceOptions.SttOptions
        {
            AllowCloudFallback = true, CloudAudioEgressAcknowledged = true,
        }));
    }

    /* Consent given and the routing switched back off is a state a household is entitled to be in. */
    [Fact]
    public void Acknowledged_but_not_enabled_is_not_an_error()
    {
        Assert.Empty(Errors(new VoiceOptions.SttOptions { CloudAudioEgressAcknowledged = true }));
    }

    /*
     * A misspelling used to mean "local" by falling through a string comparison, which is the right
     * behaviour arrived at the wrong way: nobody would ever learn that the value they set was not a
     * value, and the next such fall-through might land on the other side.
     */
    [Theory]
    [InlineData("Cloud")]
    [InlineData("local")]
    [InlineData("LOCAL")]
    public void A_recognised_preference_passes_whatever_its_case(string prefer)
    {
        Assert.Empty(Errors(new VoiceOptions.SttOptions
        {
            Prefer = prefer, CloudAudioEgressAcknowledged = true,
        }));
    }

    [Theory]
    [InlineData("clod")]
    [InlineData("")]
    [InlineData("local-first")]
    public void An_unrecognised_preference_is_named_rather_than_silently_meaning_local(string prefer)
    {
        Assert.Contains(Errors(new VoiceOptions.SttOptions { Prefer = prefer }), e => e.Contains("Prefer"));
    }

    /* Development and the automated Test environment are exempt, as they are from every other safeguard. */
    [Fact]
    public void A_developer_is_not_asked_to_acknowledge_anything()
    {
        Assert.Empty(Errors(new VoiceOptions.SttOptions { AllowCloudFallback = true }, deployment: false));
    }
}
