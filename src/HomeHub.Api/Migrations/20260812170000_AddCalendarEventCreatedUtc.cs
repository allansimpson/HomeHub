using HomeHub.Api.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace HomeHub.Api.Migrations
{
    /// <summary>
    /// When an engagement was written down (E6).
    /// </summary>
    /// <remarks>
    /// <para>
    /// For one label, and it is worth a column. A photograph read into the calendar shows its source
    /// as <c>TAKEN 12 AUG · READ BY BARNABY</c> when the file carried an EXIF date — and a screenshot
    /// carries none, so that case has to read <c>ADDED 12 AUG</c> instead. There was no honest date
    /// to put there: <c>UpdatedUtc</c> is when somebody last edited the engagement, which is a
    /// different fact and drifts every time they do.
    /// </para>
    /// <para>
    /// <b>Nullable, and not back-filled.</b> Every row that predates this genuinely does not know when
    /// it was added, and stamping them all with the migration's own timestamp would replace "unknown"
    /// with "all of them, the same afternoon" — which reads as data rather than as the guess it is.
    /// Nothing is lost by leaving them null: the label only ever draws for an engagement read off a
    /// photograph, and no row that predates this is one.
    /// </para>
    /// </remarks>
    [DbContext(typeof(HomeHubDbContext))]
    [Migration("20260812170000_AddCalendarEventCreatedUtc")]
    public partial class AddCalendarEventCreatedUtc : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTime>(
                name: "CreatedUtc",
                table: "CalendarEvents",
                type: "datetime2",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(name: "CreatedUtc", table: "CalendarEvents");
        }
    }
}
