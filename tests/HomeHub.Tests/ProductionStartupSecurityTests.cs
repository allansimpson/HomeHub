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

    /// <summary>
    /// H1's fourth definition-of-done item: prove a tool-bearing profile cannot be selected for
    /// production extraction.
    /// </summary>
    /// <remarks>
    /// <b>The gate is a startup refusal, not a runtime check, and that is the part worth pinning.</b>
    /// The extractor ladder in `Program` prefers the isolated loopback reader and only falls through
    /// to `HermesEventExtractor` — the household's own tool-capable agent — when `ImageExtractor` is
    /// not configured. Under deployment safeguards that fall-through is unreachable because the app
    /// refuses to start at all, so the guarantee rests entirely on this throw continuing to exist.
    ///
    /// Written because the finding was reported against the two files that *send* the image, both of
    /// which are unchanged and will stay unchanged: nothing in `HermesEventExtractor` says it may not
    /// run in production, and nothing should — the isolation belongs at composition, where the choice
    /// is actually made. Which leaves nothing in either file for a reader to notice, and no test
    /// saying so. This is that test.
    /// </remarks>
    [Theory]
    // Switched off explicitly, and never configured at all — the second is what an older household
    // actually has, and it is the one the ladder would otherwise fall through to the agent on.
    [InlineData("false")]
    [InlineData(null)]
    public void Production_refuses_the_household_agent_as_an_image_reader(string? enabled)
    {
        var settings = ExtractorSettings();
        settings["ConnectionStrings:HomeHub"] =
            $"Data Source=file:agentreader-{Guid.NewGuid():N}?mode=memory&cache=shared";
        // The isolated reader off, and the legacy house-agent path configured exactly as a household
        // following the old defaults would leave it.
        if (enabled is null) settings.Remove("ImageExtractor:Enabled");
        else settings["ImageExtractor:Enabled"] = enabled;
        settings["EventCapture:Provider"] = "hermes";
        settings["EventCapture:Agent"] = "barnaby";

        using var app = new HubAppFactory { EnvironmentName = "Production", Settings = settings };

        var ex = Assert.ThrowsAny<Exception>(() => _ = app.Server);
        Assert.Contains("isolated image extractor", ex.ToString(), StringComparison.OrdinalIgnoreCase);
        // Named in the message on purpose: whoever hits this at three in the morning needs to be told
        // that the fallback is refused, not merely that something is unconfigured.
        Assert.Contains("household-agent", ex.ToString(), StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// H5: the deprecated shared MCP key is refused under deployment safeguards, and named
    /// credentials are unaffected.
    /// </summary>
    /// <remarks>
    /// The negative case is the one that matters, and it is the easy one to omit: a gate that
    /// refuses the legacy key but also refuses the replacement would be discovered by whoever
    /// migrates, at the worst possible moment. Both are asserted here so the refusal stays narrow.
    /// </remarks>
    [Fact]
    public void Production_refuses_the_deprecated_shared_mcp_key()
    {
        var settings = ExtractorSettings();
        settings["ConnectionStrings:HomeHub"] =
            $"Data Source=file:mcpkey-{Guid.NewGuid():N}?mode=memory&cache=shared";
        settings["Mcp:ApiKey"] = "legacy-shared-key-value";

        using var app = new HubAppFactory { EnvironmentName = "Production", Settings = settings };

        var ex = Assert.ThrowsAny<Exception>(() => _ = app.Server);
        Assert.Contains("Mcp:ApiKey", ex.ToString(), StringComparison.Ordinal);
        // The message has to say what to do instead, because the household reading it is mid-deploy.
        Assert.Contains("Mcp:Credentials", ex.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void The_mcp_key_refusal_does_not_catch_named_credentials()
    {
        var settings = ExtractorSettings();
        settings["ConnectionStrings:HomeHub"] =
            $"Data Source=file:mcpnamed-{Guid.NewGuid():N}?mode=memory&cache=shared";
        settings["Mcp:Credentials:barnaby:ApiKey"] = "per-agent-key";
        settings["Mcp:Credentials:barnaby:Methods:0"] = "get_calendar";

        using var app = new HubAppFactory { EnvironmentName = "Production", Settings = settings };

        /*
         * Asserted as "not this error" rather than "starts cleanly", because this harness cannot get
         * a production host all the way up — the in-memory provider is not relational and the
         * migration step refuses it. Stating that as `Assert.NotNull(app.Server)` would have made a
         * passing test out of an unrelated failure the day the gate broke.
         *
         * The claim being pinned is narrow and is the one that matters: whatever else stops this
         * host, it is not the legacy-key refusal. A gate that also rejected the replacement would
         * make the migration it exists to force impossible to complete, and would be discovered by
         * whoever attempted it, mid-deploy.
         */
        var ex = Record.Exception(() => _ = app.Server);
        Assert.DoesNotContain("Mcp:ApiKey", ex?.ToString() ?? string.Empty, StringComparison.Ordinal);
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
