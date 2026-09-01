using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace HomeHub.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddPantryShelf : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "Shelf",
                table: "PantryItems",
                type: "nvarchar(24)",
                maxLength: 24,
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "ResultingLocation",
                table: "PantryEvents",
                type: "int",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "ResultingShelf",
                table: "PantryEvents",
                type: "nvarchar(24)",
                maxLength: 24,
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "Shelf",
                table: "PantryItems");

            migrationBuilder.DropColumn(
                name: "ResultingLocation",
                table: "PantryEvents");

            migrationBuilder.DropColumn(
                name: "ResultingShelf",
                table: "PantryEvents");
        }
    }
}
