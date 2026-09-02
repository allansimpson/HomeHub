namespace HomeHub.Tests;

using System.Net;
using System.Net.Sockets;
using System.Net.Http.Headers;
using HomeHub.Api.Ai;
using HomeHub.Api.Calendar;
using HomeHub.Api.HomeAssistant;
using HomeHub.Api.Net;
using HomeHub.Api.Tasks;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

/// <summary>
/// Where HomeHub is permitted to send household data and the credentials that reach it.
/// </summary>
/// <remarks>
/// <para>
/// Every outbound destination in this app was an unvalidated string. Cloud speech-to-text, local
/// speech-to-text, Google's token and calendar endpoints, Microsoft's token and Graph endpoints, and
/// each Hermes gateway: all of them took whatever configuration said and posted household audio,
/// calendar and task content, refresh tokens, client secrets and agent bearers to it.
/// </para>
/// <para>
/// Two of the failures those produced are worth naming here because a shape check alone would pass
/// them both. <b>A redirect</b> from an allowed origin re-sends the same body to a host that passed
/// no check — a 307 or 308 preserves the POST. <b>A name</b> that answers one way to a validator and
/// another way to the connection has defeated any amount of string checking. So there are two checks,
/// and these test both.
/// </para>
/// </remarks>
public class EgressGuardTests
{
    private static readonly EgressRule Internet =
        EgressRule.Internet("Test:Url", ["api.example.com"]);

    private static readonly EgressRule Local =
        EgressRule.HouseholdLan("Test:Local");

    // ---- Shape ----

    [Fact]
    public void An_allowed_https_host_passes()
    {
        Assert.Null(EgressGuard.Refuse("https://api.example.com", Internet));
    }

    [Theory]
    [InlineData("http://api.example.com")]
    [InlineData("ftp://api.example.com")]
    public void A_third_party_destination_must_be_https(string url)
    {
        Assert.Contains("https", EgressGuard.Refuse(url, Internet)!);
    }

    [Theory]
    [InlineData("https://api.example.com.attacker.example")]
    [InlineData("https://api-example.com")]
    [InlineData("https://apiexample.com")]
    public void A_lookalike_host_is_refused(string url)
    {
        Assert.Contains("not an allowed destination", EgressGuard.Refuse(url, Internet)!);
    }

    [Fact]
    public void Userinfo_is_refused_rather_than_ignored()
    {
        // The classic way to make a URL read as one host and resolve at another.
        Assert.Contains("userinfo", EgressGuard.Refuse("https://api.example.com@attacker.example", Internet)!);
    }

    [Theory]
    [InlineData("https://api.example.com?to=elsewhere")]
    [InlineData("https://api.example.com#elsewhere")]
    public void A_query_or_fragment_is_refused(string url)
    {
        Assert.Contains("query string or fragment", EgressGuard.Refuse(url, Internet)!);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(null)]
    [InlineData("api.example.com")]
    [InlineData("not a url")]
    public void An_absent_or_unparseable_destination_is_refused(string? url)
    {
        Assert.NotNull(EgressGuard.Refuse(url, Internet));
    }

    /*
     * A third party reached at a private address is not that third party — it is something on this
     * network answering to its name, which is the rebinding case caught at the shape stage when the
     * configuration states it outright.
     */
    [Theory]
    [InlineData("https://127.0.0.1")]
    [InlineData("https://10.1.2.3")]
    [InlineData("https://192.168.1.5")]
    public void A_third_party_destination_may_not_be_a_private_address(string url)
    {
        var rule = EgressRule.Internet("Test:Url", []);

        Assert.NotNull(EgressGuard.Refuse(url, rule));
    }

    // ---- Local reach ----

    [Theory]
    [InlineData("http://127.0.0.1:8080")]
    [InlineData("http://[::1]:8080")]
    [InlineData("https://10.0.0.4:8443")]
    [InlineData("https://192.168.1.50:8443")]
    public void A_local_destination_is_loopback_cleartext_or_TLS(string url)
    {
        Assert.Null(EgressGuard.Refuse(url, Local));
    }

