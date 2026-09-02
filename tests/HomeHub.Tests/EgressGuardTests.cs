namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Headers;
using HomeHub.Api.Ai;
using HomeHub.Api.Calendar;
using HomeHub.Api.Net;
using HomeHub.Api.Tasks;
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
    [InlineData("http://192.168.1.50:8080")]
    [InlineData("https://10.0.0.4:8443")]
    [InlineData("http://[::1]:8080")]
    public void A_local_destination_may_be_cleartext_on_this_house_s_own_network(string url)
    {
        Assert.Null(EgressGuard.Refuse(url, Local));
    }

    [Theory]
    [InlineData("http://203.0.113.10:8080")]
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
        Assert.Null(EgressGuard.Refuse("http://whisper.house.lan:8080", Local));
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
    }

    [Fact]
    public void A_deployment_may_approve_an_exact_origin_and_only_that_one()
    {
        string[] approved = ["http://192.168.1.10:8642"];

        Assert.Empty(HermesErrors("http://192.168.1.10:8642", approved));
        // The listener beside it is a different listener.
        Assert.NotEmpty(HermesErrors("http://192.168.1.10:8643", approved));
        // And a different machine is a different machine.
        Assert.NotEmpty(HermesErrors("http://192.168.1.11:8642", approved));
        // An approved origin is the whole authorisation, so loopback no longer passes by reach.
        Assert.NotEmpty(HermesErrors("http://127.0.0.1:8642", approved));
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
        Assert.Empty(HermesErrors("http://agent.example:8642"));

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

    // ---- The sinks that were missed ----

    /*
     * The account-link token exchange, which was built on the unnamed default client and so inherited
     * neither half of the policy. It is the worst one to have missed: the background providers send a
     * bearer and household content, and this sends the OAuth client secret, the authorization code and
     * the PKCE verifier — the whole of what it takes to mint tokens for a member's account.
     */
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
