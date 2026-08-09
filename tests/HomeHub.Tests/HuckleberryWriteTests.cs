namespace HomeHub.Tests;

using System.Net;
using System.Text;
using System.Text.Json;
using HomeHub.Api.Baby;
using HomeHub.Api.HomeAssistant;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

/// <summary>
/// Stage H2 write half, against a stubbed Home Assistant. These assert the <em>exact JSON</em> that
/// reaches HA, because the field names and enum values were verified once against a live install and
/// there is no forgiving failure mode: the services accept a 200 for a malformed-but-parseable call,
/// and nothing written can be deleted afterwards.
/// </summary>
public class HuckleberryWriteTests
{
    /// <summary>Records every service call and the body it carried, and answers template renders.</summary>
    private sealed class StubHaHandler : HttpMessageHandler
    {
        public List<(string Path, string Body)> ServiceCalls { get; } = [];
        public int TemplateCalls { get; private set; }
        public string? DeviceId { get; set; } = "dev-conrad-1234";
        public bool FailServiceCalls { get; set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var url = request.RequestUri!.ToString();

            if (url.Contains("api/template", StringComparison.Ordinal))
            {
                TemplateCalls++;
                // HA renders a missing device as the literal "None".
                return Text(DeviceId ?? "None");
            }

            if (url.Contains("api/services/huckleberry/", StringComparison.Ordinal))
            {
                var body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(ct);
                var path = url[(url.IndexOf("api/services/huckleberry/", StringComparison.Ordinal) + 25)..];
                ServiceCalls.Add((path, body));
                if (FailServiceCalls) return new HttpResponseMessage(HttpStatusCode.InternalServerError);
                return Text("[]");
            }

            // Reads aren't under test here; an empty state list is enough to keep the provider happy.
            return Text("[]");
        }

        private static HttpResponseMessage Text(string body) =>
            new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
    }

    private static (HuckleberryHomeAssistantProvider Provider, StubHaHandler Handler) NewProvider()
    {
        var handler = new StubHaHandler();
        var ha = new HomeAssistantClient(new HttpClient(handler), Options.Create(new HomeAssistantOptions
        {
            BaseUrl = "http://ha.test:8123",
            Token = "test-token",
        }));

        var provider = new HuckleberryHomeAssistantProvider(
            ha,
            new HuckleberrySnapshotCache(),
            Options.Create(new HuckleberryOptions()),
            NullLogger<HuckleberryHomeAssistantProvider>.Instance,
            TimeProvider.System);

        return (provider, handler);
    }

    private static JsonElement BodyOf(StubHaHandler handler) =>
        JsonDocument.Parse(handler.ServiceCalls.Single().Body).RootElement;

    [Fact]
    public async Task Timer_actions_map_to_the_right_service_and_carry_the_device_id()
    {
        var (provider, handler) = NewProvider();

        var result = await provider.TimerActionAsync("conrad", BabyTimerKind.Sleep, BabyTimerAction.Start, null, default);

        Assert.True(result.Success);
        Assert.Equal("start_sleep", handler.ServiceCalls.Single().Path);
        Assert.Equal("dev-conrad-1234", BodyOf(handler).GetProperty("device_id").GetString());
    }

    [Theory]
    [InlineData(BabyTimerKind.Sleep, BabyTimerAction.Pause, "pause_sleep")]
    [InlineData(BabyTimerKind.Sleep, BabyTimerAction.Cancel, "cancel_sleep")]
    [InlineData(BabyTimerKind.Sleep, BabyTimerAction.Complete, "complete_sleep")]
    [InlineData(BabyTimerKind.Nursing, BabyTimerAction.Start, "start_nursing")]
    [InlineData(BabyTimerKind.Nursing, BabyTimerAction.SwitchSide, "switch_nursing_side")]
    [InlineData(BabyTimerKind.Nursing, BabyTimerAction.Complete, "complete_nursing")]
    public async Task Every_timer_action_maps_to_its_verified_service_name(
        BabyTimerKind timer, BabyTimerAction action, string expected)
    {
        var (provider, handler) = NewProvider();

        await provider.TimerActionAsync("conrad", timer, action, null, default);

        Assert.Equal(expected, handler.ServiceCalls.Single().Path);
    }

