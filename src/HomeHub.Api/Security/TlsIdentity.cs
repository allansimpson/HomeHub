namespace HomeHub.Api.Security;

using System.Net;
using System.Security.Cryptography.X509Certificates;

/// <summary>
/// Proves the HTTPS certificate is the panel's, not merely a well-formed certificate.
/// </summary>
/// <remarks>
/// <para>
/// The startup checks that came before this establish certificate <i>fitness</i> — in date, has its
/// key, permits server authentication, is not a CA. None of them establish <i>identity</i>, so
/// production could open HTTPS with a self-signed leaf for the wrong host: something every browser
/// rejects, and every household then learns to click through. The Secure cookie and the authenticated
/// traffic underneath it lose their meaning at that point, which is why this is a High finding about
/// a transport boundary rather than a certificate hygiene note.
/// </para>
/// <para>
/// <b>Identities come from configuration, never from the machine.</b> Reading the panel's own
/// hostname and requiring the certificate to match it would prove only that the two agree, which a
/// misissued certificate on a misnamed host satisfies perfectly. The deployment states what the
/// panel is *supposed* to be and the certificate is held to that.
/// </para>
/// <para>
/// <b>Custom root trust, not the OS store.</b> The household CA is private and offline, so the
/// machine store is both wider than needed and — on a freshly imaged panel — narrower: it may not
/// hold the household root at all. Trusting exactly one configured root makes the check independent
/// of whether the OS trust installation has happened yet, which is deployment work and should not be
/// an application prerequisite.
/// </para>
/// <para>
/// Revocation is not checked, and that is a decision rather than an omission: this CA publishes no
/// CRL and runs no OCSP responder, so a revocation check has nothing to ask and would fail closed on
/// every valid certificate.
/// </para>
/// </remarks>
public static class TlsIdentity
{
    /// <summary>The deployment contract for where the household root lives.</summary>
    public const string DefaultCaPath = "/etc/homehub/tls/homehub-dev-ca.crt";

    /// <summary>
    /// Throws unless <paramref name="leaf"/> covers every required identity and chains to the
    /// configured root.
    /// </summary>
    /// <param name="requiredSans">
    /// Entries shaped <c>DNS:name</c> or <c>IP:address</c> — for example <c>DNS:mar-server.local</c>,
    /// <c>IP:192.168.5.15</c>. Every one must be present on the leaf; a certificate carrying extra
    /// names is fine, since a shared panel certificate legitimately covers more than one deployment.
    /// </param>
    public static void Require(X509Certificate2 leaf, IReadOnlyList<string> requiredSans, string caPath)
    {
        if (requiredSans.Count == 0)
        {
            throw new InvalidOperationException(
                "Deployment startup requires Server:RequiredSans to name the identities this panel "
                + "must present — for example DNS:mar-server.local and IP:192.168.5.15. Without them "
                + "the certificate is only checked for fitness, never for being the right certificate.");
        }

        RequireSubjectAlternativeNames(leaf, requiredSans);
        RequireChainToConfiguredRoot(leaf, caPath);
    }

    private static void RequireSubjectAlternativeNames(X509Certificate2 leaf, IReadOnlyList<string> required)
    {
        var extension = leaf.Extensions.OfType<X509SubjectAlternativeNameExtension>().FirstOrDefault();
        if (extension is null)
        {
            throw new InvalidOperationException(
                "The HTTPS certificate carries no subject alternative names, so it identifies no host. "
                + "A certificate whose only identity is its subject common name is not accepted by any "
                + "current browser and must not be served.");
        }

        // Case-insensitive for DNS because host names are; IP addresses are normalised through
        // `IPAddress` so `192.168.005.015` and `192.168.5.15` are not treated as different panels.
        var dns = extension.EnumerateDnsNames().ToHashSet(StringComparer.OrdinalIgnoreCase);
        var ips = extension.EnumerateIPAddresses().Select(ip => ip.ToString())
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        var missing = new List<string>();
        foreach (var entry in required)
        {
            var trimmed = entry.Trim();
            if (trimmed.Length == 0) continue;

            var separator = trimmed.IndexOf(':');
            if (separator <= 0)
            {
                throw new InvalidOperationException(
                    $"Server:RequiredSans entry '{entry}' must be written DNS:name or IP:address. An "
                    + "unprefixed value is ambiguous, and guessing which kind it is would let a DNS "
                    + "name silently satisfy an IP requirement.");
            }

            var kind = trimmed[..separator];
            var value = trimmed[(separator + 1)..].Trim();

            var present = kind.ToUpperInvariant() switch
            {
                "DNS" => dns.Contains(value),
                "IP" => IPAddress.TryParse(value, out var parsed) && ips.Contains(parsed.ToString()),
                _ => throw new InvalidOperationException(
                    $"Server:RequiredSans entry '{entry}' names an unsupported kind '{kind}'. Use DNS or IP."),
            };

            if (!present) missing.Add(trimmed);
        }

        if (missing.Count > 0)
        {
            // Named individually: "the SAN check failed" sends somebody to read a certificate by
            // hand at the moment the panel is down.
            throw new InvalidOperationException(
                "The HTTPS certificate does not cover every identity this deployment must answer to. "
                + $"Missing: {string.Join(", ", missing)}. Present: "
                + $"{string.Join(", ", dns.Select(d => "DNS:" + d).Concat(ips.Select(i => "IP:" + i)))}.");
        }
    }

    private static void RequireChainToConfiguredRoot(X509Certificate2 leaf, string caPath)
    {
        if (string.IsNullOrWhiteSpace(caPath) || !File.Exists(caPath))
        {
            throw new InvalidOperationException(
                $"Deployment startup requires the household root certificate at '{caPath}' "
                + $"(Server:CaPath, contract default {DefaultCaPath}). Without it the certificate "
                + "chain cannot be verified and a self-signed leaf would be indistinguishable from "
                + "an issued one.");
        }

        X509Certificate2 root;
        try
        {
            root = X509CertificateLoader.LoadCertificateFromFile(caPath);
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException(
                $"The household root certificate at '{caPath}' could not be read.", ex);
        }

        using (root)
        using (var chain = new X509Chain())
        {
            chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
            chain.ChainPolicy.CustomTrustStore.Add(root);
            // Nothing is waived. `NoFlag` is the point of the exercise: the whole finding is that a
            // partially-checked certificate was being accepted.
            chain.ChainPolicy.VerificationFlags = X509VerificationFlags.NoFlag;
            // This CA is private and offline — no CRL distribution point, no OCSP responder. A
            // revocation check would have nothing to ask and would refuse every valid certificate.
            chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;

            if (chain.Build(leaf)) return;

            var reasons = chain.ChainStatus.Length == 0
                ? "no status was reported, which usually means the leaf is self-signed and is not the configured root"
                : string.Join("; ", chain.ChainStatus.Select(s => $"{s.Status}: {s.StatusInformation.Trim()}"));

            throw new InvalidOperationException(
                "The HTTPS certificate does not chain to the household root certificate at "
                + $"'{caPath}'. This rejects self-signed leaves, unknown roots and invalid "
                + $"intermediates alike. Chain result — {reasons}");
        }
    }
}
