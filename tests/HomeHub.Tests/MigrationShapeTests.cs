namespace HomeHub.Tests;

using System.Reflection;
using HomeHub.Api.Data;
using HomeHub.Api.Security;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.EntityFrameworkCore.Migrations.Operations;

/// <summary>
/// The one class of migration bug this suite could not otherwise see.
/// </summary>
/// <remarks>
/// <para>
/// <b>Written after a DEV→TEST promotion was rolled back.</b>
/// <c>20260812160000_AddEventPhotoProvenance</c> carried an <c>UpdateData</c> against
/// <c>Settings</c>, and it failed at apply time with "cannot find the table in the migration model"
/// — after the migration before it had already been applied to TEST, so the database was left a
/// step ahead of the code.
/// </para>
/// <para>
/// <b>Why nothing here caught it.</b> Every other test in this project runs on the InMemory provider
/// with <c>EnsureCreated()</c> (see <c>HubAppFactory</c>), which builds the schema from the model and
/// never applies a migration at all. The migrations were therefore executed for the first time by
/// the deployment — 953 green tests said nothing about them, and could not have.
/// </para>
/// <para>
/// <b>The rule this encodes.</b> These migrations are hand-written (<c>dotnet-ef</c> cannot run on
/// the build account) and so omit <c>BuildTargetModel</c>, which leaves them with an empty
/// <see cref="Migration.TargetModel"/>. Schema operations — <c>AddColumn</c>, <c>DropColumn</c>,
/// <c>CreateTable</c> — never consult that model and are fine. <b>Data</b> operations resolve their
/// table against it, at apply time, and cannot work without one. Backfill with
/// <c>AddColumn</c>'s <c>defaultValue</c>, or use <c>migrationBuilder.Sql(...)</c> where real data
/// has to move.
/// </para>
/// <para>
/// This is a structural assertion rather than a behavioural one: it does not prove a migration is
/// correct, only that it cannot fail in the one way that reaches a deployment untested.
/// </para>
/// </remarks>
public class MigrationShapeTests
{
    private static IEnumerable<Migration> AllMigrations() =>
        typeof(HomeHubDbContext).Assembly
            .GetTypes()
            .Where(t => typeof(Migration).IsAssignableFrom(t) && !t.IsAbstract)
            .Where(t => t.GetCustomAttribute<MigrationAttribute>() is not null)
            .OrderBy(t => t.GetCustomAttribute<MigrationAttribute>()!.Id, StringComparer.Ordinal)
            .Select(t => (Migration)Activator.CreateInstance(t)!);

    [Fact]
    public void Every_migration_is_discoverable()
    {
        // The attributes are what makes a hand-written migration exist as far as EF is concerned —
        // without them it is an unreferenced class and the schema silently never changes.
        var migrations = AllMigrations().ToList();
        Assert.NotEmpty(migrations);
        foreach (var migration in migrations)
        {
            Assert.NotNull(migration.GetType().GetCustomAttribute<Microsoft.EntityFrameworkCore.Infrastructure.DbContextAttribute>());
        }
    }

    [Fact]
    public void A_migration_without_a_target_model_carries_no_data_operations()
    {
        var offenders = new List<string>();

        foreach (var migration in AllMigrations())
        {
            // No entity types means `BuildTargetModel` was not overridden — there is nothing for a
            // data operation to resolve a table name against.
            if (migration.TargetModel.GetEntityTypes().Any()) continue;

            var operations = migration.UpOperations.Concat(migration.DownOperations);
            foreach (var operation in operations)
            {
                if (operation is InsertDataOperation or UpdateDataOperation or DeleteDataOperation)
                {
                    offenders.Add($"{migration.GetType().Name} → {operation.GetType().Name}");
                }
            }
        }

        Assert.True(
            offenders.Count == 0,
            "A hand-written migration (no BuildTargetModel) cannot carry a data operation — it will "
            + "throw at apply time on the deployment, not here. Use AddColumn's defaultValue to "
            + "backfill, or migrationBuilder.Sql(...) to move real data. Offenders: "
            + string.Join(", ", offenders));
    }

    /// <summary>
    /// Every migration translates to SQL.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The general form of the test above, and the one that actually reproduces the failed
    /// promotion. Generating the script runs each operation through the provider's SQL generator —
    /// the same code the deployment runs — so an operation that cannot be translated throws here,
    /// offline, in under a second. With the <c>UpdateData</c> restored this fails with the
    /// deployment's own words: <i>"There is no entity type mapped to the table 'Settings' which is
    /// used in a data operation."</i>
    /// </para>
    /// <para>
    /// <b>No database is touched.</b> The connection string is never opened — it only selects the
    /// provider's syntax — which is what lets this run in a suite that has no SQL Server and on a
    /// build account with no rights to create one.
    /// </para>
    /// </remarks>
    [Fact]
    public void Every_migration_translates_to_sql()
    {
        var keyRing = Directory.CreateTempSubdirectory("migration-shape-tests");
        try
        {
            var protector = new SecretProtector(
                Microsoft.AspNetCore.DataProtection.DataProtectionProvider.Create(new DirectoryInfo(keyRing.FullName)));

            var options = new DbContextOptionsBuilder<HomeHubDbContext>()
                .UseSqlServer("Server=never-opened;Database=none;Trusted_Connection=False")
                .Options;

            using var db = new HomeHubDbContext(options, protector);
            var sql = db.GetService<IMigrator>().GenerateScript();

            // A sanity check on the output as well as on the absence of an exception: the script has
            // to contain the history inserts, or something has quietly generated nothing at all.
            foreach (var migration in AllMigrations())
            {
                var id = migration.GetType().GetCustomAttribute<MigrationAttribute>()!.Id;
                Assert.Contains(id, sql, StringComparison.Ordinal);
            }
        }
        finally
        {
            Directory.Delete(keyRing.FullName, true);
        }
    }

    /// <summary>
    /// Every migration can be reversed.
    /// </summary>
    /// <remarks>
    /// The promotion that failed was rolled back, and a rollback that reaches the database needs a
    /// <c>Down</c> to run. An empty one is a migration that can only be gone forwards through.
    /// </remarks>
    [Fact]
    public void Every_migration_can_be_undone()
    {
        foreach (var migration in AllMigrations())
        {
            // A migration whose Up does nothing has nothing to undo, which is legitimate.
            if (migration.UpOperations.Count == 0) continue;
            Assert.True(
                migration.DownOperations.Count > 0,
                $"{migration.GetType().Name} cannot be rolled back — its Down is empty.");
        }
    }
}
