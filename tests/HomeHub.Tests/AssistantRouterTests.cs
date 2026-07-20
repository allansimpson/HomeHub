namespace HomeHub.Tests;

using HomeHub.Api.Ai;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

/// <summary>
/// Hybrid routing behaviour: task-based local/cloud selection, low-confidence escalation, force
/// override, image→cloud, and graceful degradation to the simulated on-device assistant. Uses
/// fake providers so no network is touched.
/// </summary>
public class AssistantRouterTests
{
    private sealed class FakeProvider : IAssistantProvider
    {
        private readonly string _reply;
        private readonly double? _confidence;
        public int Calls { get; private set; }

        public FakeProvider(AssistantOrigin origin, bool available, string reply, double? confidence = null, bool supportsImages = false)
        {
            Origin = origin;
            IsAvailable = available;
            SupportsImages = supportsImages;
            _reply = reply;
            _confidence = confidence;
        }

        public AssistantOrigin Origin { get; }
        public bool IsAvailable { get; }
        public bool SupportsImages { get; }

        public Task<ProviderResult> CompleteAsync(AssistantRequest request, CancellationToken ct)
        {
            Calls++;
            return Task.FromResult(new ProviderResult(_reply, _confidence, Origin.ToString().ToLowerInvariant()));
        }
    }

    private static AssistantRouter Router(FakeProvider local, FakeProvider cloud, FakeProvider? simulated = null) =>
        new(local, cloud, simulated ?? new FakeProvider(AssistantOrigin.Local, true, "on-device answer", supportsImages: true),
            Options.Create(new AiOptions()), NullLogger<AssistantRouter>.Instance);

    private static AssistantRequest Ask(string prompt, string? force = null) => new([], prompt, null, null, force);

    [Fact]
    public async Task Routes_command_to_local()
    {
        var local = new FakeProvider(AssistantOrigin.Local, true, "Setting the living room.");
        var cloud = new FakeProvider(AssistantOrigin.Cloud, true, "cloud answer");
        var result = await Router(local, cloud).RouteAsync(Ask("Set the living room to 70."), default);

        Assert.Equal(AssistantOrigin.Local, result.Origin);
        Assert.False(result.Escalated);
        Assert.Equal(1, local.Calls);
        Assert.Equal(0, cloud.Calls);
    }

    [Fact]
    public async Task Routes_open_ended_to_cloud()
    {
        var local = new FakeProvider(AssistantOrigin.Local, true, "local");
        var cloud = new FakeProvider(AssistantOrigin.Cloud, true, "Here is a recipe for coq au vin…");
        var result = await Router(local, cloud).RouteAsync(Ask("Give me a recipe for coq au vin."), default);

        Assert.Equal(AssistantOrigin.Cloud, result.Origin);
        Assert.Equal(1, cloud.Calls);
        Assert.Equal(0, local.Calls);
    }

    [Fact]
    public async Task Escalates_low_confidence_local_to_cloud()
    {
        var local = new FakeProvider(AssistantOrigin.Local, true, "idk"); // too short → low confidence
        var cloud = new FakeProvider(AssistantOrigin.Cloud, true, "A thorough cloud answer.");
        var result = await Router(local, cloud).RouteAsync(Ask("Add milk to the list."), default);

        Assert.Equal(AssistantOrigin.Cloud, result.Origin);
        Assert.True(result.Escalated);
        Assert.Equal(1, local.Calls);
        Assert.Equal(1, cloud.Calls);
    }

    [Fact]
    public async Task Force_cloud_overrides_task_routing()
    {
        var local = new FakeProvider(AssistantOrigin.Local, true, "local");
        var cloud = new FakeProvider(AssistantOrigin.Cloud, true, "forced cloud answer");
        var result = await Router(local, cloud).RouteAsync(Ask("Set the living room to 70.", force: "cloud"), default);

        Assert.Equal(AssistantOrigin.Cloud, result.Origin);
        Assert.Equal(1, cloud.Calls);
    }

    [Fact]
    public async Task Image_requests_go_to_cloud()
    {
        var local = new FakeProvider(AssistantOrigin.Local, true, "local");
        var cloud = new FakeProvider(AssistantOrigin.Cloud, true, "I see a dog.", supportsImages: true);
        var request = new AssistantRequest([], "What's this?", "BASE64", "image/png", null);

        var result = await Router(local, cloud).RouteAsync(request, default);

        Assert.Equal(AssistantOrigin.Cloud, result.Origin);
        Assert.Equal(1, cloud.Calls);
    }

    [Fact]
    public async Task Falls_back_to_simulated_when_nothing_configured()
    {
        var local = new FakeProvider(AssistantOrigin.Local, available: false, "");
        var cloud = new FakeProvider(AssistantOrigin.Cloud, available: false, "");
        var simulated = new FakeProvider(AssistantOrigin.Local, true, "on-device demo answer", supportsImages: true);

        var result = await Router(local, cloud, simulated).RouteAsync(Ask("Set the living room to 70."), default);

        Assert.Equal(AssistantOrigin.Local, result.Origin);
        Assert.Equal("on-device demo answer", result.Text);
        Assert.Equal(1, simulated.Calls);
    }

    [Fact]
    public async Task Local_route_uses_cloud_when_no_local_configured()
    {
        var local = new FakeProvider(AssistantOrigin.Local, available: false, "");
        var cloud = new FakeProvider(AssistantOrigin.Cloud, true, "cloud handled the command");
        var result = await Router(local, cloud).RouteAsync(Ask("Add milk to the list."), default);

        Assert.Equal(AssistantOrigin.Cloud, result.Origin);
        Assert.False(result.Escalated);
        Assert.Equal(1, cloud.Calls);
    }
}
