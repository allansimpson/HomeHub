using HomeHub.Api.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace HomeHub.Api.Migrations
{
    /// <summary>
    /// A pump session that has finished and is waiting for its amount.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>A pump session is measured at one moment and written at another.</b> How much was
    /// expressed is knowable only at the end, so the panel's FINISH stops the clock and holds the
    /// session; the amount is asked for once, and SAVE writes the session and the amount together.
    /// There is deliberately no path that writes a session and updates its amount afterwards, and
    /// none that carries an amount guessed before the session ran.
    /// </para>
    /// <para>
    /// The hold is a row rather than panel state so it survives the panel being closed, the app
    /// being killed, and the household picking up a different device: all three find the same held
    /// session, and the day view reports it as awaiting an amount rather than losing it or writing
    /// it unmeasured.
    /// </para>
    /// <para>
    /// <b>Nullable, and not back-filled.</b> Null is the ordinary state — a session that is running,
    /// and every timer of every other type. Nothing that predates this column was ever held.
    /// </para>
    /// </remarks>
    [DbContext(typeof(HomeHubDbContext))]
    [Migration("20260817120000_AddHeldPumpSession")]
    public partial class AddHeldPumpSession : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTime>(
                name: "EndedUtc",
                table: "CareTimers",
                type: "datetime2",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(name: "EndedUtc", table: "CareTimers");
        }
    }
}
