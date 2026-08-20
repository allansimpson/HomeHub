using HomeHub.Api.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace HomeHub.Api.Migrations
{
    /// <summary>
    /// Where expression started, so it gets its full length.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A pump session is stimulation then expression, and nothing switches between them on anybody's
    /// behalf — the phase moves when SWITCH NOW is pressed. Both phases were measured from the start
    /// of the session, so the second one ended at <c>PhaseOneMinutes + PhaseTwoMinutes</c> however
    /// long the first actually ran: overrunning stimulation by four minutes at 4am quietly docked
    /// four minutes off the pumping, and the phase that came up short was the one that produces the
    /// milk.
    /// </para>
    /// <para>
    /// <b>Elapsed minutes, not a switch timestamp.</b> Elapsed already knows about pauses — the
    /// session banks them in <c>AccumulatedMinutes</c> — and a wall clock would count a ten-minute
    /// pause as ten minutes of expression.
    /// </para>
    /// <para>
    /// <b>Nullable and not back-filled.</b> It is only ever set at the moment of a switch, so a
    /// session still in stimulation has nothing to put here, and the one session that might be
    /// mid-expression when this deploys genuinely does not know when it turned over. The panel falls
    /// back to the old whole-session reading when it is null rather than inventing a mark.
    /// </para>
    /// </remarks>
    [DbContext(typeof(HomeHubDbContext))]
    [Migration("20260817090000_AddPumpPhaseTwoMark")]
    public partial class AddPumpPhaseTwoMark : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<double>(
                name: "PhaseTwoAtMinutes",
                table: "CareTimers",
                type: "float",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(name: "PhaseTwoAtMinutes", table: "CareTimers");
        }
    }
}
