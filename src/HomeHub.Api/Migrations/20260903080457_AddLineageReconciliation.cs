using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace HomeHub.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddLineageReconciliation : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTime>(
                name: "LineageAuditedAtUtc",
                table: "Settings",
                type: "datetime2",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "LineageRiskAcceptedAtUtc",
                table: "Settings",
                type: "datetime2",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "LineageRiskAcceptedByProfileId",
                table: "Settings",
                type: "int",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "LineageRiskAcceptedSessions",
                table: "Settings",
                type: "nvarchar(max)",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "LineageState",
                table: "Settings",
                type: "int",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.UpdateData(
                table: "Settings",
                keyColumn: "Id",
                keyValue: 1,
                columns: new[] { "LineageAuditedAtUtc", "LineageRiskAcceptedAtUtc", "LineageRiskAcceptedByProfileId", "LineageRiskAcceptedSessions", "LineageState" },
                values: new object[] { null, null, null, null, 0 });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "LineageAuditedAtUtc",
                table: "Settings");

            migrationBuilder.DropColumn(
                name: "LineageRiskAcceptedAtUtc",
                table: "Settings");

            migrationBuilder.DropColumn(
                name: "LineageRiskAcceptedByProfileId",
                table: "Settings");

            migrationBuilder.DropColumn(
                name: "LineageRiskAcceptedSessions",
                table: "Settings");

            migrationBuilder.DropColumn(
                name: "LineageState",
                table: "Settings");
        }
    }
}