    /*
     * <b>The rule extends here, and the extension is deliberate.</b> Geist's decision was about Home
     * Assistant and the bridge, and the reasoning does not stop at those two: a private address says
     * where a listener is and nothing about what it is, and a "local" sidecar takes the household's
     * recorded audio and the text it is about to speak aloud. A device on the LAN answering at that
     * address hears all of it, and everything between reads it on the way.
     */
    [Fact]
    public void A_local_destination_may_not_be_cleartext_once_it_leaves_this_machine()
    {
        var refusal = EgressGuard.Refuse("http://192.168.1.50:8080", Local);

        Assert.NotNull(refusal);
        Assert.Contains("in the clear", refusal);
    }

    [Theory]
    [InlineData("https://203.0.113.10:8443")]
    [InlineData("https://8.8.8.8")]
    public void A_local_destination_may_not_be_a_public_address(string url)
    {
        Assert.Contains("not on this house's own network", EgressGuard.Refuse(url, Local)!);
    }

    [Fact]
    public void A_local_destination_still_refuses_userinfo_and_odd_schemes()
    {
        Assert.NotNull(EgressGuard.Refuse("http://user:pw@127.0.0.1", Local));
        Assert.NotNull(EgressGuard.Refuse("ftp://127.0.0.1", Local));
    }

    /*
     * A hostname cannot be classified without resolving it, and resolving it at startup would be a
     * check the connection is free to disagree with. So the shape stage passes it and the dial-time
     * screen settles it — see the handler tests below.
     */
    [Fact]
    public void A_hostname_is_left_for_the_connection_to_settle()
    {
        // https, because a named host is not a loopback address and so may not be cleartext. Where it
        // resolves is the dial screen's question; that it is authenticated is this one's.
        Assert.Null(EgressGuard.Refuse("https://whisper.house.lan:8443", Local));
    }

    [Theory]
    [InlineData("127.0.0.1")]
    [InlineData("10.0.0.1")]
    [InlineData("172.16.0.1")]
    [InlineData("172.31.255.255")]
    [InlineData("192.168.0.1")]
    [InlineData("169.254.1.1")]
    [InlineData("::1")]
    [InlineData("fd00::1")]
    [InlineData("fe80::1")]
    [InlineData("::ffff:127.0.0.1")]
    public void These_are_this_house_s_own_addresses(string address)
    {
        Assert.True(EgressGuard.IsHouseholdLan(IPAddress.Parse(address)));
    }

    [Theory]
    [InlineData("8.8.8.8")]
    [InlineData("1.1.1.1")]
    [InlineData("172.32.0.1")]
    [InlineData("172.15.0.1")]
    [InlineData("192.169.0.1")]
    [InlineData("2606:4700::1111")]
    public void And_these_are_not(string address)
    {
        Assert.False(EgressGuard.IsHouseholdLan(IPAddress.Parse(address)));
    }

    /*
     * Carrier-grade NAT is the range that made "not public" the wrong question. It is not publicly
     * routable, so an earlier version admitted it as household — and it is the ISP's space, shared
     * with every other subscriber behind the same equipment. It belongs to neither side, and both
     * sides refuse it.
     */
    [Theory]
    [InlineData("100.64.0.1")]
    [InlineData("100.127.255.254")]
    [InlineData("0.1.2.3")]
    [InlineData("224.0.0.1")]
    public void Space_that_is_neither_ours_nor_the_internet_s_is_refused_by_both(string address)
    {
        var parsed = IPAddress.Parse(address);

        Assert.False(EgressGuard.IsHouseholdLan(parsed));
        Assert.False(EgressGuard.IsPubliclyRoutable(parsed));
    }

    [Fact]
    public void A_household_sidecar_may_not_sit_in_carrier_grade_NAT()
    {
        Assert.NotNull(EgressGuard.Refuse("http://100.64.0.1:8080", Local));
    }

    // ---- Redirects ----

