using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace HomeHub.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddHermesSessionLineage : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "HermesSessionReferences",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    ConversationId = table.Column<int>(type: "int", nullable: false),
                    AgentKey = table.Column<string>(type: "nvarchar(60)", maxLength: 60, nullable: false),
                    SessionId = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: false),
                    DiscoveredAtUtc = table.Column<DateTime>(type: "datetime2", nullable: false),
                    IsCurrent = table.Column<bool>(type: "bit", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_HermesSessionReferences", x => x.Id);
                    table.ForeignKey(
                        name: "FK_HermesSessionReferences_Conversations_ConversationId",
                        column: x => x.ConversationId,
                        principalTable: "Conversations",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_HermesSessionReferences_ConversationId_IsCurrent",
                table: "HermesSessionReferences",
                columns: new[] { "ConversationId", "IsCurrent" });

            migrationBuilder.CreateIndex(
                name: "IX_HermesSessionReferences_ConversationId_SessionId",
                table: "HermesSessionReferences",
                columns: new[] { "ConversationId", "SessionId" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "HermesSessionReferences");
        }
    }
}