    [Fact]
    public async Task Cancel_and_complete_are_distinct_services()
    {
        // The distinction is load-bearing: cancel discards the session, complete writes it to
        // history. Toggling the HA switch entity performs a complete, which is why the panel must
        // call these explicitly.
        var (provider, handler) = NewProvider();

        await provider.TimerActionAsync("conrad", BabyTimerKind.Sleep, BabyTimerAction.Cancel, null, default);
        await provider.TimerActionAsync("conrad", BabyTimerKind.Sleep, BabyTimerAction.Complete, null, default);

        Assert.Equal(["cancel_sleep", "complete_sleep"], handler.ServiceCalls.Select(c => c.Path));
    }

    [Fact]
    public async Task Nursing_start_carries_the_side_but_pause_does_not()
    {
        var (provider, handler) = NewProvider();

        await provider.TimerActionAsync("conrad", BabyTimerKind.Nursing, BabyTimerAction.Start, NursingSide.Right, default);
        Assert.Equal("right", BodyOf(handler).GetProperty("side").GetString());

        handler.ServiceCalls.Clear();
        await provider.TimerActionAsync("conrad", BabyTimerKind.Nursing, BabyTimerAction.Pause, NursingSide.Right, default);
        Assert.False(BodyOf(handler).TryGetProperty("side", out _)); // pause_nursing accepts no side
    }

    [Fact]
    public async Task Sleep_timers_reject_a_side_switch_without_calling_home_assistant()
    {
        var (provider, handler) = NewProvider();

        var result = await provider.TimerActionAsync("conrad", BabyTimerKind.Sleep, BabyTimerAction.SwitchSide, null, default);

        Assert.False(result.Success);
        Assert.Empty(handler.ServiceCalls);
    }

    [Fact]
    public async Task Bottle_uses_the_upstream_enum_value_not_the_display_form()
    {
        var (provider, handler) = NewProvider();

        await provider.LogBottleAsync("conrad", new BottleEntry(3.5, BottleType.BreastMilk, BottleUnits.Oz), default);

        var body = BodyOf(handler);
        Assert.Equal("log_bottle", handler.ServiceCalls.Single().Path);
        Assert.Equal(3.5, body.GetProperty("amount").GetDouble());
        // Reads report "Breast Milk"; writes must send breast_milk.
        Assert.Equal("breast_milk", body.GetProperty("bottle_type").GetString());
        Assert.Equal("oz", body.GetProperty("units").GetString());
    }

    [Fact]
    public void Bottle_type_round_trips_between_the_read_and_write_forms()
    {
        Assert.Equal(BottleType.BreastMilk, HuckleberryServiceValues.ParseBottleType("Breast Milk"));
        Assert.Equal("breast_milk", HuckleberryServiceValues.Bottle(BottleType.BreastMilk));
        Assert.Null(HuckleberryServiceValues.ParseBottleType("Something New"));
    }

    [Fact]
    public async Task Diaper_only_sends_fields_the_chosen_service_accepts()
    {
        var (provider, handler) = NewProvider();

        // A pee-only entry must not carry poo colour/consistency even if supplied.
        await provider.LogDiaperAsync("conrad", new DiaperEntry(
            DiaperKind.Pee,
            PeeAmount: DiaperAmount.Medium,
            PooAmount: DiaperAmount.Big,
            Color: PooColor.Green,
            Consistency: PooConsistency.Runny,
            DiaperRash: true,
            Notes: "after feeding"), default);

        var body = BodyOf(handler);
        Assert.Equal("log_diaper_pee", handler.ServiceCalls.Single().Path);
        Assert.Equal("medium", body.GetProperty("pee_amount").GetString());
        Assert.False(body.TryGetProperty("poo_amount", out _));
        Assert.False(body.TryGetProperty("color", out _));
        Assert.False(body.TryGetProperty("consistency", out _));
        Assert.True(body.GetProperty("diaper_rash").GetBoolean());
        Assert.Equal("after feeding", body.GetProperty("notes").GetString());
    }

    [Fact]
    public async Task Diaper_both_carries_the_full_detail_set()
    {
        var (provider, handler) = NewProvider();

        await provider.LogDiaperAsync("conrad", new DiaperEntry(
            DiaperKind.Both, DiaperAmount.Little, DiaperAmount.Big, PooColor.Yellow, PooConsistency.Pebbles), default);

        var body = BodyOf(handler);
        Assert.Equal("log_diaper_both", handler.ServiceCalls.Single().Path);
        Assert.Equal("little", body.GetProperty("pee_amount").GetString());
        Assert.Equal("big", body.GetProperty("poo_amount").GetString());
        Assert.Equal("yellow", body.GetProperty("color").GetString());
        Assert.Equal("pebbles", body.GetProperty("consistency").GetString());
    }

