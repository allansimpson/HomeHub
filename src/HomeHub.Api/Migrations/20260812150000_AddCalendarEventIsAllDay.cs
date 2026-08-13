using HomeHub.Api.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace HomeHub.Api.Migrations
{
    /// <summary>
    /// All-day becomes a stored fact (E1).
    /// </summary>
    /// <remarks>
    /// <para>
    /// Hand-written rather than scaffolded: <c>dotnet-ef</c> is not installed on this machine and the
    /// project's <c>obj/</c> is not writable by the build account, so <c>migrations add</c> cannot
    /// run here. The <c>[DbContext]</c> and <c>[Migration]</c> attributes are the two things the
    /// scaffolded <c>.Designer.cs</c> would have contributed that EF needs at run time — without them
    /// the migration is not discovered at all. <c>BuildTargetModel</c> is omitted; it is used only by
    /// the tooling's own diffing, and <c>HomeHubDbContextModelSnapshot</c> — which is what the next
    /// scaffolded migration diffs against — is updated alongside this file.
    /// </para>
    /// <para>
    /// <b>One consequence of omitting it, learned the hard way:</b> a migration with no
    /// <c>BuildTargetModel</c> may contain <i>schema</i> operations only. <c>UpdateData</c>,
    /// <c>InsertData</c> and <c>DeleteData</c> resolve their table against <c>TargetModel</c> at
    /// <b>apply</b> time — not in the tooling — so on a hand-written migration they fail with "cannot
    /// find the table in the migration model", and they fail on the deployment rather than in the
    /// test suite, which runs on the InMemory provider and never applies a migration at all. Use
    /// <c>AddColumn</c>'s <c>defaultValue</c> for backfilling an existing row, or
    /// <c>migrationBuilder.Sql(...)</c> where real data has to move.
    /// </para>
    /// <para>
    /// Existing rows take <c>false</c>, which is right for every one of them: the column exists
    /// because nothing before it could say otherwise, and a cached Google all-day event is corrected
    /// on the next sync from whether Google sent a bare <c>date</c>. Until then the panel's boundary
    /// heuristic still reads those rows correctly — see <c>app/calendarMarks.ts</c>.
    /// </para>
    /// </remarks>
    [DbContext(typeof(HomeHubDbContext))]
    [Migration("20260812150000_AddCalendarEventIsAllDay")]
    public partial class AddCalendarEventIsAllDay : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "IsAllDay",
                table: "CalendarEvents",
                type: "bit",
                nullable: false,
                defaultValue: false);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "IsAllDay",
                table: "CalendarEvents");
        }
    }
}
