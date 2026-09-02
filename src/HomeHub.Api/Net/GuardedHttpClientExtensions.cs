namespace HomeHub.Api.Net;

using Microsoft.Extensions.Options;

/// <summary>
/// The only way to register an <see cref="HttpClient"/> that may reach a destination.
/// </summary>
/// <remarks>
/// <para>
/// <b>One registration, both halves, because two separately maintained facts is what kept failing.</b>
/// Every confined client needs a shape check — is this destination one somebody authorised, and is the
/// transport authenticated — and an address screen at dial time, which is the only place a name can be
/// resolved once and connected to without a second resolution to race. Those were being attached
/// independently, and five consecutive reviews found five places with one and not the other:
/// `Ai:OpenAiBaseUrl` guarded while four siblings were not, the account-link exchange on the unnamed
/// default, the unnamed default itself never actually denied, `UseProxy` left on everywhere, and
/// Chatterbox screened at the socket and shape-checked nowhere.
/// </para>
/// <para>
/// Each of those was a true statement about a class that nothing enumerated. So the class is a
/// registration helper now: a caller either gets both guards or does not get a client, and
/// <c>EgressGuardTests.Every_outbound_client_registration_is_guarded</c> reads the source and fails on
/// any <c>AddHttpClient</c> that is not this, the deny-all default, or a named exception with its own
/// invariant test.
/// </para>
/// <para>
/// <b>The rule is resolved per call rather than captured.</b> Options reload without a restart, and a
/// handler holding a snapshot from boot would screen against a destination the app no longer uses.
/// </para>
/// </remarks>
public static class GuardedHttpClientExtensions
{
    /// <summary>A named client confined to one destination class.</summary>
    public static IHttpClientBuilder AddGuardedHttpClient(
        this IServiceCollection services,
        string name,
        Func<IServiceProvider, EgressRule> rule) =>
        services.AddHttpClient(name).Guard(rule);

    /// <summary>A typed client confined to one destination class.</summary>
    public static IHttpClientBuilder AddGuardedHttpClient<TClient>(
        this IServiceCollection services,
        Func<IServiceProvider, EgressRule> rule,
        Action<IServiceProvider, HttpClient>? configure = null)
        where TClient : class =>
        (configure is null
            ? services.AddHttpClient<TClient>()
            : services.AddHttpClient<TClient>(configure)).Guard(rule);

    /// <summary>A typed client behind an interface, confined to one destination class.</summary>
    public static IHttpClientBuilder AddGuardedHttpClient<TClient, TImplementation>(
        this IServiceCollection services,
        Func<IServiceProvider, EgressRule> rule,
        Action<IServiceProvider, HttpClient>? configure = null)
        where TClient : class
        where TImplementation : class, TClient =>
        (configure is null
            ? services.AddHttpClient<TClient, TImplementation>()
            : services.AddHttpClient<TClient, TImplementation>(configure)).Guard(rule);

    /// <summary>
    /// The deny-all default, which exists so that <c>CreateClient()</c> reaches nothing.
    /// </summary>
    /// <remarks>
    /// <c>AddHttpClient()</c> registers <see cref="IHttpClientFactory"/> <i>and</i> a client under
    /// <see cref="Options.DefaultName"/> configured with nothing — which is what the account-link token
    /// exchange picked up, posting an OAuth client secret through a handler that follows redirects and
    /// screens no address. Naming the default slot explicitly and giving it a handler that refuses
    /// every connection is the whole fix; a caller reaching for it fails loudly instead of working.
    /// </remarks>
    public static IHttpClientBuilder AddDenyAllDefaultHttpClient(this IServiceCollection services) =>
        services.AddHttpClient(Options.DefaultName)
            .ConfigurePrimaryHttpMessageHandler(EgressGuard.CreateBlockingHandler);

    /// <summary>Attach both guards. Private, so there is no way to attach one of them.</summary>
    private static IHttpClientBuilder Guard(
        this IHttpClientBuilder builder, Func<IServiceProvider, EgressRule> rule) =>
        builder
            // The socket: single-resolution dialling of the addresses it screened, no proxy, no
            // automatic redirects.
            .ConfigurePrimaryHttpMessageHandler(sp => EgressGuard.CreateHandler(() => rule(sp)))
            // The request: the scheme and the origin, which the socket cannot see.
            .AddHttpMessageHandler(sp => new EgressRequestGuard(() => rule(sp)));
}
