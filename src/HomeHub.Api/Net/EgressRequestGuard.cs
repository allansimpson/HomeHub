namespace HomeHub.Api.Net;

/// <summary>
/// Refuses a request whose destination is not one somebody authorised, before it is sent.
/// </summary>
/// <remarks>
/// <para>
/// <b>This exists because the connect callback cannot see the scheme.</b> A
/// <see cref="System.Net.Sockets.Socket"/> is opened to an address and a port; whether the request
/// riding it is <c>http</c> or <c>https</c> is not a fact available at that layer. So the socket
/// handler could screen every address a client dialled and still let household text cross the LAN in
/// the clear — which is exactly what happened to Chatterbox, whose endpoint was guarded at the socket
/// and never shape-checked anywhere.
/// </para>
/// <para>
/// <b>And it exists here rather than as a second thing to remember.</b> The shape check and the
/// address screen had been two separately maintained facts about each destination, and five rounds of
/// review found five places where one of them was missing. A <c>DelegatingHandler</c> makes them one
/// registration: a client cannot have the socket guard without also having this, because
/// {@link GuardedHttpClientExtensions.AddGuardedHttpClient} attaches both or neither.
/// </para>
/// <para>
/// <b>The origin is checked, not the whole URL.</b> A request URI legitimately carries a path and a
/// query — a barcode lookup, a calendar range — and <see cref="EgressGuard.Refuse"/> rejects those
/// deliberately, because in a *configured base URL* they are how a destination is disguised. So what
/// is handed to it is <c>scheme://host:port</c>, which is the part a rule has an opinion about.
/// </para>
/// </remarks>
public sealed class EgressRequestGuard : DelegatingHandler
{
    private readonly Func<EgressRule> _rule;

    public EgressRequestGuard(Func<EgressRule> rule) => _rule = rule;

    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var rule = _rule();

        if (request.RequestUri is not { IsAbsoluteUri: true } uri)
        {
            // A relative URI means the client has no BaseAddress, which for a guarded client means
            // nothing has said where it may go. Refused rather than resolved.
            throw new EgressGuard.BlockedAddressException(
                $"{rule.Setting}: a request was made with no absolute destination.");
        }

        if (EgressGuard.Refuse(uri.GetLeftPart(UriPartial.Authority), rule) is { } refusal)
            throw new EgressGuard.BlockedAddressException(refusal);

        return base.SendAsync(request, cancellationToken);
    }
}
