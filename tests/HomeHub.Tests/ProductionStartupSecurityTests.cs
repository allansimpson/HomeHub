namespace HomeHub.Tests;

using HomeHub.Api.Calendar.Capture;
using Microsoft.Extensions.DependencyInjection;

public class ProductionStartupSecurityTests
{
    private static string CreateKeyRingDirectory()
    {
        var path = Path.Combine(
            Path.GetTempPath(), "homehub-tests", "keys-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }

    private static Dictionary<string, string> ExtractorSettings(TestTlsCertificate.Chain? tls = null)
    {
        tls ??= TestTlsCertificate.CreateChain();
        var settings = new Dictionary<string, string>
        {
            ["ImageExtractor:Enabled"] = "true",
            ["ImageExtractor:BaseUrl"] = "http://127.0.0.1:8644",
            ["ImageExtractor:ApiKey"] = "test-only",
            ["DataProtection:KeyPath"] = CreateKeyRingDirectory(),
            ["Server:CertPath"] = tls.CertificatePath,
            ["Server:KeyPath"] = tls.KeyPath,
            // Identity, not just fitness. Every other production test in this file needs these to
            // pass so it can reach the gate it is actually about — a deployment without them now
            // fails at the listener, which is the whole point of H4.
            ["Server:CaPath"] = tls.CaPath,
        };
        for (var i = 0; i < TestTlsCertificate.RequiredSans.Length; i++)
        {
            settings[$"Server:RequiredSans:{i}"] = TestTlsCertificate.RequiredSans[i];
        }
        return settings;
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
        var expired = TestTlsCertificate.CreateChain(
            notBefore: DateTimeOffset.UtcNow.AddDays(-3),
            notAfter: DateTimeOffset.UtcNow.AddDays(-2));
        // Its own chain, so the only thing wrong with this certificate is the property under test.
        var settings = ExtractorSettings(expired);

        using var app = new HubAppFactory { EnvironmentName = "Production", Settings = settings };

        var error = Assert.ThrowsAny<Exception>(() => app.CreateAnonymousClient());
        Assert.Contains("HTTPS", error.ToString(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Production_refuses_a_not_yet_valid_tls_certificate()
    {
        var future = TestTlsCertificate.CreateChain(
            notBefore: DateTimeOffset.UtcNow.AddDays(2),
            notAfter: DateTimeOffset.UtcNow.AddDays(3));
        // Its own chain, so the only thing wrong with this certificate is the property under test.
        var settings = ExtractorSettings(future);

        using var app = new HubAppFactory { EnvironmentName = "Production", Settings = settings };

        var error = Assert.ThrowsAny<Exception>(() => app.CreateAnonymousClient());
        Assert.Contains("HTTPS", error.ToString(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Production_refuses_a_certificate_without_server_authentication_purpose()
    {
        var wrongPurpose = TestTlsCertificate.CreateChain(serverAuthentication: false);
        // Its own chain, so the only thing wrong with this certificate is the property under test.
        var settings = ExtractorSettings(wrongPurpose);

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
    // ---- H4: the certificate must be *ours*, not merely well-formed ----

    /// <remarks>
    /// Each of these would have been served happily before, and every one of them is a certificate a
    /// browser refuses. The household's response to a browser refusal is to click through it, at
    /// which point the Secure cookie underneath has stopped meaning anything — which is why a
    /// partially-checked certificate is a transport-boundary finding rather than hygiene.
    /// </remarks>
    [Fact]
    public void Production_refuses_a_certificate_missing_a_required_identity()
    {
        // Covers the hostname and the address but not the mDNS name the deployment must answer to.
        var wrongNames = TestTlsCertificate.CreateChain(
            dnsNames: ["homehub-test.home.arpa"], ipAddresses: ["192.168.5.15"]);

        using var app = new HubAppFactory
        {
            EnvironmentName = "Production",
            Settings = ExtractorSettings(wrongNames),
        };

        var error = Assert.ThrowsAny<Exception>(() => app.CreateAnonymousClient());
        // Named individually, because the alternative sends somebody to read a certificate by hand
        // while the panel is down.
        Assert.Contains("mar-server.local", error.ToString(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Production_refuses_a_self_signed_leaf()
    {
        var selfSigned = TestTlsCertificate.CreateChain(selfSigned: true);

        using var app = new HubAppFactory
        {
            EnvironmentName = "Production",
            Settings = ExtractorSettings(selfSigned),
        };

        var error = Assert.ThrowsAny<Exception>(() => app.CreateAnonymousClient());
        Assert.Contains("chain", error.ToString(), StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// The case that is invisible without actually building the chain: a leaf issued by a CA with the
    /// *same subject name* as the household root, but a different key.
    /// </summary>
    [Fact]
    public void Production_refuses_a_leaf_from_an_unknown_root()
    {
        var unknownRoot = TestTlsCertificate.CreateChain(issueFromUnrelatedRoot: true);

        using var app = new HubAppFactory
        {
            EnvironmentName = "Production",
            Settings = ExtractorSettings(unknownRoot),
        };

        var error = Assert.ThrowsAny<Exception>(() => app.CreateAnonymousClient());
        Assert.Contains("chain", error.ToString(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Production_refuses_to_start_without_the_household_root_configured()
    {
        var settings = ExtractorSettings();
        settings.Remove("Server:CaPath");

        using var app = new HubAppFactory { EnvironmentName = "Production", Settings = settings };

        var error = Assert.ThrowsAny<Exception>(() => app.CreateAnonymousClient());
        // Falls back to the deployment contract path, which is absent on a dev box — so the failure
        // names the file somebody has to go and put there.
        Assert.Contains("homehub-dev-ca.crt", error.ToString(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Production_refuses_to_start_without_required_identities()
    {
        var settings = ExtractorSettings();
        for (var i = 0; i < TestTlsCertificate.RequiredSans.Length; i++)
        {
            settings.Remove($"Server:RequiredSans:{i}");
        }

        using var app = new HubAppFactory { EnvironmentName = "Production", Settings = settings };

        var error = Assert.ThrowsAny<Exception>(() => app.CreateAnonymousClient());
        // An unconfigured list must fail closed. Treating "none required" as "nothing to check" would
        // reinstate the finding by omission on the first deployment that forgot the setting.
        Assert.Contains("Server:RequiredSans", error.ToString(), StringComparison.Ordinal);
    }

    /// <summary>
    /// The seam, end to end: with the isolated reader configured, an image request resolves to it and
    /// never to the tool-capable agent path.
    /// </summary>
    /// <remarks>
    /// The startup negatives above prove a hardened deployment cannot boot *without* isolation. This
    /// proves the other half — that when isolation is present it is actually what gets composed —
    /// and together they close the route. Without this, a ladder reordered so that `EventCapture`
    /// won when both were configured would pass every other test in this file.
    ///
    /// Asserted on the resolved implementation type rather than on behaviour because that is the
    /// decision under test: the choice of reader is made once, at composition, and `HermesEventExtractor`
    /// deliberately contains nothing that would refuse to run.
    /// </remarks>
    [Fact]
    public void An_image_request_resolves_to_the_isolated_reader_not_the_household_agent()
    {
        var settings = ExtractorSettings();
        // The legacy path configured as invitingly as possible: a household that had set it up, and
        // then had the isolated reader switched on around it.
        settings["EventCapture:Provider"] = "hermes";
        settings["EventCapture:Agent"] = "barnaby";

        using var app = new HubAppFactory { Settings = settings };
        using var scope = app.Services.CreateScope();

        var reader = scope.ServiceProvider.GetRequiredService<IEventExtractor>();

        Assert.IsNotType<HermesEventExtractor>(reader);
        Assert.IsType<ExtractorEventReader>(reader);
    }

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
