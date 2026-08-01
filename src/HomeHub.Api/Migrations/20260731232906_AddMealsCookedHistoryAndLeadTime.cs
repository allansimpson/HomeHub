using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace HomeHub.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddMealsCookedHistoryAndLeadTime : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "LeadMinutes",
                table: "Recipes",
                type: "int",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "ModifiedAtUtc",
                table: "Recipes",
                type: "datetime2",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "ModifiedByProfileId",
                table: "Recipes",
                type: "int",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "PrepNote",
                table: "Recipes",
                type: "nvarchar(600)",
                maxLength: 600,
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "WasEaten",
                table: "MealPlanEntries",
                type: "bit",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "LeadMinutes",
                table: "Recipes");

            migrationBuilder.DropColumn(
                name: "ModifiedAtUtc",
                table: "Recipes");

            migrationBuilder.DropColumn(
                name: "ModifiedByProfileId",
                table: "Recipes");

            migrationBuilder.DropColumn(
                name: "PrepNote",
                table: "Recipes");

            migrationBuilder.DropColumn(
                name: "WasEaten",
                table: "MealPlanEntries");
        }
    }
}
