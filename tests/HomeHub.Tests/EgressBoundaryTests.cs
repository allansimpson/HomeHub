namespace HomeHub.Tests;

using System.Net;
using System.Net.Http.Json;
using HomeHub.Api.Net;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Http;
using Microsoft.Extensions.Options;

/// <summary>
/// Every registered HTTP client, discovered at runtime, pointed somewhere it may not go.
/// </summary>
/// <remarks>
/// <para>
/// <b>This is the invariant the last five reviews were each finding one instance of.</b> Each round
/// closed the destination it named and left a sibling: one endpoint guarded and four not, an OAuth
/// exchange on the unnamed default, the default never actually denied, proxies enabled everywhere, a
/// speech server screened at the socket and shape-checked nowhere. Every one of those was a true
/// statement about a class that nothing enumerated, and a hand-kept inventory failed five times.
/// </para>
/// <para>
/// So nothing here is written down. The clients come from the container —
/// <c>IConfigureOptions&lt;HttpClientFactoryOptions&gt;</c> carries the name of every registration
/// there is — and each one is driven at a listener that is genuinely running and genuinely reachable.
/// A client that answers the listener has escaped, whatever its rule was meant to say, and the test
/// names it. A registration added next year is in the list without anybody adding it.
/// </para>
/// <para>
/// <b>The destination is `http://localhost:&lt;port&gt;`, which is refused for two different reasons
/// and reachable for real.</b> `localhost` is a name rather than a literal loopback address, so the
/// transport rule refuses cleartext to it; and it is not on any allowlist, so the host rule refuses it
/// too. The listener sits on 127.0.0.1, so if either check is missing the request lands and is
/// counted. A destination that were merely unreachable would prove nothing.
/// </para>
/// </remarks>
public class EgressBoundaryTests
{
    /// <summary>
    /// A real listener that counts every byte anything sends it.
    /// </summary>
    /// <remarks>
    /// <b>A raw socket, deliberately, and the first version of this used <c>HttpListener</c> and was
    /// wrong.</b> `HttpListener` matches its prefixes against the request's `Host` header, so a probe
    /// addressed to `localhost` against a listener bound to `127.0.0.1` is rejected inside the
    /// framework and never reaches `GetContextAsync`. The count stayed at zero whether or not the
    /// guard was doing anything — a test that passes because it cannot see the failure. This counts
    /// connections and bytes at the socket, where nothing can filter them on the way.
    /// </remarks>
    private sealed class CountingListener : IDisposable
    {
        private readonly System.Net.Sockets.TcpListener _listener;
        private readonly CancellationTokenSource _stopping = new();
        public int Requests;
        public long BytesReceived;

        public CountingListener()
        {
            _listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
            _listener.Start();
            Port = ((IPEndPoint)_listener.LocalEndpoint).Port;
            _ = Task.Run(Loop);
        }

        public int Port { get; }

        private async Task Loop()
        {
            while (!_stopping.IsCancellationRequested)
            {
                System.Net.Sockets.TcpClient socket;
                try { socket = await _listener.AcceptTcpClientAsync(_stopping.Token); }
                catch { return; }

                _ = Task.Run(async () =>
                {
                    using (socket)
                    {
                        Interlocked.Increment(ref Requests);
                        var stream = socket.GetStream();
                        var buffer = new byte[8192];
                        try
                        {
                            // One read is enough: anything at all having arrived is the finding.
                            var read = await stream.ReadAsync(buffer, _stopping.Token);
                            Interlocked.Add(ref BytesReceived, read);
                            var response = System.Text.Encoding.ASCII.GetBytes(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                                + "Content-Length: 2\r\nConnection: close\r\n\r\n{}");
                            await stream.WriteAsync(response, _stopping.Token);
                        }
                        catch { /* the client hung up; it still connected, which is what is counted */ }
                    }
                });
            }
        }

        public void Dispose()
        {
            _stopping.Cancel();
            try { _listener.Stop(); } catch { /* already down */ }
            _stopping.Dispose();
        }
    }

