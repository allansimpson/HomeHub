namespace HomeHub.Tests;

using HomeHub.Api.Assist;
using HomeHub.Api.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

/// <summary>
/// <b>H2c.</b> Consuming an acceptance and deleting the conversations it authorised used to be two
/// separate commits — set <c>ConsumedAtUtc</c> and save, then remove the rows and save again. A crash,
/// a dropped connection or a lost race between the two left the conversations deleted and the
/// authorisation still unspent: reusable, ready to authorise a second deletion it was never granted
/// for. They are one commit now, and <see cref="LineageRiskAcceptance.RowVersion"/> is the concurrency
/// token that turns a second, concurrent attempt to spend the same row into a conflict rather than a
/// second success.
/// </summary>
/// <remarks>
/// <para>
/// <b>What EF Core InMemory cannot stand in for here, found while writing these.</b> A SQL Server
/// <c>rowversion</c> column is bumped by the engine itself on every <c>UPDATE</c> — that is what makes
/// a second reader's copy stale. InMemory never generates a value for it at all: a freshly inserted row
/// probes as <c>RowVersion == null</c>, and stays null through an update that touches no other property
/// of it, so two contexts that only set <c>ConsumedAtUtc</c> never disagree about the token and neither
/// throws. The first test below bumps it by hand to stand in for what the engine guarantees in
/// production, which is the honest way to exercise the comparison without a real server to prove it
/// against.
/// </para>
/// <para>
/// <b>And SaveChanges on InMemory is not all-or-nothing.</b> Probed directly: when one tracked entity's
/// save fails, InMemory still applies the unrelated inserts from the same call — a tombstone <c>Add</c>
/// alongside a <c>Remove</c> that throws leaves the tombstone behind anyway. A real SQL Server
/// connection wraps the whole call in one transaction, so a losing request's tombstone would roll back
/// with everything else in it; this provider cannot show that.
/// </para>
/// <para>
/// <b>There was a second, end-to-end test here — many real concurrent HTTP delete requests against one
/// acceptance, asserting exactly one succeeded.</b> It passed reliably alone and failed intermittently
/// once the rest of the suite was running beside it: under real thread-pool contention, more than one
/// request's <c>SaveChanges</c> came back successful for what should have been a single-use row, which
/// only a database's actual locking prevents. That is InMemory's internal concurrency handling, not
/// this fix — a store with no real transactions or row locks cannot be driven hard enough by a unit
/// test to reproduce what a database does under contention, and a test that only fails when the CPU is
/// busy is not a signal to keep. It was removed rather than kept flaky; proving this specific property
/// end-to-end needs a real SQL Server connection.
/// </para>
/// </remarks>
public class LineageRiskAcceptanceConcurrencyTests
{
    /// <summary>
    /// The comparison itself: two contexts that both read one unspent acceptance, and only the first
    /// to save may win. <c>RowVersion</c> is bumped by hand on each write, standing in for the value a
    /// SQL Server <c>rowversion</c> column would generate on its own — see the class remarks.
    /// </summary>
    [Fact]
    public async Task A_second_concurrent_save_of_the_same_acceptance_is_rejected()
    {
        using var app = new HubAppFactory();

        int acceptanceId;
        using (var scope = app.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<HomeHubDbContext>();
            var acceptance = new LineageRiskAcceptance
            {
                Nonce = "race-nonce",
                ReportDigest = "digest",
                ConversationIds = "1",
                AcceptedAtUtc = DateTime.UtcNow,
                ExpiresAtUtc = DateTime.UtcNow.AddMinutes(15),
                RowVersion = [0],
            };
            db.LineageRiskAcceptances.Add(acceptance);
            await db.SaveChangesAsync();
            acceptanceId = acceptance.Id;
        }

        using var scopeA = app.Services.CreateScope();
        using var scopeB = app.Services.CreateScope();
        var dbA = scopeA.ServiceProvider.GetRequiredService<HomeHubDbContext>();
        var dbB = scopeB.ServiceProvider.GetRequiredService<HomeHubDbContext>();

        // Both "requests" read the row while it is still unspent, each holding token value [0].
        var acceptanceA = await dbA.LineageRiskAcceptances.SingleAsync(a => a.Id == acceptanceId);
        var acceptanceB = await dbB.LineageRiskAcceptances.SingleAsync(a => a.Id == acceptanceId);

        acceptanceA.ConsumedAtUtc = DateTime.UtcNow;
        acceptanceA.RowVersion = [1]; // what SQL Server would generate on this UPDATE
        await dbA.SaveChangesAsync(); // the winner

        acceptanceB.ConsumedAtUtc = DateTime.UtcNow;
        acceptanceB.RowVersion = [2];
        // The loser: its original token value ([0]) no longer matches what is stored ([1]).
        await Assert.ThrowsAsync<DbUpdateConcurrencyException>(() => dbB.SaveChangesAsync());

        Assert.NotNull((await dbA.LineageRiskAcceptances.SingleAsync(a => a.Id == acceptanceId)).ConsumedAtUtc);
    }
}
