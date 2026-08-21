namespace HomeHub.Tests;

using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

internal static class TestTlsCertificate
{
    internal static (string CertificatePath, string KeyPath) Create(
        bool serverAuthentication = true,
        DateTimeOffset? notBefore = null,
        DateTimeOffset? notAfter = null)
    {
        var directory = Path.Combine(
            Path.GetTempPath(), "homehub-tests", "tls-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var certificatePath = Path.Combine(directory, "server.crt");
        var keyPath = Path.Combine(directory, "server.key");

        using var key = RSA.Create(2048);
        var request = new CertificateRequest(
            "CN=localhost", key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(
            X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyEncipherment, true));
        if (serverAuthentication)
        {
            request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(
                new OidCollection { new("1.3.6.1.5.5.7.3.1") }, true));
        }
        var names = new SubjectAlternativeNameBuilder();
        names.AddDnsName("localhost");
        names.AddIpAddress(IPAddress.Loopback);
        request.CertificateExtensions.Add(names.Build());

        using var certificate = request.CreateSelfSigned(
            notBefore ?? DateTimeOffset.UtcNow.AddMinutes(-5),
            notAfter ?? DateTimeOffset.UtcNow.AddDays(2));
        File.WriteAllText(certificatePath, certificate.ExportCertificatePem());
        File.WriteAllText(keyPath, key.ExportPkcs8PrivateKeyPem());
        return (certificatePath, keyPath);
    }
}