    /// <summary>
    /// Every client name the container knows about.
    /// </summary>
    /// <remarks>
    /// Read from the options system rather than from a list in this file, which is the whole point:
    /// `AddHttpClient` in any form registers a named <c>HttpClientFactoryOptions</c>, so this is the
    /// registrations themselves rather than somebody's account of them. The empty name is the deny-all
    /// default and belongs in the sweep like any other.
    /// </remarks>
    private static IReadOnlyList<string> RegisteredClientNames(IServiceProvider services) =>
        [.. services.GetServices<IConfigureOptions<HttpClientFactoryOptions>>()
            .OfType<ConfigureNamedOptions<HttpClientFactoryOptions>>()
            .Select(c => c.Name ?? "")
            .Distinct(StringComparer.Ordinal)
            .OrderBy(n => n, StringComparer.Ordinal)];

    /// <summary>
    /// A factory with every optional integration configured, so every registration exists.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Several clients are registered only when their provider is configured — Google, Microsoft,
    /// SensorPush, Home Assistant, the vendor vision path. Without these the sweep would quietly cover
    /// fewer clients than the app has, which is the shape of failure this test exists to prevent.
    /// </para>
    /// <para>
    /// Every value here is one the policy <b>permits</b>, so the app starts and every client is
    /// constructible. What is then proved is about the destination each client is *driven* at, which
    /// is the boundary rather than the configuration: a permitted base address must not become
    /// permission to go elsewhere.
    /// </para>
    /// </remarks>
    private static HubAppFactory FullyConfigured(int port) => new()
    {
        Settings =
        {
            // Internet reach: the providers' own hosts, over https.
            ["Ai:OpenAiApiKey"] = "sk-test",
            ["Google:ClientId"] = "id",
            ["Google:ClientSecret"] = "secret",
            ["Microsoft:ClientId"] = "id",
            ["Microsoft:ClientSecret"] = "secret",
            ["SensorPush:Email"] = "someone@example.com",
            ["SensorPush:Password"] = "hunter2",
            ["EventCapture:ApiKey"] = "sk-test",
            // Household and loopback reach: literal addresses on this machine, which cleartext allows.
            ["Voice:Stt:LocalEndpoint"] = $"http://127.0.0.1:{port}",
            ["Voice:Tts:Chatterbox:Endpoint"] = $"http://127.0.0.1:{port}",
            ["HomeAssistant:BaseUrl"] = $"http://127.0.0.1:{port}",
            ["HomeAssistant:Token"] = "long-lived",
            ["Hermes:Agents:barnaby:Name"] = "Barnaby",
            ["Hermes:Agents:barnaby:BaseUrl"] = $"http://127.0.0.1:{port}",
            ["Hermes:Agents:barnaby:ApiKey"] = "k",
            ["Hermes:Agents:barnaby:Default"] = "true",
        },
    };

    // ---- The negative ----

    /*
     * The sweep. Every registered client, driven at a live listener whose origin no rule permits.
     * Nothing may arrive — not a request, not a byte of a body.
     */
    [Fact]
    public async Task No_registered_client_can_reach_a_destination_no_rule_permits()
    {
        using var listener = new CountingListener();
        using var app = FullyConfigured(listener.Port);
        var factory = app.Services.GetRequiredService<IHttpClientFactory>();

        var names = RegisteredClientNames(app.Services);
        // If this ever reads low, the discovery has broken and the sweep is vacuous.
        Assert.True(names.Count >= 10, $"Only {names.Count} clients discovered; the sweep would prove little.");

        var escaped = new List<string>();
        foreach (var name in names)
        {
            using var client = factory.CreateClient(name);
            client.Timeout = TimeSpan.FromSeconds(5);
            var before = Volatile.Read(ref listener.Requests);

            try
            {
                // POST with a body, so an escape is measured in the household's bytes and not only in
                // a request count.
                await client.PostAsJsonAsync(
                    $"http://localhost:{listener.Port}/probe",
                    new { prompt = "is the back door locked", history = new[] { "earlier" } });
            }
            catch
            {
                // Refused, which is the expected outcome for every one of them.
            }

            if (Volatile.Read(ref listener.Requests) != before)
                escaped.Add(string.IsNullOrEmpty(name) ? "(the unnamed default)" : name);
        }

        Assert.True(
            escaped.Count == 0,
            "These clients reached a destination no rule permits:\n  " + string.Join("\n  ", escaped));
        Assert.Equal(0, Volatile.Read(ref listener.Requests));
        Assert.Equal(0L, Interlocked.Read(ref listener.BytesReceived));
    }

