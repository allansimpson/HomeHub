using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace HomeHub.Api.Migrations
{
    /// <inheritdoc />
    public partial class SyncedListsSelection : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "ListsConfigured",
                table: "MicrosoftAccountLinks",
                type: "bit",
                nullable: false,
                defaultValue: false);

            migrationBuilder.CreateTable(
                name: "SyncedLists",
                columns: table => new
                {
                    ProfileId = table.Column<int>(type: "int", nullable: false),
                    GraphListId = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: false),
                    ListName = table.Column<string>(type: "nvarchar(100)", maxLength: 100, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SyncedLists", x => new { x.ProfileId, x.GraphListId });
                });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "SyncedLists");

            migrationBuilder.DropColumn(
                name: "ListsConfigured",
                table: "MicrosoftAccountLinks");
        }
    }
}
