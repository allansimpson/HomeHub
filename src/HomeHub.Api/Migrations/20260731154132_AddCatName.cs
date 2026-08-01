using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace HomeHub.Api.Migrations
{
    /// <summary>
    /// The household's name for the cat — the one Litter setting the panel owns rather than Home
    /// Assistant, so it needs somewhere to live that survives a restart.
    /// </summary>
    public partial class AddCatName : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "CatName",
                table: "Settings",
                type: "nvarchar(max)",
                nullable: true);

            // The settings row is seeded, so the seed's shape has to move with the column.
            migrationBuilder.UpdateData(
                table: "Settings",
                keyColumn: "Id",
                keyValue: 1,
                column: "CatName",
                value: null);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "CatName",
                table: "Settings");
        }
    }
}
