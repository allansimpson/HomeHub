namespace HomeHub.Api.Security;

using HomeHub.Api.Data;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// Rewrites credential columns that still hold plaintext from before <see cref="SecretProtector"/>.
/// </summary>
/// <remarks>
/// <para>
/// AUDIT A2 asks for "a data migration that re-encrypts existing rows". This is that, and it is
/// deliberately <b>not</b> an EF migration: an EF migration is a schema statement, it runs under
/// <c>dotnet ef</c> with no access to the running app's key ring, and the value it would have to
/// write depends on a key that only exists at runtime. Encrypting data with a runtime key belongs
/// in runtime code.
/// </para>
/// <para>
/// <b>It reads and writes raw SQL on purpose.</b> Going through the entity would mean going through
/// the value converter, which is exactly the layer being bypassed — the converter cannot tell you
/// what is physically in the column, which is the only question this class asks. Raw SQL sees the
/// stored bytes, so "is this row still plaintext" has an actual answer.
/// </para>
/// <para>
/// It is idempotent and cheap: after the first run the <c>NOT LIKE</c> matches nothing, and there
/// is at most one row per household member per provider. It stays rather than being deleted after
/// one deploy, because a restore from an old backup would otherwise put plaintext back with nothing
/// to notice.
/// </para>
/// </remarks>
public static class LegacySecretMigration
{
    /// <summary>The two columns holding a credential, as (table, key column, secret column).</summary>
    private static readonly (string Table, string Key, string Column)[] Targets =
    [
        ("GoogleAccountLinks", "ProfileId", "RefreshToken"),
        ("MicrosoftAccountLinks", "ProfileId", "RefreshToken"),
    ];

    /// <summary>Encrypt any still-plaintext credential. Returns how many rows were rewritten.</summary>
    public static async Task<int> RunAsync(
        HomeHubDbContext db, ISecretProtector protector, ILogger logger, CancellationToken ct = default)
    {
        var rewritten = 0;

        foreach (var (table, key, column) in Targets)
        {
            // EF1002 is about interpolating *values* into SQL. What is interpolated here is only
            // ever an identifier from the constant `Targets` array a few lines above — no argument,
            // no configuration, nothing reachable from a request. `SqlQuery` (the interpolated,
            // parameterising overload) cannot express this, because a table name is not something
            // SQL can parameterise. Every actual value below travels as @p0/@p1, including the
            // ciphertext and the LIKE pattern, which is the part the rule exists to protect.
#pragma warning disable EF1002
            var ids = await db.Database
                .SqlQueryRaw<int>(
                    $"SELECT [{key}] AS [Value] FROM [{table}] WHERE [{column}] IS NOT NULL AND [{column}] NOT LIKE @p0",
                    SecretProtector.Envelope + "%")
                .ToListAsync(ct);

            foreach (var id in ids)
            {
                var plaintext = await db.Database
                    .SqlQueryRaw<string>($"SELECT [{column}] AS [Value] FROM [{table}] WHERE [{key}] = @p0", id)
                    .SingleOrDefaultAsync(ct);

                if (string.IsNullOrEmpty(plaintext)) continue;

                await db.Database.ExecuteSqlRawAsync(
                    $"UPDATE [{table}] SET [{column}] = @p0 WHERE [{key}] = @p1",
                    [protector.Protect(plaintext)!, id],
                    ct);
                rewritten++;
            }
#pragma warning restore EF1002
        }

        // Logged at Information rather than Debug because this is the line that tells you the
        // household's tokens are now bound to this key ring — which is the fact that matters if the
        // key directory is ever lost or moved.
        if (rewritten > 0) logger.LogInformation("Encrypted {Count} stored credential(s) at rest.", rewritten);

        return rewritten;
    }
}
