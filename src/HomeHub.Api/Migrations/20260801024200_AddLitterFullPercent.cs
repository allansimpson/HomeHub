using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace HomeHub.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddLitterFullPercent : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // 80, not EF's scaffolded 0. The column default is what any row inserted outside EF
            // would get, and a threshold of zero means "the drawer is always full" — an alert that
            // fires on an empty drawer and never stops. Matching the domain default keeps the
            // database incapable of expressing that.
            migrationBuilder.AddColumn<int>(
                name: "LitterFullPercent",
                table: "Settings",
                type: "int",
                nullable: false,
                defaultValue: 80);

            migrationBuilder.UpdateData(
                table: "Settings",
                keyColumn: "Id",
                keyValue: 1,
                column: "LitterFullPercent",
                value: 80);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "LitterFullPercent",
                table: "Settings");
        }
    }
}
