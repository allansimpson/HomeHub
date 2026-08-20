using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace HomeHub.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddGoodUntil : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateOnly>(
                name: "GoodUntil",
                table: "PantryItems",
                type: "date",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "GoodUntilSource",
                table: "PantryItems",
                type: "int",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "GoodUntil",
                table: "PantryItems");

            migrationBuilder.DropColumn(
                name: "GoodUntilSource",
                table: "PantryItems");
        }
    }
}
