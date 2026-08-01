namespace HomeHub.Api.Data;

using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;
using Microsoft.Extensions.Configuration;

/// <summary>
/// Design-time factory used by the EF Core CLI (<c>dotnet ef migrations add</c> /
/// <c>database update</c>). It lets migrations be scaffolded without the app's conditional runtime
/// registration — only the SQL Server provider is needed to author one.
/// </summary>
/// <remarks>
/// <b>It reads the same configuration sources the app does</b>, in the same order, and that is the
/// point of the file rather than an incidental nicety. It previously read only the
/// <c>ConnectionStrings__HomeHub</c> environment variable and otherwise fell back to
/// <c>Server=localhost</c> — so on a machine whose connection string lives in user-secrets (the
/// documented arrangement: secrets in dev, environment variable in prod) <c>database update</c>
/// quietly tried to reach a local instance that does not exist. The failure is genuinely
/// misleading: it surfaces as a <i>Named Pipes</i> error naming no server, which reads as "the
/// database is down" when the database is fine and simply was never asked.
/// <para>
/// Scaffolding a migration touches no database, so that bug stayed invisible until the first
/// attempt to apply one.
/// </para>
/// </remarks>
public class HomeHubDbContextFactory : IDesignTimeDbContextFactory<HomeHubDbContext>
{
    public HomeHubDbContext CreateDbContext(string[] args)
    {
        // Development by default: `dotnet ef` is a developer's command, and the whole reason the
        // connection string is in user-secrets is that it is never committed.
        var environment = Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT") ?? "Development";

        var configuration = new ConfigurationBuilder()
            .SetBasePath(Directory.GetCurrentDirectory())
            .AddJsonFile("appsettings.json", optional: true)
            .AddJsonFile($"appsettings.{environment}.json", optional: true)
            // Unconditional, unlike the app's builder, which adds secrets only in Development. A
            // design-time tool run with the environment left unset would otherwise skip the one
            // place the string actually is.
            .AddUserSecrets<HomeHubDbContextFactory>(optional: true)
            // Last, so it still wins — this is how the string is supplied in prod, and how a
            // one-off `ConnectionStrings__HomeHub=… dotnet ef database update` overrides secrets.
            .AddEnvironmentVariables()
            .Build();

        var connectionString = configuration.GetConnectionString("HomeHub");

        if (string.IsNullOrWhiteSpace(connectionString))
        {
            // Say which sources were tried rather than falling back to localhost. A silent default
            // turns "nobody told me where the database is" into "the database is unreachable", and
            // the second sends you to check a server that was never the problem.
            throw new InvalidOperationException(
                "No 'HomeHub' connection string found. Looked in appsettings.json, " +
                $"appsettings.{environment}.json, user-secrets " +
                "(54c59da6-3fb5-407f-92e0-4381bb765932) and the environment " +
                "(ConnectionStrings__HomeHub). Set one with:\n" +
                "  dotnet user-secrets set \"ConnectionStrings:HomeHub\" \"Server=…;Database=HomeHub;…\"");
        }

        var options = new DbContextOptionsBuilder<HomeHubDbContext>()
            .UseSqlServer(connectionString)
            .Options;

        return new HomeHubDbContext(options);
    }
}
