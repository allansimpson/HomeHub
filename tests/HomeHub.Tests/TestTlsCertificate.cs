namespace HomeHub.Tests;

using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

/// <summary>
/// Certificates generated at run time, so no key material is committed.
/// </summary>
/// <remarks>
/// <b>Issues a real chain, not just a leaf.</b> The startup gate proves identity by building a chain
/// to a configured household root, so a self-signed certificate can no longer stand in for a
/// deployment's certificate — that is precisely the case the gate exists to reject. Every helper here
/// therefore mints a CA and signs from it, and the self-signed shape is available deliberately, as
/// something to be refused.
/// </remarks>
internal static class TestTlsCertificate
{
    internal sealed record Chain(string CertificatePath, string KeyPath, string CaPath);

    /// <summary>The identities a test deployment is required to answer to.</summary>
    /// <remarks>
    /// Shaped like the real ones Hermes supplied for TEST — a hostname, an mDNS name and an address —
    /// so the parsing of both kinds is exercised rather than only the easy one.
    /// </remarks>
    internal static readonly string[] RequiredSans =
        ["DNS:homehub-test.home.arpa", "IP:192.168.5.15", "DNS:mar-server.local"];

    /// <summary>A leaf issued by a fresh household root, covering <see cref="RequiredSans"/>.</summary>
    internal static Chain CreateChain(
        bool serverAuthentication = true,
        DateTimeOffset? notBefore = null,
        DateTimeOffset? notAfter = null,
        IEnumerable<string>? dnsNames = null,
        IEnumerable<string>? ipAddresses = null,
        bool selfSigned = false,
        bool issueFromUnrelatedRoot = false)
    {
        var directory = Path.Combine(
            Path.GetTempPath(), "homehub-tests", "tls-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var certificatePath = Path.Combine(directory, "server.crt");
        var keyPath = Path.Combine(directory, "server.key");
        var caPath = Path.Combine(directory, "ca.crt");

        var leafFrom = notBefore ?? DateTimeOffset.UtcNow.AddMinutes(-5);
        var leafTo = notAfter ?? DateTimeOffset.UtcNow.AddDays(2);
        // The issuer must outlive what it issues in both directions. The expired-certificate case
        // asks for a leaf that started three days ago, and a CA minted one day ago cannot sign it —
        // `CertificateRequest.Create` refuses outright, which fails that test for a reason that has
        // nothing to do with what it is testing.
        var caFrom = (leafFrom < DateTimeOffset.UtcNow.AddDays(-1) ? leafFrom : DateTimeOffset.UtcNow.AddDays(-1))
            .AddDays(-1);
        var caTo = (leafTo > DateTimeOffset.UtcNow.AddDays(30) ? leafTo : DateTimeOffset.UtcNow.AddDays(30))
            .AddDays(1);

        using var caKey = RSA.Create(2048);
        var caRequest = new CertificateRequest(
            "CN=HomeHub Dev CA, O=HomeHub", caKey, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        caRequest.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
        caRequest.CertificateExtensions.Add(new X509KeyUsageExtension(
            X509KeyUsageFlags.KeyCertSign | X509KeyUsageFlags.CrlSign, true));
        using var ca = caRequest.CreateSelfSigned(caFrom, caTo);

        // The root the deployment is configured to trust. When `issueFromUnrelatedRoot` is set the
        // leaf is signed by a *different* CA than the one written here, which is the "unknown root"
        // case — indistinguishable from a valid setup unless the chain is actually built.
        if (issueFromUnrelatedRoot)
        {
            using var otherKey = RSA.Create(2048);
            var otherRequest = new CertificateRequest(
                "CN=HomeHub Dev CA, O=HomeHub", otherKey, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
            otherRequest.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
            otherRequest.CertificateExtensions.Add(new X509KeyUsageExtension(
                X509KeyUsageFlags.KeyCertSign | X509KeyUsageFlags.CrlSign, true));
            using var other = otherRequest.CreateSelfSigned(caFrom, caTo);
            File.WriteAllText(caPath, other.ExportCertificatePem());
        }
        else
        {
            File.WriteAllText(caPath, ca.ExportCertificatePem());
        }

        using var key = RSA.Create(2048);
        var request = new CertificateRequest(
            "CN=homehub-test.home.arpa", key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(
            X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyEncipherment, true));
        if (serverAuthentication)
        {
            request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(
                new OidCollection { new("1.3.6.1.5.5.7.3.1") }, true));
        }

        var names = new SubjectAlternativeNameBuilder();
        foreach (var name in dnsNames ?? ["homehub-test.home.arpa", "mar-server.local"])
        {
            names.AddDnsName(name);
        }
        foreach (var address in ipAddresses ?? ["192.168.5.15"])
        {
            names.AddIpAddress(IPAddress.Parse(address));
        }
        request.CertificateExtensions.Add(names.Build());

        var from = leafFrom;
        var to = leafTo;

        X509Certificate2 issued;
        if (selfSigned)
        {
            issued = request.CreateSelfSigned(from, to);
        }
        else
        {
            // Clamped inside the CA's own window: a leaf outliving its issuer is a chain error, and
            // it would fire on the date cases below for the wrong reason.
            var serial = new byte[8];
            RandomNumberGenerator.Fill(serial);
            // Not `using` — it is disposed by the block below. Scoping it here disposed the handle
            // before the export and produced "m_safeCertContext is an invalid handle" from twenty-odd
            // unrelated tests, which reads like a platform fault rather than a lifetime mistake.
            issued = request.Create(ca, from, to, serial);
        }

        using (issued)
        {
            File.WriteAllText(certificatePath, issued.ExportCertificatePem());
        }
        File.WriteAllText(keyPath, key.ExportPkcs8PrivateKeyPem());
        return new Chain(certificatePath, keyPath, caPath);
    }

    /// <summary>Back-compatible shape for tests that only care about the leaf's own properties.</summary>
    internal static (string CertificatePath, string KeyPath) Create(
        bool serverAuthentication = true,
        DateTimeOffset? notBefore = null,
        DateTimeOffset? notAfter = null)
    {
        var chain = CreateChain(serverAuthentication, notBefore, notAfter);
        return (chain.CertificatePath, chain.KeyPath);
    }
}
