using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

#pragma warning disable CA1814 // Prefer jagged arrays over multidimensional

namespace HomeHub.Api.Migrations
{
    /// <inheritdoc />
    public partial class Stage1_ProfilesAndSettings : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "Profiles",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    Name = table.Column<string>(type: "nvarchar(40)", maxLength: 40, nullable: false),
                    Initial = table.Column<string>(type: "nvarchar(2)", maxLength: 2, nullable: false),
                    PinHash = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    RequirePinWhenIdle = table.Column<bool>(type: "bit", nullable: false),
                    StayLoggedIn = table.Column<bool>(type: "bit", nullable: false),
                    DisplayOrder = table.Column<int>(type: "int", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Profiles", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Settings",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    IdleTimeoutMinutes = table.Column<int>(type: "int", nullable: false),
                    IdleDimmingEnabled = table.Column<bool>(type: "bit", nullable: false),
                    FreezerWarnAboveCelsius = table.Column<int>(type: "int", nullable: false),
                    HumidityWarnAbovePercent = table.Column<int>(type: "int", nullable: false),
                    ActiveProfileId = table.Column<int>(type: "int", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Settings", x => x.Id);
                });

            migrationBuilder.InsertData(
                table: "Profiles",
                columns: new[] { "Id", "DisplayOrder", "Initial", "Name", "PinHash", "RequirePinWhenIdle", "StayLoggedIn" },
                values: new object[,]
                {
                    { 1, 0, "A", "Astrid", null, false, true },
                    { 2, 1, "R", "Ragnar", null, false, true },
                    { 3, 2, "L", "Leif", null, false, true }
                });

            migrationBuilder.InsertData(
                table: "Settings",
                columns: new[] { "Id", "ActiveProfileId", "FreezerWarnAboveCelsius", "HumidityWarnAbovePercent", "IdleDimmingEnabled", "IdleTimeoutMinutes" },
                values: new object[] { 1, null, 10, 65, true, 5 });

            migrationBuilder.CreateIndex(
                name: "IX_Profiles_DisplayOrder",
                table: "Profiles",
                column: "DisplayOrder");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "Profiles");

            migrationBuilder.DropTable(
                name: "Settings");
        }
    }
}
