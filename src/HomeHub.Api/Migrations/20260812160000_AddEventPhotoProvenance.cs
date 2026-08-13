using HomeHub.Api.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace HomeHub.Api.Migrations
{
    /// <summary>
    /// Where an engagement came from, and the photograph it was read off (E3).
    /// </summary>
    /// <remarks>
    /// Hand-written for the same reason as the migration before it — see
    /// <see cref="AddCalendarEventIsAllDay"/> for why, and for what the two attributes are doing.
    /// <para>
    /// Three columns rather than one, because "read from a photo", "the photo is still here" and
    /// "the photo was taken on" are three different facts and each has a state where it is true
    /// alone: a flyer in a format the panel cannot draw is read-from-a-photo with nothing kept, and
    /// a screenshot is kept with no date on it.
    /// </para>
    /// </remarks>
    [DbContext(typeof(HomeHubDbContext))]
    [Migration("20260812160000_AddEventPhotoProvenance")]
    public partial class AddEventPhotoProvenance : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "FromPhoto",
                table: "CalendarEvents",
                type: "bit",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<string>(
                name: "PhotoFile",
                table: "CalendarEvents",
                type: "nvarchar(64)",
                maxLength: 64,
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "PhotoTakenUtc",
                table: "CalendarEvents",
                type: "datetime2",
                nullable: true);

            // Default on: this feature manufactures uncertain values and marks them for checking,
            // and checking means looking at the flyer.
            //
            // The default is also what sets the *existing* row. There was an `UpdateData` here
            // stating that again for `Id = 1`, and it broke the DEV→TEST promotion: data operations
            // (`UpdateData` / `InsertData` / `DeleteData`) resolve their table against the
            // migration's `TargetModel`, which is built by `BuildTargetModel` — and these migrations
            // are hand-written and deliberately omit it. With no target model there is no `Settings`
            // table to find, so the migration threw at apply time on a database that had just taken
            // the one before it. Schema operations like this `AddColumn` never consult that model,
            // which is why every other statement in this file was fine.
            //
            // Redundant as well as fatal: `ALTER TABLE … ADD … NOT NULL DEFAULT 1` writes 1 into
            // every row that already exists, which is exactly what the `UpdateData` was for.
            migrationBuilder.AddColumn<bool>(
                name: "KeepEventPhotos",
                table: "Settings",
                type: "bit",
                nullable: false,
                defaultValue: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(name: "FromPhoto", table: "CalendarEvents");
            migrationBuilder.DropColumn(name: "PhotoFile", table: "CalendarEvents");
            migrationBuilder.DropColumn(name: "PhotoTakenUtc", table: "CalendarEvents");
            migrationBuilder.DropColumn(name: "KeepEventPhotos", table: "Settings");
        }
    }
}
