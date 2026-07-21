namespace HomeHub.Tests;

using HomeHub.Api.Calendar;
using HomeHub.Api.Climate;
using HomeHub.Api.Data;
using HomeHub.Api.Tasks;
using HomeHub.Api.Ai;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

/// <summary>
/// Boots the real app with an isolated in-memory database (unique per factory instance) so the
/// Stage 1 API can be exercised end-to-end without SQL Server. Registering the DbContext here
/// mirrors what a real connection string does in production; the app itself adds none in tests.
/// </summary>
public sealed class HubAppFactory : WebApplicationFactory<Program>
{
    private readonly string _dbName = "hub-tests-" + Guid.NewGuid();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.ConfigureServices(services =>
        {
            // If the developer has a real connection string in user-secrets/env, Program.cs registers
            // the SqlServer provider (+ DB-gated pollers). Strip all EF Core registrations and the
            // app's background pollers so tests run against an isolated in-memory DB regardless of the
            // machine's config — otherwise the two DB providers collide ("only a single provider").
            var stale = services.Where(d =>
                    (d.ServiceType.FullName?.StartsWith("Microsoft.EntityFrameworkCore", StringComparison.Ordinal) ?? false)
                    || d.ServiceType == typeof(HomeHubDbContext)
                    || (d.ServiceType == typeof(IHostedService)
                        && (d.ImplementationType?.Namespace?.StartsWith("HomeHub.Api", StringComparison.Ordinal) ?? false)))
                .ToList();
            foreach (var d in stale) services.Remove(d);

            services.AddDbContext<HomeHubDbContext>(options => options.UseInMemoryDatabase(_dbName));
            // The app DB-gates these on a connection string; register the local providers here so the
            // calendar/task/climate endpoints work against the in-memory DB (last registration wins).
            services.AddScoped<ICalendarProvider, SqlCalendarProvider>();
            services.AddScoped<ITaskProvider, SqlTaskProvider>();
            services.AddScoped<IClimateProvider, SimulatedClimateProvider>();

            // Tests assert the no-integration fallbacks (simulated assistant, no server STT). Clear any
            // AI keys the developer has in user-secrets so those defaults hold regardless of machine.
            services.PostConfigure<AiOptions>(o => { o.OpenAiApiKey = null; o.LocalEndpoint = null; });
        });
    }

    /// <summary>Creates a client and applies the seed data (HasData) via EnsureCreated.</summary>
    public HttpClient CreateSeededClient()
    {
        var client = CreateClient();
        using var scope = Services.CreateScope();
        scope.ServiceProvider.GetRequiredService<HomeHubDbContext>().Database.EnsureCreated();
        return client;
    }
}