    [Fact]
    public async Task Growth_sends_head_not_head_circumference()
    {
        // The read side and the write side disagree on this name; the service takes `head`.
        var (provider, handler) = NewProvider();

        await provider.LogGrowthAsync("conrad", new GrowthEntry(Weight: 6.4, Head: 42.3, Units: MeasurementUnits.Metric), default);

        var body = BodyOf(handler);
        Assert.Equal("log_growth", handler.ServiceCalls.Single().Path);
        Assert.Equal(42.3, body.GetProperty("head").GetDouble());
        Assert.False(body.TryGetProperty("head_circumference", out _));
        Assert.Equal("metric", body.GetProperty("units").GetString());
        Assert.False(body.TryGetProperty("height", out _)); // omitted, not sent as null
    }

    [Fact]
    public void Pounds_and_ounces_convert_to_decimal_imperial_pounds()
    {
        // 14 lb 2 oz -> 14.125 lb. The household reads lb+oz; upstream only accepts decimal.
        var entry = GrowthEntry.FromPoundsOunces(14, 2);

        Assert.Equal(14.125, entry.Weight);
        Assert.Equal(MeasurementUnits.Imperial, entry.Units);
    }

    [Fact]
    public async Task An_empty_growth_entry_is_refused_before_reaching_home_assistant()
    {
        // Guards an irreversible no-op record: there is no delete service to clean it up.
        var (provider, handler) = NewProvider();

        var result = await provider.LogGrowthAsync("conrad", new GrowthEntry(), default);

        Assert.False(result.Success);
        Assert.Empty(handler.ServiceCalls);
    }

    [Fact]
    public async Task A_zero_bottle_amount_is_refused_before_reaching_home_assistant()
    {
        var (provider, handler) = NewProvider();

        var result = await provider.LogBottleAsync("conrad", new BottleEntry(0, BottleType.Formula), default);

        Assert.False(result.Success);
        Assert.Empty(handler.ServiceCalls);
    }

    [Fact]
    public async Task The_device_id_is_resolved_once_and_reused()
    {
        var (provider, handler) = NewProvider();

        await provider.TimerActionAsync("conrad", BabyTimerKind.Sleep, BabyTimerAction.Start, null, default);
        await provider.TimerActionAsync("conrad", BabyTimerKind.Sleep, BabyTimerAction.Complete, null, default);
        await provider.LogBottleAsync("conrad", new BottleEntry(3, BottleType.Formula), default);

        Assert.Equal(1, handler.TemplateCalls);
        Assert.Equal(3, handler.ServiceCalls.Count);
    }

    [Fact]
    public async Task An_unresolvable_device_fails_the_write_instead_of_calling_the_service()
    {
        // HA renders a missing device as "None" — that must not be sent as a device_id.
        var (provider, handler) = NewProvider();
        handler.DeviceId = null;

        var result = await provider.TimerActionAsync("conrad", BabyTimerKind.Sleep, BabyTimerAction.Start, null, default);

        Assert.False(result.Success);
        Assert.Contains("device", result.Error!, StringComparison.OrdinalIgnoreCase);
        Assert.Empty(handler.ServiceCalls);
    }

    [Fact]
    public async Task A_rejected_service_call_fails_visibly_rather_than_queueing()
    {
        var (provider, handler) = NewProvider();
        handler.FailServiceCalls = true;

        var result = await provider.TimerActionAsync("conrad", BabyTimerKind.Sleep, BabyTimerAction.Start, null, default);

        Assert.False(result.Success);
        Assert.NotNull(result.Error);
    }

    [Fact]
    public async Task Writes_fail_when_huckleberry_is_not_connected()
    {
        var provider = new NotConnectedHuckleberryProvider();

        var result = await provider.LogBottleAsync("conrad", new BottleEntry(3, BottleType.Formula), default);

        Assert.False(result.Success);
        Assert.Contains("not connected", result.Error!, StringComparison.OrdinalIgnoreCase);
    }
}
