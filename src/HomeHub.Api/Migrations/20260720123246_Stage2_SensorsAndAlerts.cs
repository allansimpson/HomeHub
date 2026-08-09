using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

#pragma warning disable CA1814 // Prefer jagged arrays over multidimensional

namespace HomeHub.Api.Migrations
{
    /// <inheritdoc />
    public partial class Stage2_SensorsAndAlerts : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "FreezerWarnAboveCelsius",
                table: "Settings");

            migrationBuilder.DropColumn(
                name: "HumidityWarnAbovePercent",
                table: "Settings");

            migrationBuilder.CreateTable(
                name: "ActiveAlerts",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    Type = table.Column<string>(type: "nvarchar(30)", maxLength: 30, nullable: false),
                    DedupeKey = table.Column<string>(type: "nvarchar(80)", maxLength: 80, nullable: false),
                    Severity = table.Column<int>(type: "int", nullable: false),
                    Message = table.Column<string>(type: "nvarchar(300)", maxLength: 300, nullable: false),
                    Source = table.Column<string>(type: "nvarchar(80)", maxLength: 80, nullable: false),
                    StartedAtUtc = table.Column<DateTime>(type: "datetime2", nullable: false),
                    ClearedAtUtc = table.Column<DateTime>(type: "datetime2", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ActiveAlerts", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "SensorZones",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    Name = table.Column<string>(type: "nvarchar(60)", maxLength: 60, nullable: false),
                    Source = table.Column<string>(type: "nvarchar(30)", maxLength: 30, nullable: false),
                    ProviderRef = table.Column<string>(type: "nvarchar(120)", maxLength: 120, nullable: false),
                    Category = table.Column<int>(type: "int", nullable: false),
                    DisplayOrder = table.Column<int>(type: "int", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SensorZones", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "AlertThresholds",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    ZoneId = table.Column<int>(type: "int", nullable: false),
                    Metric = table.Column<int>(type: "int", nullable: false),
                    Direction = table.Column<int>(type: "int", nullable: false),
                    Value = table.Column<double>(type: "float", nullable: false),
                    DurationMinutes = table.Column<int>(type: "int", nullable: false),
                    Severity = table.Column<int>(type: "int", nullable: false),
                    Enabled = table.Column<bool>(type: "bit", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AlertThresholds", x => x.Id);
                    table.ForeignKey(
                        name: "FK_AlertThresholds_SensorZones_ZoneId",
                        column: x => x.ZoneId,
                        principalTable: "SensorZones",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "SensorReadings",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    ZoneId = table.Column<int>(type: "int", nullable: false),
                    TimestampUtc = table.Column<DateTime>(type: "datetime2", nullable: false),
                    TempF = table.Column<double>(type: "float", nullable: false),
                    Humidity = table.Column<double>(type: "float", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SensorReadings", x => x.Id);
                    table.ForeignKey(
                        name: "FK_SensorReadings_SensorZones_ZoneId",
                        column: x => x.ZoneId,
                        principalTable: "SensorZones",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.InsertData(
                table: "SensorZones",
                columns: new[] { "Id", "Category", "DisplayOrder", "Name", "ProviderRef", "Source" },
                values: new object[,]
                {
                    { 1, 1, 0, "Freezer", "sim-freezer", "simulated" },
                    { 2, 1, 1, "Fridge", "sim-fridge", "simulated" },
                    { 3, 0, 2, "Living Room", "sim-living", "simulated" },
                    { 4, 0, 3, "Kitchen", "sim-kitchen", "simulated" },
                    { 5, 0, 4, "Bedroom", "sim-bedroom", "simulated" }
                });

            migrationBuilder.InsertData(
                table: "AlertThresholds",
                columns: new[] { "Id", "Direction", "DurationMinutes", "Enabled", "Metric", "Severity", "Value", "ZoneId" },
                values: new object[,]
                {
                    { 1, 0, 10, true, 0, 2, 10.0, 1 },
                    { 2, 0, 10, true, 0, 1, 40.0, 2 },
                    { 3, 0, 10, true, 1, 1, 65.0, 3 },
                    { 4, 0, 10, true, 1, 1, 65.0, 4 },
                    { 5, 0, 10, true, 1, 1, 65.0, 5 }
                });

            migrationBuilder.CreateIndex(
                name: "IX_ActiveAlerts_Type_ClearedAtUtc",
                table: "ActiveAlerts",
                columns: new[] { "Type", "ClearedAtUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_AlertThresholds_ZoneId",
                table: "AlertThresholds",
                column: "ZoneId");

            migrationBuilder.CreateIndex(
                name: "IX_SensorReadings_ZoneId_TimestampUtc",
                table: "SensorReadings",
                columns: new[] { "ZoneId", "TimestampUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_SensorZones_DisplayOrder",
                table: "SensorZones",
                column: "DisplayOrder");

            migrationBuilder.CreateIndex(
                name: "IX_SensorZones_Source_ProviderRef",
                table: "SensorZones",
                columns: new[] { "Source", "ProviderRef" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ActiveAlerts");

            migrationBuilder.DropTable(
                name: "AlertThresholds");

            migrationBuilder.DropTable(
                name: "SensorReadings");

            migrationBuilder.DropTable(
                name: "SensorZones");

            migrationBuilder.AddColumn<int>(
                name: "FreezerWarnAboveCelsius",
                table: "Settings",
                type: "int",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<int>(
                name: "HumidityWarnAbovePercent",
                table: "Settings",
                type: "int",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.UpdateData(
                table: "Settings",
                keyColumn: "Id",
                keyValue: 1,
                columns: new[] { "FreezerWarnAboveCelsius", "HumidityWarnAbovePercent" },
                values: new object[] { 10, 65 });
        }
    }
}
