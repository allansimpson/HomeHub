using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace HomeHub.Api.Migrations
{
    /// <inheritdoc />
    public partial class PerProfileGoogleCalendars : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "CalendarName",
                table: "CalendarEvents",
                type: "nvarchar(200)",
                maxLength: 200,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "GoogleCalendarId",
                table: "CalendarEvents",
                type: "nvarchar(200)",
                maxLength: 200,
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "ProfileId",
                table: "CalendarEvents",
                type: "int",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "GoogleAccountLinks",
                columns: table => new
                {
                    ProfileId = table.Column<int>(type: "int", nullable: false),
                    RefreshToken = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    PrimaryCalendarId = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: true),
                    CalendarsConfigured = table.Column<bool>(type: "bit", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_GoogleAccountLinks", x => x.ProfileId);
                });

            migrationBuilder.CreateTable(
                name: "SyncedCalendars",
                columns: table => new
                {
                    ProfileId = table.Column<int>(type: "int", nullable: false),
                    GoogleCalendarId = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: false),
                    CalendarName = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SyncedCalendars", x => new { x.ProfileId, x.GoogleCalendarId });
                });

            migrationBuilder.UpdateData(
                table: "ClimateZones",
                keyColumn: "Id",
                keyValue: 1,
                column: "UpdatedUtc",
                value: new DateTime(1, 1, 1, 6, 0, 0, 0, DateTimeKind.Utc));

            migrationBuilder.UpdateData(
                table: "ClimateZones",
                keyColumn: "Id",
                keyValue: 2,
                column: "UpdatedUtc",
                value: new DateTime(1, 1, 1, 6, 0, 0, 0, DateTimeKind.Utc));

            migrationBuilder.UpdateData(
                table: "ClimateZones",
                keyColumn: "Id",
                keyValue: 3,
                column: "UpdatedUtc",
                value: new DateTime(1, 1, 1, 6, 0, 0, 0, DateTimeKind.Utc));

            migrationBuilder.UpdateData(
                table: "ClimateZones",
                keyColumn: "Id",
                keyValue: 4,
                column: "UpdatedUtc",
                value: new DateTime(1, 1, 1, 6, 0, 0, 0, DateTimeKind.Utc));

            migrationBuilder.UpdateData(
                table: "ClimateZones",
                keyColumn: "Id",
                keyValue: 5,
                column: "UpdatedUtc",
                value: new DateTime(1, 1, 1, 6, 0, 0, 0, DateTimeKind.Utc));

            migrationBuilder.CreateIndex(
                name: "IX_CalendarEvents_ProfileId_StartUtc",
                table: "CalendarEvents",
                columns: new[] { "ProfileId", "StartUtc" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "GoogleAccountLinks");

            migrationBuilder.DropTable(
                name: "SyncedCalendars");

            migrationBuilder.DropIndex(
                name: "IX_CalendarEvents_ProfileId_StartUtc",
                table: "CalendarEvents");

            migrationBuilder.DropColumn(
                name: "CalendarName",
                table: "CalendarEvents");

            migrationBuilder.DropColumn(
                name: "GoogleCalendarId",
                table: "CalendarEvents");

            migrationBuilder.DropColumn(
                name: "ProfileId",
                table: "CalendarEvents");

            migrationBuilder.UpdateData(
                table: "ClimateZones",
                keyColumn: "Id",
                keyValue: 1,
                column: "UpdatedUtc",
                value: new DateTime(1, 1, 1, 0, 0, 0, 0, DateTimeKind.Unspecified));

            migrationBuilder.UpdateData(
                table: "ClimateZones",
                keyColumn: "Id",
                keyValue: 2,
                column: "UpdatedUtc",
                value: new DateTime(1, 1, 1, 0, 0, 0, 0, DateTimeKind.Unspecified));

            migrationBuilder.UpdateData(
                table: "ClimateZones",
                keyColumn: "Id",
                keyValue: 3,
                column: "UpdatedUtc",
                value: new DateTime(1, 1, 1, 0, 0, 0, 0, DateTimeKind.Unspecified));

            migrationBuilder.UpdateData(
                table: "ClimateZones",
                keyColumn: "Id",
                keyValue: 4,
                column: "UpdatedUtc",
                value: new DateTime(1, 1, 1, 0, 0, 0, 0, DateTimeKind.Unspecified));

            migrationBuilder.UpdateData(
                table: "ClimateZones",
                keyColumn: "Id",
                keyValue: 5,
                column: "UpdatedUtc",
                value: new DateTime(1, 1, 1, 0, 0, 0, 0, DateTimeKind.Unspecified));
        }
    }
}
