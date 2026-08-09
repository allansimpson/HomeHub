using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace HomeHub.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddNightDimWindow : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // 22:00–06:00 is the window the panel dimmed to before it was configurable, so an
            // existing panel behaves identically until somebody moves it.
            //
            // Backfilled here rather than left at the scaffolded midnight on purpose: a start equal
            // to an end is an *empty* window, so those rows would leave the panel never dimming
            // again — and an upgrade that silently switches night mode off is exactly the kind of
            // change nobody connects to the deploy that caused it. The UpdateData below sets the
            // singleton row regardless; this is the same answer for any row it does not reach.
            migrationBuilder.AddColumn<TimeOnly>(
                name: "NightDimEnd",
                table: "Settings",
                type: "time",
                nullable: false,
                defaultValue: new TimeOnly(6, 0, 0));

            migrationBuilder.AddColumn<TimeOnly>(
                name: "NightDimStart",
                table: "Settings",
                type: "time",
                nullable: false,
                defaultValue: new TimeOnly(22, 0, 0));

            migrationBuilder.UpdateData(
                table: "Settings",
                keyColumn: "Id",
                keyValue: 1,
                columns: new[] { "NightDimEnd", "NightDimStart" },
                values: new object[] { new TimeOnly(6, 0, 0), new TimeOnly(22, 0, 0) });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "NightDimEnd",
                table: "Settings");

            migrationBuilder.DropColumn(
                name: "NightDimStart",
                table: "Settings");
        }
    }
}
