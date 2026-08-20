using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace HomeHub.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddAliasRejectionsAndSource : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "Source",
                table: "IngredientAliases",
                type: "int",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.CreateTable(
                name: "AliasRejections",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    CanonicalName = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: false),
                    PantryItemId = table.Column<int>(type: "int", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "datetime2", nullable: false),
                    ByProfileId = table.Column<int>(type: "int", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AliasRejections", x => x.Id);
                    table.ForeignKey(
                        name: "FK_AliasRejections_PantryItems_PantryItemId",
                        column: x => x.PantryItemId,
                        principalTable: "PantryItems",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_AliasRejections_CanonicalName_PantryItemId",
                table: "AliasRejections",
                columns: new[] { "CanonicalName", "PantryItemId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_AliasRejections_PantryItemId",
                table: "AliasRejections",
                column: "PantryItemId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "AliasRejections");

            migrationBuilder.DropColumn(
                name: "Source",
                table: "IngredientAliases");
        }
    }
}
