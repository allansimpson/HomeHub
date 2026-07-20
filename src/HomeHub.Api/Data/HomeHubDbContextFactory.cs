namespace HomeHub.Api.Data;

using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

/// <summary>
/// Design-time factory used by the EF Core CLI (<c>dotnet ef migrations add</c> /
/// <c>database update</c>). It lets migrations be scaffolded without the app's conditional
/// runtime registration and without a live database — only the SQL Server provider is
/// needed to author a migration. A real connection string can be supplied via the
/// <c>ConnectionStrings__HomeHub</c> environment variable when applying migrations by hand.
/// </summary>
public class HomeHubDbContextFactory : IDesignTimeDbContextFactory<HomeHubDbContext>
{
    public HomeHubDbContext CreateDbContext(string[] args)
    {
        var connectionString =
            Environment.GetEnvironmentVariable("ConnectionStrings__HomeHub")
            ?? "Server=localhost;Database=HomeHub;Trusted_Connection=True;TrustServerCertificate=True";

        var options = new DbContextOptionsBuilder<HomeHubDbContext>()
            .UseSqlServer(connectionString)
            .Options;

        return new HomeHubDbContext(options);
    }
}
