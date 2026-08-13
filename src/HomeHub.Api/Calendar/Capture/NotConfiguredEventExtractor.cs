namespace HomeHub.Api.Calendar.Capture;

/// <summary>
/// The floor: no vision provider is configured, so no photograph can be read.
/// </summary>
/// <remarks>
/// <para>
/// Registered whenever <c>EventCapture:ApiKey</c> is absent, which is every panel that has not opted
/// into sending photographs off the LAN — including the whole test suite, so nothing in CI can reach
/// a provider by accident. It is the same shape as the app's other not-connected implementations:
/// the seam always resolves, the endpoint always answers, and the panel is told the truth rather
/// than left with a spinner.
/// </para>
/// <para>
/// It reports <see cref="IsAvailable"/> false so the attach path can stay silent instead of
/// answering "I couldn't find a date on that" — which would be a lie about the photograph when the
/// real subject is the configuration.
/// </para>
/// </remarks>
public sealed class NotConfiguredEventExtractor : IEventExtractor
{
    public bool IsAvailable => false;

    public Task<ExtractionResult> ReadAsync(ExtractionRequest request, CancellationToken ct) =>
        Task.FromResult(ExtractionResult.Nothing("Reading photographs isn't switched on for this panel."));
}
