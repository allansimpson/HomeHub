using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace HomeHub.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddHouseholdWeatherLocation : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<double>(
                name: "WeatherLatitude",
                table: "Settings",
                type: "float",
                nullable: true);

            migrationBuilder.AddColumn<double>(
                name: "WeatherLongitude",
                table: "Settings",
                type: "float",
                nullable: true);

            migrationBuilder.UpdateData(
                table: "Settings",
                keyColumn: "Id",
                keyValue: 1,
                columns: new[] { "WeatherLatitude", "WeatherLongitude" },
                values: new object[] { null, null });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "WeatherLatitude",
                table: "Settings");

            migrationBuilder.DropColumn(
                name: "WeatherLongitude",
                table: "Settings");
        }
    }
}
