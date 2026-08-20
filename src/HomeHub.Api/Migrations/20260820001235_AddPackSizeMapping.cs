using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace HomeHub.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddPackSizeMapping : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "PackUnit",
                table: "ProductCatalogue",
                type: "nvarchar(max)",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "PackSizeAtUtc",
                table: "PantryItems",
                type: "datetime2",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "PackSizeByProfileId",
                table: "PantryItems",
                type: "int",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "PackUnit",
                table: "ProductCatalogue");

            migrationBuilder.DropColumn(
                name: "PackSizeAtUtc",
                table: "PantryItems");

            migrationBuilder.DropColumn(
                name: "PackSizeByProfileId",
                table: "PantryItems");
        }
    }
}
