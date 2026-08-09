using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace HomeHub.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddAssistConversations : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Scaffolded as 0/false. Corrected to the entity's own defaults so the column default and
            // `new HouseholdSettings()` agree: an existing household that has never seen this screen
            // must come up storing conversations for 30 days, not silently keeping nothing.
            migrationBuilder.AddColumn<int>(
                name: "ConversationRetentionDays",
                table: "Settings",
                type: "int",
                nullable: false,
                defaultValue: 30);

            migrationBuilder.AddColumn<bool>(
                name: "StoreConversations",
                table: "Settings",
                type: "bit",
                nullable: false,
                defaultValue: true);

            migrationBuilder.CreateTable(
                name: "Conversations",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    ProfileId = table.Column<int>(type: "int", nullable: true),
                    AgentKey = table.Column<string>(type: "nvarchar(60)", maxLength: 60, nullable: false),
                    HermesSessionId = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: true),
                    Title = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: false),
                    StartedAtUtc = table.Column<DateTime>(type: "datetime2", nullable: false),
                    LastAtUtc = table.Column<DateTime>(type: "datetime2", nullable: false),
                    Pinned = table.Column<bool>(type: "bit", nullable: false),
                    ArchivedAtUtc = table.Column<DateTime>(type: "datetime2", nullable: true),
                    ReadAtUtc = table.Column<DateTime>(type: "datetime2", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Conversations", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "ConversationMessages",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    ConversationId = table.Column<int>(type: "int", nullable: false),
                    Role = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: false),
                    Text = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    AtUtc = table.Column<DateTime>(type: "datetime2", nullable: false),
                    Origin = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: true),
                    Escalated = table.Column<bool>(type: "bit", nullable: false),
                    Action = table.Column<string>(type: "nvarchar(40)", maxLength: 40, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ConversationMessages", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ConversationMessages_Conversations_ConversationId",
                        column: x => x.ConversationId,
                        principalTable: "Conversations",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.UpdateData(
                table: "Settings",
                keyColumn: "Id",
                keyValue: 1,
                columns: new[] { "ConversationRetentionDays", "StoreConversations" },
                values: new object[] { 30, true });

            migrationBuilder.CreateIndex(
                name: "IX_ConversationMessages_ConversationId_AtUtc",
                table: "ConversationMessages",
                columns: new[] { "ConversationId", "AtUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_Conversations_LastAtUtc",
                table: "Conversations",
                column: "LastAtUtc");

            migrationBuilder.CreateIndex(
                name: "IX_Conversations_ProfileId_AgentKey_ArchivedAtUtc_LastAtUtc",
                table: "Conversations",
                columns: new[] { "ProfileId", "AgentKey", "ArchivedAtUtc", "LastAtUtc" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ConversationMessages");

            migrationBuilder.DropTable(
                name: "Conversations");

            migrationBuilder.DropColumn(
                name: "ConversationRetentionDays",
                table: "Settings");

            migrationBuilder.DropColumn(
                name: "StoreConversations",
                table: "Settings");
        }
    }
}
