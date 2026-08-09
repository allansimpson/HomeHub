using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace HomeHub.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddMealGroups : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_MealPlanEntries_Date_Slot",
                table: "MealPlanEntries");

            migrationBuilder.AddColumn<int>(
                name: "Position",
                table: "MealPlanEntries",
                type: "int",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<int>(
                name: "Role",
                table: "MealPlanEntries",
                type: "int",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.CreateTable(
                name: "Meals",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    Name = table.Column<string>(type: "nvarchar(300)", maxLength: 300, nullable: false),
                    Servings = table.Column<int>(type: "int", nullable: true),
                    PrepNote = table.Column<string>(type: "nvarchar(600)", maxLength: 600, nullable: true),
                    Cuisine = table.Column<string>(type: "nvarchar(40)", maxLength: 40, nullable: true),
                    IsArchived = table.Column<bool>(type: "bit", nullable: false),
                    ModifiedByProfileId = table.Column<int>(type: "int", nullable: true),
                    ModifiedAtUtc = table.Column<DateTime>(type: "datetime2", nullable: true),
                    CreatedUtc = table.Column<DateTime>(type: "datetime2", nullable: false),
                    UpdatedUtc = table.Column<DateTime>(type: "datetime2", nullable: false),
                    Version = table.Column<int>(type: "int", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Meals", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "MealComponents",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    MealId = table.Column<int>(type: "int", nullable: false),
                    RecipeId = table.Column<int>(type: "int", nullable: false),
                    Role = table.Column<int>(type: "int", nullable: false),
                    Position = table.Column<int>(type: "int", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_MealComponents", x => x.Id);
                    table.ForeignKey(
                        name: "FK_MealComponents_Meals_MealId",
                        column: x => x.MealId,
                        principalTable: "Meals",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_MealComponents_Recipes_RecipeId",
                        column: x => x.RecipeId,
                        principalTable: "Recipes",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_MealPlanEntries_Date_Slot_Position",
                table: "MealPlanEntries",
                columns: new[] { "Date", "Slot", "Position" });

            migrationBuilder.CreateIndex(
                name: "IX_MealComponents_MealId_Position",
                table: "MealComponents",
                columns: new[] { "MealId", "Position" });

            migrationBuilder.CreateIndex(
                name: "IX_MealComponents_MealId_RecipeId",
                table: "MealComponents",
                columns: new[] { "MealId", "RecipeId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_MealComponents_RecipeId",
                table: "MealComponents",
                column: "RecipeId");

            migrationBuilder.CreateIndex(
                name: "IX_Meals_IsArchived_Name",
                table: "Meals",
                columns: new[] { "IsArchived", "Name" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "MealComponents");

            migrationBuilder.DropTable(
                name: "Meals");

            migrationBuilder.DropIndex(
                name: "IX_MealPlanEntries_Date_Slot_Position",
                table: "MealPlanEntries");

            migrationBuilder.DropColumn(
                name: "Position",
                table: "MealPlanEntries");

            migrationBuilder.DropColumn(
                name: "Role",
                table: "MealPlanEntries");

            migrationBuilder.CreateIndex(
                name: "IX_MealPlanEntries_Date_Slot",
                table: "MealPlanEntries",
                columns: new[] { "Date", "Slot" },
                unique: true);
        }
    }
}
