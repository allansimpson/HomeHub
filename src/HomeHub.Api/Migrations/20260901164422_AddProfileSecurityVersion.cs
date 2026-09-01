using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace HomeHub.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddProfileSecurityVersion : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Default 1, matching the entity, so an existing member is not distinguishable from a
            // new one by their version alone. Every cookie issued before this column existed carries
            // no version claim at all and is rejected regardless of the number here — the household
            // signs in once after this deploy, which is the correct cost of the old cookies ceasing
            // to outlive the authority they were minted against.
            migrationBuilder.AddColumn<int>(
                name: "SecurityVersion",
                table: "Profiles",
                type: "int",
                nullable: false,
                defaultValue: 1);

            migrationBuilder.UpdateData(
                table: "Profiles",
                keyColumn: "Id",
                keyValue: 1,
                column: "SecurityVersion",
                value: 1);

            migrationBuilder.UpdateData(
                table: "Profiles",
                keyColumn: "Id",
                keyValue: 2,
                column: "SecurityVersion",
                value: 1);

            migrationBuilder.UpdateData(
                table: "Profiles",
                keyColumn: "Id",
                keyValue: 3,
                column: "SecurityVersion",
                value: 1);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "SecurityVersion",
                table: "Profiles");
        }
    }
}