    /// <summary>Answers a 307 pointing at a second host, and records what was sent to each.</summary>
    private sealed class RedirectingHandler : HttpMessageHandler
    {
        public List<Uri?> Sent { get; } = [];
        public List<string?> Credentials { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Sent.Add(request.RequestUri);
            Credentials.Add(request.Headers.Authorization?.Parameter);

            if (request.RequestUri!.Host == "api.openai.com")
            {
                var moved = new HttpResponseMessage(HttpStatusCode.TemporaryRedirect);
                moved.Headers.Location = new Uri("https://attacker.example/v1/audio/transcriptions");
                return Task.FromResult(moved);
            }

            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("""{"text":"stolen"}""", System.Text.Encoding.UTF8, "application/json"),
            });
        }
    }

    /*
     * The finding. `CloudSpeechEndpoint` validated the initial URL and the client then followed
     * whatever it was told to — and a 307 preserves the method and the body, so the same raw household
     * audio was re-posted to a host that had passed no check at all.
     *
     * `HttpClient` follows redirects in its *primary handler*, so a test handler placed above one
     * cannot exercise the real behaviour; what this pins is the property the fix depends on. The
     * production handler sets `AllowAutoRedirect = false`, asserted separately below.
     */
    [Fact]
    public async Task A_redirect_is_not_followed_and_the_second_host_receives_nothing()
    {
        var handler = new RedirectingHandler();
        var options = new AiOptions { OpenAiApiKey = "sk-test" };
        var stt = new OpenAISpeechToText(new HttpClient(handler), Options.Create(options));

        await Assert.ThrowsAsync<HttpRequestException>(() =>
            stt.TranscribeAsync(new MemoryStream([1, 2, 3]), "a.webm", "audio/webm", CancellationToken.None));

        // One request, to the allowed host. The audio never reached the second server.
        Assert.Equal(new Uri("https://api.openai.com/v1/audio/transcriptions"), Assert.Single(handler.Sent));
        Assert.DoesNotContain(handler.Sent, u => u!.Host == "attacker.example");
    }

    [Fact]
    public void The_guarded_handler_follows_no_redirects()
    {
        using var handler = EgressGuard.CreateHandler(() => Internet);

        // The property the fix rests on: without it the 3xx above is followed inside the handler,
        // below anything a test or a policy check can see.
        Assert.False(handler.AllowAutoRedirect);
        Assert.NotNull(handler.ConnectCallback);
    }

    // ---- Dial-time screening ----

    private static async Task<Exception?> Dial(EgressRule rule, string host, int port = 443)
    {
        using var handler = EgressGuard.CreateHandler(() => rule);
        using var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(5) };
        return await Record.ExceptionAsync(() => client.GetAsync($"http://{host}:{port}/"));
    }

    /*
     * The half a string check cannot do. A name that resolves onto this machine is refused for a
     * third-party rule at the moment of connection, whatever the configuration said — which is the
     * rebinding case, and the reason the screen is in the connect callback rather than before the send.
     */
    [Fact]
    public async Task A_third_party_name_resolving_onto_this_machine_is_not_dialled()
    {
        var rule = EgressRule.Internet("Test:Url", ["localhost"]);

        var error = await Dial(rule, "localhost", 9);

        Assert.Contains("not a publicly routable address", Flatten(error));
    }

    [Fact]
    public async Task A_host_outside_the_allowlist_is_not_dialled_even_if_it_would_resolve()
    {
        var rule = EgressRule.Internet("Test:Url", ["api.example.com"]);

        var error = await Dial(rule, "127.0.0.1", 9);

        Assert.Contains("not an allowed destination", Flatten(error));
    }

    private static string Flatten(Exception? error)
    {
        var text = "";
        for (var e = error; e is not null; e = e.InnerException) text += e.Message + " | ";
        return text;
    }

    // ---- The provider rules ----

    [Fact]
    public void Google_defaults_to_google_s_own_hosts_and_refuses_anything_else()
    {
        var options = new GoogleCalendarOptions { ClientId = "id", ClientSecret = "secret" };
        Assert.Null(options.RefuseDestinations());
        Assert.True(options.IsConfigured);

        options.TokenUrl = "https://attacker.example/token";
        Assert.NotNull(options.RefuseDestinations());
        // Fail closed: the provider deactivates rather than posting a refresh token to it.
        Assert.False(options.IsConfigured);
        Assert.True(options.IsAppRegistered);
    }

    [Theory]
    [InlineData("http://oauth2.googleapis.com/token")]
    [InlineData("https://oauth2.googleapis.com.attacker.example/token")]
    [InlineData("https://user:pw@oauth2.googleapis.com/token")]
    public void Google_refuses_cleartext_lookalikes_and_userinfo(string tokenUrl)
    {
        var options = new GoogleCalendarOptions
        {
            ClientId = "id", ClientSecret = "secret", TokenUrl = tokenUrl,
        };

        Assert.NotNull(options.RefuseDestinations());
    }

    [Fact]
    public void Google_honours_an_explicitly_named_host()
    {
        var options = new GoogleCalendarOptions
        {
            ClientId = "id",
            ClientSecret = "secret",
            TokenUrl = "https://proxy.example/token",
            ApiBaseUrl = "https://proxy.example/calendar/v3",
            AuthorizeUrl = "https://proxy.example/auth",
            AllowedHosts = ["proxy.example"],
        };

        Assert.Null(options.RefuseDestinations());
    }

    [Fact]
    public void Microsoft_is_held_to_the_same_rule_and_the_grocery_mirror_shares_it()
    {
        var options = new MicrosoftTodoOptions { ClientId = "id", ClientSecret = "secret" };
        Assert.Null(options.RefuseDestinations());

        options.GraphBaseUrl = "https://graph.microsoft.com.attacker.example/v1.0";
        Assert.NotNull(options.RefuseDestinations());
        Assert.False(options.IsConfigured);
    }

    // ---- Hermes ----

    private static IEnumerable<string> HermesErrors(string baseUrl, string[]? approvedOrigins = null) =>
        new HermesOptionsValidator()
            .Validate(null, new HermesOptions
            {
                AllowedGatewayOrigins = [.. approvedOrigins ?? []],
                Agents = new()
                {
                    ["barnaby"] = new HermesAgentOptions
                    {
                        Name = "Barnaby", BaseUrl = baseUrl, ApiKey = "k", Default = true,
                    },
                },
            })
            .Failures ?? [];

    [Theory]
    [InlineData("http://127.0.0.1:8642")]
    [InlineData("http://[::1]:8642")]
    [InlineData("https://127.0.0.1:8642")]
    public void A_hermes_gateway_on_this_machine_is_accepted(string baseUrl)
    {
        Assert.Empty(HermesErrors(baseUrl));
    }

    /*
     * The decision this encodes: a reach test was the first attempt and is too generous here. A
     * gateway receives an agent's own API_SERVER_KEY and the household's conversations, and answers
     * with tool-bearing responses the panel acts on. A typo landing on another box, or a device on the
     * same network somebody else controls, satisfies "has a private address" and must not thereby
     * qualify. So the LAN is refused by default.
     */
    [Fact]
    public void A_hermes_gateway_merely_somewhere_on_the_LAN_is_not()
    {
        Assert.NotEmpty(HermesErrors("http://192.168.1.10:8642"));
        // Not even over TLS: without an approved origin the default is this machine.
        Assert.NotEmpty(HermesErrors("https://192.168.1.10:8642"));
    }

    [Fact]
    public void A_deployment_may_approve_an_exact_origin_and_only_that_one()
    {
        string[] approved = ["https://hermes.house.lan:8642"];

        Assert.Empty(HermesErrors("https://hermes.house.lan:8642", approved));
        // The listener beside it is a different listener.
        Assert.NotEmpty(HermesErrors("https://hermes.house.lan:8643", approved));
        // And a different machine is a different machine.
        Assert.NotEmpty(HermesErrors("https://hermes.other.lan:8642", approved));
        // An approved origin is the whole authorisation, so loopback no longer passes by reach.
        Assert.NotEmpty(HermesErrors("http://127.0.0.1:8642", approved));
    }

    /*
     * <b>This test used to approve a plain-http gateway, which is the finding written down as an
     * assertion.</b> `Refuse` returned the moment the origin matched, before the transport was looked
     * at — so naming an http origin in the allowlist authorised sending it an agent's own
     * API_SERVER_KEY and the household's conversations in the clear. Listing a destination says which
     * machine is meant; it says nothing about whether the machine answering is that one.
     */
    [Fact]
    public void Approving_an_origin_does_not_buy_it_a_transport()
    {
        string[] approved = ["http://192.168.1.10:8642"];

        var errors = HermesErrors("http://192.168.1.10:8642", approved).ToList();

        Assert.NotEmpty(errors);
        Assert.Contains(errors, e => e.Contains("in the clear"));
    }

    [Fact]
    public void An_approved_loopback_origin_may_still_be_cleartext()
    {
        // Nothing touches a wire, which is the whole of the exemption.
        Assert.Empty(HermesErrors("http://127.0.0.1:8642", ["http://127.0.0.1:8642"]));
    }

    /*
     * The contradiction that made an approved HTTPS gateway unreachable: the shape check accepted it
     * and the dial screen then refused it as "not on this machine", because `EgressRule.Origins` was
     * hard-coded to loopback reach. An approved origin's identity is its origin and its certificate.
     */
    [Fact]
    public async Task An_approved_non_loopback_origin_survives_the_dial_screen()
    {
        var rule = HermesOptionsValidator.GatewayRule("barnaby", ["https://one.one.one.one:9"]);

        Assert.Null(EgressGuard.Refuse("https://one.one.one.one:9", rule));

        var error = await Dial(rule, "one.one.one.one", 9);

        // Refused by the socket — nothing listens on discard — and not by the screen.
        Assert.DoesNotContain("not on this machine", Flatten(error));
        Assert.DoesNotContain("not an approved origin", Flatten(error));
    }

    [Fact]
    public async Task An_approved_http_origin_that_does_not_resolve_locally_is_not_dialled()
    {
        // The shape check sees `one.one.one.one` and cannot classify it; the dial screen sees what the
        // socket would actually connect to.
        var rule = HermesOptionsValidator.GatewayRule("barnaby", ["http://one.one.one.one:9"]);

        var error = await Dial(rule, "one.one.one.one", 9);

        Assert.Contains("does not resolve to this machine", Flatten(error));
    }

    /*
     * `BaseUrl` documented a loopback gateway and accepted any absolute URL. A public or cleartext
     * origin receives that agent's own API_SERVER_KEY and then the household's conversation content,
     * and answers with tool-bearing responses the panel acts on. Documentation is not a boundary.
     */
    [Theory]
    [InlineData("http://203.0.113.9:8642")]
    [InlineData("https://8.8.8.8")]
    public void A_hermes_gateway_off_it_is_refused_at_startup(string baseUrl)
    {
        Assert.NotEmpty(HermesErrors(baseUrl));
    }

    /*
     * A named gateway passes the shape check and is settled at dial time instead — the honest split,
     * because resolving a name at startup would be a check the connection is free to disagree with.
     * The connect screen is what refuses it, and it refuses the addresses rather than the name.
     */
    [Fact]
    public async Task A_named_hermes_gateway_that_resolves_off_this_machine_is_not_dialled()
    {
        // Passes the shape check — https, and a name this cannot classify — and is settled at dial.
        Assert.Empty(HermesErrors("https://agent.example:8642"));

        var error = await Dial(HermesOptionsValidator.GatewayRule("barnaby"), "one.one.one.one", 9);

        Assert.Contains("not on this machine", Flatten(error));
    }

    /*
     * The default is loopback, so a name that resolves to this machine still passes — which keeps the
     * documented deployment working while refusing everything else.
     */
    [Fact]
    public async Task A_named_hermes_gateway_on_this_machine_is_dialled()
    {
        var error = await Dial(HermesOptionsValidator.GatewayRule("barnaby"), "localhost", 9);

        // Refused by the socket, not by the screen: nothing is listening on discard.
        Assert.DoesNotContain("not on this machine", Flatten(error));
    }

    [Fact]
    public void A_hermes_gateway_may_not_carry_userinfo_or_a_query()
    {
        Assert.NotEmpty(HermesErrors("http://user:pw@127.0.0.1:8642"));
        Assert.NotEmpty(HermesErrors("http://127.0.0.1:8642?to=elsewhere"));
    }

    /*
     * Rechecked when the client is built, not only at startup: `Hermes` is bound through
     * `IOptionsMonitor` so a reload can replace an address that passed validation at boot.
     */
    [Fact]
    public void A_gateway_that_becomes_unacceptable_is_not_handed_the_credential()
    {
        var options = new HermesOptions
        {
            Agents = new()
            {
                ["barnaby"] = new HermesAgentOptions
                {
                    Name = "Barnaby", BaseUrl = "https://192.168.1.10:8642", ApiKey = "k", Default = true,
                },
            },
        };
        var factory = new HermesClientFactory(
            new StubHttpClientFactory(),
            new StubOptionsMonitor<HermesOptions>(options),
            Microsoft.Extensions.Logging.Abstractions.NullLogger<HermesClientFactory>.Instance);

        // A LAN address, which the loopback default refuses — before any client exists to carry the bearer.
        Assert.Null(factory.Create("barnaby"));
    }

    // ---- Home Assistant ----

    private static HomeAssistantOptions Ha(string baseUrl, string[]? origins = null) =>
        new()
        {
            BaseUrl = baseUrl,
            Token = "long-lived",
            AllowedOrigins = [.. origins ?? []],
        };

    /*
     * A private address proves where a listener is, not what it is. The reach test that came first
     * stopped this bearer leaving the house and did nothing about the house itself: any LAN device
     * answering on the configured address receives a token with service-call permission, the
     * household's state, and the commands that change it.
     */
    [Fact]
    public void A_home_assistant_merely_somewhere_on_the_LAN_is_refused()
    {
        Assert.NotNull(Ha("http://192.168.1.20:8123").RefuseDestination());
    }

    [Fact]
    public void An_approved_home_assistant_origin_is_exact()
    {
        string[] approved = ["https://ha.house.lan:8123"];

        Assert.Null(Ha("https://ha.house.lan:8123", approved).RefuseDestination());
        // The listener on the next port is a different program.
        Assert.NotNull(Ha("https://ha.house.lan:8124", approved).RefuseDestination());
        Assert.NotNull(Ha("https://ha.attacker.example:8123", approved).RefuseDestination());
    }

    /*
     * <b>There was an acknowledgement flag here and it is gone.</b> It recorded that a deployment
     * accepted a readable bearer on its own network, which is a different thing from making the
     * bearer safe: an exact origin stops the traffic being rerouted and authenticates nothing about
     * the machine answering there, so a device taking that address by DHCP lease still receives a
     * long-lived service-call token. Accepting a risk is not closing it, and there is no escape hatch.
     */
    [Fact]
    public void Cleartext_to_a_non_loopback_home_assistant_is_refused_however_it_is_configured()
    {
        var refusal = Ha("http://ha.house.lan:8123", ["http://ha.house.lan:8123"]).RefuseDestination();

        Assert.NotNull(refusal);
        Assert.Contains("in the clear", refusal);
        // Naming the origin does not buy it a transport. The same origin over https does.
        Assert.Null(Ha("https://ha.house.lan:8123", ["https://ha.house.lan:8123"]).RefuseDestination());
    }

    [Theory]
    [InlineData("http://192.168.1.20:8123")]
    [InlineData("http://ha.local:8123")]
    [InlineData("http://10.0.0.5:8123")]
    public void No_configuration_admits_a_cleartext_home_assistant_off_this_machine(string baseUrl)
    {
        // Approved or not: the refusal is about the transport, not the destination.
        Assert.NotNull(Ha(baseUrl, [baseUrl]).RefuseDestination());
        Assert.NotNull(Ha(baseUrl).RefuseDestination());
    }

    [Theory]
    [InlineData("http://127.0.0.1:8123")]
    [InlineData("http://[::1]:8123")]
    public void Cleartext_to_a_loopback_address_is_permitted(string baseUrl)
    {
        // Nothing touches a wire, so there is nothing to intercept.
        Assert.Null(Ha(baseUrl).RefuseDestination());
    }

    /*
     * `localhost` is a name, and `Uri.IsLoopback` says true for it. What the resolver returns is
     * `/etc/hosts`, a search domain, a DHCP-supplied suffix — none of which this app controls. The
     * cleartext exemption is the claim that the traffic cannot reach a wire, so it is granted to
     * addresses that cannot rather than to a string that usually means one.
     */
    [Fact]
    public void Cleartext_to_the_name_localhost_is_not_a_loopback_exemption()
    {
        Assert.NotNull(Ha("http://localhost:8123").RefuseDestination());
        Assert.Null(Ha("https://localhost:8123", ["https://localhost:8123"]).RefuseDestination());
    }

    [Fact]
    public void A_refused_home_assistant_reads_as_unconfigured_rather_than_being_used()
    {
        var options = Ha("http://192.168.1.20:8123");

        // Fail closed: the panel falls back to simulated climate rather than posting the token at it.
        Assert.False(options.IsConfigured);
    }

    /*
     * The obsolete acknowledgement, exercised through configuration binding rather than the type.
     *
     * <b>This is the regression the previous round should have written.</b> What I offered instead was
     * a forced fail-open in `RefuseDestination`, which made five tests go red and proved only that the
     * tests notice when the method stops working. It could not be evidence against the *previous
     * implementation*, because the tests no longer compile against it: the property they would have to
     * set does not exist any more.
     *
     * Binding from configuration does not care whether the property exists. A deployment carrying the
     * old key in `homehub.env` — which is exactly what an upgraded one carries — binds cleanly here,
     * and the question is what the result then permits. Against `016c95b` this configuration allowed
     * cleartext to a LAN listener; it must not now.
     */
    [Fact]
    public void The_obsolete_cleartext_acknowledgement_no_longer_permits_anything()
    {
        var configuration = new Microsoft.Extensions.Configuration.ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["HomeAssistant:BaseUrl"] = "http://ha.house.lan:8123",
                ["HomeAssistant:Token"] = "long-lived",
                ["HomeAssistant:AllowedOrigins:0"] = "http://ha.house.lan:8123",
                // The key a deployment upgraded from 016c95b still has in its environment file.
                ["HomeAssistant:AcknowledgeCleartextLan"] = "true",
            })
            .Build();

        var options = configuration.GetSection(HomeAssistantOptions.Section).Get<HomeAssistantOptions>()!;

        Assert.NotNull(options.RefuseDestination());
        Assert.False(options.IsConfigured);
    }

    /*
     * And the key itself is gone rather than ignored, so a deployment that keeps it is not quietly
     * carrying a setting that reads as meaningful. `IConfiguration` binding tolerates unknown keys, so
     * nothing breaks; there is simply nothing there to set.
     */
    [Fact]
    public void There_is_no_acknowledgement_property_left_to_set()
    {
        Assert.Null(typeof(HomeAssistantOptions).GetProperty("AcknowledgeCleartextLan"));
    }

    // ---- The sinks that were missed ----

    /*
     * The account-link token exchange, which was built on the unnamed default client and so inherited
     * neither half of the policy. It is the worst one to have missed: the background providers send a
     * bearer and household content, and this sends the OAuth client secret, the authorization code and
     * the PKCE verifier — the whole of what it takes to mint tokens for a member's account.
     */
    /*
     * The invariant, resolved through real DI rather than read off a registration line.
     *
     * <b>The previous version of this claim was false and the test agreed with it.</b> A named client
     * called "unconfigured" was registered in the belief that it left the unnamed default
     * unregistered; `CreateClient()` returns whatever sits under `Options.DefaultName`, which is the
     * empty string, and that slot was still the framework's. Reading registration lines could not see
     * that. Asking the container for the thing the caller would actually get can.
     */
    [Fact]
    public async Task The_default_client_refuses_every_connection()
    {
        using var app = new HubAppFactory();
        var factory = app.Services.GetRequiredService<IHttpClientFactory>();

        using var client = factory.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(5);
        var error = await Record.ExceptionAsync(() => client.GetAsync("http://127.0.0.1:9/"));

        Assert.Contains("unconfigured HTTP client", Flatten(error));
    }

    /*
     * A proxy defeats the connect callback completely: the connection is made to the proxy, so the
     * addresses screened are the proxy's, and the destination is reached by asking it to go there.
     * Every check would pass while the household's audio went elsewhere. `HttpClient` picks proxies up
     * from the environment by default, so this is not a hypothetical setting somebody has to choose —
     * it is the one they have to remember to switch off.
     */
    [Fact]
    public void No_confined_handler_will_use_a_proxy()
    {
        using var guarded = EgressGuard.CreateHandler(() => Internet);
        using var blocking = EgressGuard.CreateBlockingHandler();
        using var fetcher = HomeHub.Api.Meals.RecipeFetcher.CreateGuardedHandler(new HomeHub.Api.Meals.MealsOptions());

        Assert.False(guarded.UseProxy);
        Assert.False(blocking.UseProxy);
        Assert.False(fetcher.UseProxy);
    }

    [Fact]
    public void The_account_link_exchange_asks_for_a_guarded_client_by_name()
    {
        var source = File.ReadAllText(SourcePath("src/HomeHub.Api/Controllers/AccountLinkController.cs"));

        Assert.Contains("GuardedClients.Google", source);
        Assert.Contains("GuardedClients.Microsoft", source);
        // The shape this replaced. An unnamed client is the framework default: no screen, redirects on.
        Assert.DoesNotContain("_http.CreateClient()", source);
    }

    /*
     * The class, asserted as a class.
     *
     * Two consecutive reviews found the same fault in places the previous round had not enumerated —
     * so what is pinned here is not another instance but the absence of the shape that produced them.
     * A registration with no primary handler gets the framework's, which follows redirects and screens
     * nothing; if a future one is added without a guard, this fails and names it.
     */
    [Fact]
    public void Every_outbound_client_registration_is_guarded()
    {
        var program = File.ReadAllText(SourcePath("src/HomeHub.Api/Program.cs"));
        var unguarded = new List<string>();

        foreach (var line in program.Split('\n'))
        {
            var trimmed = line.Trim();
            if (!trimmed.StartsWith("builder.Services.AddHttpClient", StringComparison.Ordinal)) continue;
            // A registration that ends its own statement has no handler configured after it.
            if (trimmed.EndsWith(");", StringComparison.Ordinal)) unguarded.Add(trimmed);
        }

        Assert.True(
            unguarded.Count == 0,
            "These HttpClient registrations configure no primary handler, so they follow redirects and "
            + "screen no address:\n  " + string.Join("\n  ", unguarded));
    }

    /*
     * And the handler families themselves, since reading registration lines proves only that *a*
     * handler was configured. Every one this app builds must refuse redirects and refuse a proxy;
     * a new family that forgets either is a new instance of a fault this has now had three rounds of.
     */
    [Fact]
    public void Every_handler_family_refuses_redirects_and_proxies()
    {
        var handlers = new (string Name, SocketsHttpHandler Handler)[]
        {
            ("EgressGuard.CreateHandler", EgressGuard.CreateHandler(() => Internet)),
            ("EgressGuard.CreateBlockingHandler", EgressGuard.CreateBlockingHandler()),
            ("RecipeFetcher.CreateGuardedHandler",
                HomeHub.Api.Meals.RecipeFetcher.CreateGuardedHandler(new HomeHub.Api.Meals.MealsOptions())),
        };

        foreach (var (name, handler) in handlers)
        {
            using (handler)
            {
                Assert.False(handler.AllowAutoRedirect, $"{name} follows redirects.");
                Assert.False(handler.UseProxy, $"{name} would use a proxy, which bypasses its address screen.");
            }
        }
    }

    /// <summary>The repository root, found by walking up from the test binary.</summary>
    private static string SourcePath(string relative)
    {
        var dir = AppContext.BaseDirectory;
        while (dir is not null && !Directory.Exists(Path.Combine(dir, "src", "HomeHub.Api")))
            dir = Path.GetDirectoryName(dir);
        Assert.NotNull(dir);
        return Path.Combine(dir!, relative.Replace('/', Path.DirectorySeparatorChar));
    }

    private sealed class StubHttpClientFactory : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new();
    }

    private sealed class StubOptionsMonitor<T>(T value) : IOptionsMonitor<T>
    {
        public T CurrentValue { get; } = value;
        public T Get(string? name) => CurrentValue;
        public IDisposable? OnChange(Action<T, string?> listener) => null;
    }
}