    /*
     * And a deployment that configures one of these as non-loopback cleartext does not start at all.
     *
     * Stronger than refusing at the request, and worth pinning separately: the operator is told at
     * boot rather than by nothing happening when somebody speaks. Startup validation is the reason the
     * sweep above has to use permitted values — the app will not build with these.
     */
    [Theory]
    [InlineData("Voice:Stt:LocalEndpoint")]
    [InlineData("Voice:Tts:Chatterbox:Endpoint")]
    public void A_misconfigured_voice_destination_refuses_to_start(string key)
    {
        using var listener = new CountingListener();
        var app = FullyConfigured(listener.Port);
        app.Settings[key] = $"http://elsewhere.example:{listener.Port}";

        // `CreateClient` is what starts the host, which is where `ValidateOnStart` runs.
        var failure = Record.Exception(() => app.CreateAnonymousClient());

        Assert.NotNull(failure);
        Assert.Contains("in the clear", Flatten(failure));
        Assert.Equal(0, Volatile.Read(ref listener.Requests));
        app.Dispose();
    }

    private static string Flatten(Exception? error)
    {
        var text = "";
        for (var e = error; e is not null; e = e.InnerException) text += e.Message + " | ";
        return text;
    }

    // ---- The positives, so the guard is not merely refusing everything ----

    /*
     * A guarded client that is pointed somewhere it *is* allowed must actually work. Without this the
     * sweep above is satisfied by a boundary that refuses the whole world, which would pass every
     * security test and ship a panel that talks to nothing.
     */
    [Fact]
    public async Task A_literal_loopback_http_destination_is_delivered_where_the_rule_allows_it()
    {
        using var listener = new CountingListener();
        var services = new ServiceCollection();
        services.AddGuardedHttpClient("probe", _ => EgressRule.HouseholdLan("Test:Endpoint"));
        using var provider = services.BuildServiceProvider();

        using var client = provider.GetRequiredService<IHttpClientFactory>().CreateClient("probe");
        var response = await client.GetAsync($"http://127.0.0.1:{listener.Port}/probe");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(1, Volatile.Read(ref listener.Requests));
    }

    [Fact]
    public async Task An_approved_origin_is_delivered_and_its_neighbour_is_not()
    {
        using var listener = new CountingListener();
        var approved = $"http://127.0.0.1:{listener.Port}";
        var services = new ServiceCollection();
        services.AddGuardedHttpClient("probe", _ => EgressRule.Origins("Test:Origin", [approved]));
        using var provider = services.BuildServiceProvider();
        var factory = provider.GetRequiredService<IHttpClientFactory>();

        using var client = factory.CreateClient("probe");
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync($"{approved}/probe")).StatusCode);

        // The listener on the next port is a different program, and the approval named this one.
        using var neighbour = factory.CreateClient("probe");
        await Assert.ThrowsAnyAsync<Exception>(
            () => neighbour.GetAsync($"http://127.0.0.1:{listener.Port + 1}/probe"));

        Assert.Equal(1, Volatile.Read(ref listener.Requests));
    }

    /*
     * The request guard sees the scheme, which the connect callback cannot — that is the whole reason
     * it exists. A destination that resolves to an address the socket screen would happily dial must
     * still be refused when the transport is wrong.
     */
    [Fact]
    public async Task The_request_guard_refuses_a_scheme_the_socket_screen_cannot_see()
    {
        using var listener = new CountingListener();
        var services = new ServiceCollection();
        services.AddGuardedHttpClient("probe", _ => EgressRule.HouseholdLan("Test:Endpoint"));
        using var provider = services.BuildServiceProvider();

        using var client = provider.GetRequiredService<IHttpClientFactory>().CreateClient("probe");

        // `localhost` resolves to 127.0.0.1, so every address the socket sees is one it would allow.
        // Only the scheme makes this wrong, and only the request guard can tell.
        await Assert.ThrowsAnyAsync<Exception>(
            () => client.GetAsync($"http://localhost:{listener.Port}/probe"));

        Assert.Equal(0, Volatile.Read(ref listener.Requests));
    }
}
