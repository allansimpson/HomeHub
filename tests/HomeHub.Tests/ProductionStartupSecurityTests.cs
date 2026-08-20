namespace HomeHub.Tests;

public class ProductionStartupSecurityTests
{
    private static Dictionary<string, string> ExtractorSettings() => new()
    {
        ["ImageExtractor:Enabled"] = "true",
        ["ImageExtractor:BaseUrl"] = "http://127.0.0.1:8644",
        ["ImageExtractor:ApiKey"] = "test-only",
    };

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
}
