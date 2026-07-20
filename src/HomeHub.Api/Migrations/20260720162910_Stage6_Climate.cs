using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

#pragma warning disable CA1814 // Prefer jagged arrays over multidimensional

namespace HomeHub.Api.Migrations
{
    /// <inheritdoc />
    public partial class Stage6_Climate : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "ClimateZones",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    Name = table.Column<string>(type: "nvarchar(60)", maxLength: 60, nullable: false),
                    Source = table.Column<string>(type: "nvarchar(30)", maxLength: 30, nullable: false),
                    ProviderRef = table.Column<string>(type: "nvarchar(160)", maxLength: 160, nullable: false),
                    CurrentTempF = table.Column<double>(type: "float", nullable: false),
                    SetPointF = table.Column<double>(type: "float", nullable: false),
                    Mode = table.Column<int>(type: "int", nullable: false),
                    FanMode = table.Column<string>(type: "nvarchar(30)", maxLength: 30, nullable: true),
                    DisplayOrder = table.Column<int>(type: "int", nullable: false),
                    UpdatedUtc = table.Column<DateTime>(type: "datetime2", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ClimateZones", x => x.Id);
                });

            migrationBuilder.InsertData(
                table: "ClimateZones",
                columns: new[] { "Id", "CurrentTempF", "DisplayOrder", "FanMode", "Mode", "Name", "ProviderRef", "SetPointF", "Source", "UpdatedUtc" },
                values: new object[,]
                {
                    { 1, 74.0, 0, "Quiet", 1, "Living Room", "sim-living", 72.0, "simulated", new DateTime(1, 1, 1, 0, 0, 0, 0, DateTimeKind.Unspecified) },
                    { 2, 71.0, 1, "Auto", 1, "Bedroom", "sim-bedroom", 70.0, "simulated", new DateTime(1, 1, 1, 0, 0, 0, 0, DateTimeKind.Unspecified) },
                    { 3, 73.0, 2, "Auto", 3, "Kitchen", "sim-kitchen", 73.0, "simulated", new DateTime(1, 1, 1, 0, 0, 0, 0, DateTimeKind.Unspecified) },
                    { 4, 72.0, 3, null, 0, "Study", "sim-study", 72.0, "simulated", new DateTime(1, 1, 1, 0, 0, 0, 0, DateTimeKind.Unspecified) },
                    { 5, 72.0, 4, null, 0, "Loft", "sim-loft", 72.0, "simulated", new DateTime(1, 1, 1, 0, 0, 0, 0, DateTimeKind.Unspecified) }
                });

            migrationBuilder.CreateIndex(
                name: "IX_ClimateZones_DisplayOrder",
                table: "ClimateZones",
                column: "DisplayOrder");

            migrationBuilder.CreateIndex(
                name: "IX_ClimateZones_Source_ProviderRef",
                table: "ClimateZones",
                columns: new[] { "Source", "ProviderRef" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ClimateZones");
        }
    }
}
