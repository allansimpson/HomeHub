using HomeHub.Api.Data;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

// --- Services ---
builder.Services.AddControllers();
builder.Services.AddOpenApi();

// EF Core / SQL Server. The connection string is NEVER committed — it is read from the
// secrets mechanism: user-secrets in dev, environment variable / protected config for the
// systemd service in prod (ConnectionStrings__HomeHub). Stage 0 tolerates it being absent
// so the design-system shell still boots for local UI work.
var connectionString = builder.Configuration.GetConnectionString("HomeHub");
if (!string.IsNullOrWhiteSpace(connectionString))
{
    builder.Services.AddDbContext<HomeHubDbContext>(options =>
        options.UseSqlServer(connectionString));
}

var app = builder.Build();

// --- Pipeline ---
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

// No HTTPS redirect: the kiosk is served over plain HTTP on the trusted LAN
// (nginx/TLS can be layered in front later, per the architecture).

// Apply migrations on startup so the app owns its schema. Controlled by
// RunMigrationsOnStartup (default true). Failure is logged but non-fatal — the SPA shell
// must still load and show a calm reconnecting state rather than a crash, per the
// offline-first principle.
if (!string.IsNullOrWhiteSpace(connectionString)
    && app.Configuration.GetValue("RunMigrationsOnStartup", true))
{
    using var scope = app.Services.CreateScope();
    var logger = scope.ServiceProvider.GetRequiredService<ILogger<Program>>();
    try
    {
        var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
        db.Database.Migrate();
        logger.LogInformation("Database migrations applied.");
    }
    catch (Exception ex)
    {
        logger.LogError(ex, "Database migration failed at startup; serving app without a verified schema.");
    }
}

app.MapControllers();

// Serve the built React SPA (client/dist copied into wwwroot at publish) with SPA
// fallback so client-side routes deep-link correctly. In Development the SPA is served by
// Vite (npm run dev) and proxied, so wwwroot is typically empty.
app.UseDefaultFiles();
app.UseStaticFiles();
app.MapFallbackToFile("index.html");

app.Run();

// Exposed so the integration test project can reference the app entry point via WebApplicationFactory.
public partial class Program { }
