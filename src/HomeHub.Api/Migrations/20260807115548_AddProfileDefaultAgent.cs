using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace HomeHub.Api.Migrations
{
    /// <summary>
    /// Which agent Assist opens on, per member. Null — every existing row — is the household agent,
    /// which is what the panel already did, so an upgraded database behaves identically until somebody
    /// picks something.
    /// </summary>
    /// <remarks>
    /// The three <c>UpdateData</c> calls EF scaffolded alongside this were removed. They set the seeded
    /// profiles' new column to null, which it already is — the column is created two lines above them
    /// — and a seed write against live rows is precisely the retroactive edit <c>HomeHubDbContext</c>
    /// warns about beside those seeds. Inert here, and not worth leaving as a pattern to copy.
    /// </remarks>
    public partial class AddProfileDefaultAgent : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "DefaultAgentKey",
                table: "Profiles",
                type: "nvarchar(60)",
                maxLength: 60,
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "DefaultAgentKey",
                table: "Profiles");
        }
    }
}
