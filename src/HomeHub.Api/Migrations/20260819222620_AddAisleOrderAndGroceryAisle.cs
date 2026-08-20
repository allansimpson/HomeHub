using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace HomeHub.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddAisleOrderAndGroceryAisle : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "Aisle",
                table: "GroceryLines",
                type: "nvarchar(80)",
                maxLength: 80,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Store",
                table: "GroceryLines",
                type: "nvarchar(80)",
                maxLength: 80,
                nullable: true);

            migrationBuilder.CreateTable(
                name: "AisleOrder",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    Store = table.Column<string>(type: "nvarchar(80)", maxLength: 80, nullable: false),
                    Aisle = table.Column<string>(type: "nvarchar(80)", maxLength: 80, nullable: false),
                    Position = table.Column<int>(type: "int", nullable: false),
                    UpdatedUtc = table.Column<DateTime>(type: "datetime2", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AisleOrder", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_AisleOrder_Store_Aisle",
                table: "AisleOrder",
                columns: new[] { "Store", "Aisle" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "AisleOrder");

            migrationBuilder.DropColumn(
                name: "Aisle",
                table: "GroceryLines");

            migrationBuilder.DropColumn(
                name: "Store",
                table: "GroceryLines");
        }
    }
}
