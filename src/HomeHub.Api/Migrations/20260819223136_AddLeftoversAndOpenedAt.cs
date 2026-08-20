using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace HomeHub.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddLeftoversAndOpenedAt : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTime>(
                name: "OpenedAt",
                table: "PantryItems",
                type: "datetime2",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "OpenedByProfileId",
                table: "PantryItems",
                type: "int",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "ProducedByPlanEntryId",
                table: "PantryItems",
                type: "int",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "PortionsEaten",
                table: "MealPlanEntries",
                type: "int",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "OpenedAt",
                table: "PantryItems");

            migrationBuilder.DropColumn(
                name: "OpenedByProfileId",
                table: "PantryItems");

            migrationBuilder.DropColumn(
                name: "ProducedByPlanEntryId",
                table: "PantryItems");

            migrationBuilder.DropColumn(
                name: "PortionsEaten",
                table: "MealPlanEntries");
        }
    }
}
