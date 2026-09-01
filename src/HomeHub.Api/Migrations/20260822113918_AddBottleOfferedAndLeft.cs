using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace HomeHub.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddBottleOfferedAndLeft : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<double>(
                name: "Left",
                table: "CareEntries",
                type: "float",
                nullable: true);

            migrationBuilder.AddColumn<double>(
                name: "Offered",
                table: "CareEntries",
                type: "float",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "Left",
                table: "CareEntries");

            migrationBuilder.DropColumn(
                name: "Offered",
                table: "CareEntries");
        }
    }
}
