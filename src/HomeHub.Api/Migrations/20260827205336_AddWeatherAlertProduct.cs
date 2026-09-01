using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace HomeHub.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddWeatherAlertProduct : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "AreaDesc",
                table: "ActiveAlerts",
                type: "nvarchar(2000)",
                maxLength: 2000,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Certainty",
                table: "ActiveAlerts",
                type: "nvarchar(20)",
                maxLength: 20,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Description",
                table: "ActiveAlerts",
                type: "nvarchar(max)",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "EndsUtc",
                table: "ActiveAlerts",
                type: "datetime2",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Event",
                table: "ActiveAlerts",
                type: "nvarchar(120)",
                maxLength: 120,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Instruction",
                table: "ActiveAlerts",
                type: "nvarchar(max)",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "OnsetUtc",
                table: "ActiveAlerts",
                type: "datetime2",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "ProductId",
                table: "ActiveAlerts",
                type: "nvarchar(256)",
                maxLength: 256,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "SenderName",
                table: "ActiveAlerts",
                type: "nvarchar(160)",
                maxLength: 160,
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "SentUtc",
                table: "ActiveAlerts",
                type: "datetime2",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "SeverityText",
                table: "ActiveAlerts",
                type: "nvarchar(20)",
                maxLength: 20,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Urgency",
                table: "ActiveAlerts",
                type: "nvarchar(20)",
                maxLength: 20,
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "AreaDesc",
                table: "ActiveAlerts");

            migrationBuilder.DropColumn(
                name: "Certainty",
                table: "ActiveAlerts");

            migrationBuilder.DropColumn(
                name: "Description",
                table: "ActiveAlerts");

            migrationBuilder.DropColumn(
                name: "EndsUtc",
                table: "ActiveAlerts");

            migrationBuilder.DropColumn(
                name: "Event",
                table: "ActiveAlerts");

            migrationBuilder.DropColumn(
                name: "Instruction",
                table: "ActiveAlerts");

            migrationBuilder.DropColumn(
                name: "OnsetUtc",
                table: "ActiveAlerts");

            migrationBuilder.DropColumn(
                name: "ProductId",
                table: "ActiveAlerts");

            migrationBuilder.DropColumn(
                name: "SenderName",
                table: "ActiveAlerts");

            migrationBuilder.DropColumn(
                name: "SentUtc",
                table: "ActiveAlerts");

            migrationBuilder.DropColumn(
                name: "SeverityText",
                table: "ActiveAlerts");

            migrationBuilder.DropColumn(
                name: "Urgency",
                table: "ActiveAlerts");
        }
    }
}
