namespace HomeHub.Tests;

using HomeHub.Api.Accounts;

/// <summary>
/// The OAuth <c>state</c> store. It is the only thing standing between a callback and a stored
/// refresh token, so the cases that matter are the ones where a callback should be refused.
/// </summary>
public class AccountLinkStateTests
{
    private sealed class FakeTime : TimeProvider
    {
        private DateTimeOffset _now = new(2026, 7, 30, 12, 0, 0, TimeSpan.Zero);
        public override DateTimeOffset GetUtcNow() => _now;
        public void Advance(TimeSpan by) => _now += by;
    }

    private static (AccountLinkState State, FakeTime Time) Build()
    {
        var time = new FakeTime();
        return (new AccountLinkState(time), time);
    }

    [Fact]
    public void Consume_returns_the_profile_that_started_the_flow()
    {
        var (state, _) = Build();
        var token = state.Create("google", 4, "http://panel/api/link/google/callback");

        var pending = state.Consume("google", token);

        Assert.NotNull(pending);
        Assert.Equal(4, pending!.Value.ProfileId);
        Assert.Equal("http://panel/api/link/google/callback", pending.Value.RedirectUri);
    }

    [Fact]
    public void A_state_cannot_be_replayed()
    {
        var (state, _) = Build();
        var token = state.Create("google", 4, "http://panel/cb");

        Assert.NotNull(state.Consume("google", token));
        Assert.Null(state.Consume("google", token));
    }

    [Fact]
    public void A_state_expires()
    {
        var (state, time) = Build();
        var token = state.Create("google", 4, "http://panel/cb");

        time.Advance(TimeSpan.FromMinutes(11));

        Assert.Null(state.Consume("google", token));
    }

    [Fact]
    public void A_state_belongs_to_the_provider_that_issued_it()
    {
        var (state, _) = Build();
        var token = state.Create("google", 4, "http://panel/cb");

        // A Microsoft callback presenting a Google state is not a flow this panel started.
        Assert.Null(state.Consume("microsoft", token));
    }

    [Fact]
    public void A_wrong_provider_callback_does_not_destroy_the_live_flow()
    {
        var (state, _) = Build();
        var token = state.Create("google", 4, "http://panel/cb");

        // The state rides in the kiosk's address bar, so a mismatched callback is reachable by
        // anyone who can see it. Refusing it must not spend the flow — otherwise Google's real
        // callback arrives moments later, finds nothing, and the household is told their consent
        // expired after they already gave it.
        Assert.Null(state.Consume("microsoft", token));

        var pending = state.Consume("google", token);
        Assert.NotNull(pending);
        Assert.Equal(4, pending!.Value.ProfileId);
    }

    [Fact]
    public void An_expired_state_is_refused_without_being_silently_reusable()
    {
        var (state, time) = Build();
        var token = state.Create("google", 4, "http://panel/cb");
        time.Advance(TimeSpan.FromMinutes(11));

        Assert.Null(state.Consume("google", token));
        // Still gone on a second look — expiry must not leave a live entry behind either.
        Assert.Null(state.Consume("google", token));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not-a-real-state")]
    public void An_unknown_state_is_refused(string? token)
    {
        var (state, _) = Build();
        state.Create("google", 4, "http://panel/cb");

        Assert.Null(state.Consume("google", token));
    }

    [Fact]
    public void Each_flow_gets_its_own_state()
    {
        var (state, _) = Build();

        var first = state.Create("google", 1, "http://panel/cb");
        var second = state.Create("google", 2, "http://panel/cb");

        Assert.NotEqual(first, second);
        Assert.Equal(2, state.Consume("google", second)!.Value.ProfileId);
        Assert.Equal(1, state.Consume("google", first)!.Value.ProfileId);
    }

    [Fact]
    public void The_return_path_survives_the_round_trip()
    {
        var (state, _) = Build();
        var token = state.Create("google", 7, "http://panel/cb", "/settings/member?profile=7");

        var pending = state.Consume("google", token);

        // Linking a member other than the signed-in one has to report its result on that member's
        // page, so the destination must come back out of the state the callback presents.
        Assert.Equal("/settings/member?profile=7", pending!.Value.ReturnPath);
    }

    [Fact]
    public void A_flow_with_no_return_path_reports_none()
    {
        var (state, _) = Build();
        var token = state.Create("google", 7, "http://panel/cb");

        Assert.Null(state.Consume("google", token)!.Value.ReturnPath);
    }
}
