namespace HomeHub.Tests;

public class ProductionStartupSecurityTests
{
    private static string CreateKeyRingDirectory()
    {
        var path = Path.Combine(
            Path.GetTempPath(), "homehub-tests", "keys-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }

    private static Dictionary<string, string> ExtractorSettings()
    {
        var tls = TestTlsCertificate.Create();
        return new()
        {
            ["ImageExtractor:Enabled"] = "true",
            ["ImageExtractor:BaseUrl"] = "http://127.0.0.1:8644",
            ["ImageExtractor:ApiKey"] = "test-only",
            ["DataProtection:KeyPath"] = CreateKeyRingDirectory(),
            ["Server:CertPath"] = tls.CertificatePath,
            ["Server:KeyPath"] = tls.KeyPath,
        };
    }

    [Fact]
    public void Production_refuses_to_start_without_valid_tls_credentials()
    {
        var settings = ExtractorSettings();
        settings.Remove("Server:CertPath");
        settings.Remove("Server:KeyPath");

        using var app = new HubAppFactory { EnvironmentName = "Production", Settings = settings };

        var error = Assert.ThrowsAny<Exception>(() => app.CreateAnonymousClient());
        Assert.Contains("HTTPS", error.ToString(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Production_refuses_an_expired_tls_certificate()
    {
        var expired = TestTlsCertificate.Create(
            notBefore: DateTimeOffset.UtcNow.AddDays(-3),
            notAfter: DateTimeOffset.UtcNow.AddDays(-2));
        var settings = ExtractorSettings();
        settings["Server:CertPath"] = expired.CertificatePath;
        settings["Server:KeyPath"] = expired.KeyPath;

        using var app = new HubAppFactory { EnvironmentName = "Production", Settings = settings };

        var error = Assert.ThrowsAny<Exception>(() => app.CreateAnonymousClient());
        Assert.Contains("HTTPS", error.ToString(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Production_refuses_a_not_yet_valid_tls_certificate()
    {
        var future = TestTlsCertificate.Create(
            notBefore: DateTimeOffset.UtcNow.AddDays(2),
            notAfter: DateTimeOffset.UtcNow.AddDays(3));
        var settings = ExtractorSettings();
        settings["Server:CertPath"] = future.CertificatePath;
        settings["Server:KeyPath"] = future.KeyPath;

        using var app = new HubAppFactory { EnvironmentName = "Production", Settings = settings };

        var error = Assert.ThrowsAny<Exception>(() => app.CreateAnonymousClient());
        Assert.Contains("HTTPS", error.ToString(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Production_refuses_a_certificate_without_server_authentication_purpose()
    {
        var wrongPurpose = TestTlsCertificate.Create(serverAuthentication: false);
        var settings = ExtractorSettings();
        settings["Server:CertPath"] = wrongPurpose.CertificatePath;
        settings["Server:KeyPath"] = wrongPurpose.KeyPath;

        using var app = new HubAppFactory { EnvironmentName = "Production", Settings = settings };

        var error = Assert.ThrowsAny<Exception>(() => app.CreateAnonymousClient());
        Assert.Contains("HTTPS", error.ToString(), StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("Production")]
    [InlineData("Staging")]
    [InlineData("Live")]
    public void Deployment_environments_refuse_to_start_without_a_database_to_verify(string environment)
    {
        using var app = new HubAppFactory
        {
            EnvironmentName = environment,
            Settings = ExtractorSettings(),
        };

        var error = Assert.ThrowsAny<Exception>(() => app.CreateAnonymousClient());

        Assert.Contains("ConnectionStrings:HomeHub", error.ToString(), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("https://extractor.example:8644")]
    [InlineData("http://0.0.0.0:8644")]
    [InlineData("not-a-uri")]
    public void Deployment_refuses_a_non_loopback_image_extractor(string baseUrl)
    {
        var settings = ExtractorSettings();
        settings["ConnectionStrings:HomeHub"] =
            $"Data Source=file:extractor-{Guid.NewGuid():N}?mode=memory&cache=shared";
        settings["ImageExtractor:BaseUrl"] = baseUrl;

        using var app = new HubAppFactory { EnvironmentName = "Production", Settings = settings };

        var ex = Assert.ThrowsAny<Exception>(() => _ = app.Server);
        Assert.Contains("isolated image extractor", ex.ToString(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Production_refuses_to_serve_when_schema_or_secret_migration_fails()
    {
        var settings = ExtractorSettings();
        settings["ConnectionStrings:HomeHub"] =
            "Server=127.0.0.1,1;Database=unreachable;User Id=x;Password=x;Connect Timeout=1;TrustServerCertificate=true";

        using var app = new HubAppFactory
        {
            EnvironmentName = "Production",
            Settings = settings,
        };

        var error = Assert.ThrowsAny<Exception>(() => app.CreateAnonymousClient());

        Assert.Contains("migration", error.ToString(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Production_refuses_to_start_without_a_durable_data_protection_key_ring()
    {
        var settings = ExtractorSettings();
        settings.Remove("DataProtection:KeyPath");
        settings["ConnectionStrings:HomeHub"] =
            "Server=127.0.0.1,1;Database=unreachable;User Id=x;Password=x;Connect Timeout=1;TrustServerCertificate=true";

        using var app = new HubAppFactory
        {
            EnvironmentName = "Production",
            Settings = settings,
        };

        var error = Assert.ThrowsAny<Exception>(() => app.CreateAnonymousClient());

        Assert.Contains("DataProtection:KeyPath", error.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void Migration_capable_development_refuses_an_ephemeral_data_protection_key_ring()
    {
        var settings = ExtractorSettings();
        settings.Remove("DataProtection:KeyPath");
        settings["ConnectionStrings:HomeHub"] =
            "Server=127.0.0.1,1;Database=unreachable;User Id=x;Password=x;Connect Timeout=1;TrustServerCertificate=true";

        using var app = new HubAppFactory { EnvironmentName = "Development", Settings = settings };

        var error = Assert.ThrowsAny<Exception>(() => app.CreateAnonymousClient());
        Assert.Contains("DataProtection:KeyPath", error.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void Production_refuses_a_missing_key_ring_directory_without_creating_it()
    {
        var missing = Path.Combine(
            Path.GetTempPath(), "homehub-tests", "missing-keys-" + Guid.NewGuid().ToString("N"));
        var settings = ExtractorSettings();
        settings["DataProtection:KeyPath"] = missing;
        settings["ConnectionStrings:HomeHub"] =
            "Server=127.0.0.1,1;Database=unreachable;User Id=x;Password=x;Connect Timeout=1;TrustServerCertificate=true";

        using var app = new HubAppFactory { EnvironmentName = "Production", Settings = settings };

        var error = Assert.ThrowsAny<Exception>(() => app.CreateAnonymousClient());
        Assert.Contains("DataProtection:KeyPath", error.ToString(), StringComparison.Ordinal);
        Assert.False(Directory.Exists(missing));
    }

    [Fact]
    public void Production_refuses_a_relative_key_ring_path()
    {
        var settings = ExtractorSettings();
        settings["DataProtection:KeyPath"] = "relative-key-ring";
        settings["ConnectionStrings:HomeHub"] =
            "Server=127.0.0.1,1;Database=unreachable;User Id=x;Password=x;Connect Timeout=1;TrustServerCertificate=true";

        using var app = new HubAppFactory { EnvironmentName = "Production", Settings = settings };

        var error = Assert.ThrowsAny<Exception>(() => app.CreateAnonymousClient());
        Assert.Contains("DataProtection:KeyPath", error.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void Production_refuses_a_key_ring_beneath_a_regular_file()
    {
        var parentFile = Path.GetTempFileName();
        var settings = ExtractorSettings();
        settings["DataProtection:KeyPath"] = Path.Combine(parentFile, "keys");
        settings["ConnectionStrings:HomeHub"] =
            "Server=127.0.0.1,1;Database=unreachable;User Id=x;Password=x;Connect Timeout=1;TrustServerCertificate=true";

        using var app = new HubAppFactory { EnvironmentName = "Production", Settings = settings };

        var error = Assert.ThrowsAny<Exception>(() => app.CreateAnonymousClient());
        Assert.Contains("DataProtection:KeyPath", error.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void Valid_key_ring_is_eagerly_initialized_before_database_migration()
    {
        var settings = ExtractorSettings();
        var keyPath = settings["DataProtection:KeyPath"];
        settings["ConnectionStrings:HomeHub"] =
            "Server=127.0.0.1,1;Database=unreachable;User Id=x;Password=x;Connect Timeout=1;TrustServerCertificate=true";

        using var app = new HubAppFactory { EnvironmentName = "Production", Settings = settings };

        var error = Assert.ThrowsAny<Exception>(() => app.CreateAnonymousClient());
        Assert.Contains("migration", error.ToString(), StringComparison.OrdinalIgnoreCase);
        Assert.NotEmpty(Directory.GetFiles(keyPath!, "key-*.xml"));
    }
}
