using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace HomeHub.Api.Migrations
{
    /// <summary>
    /// Stage A2 — rolls back the two parts of A1 that no longer have a job (ai-assistant.md rev. 2).
    ///
    /// <c>AssistantIdentity</c> held Barnaby's persona text for a prompt assembler that was never
    /// built: the persona now lives in Hermes Agent's own profile configuration, so the table would
    /// only ever be a misleading second source of truth. <c>Profiles.AgeBand</c> existed solely to
    /// drive a child/adult register delta, and no children use the panel — the whole child track is
    /// gone. <c>Profiles.Role</c> is deliberately kept: gating who may change settings on a shared
    /// panel stands on its own, independent of the assistant.
    ///
    /// A1's migration is applied to the live database, so this is a forward migration rather than a
    /// file deletion. <c>Down</c> restores both, seed included.
    /// </summary>
    public partial class RemoveAssistantIdentityAndAgeBand : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "AssistantIdentity");

            migrationBuilder.DropColumn(
                name: "AgeBand",
                table: "Profiles");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "AgeBand",
                table: "Profiles",
                type: "int",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.CreateTable(
                name: "AssistantIdentity",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false),
                    ChildContentBoundaries = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    CorePersona = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    GlobalConstraints = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    Name = table.Column<string>(type: "nvarchar(40)", maxLength: 40, nullable: false),
                    UpdatedUtc = table.Column<DateTime>(type: "datetime2", nullable: false),
                    Version = table.Column<int>(type: "int", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AssistantIdentity", x => x.Id);
                });

            migrationBuilder.InsertData(
                table: "AssistantIdentity",
                columns: new[] { "Id", "ChildContentBoundaries", "CorePersona", "GlobalConstraints", "Name", "UpdatedUtc", "Version" },
                values: new object[] { 1, "You are speaking with a child. Keep language simple and kind, and be patient. Don't discuss adult topics (violence, sexual content, self-harm, substances, or frightening material), don't give medical or safety advice beyond \"ask a grown-up,\" and don't help with anything a parent wouldn't want handled unsupervised — gently point them to a guardian instead. Never promise to keep something secret from their parents.", "You are Barnaby, the attendant of this household's home panel. You are calm, warm, and quietly capable — the sort of presence that makes a busy house run smoother without ever making itself the center of attention. You speak plainly and briefly, especially aloud; you would rather do the thing than describe it. Your humor is dry and gentle, used sparingly. You know the people here and meet each one where they are — unhurried with a child, efficient with someone mid-task — never one-size-fits-all. You are a fixture of the home, not a product: you don't perform enthusiasm, announce yourself as an AI, or pad your answers. When you don't know, you say so.", "- Keep spoken replies to a sentence or two unless asked for more — this is a wall panel, not a lecture.\n- Never claim to be a person; if asked directly whether you're an assistant, answer plainly — but don't volunteer it or hedge with \"as an AI.\"\n- Prefer doing over explaining: if a request maps to an action, it is already handled before you speak.\n- Admit uncertainty rather than invent; a short \"I'm not sure\" beats a confident guess.\n- Never promise secrecy or imply a conversation is private from a guardian.", "Barnaby", new DateTime(2026, 8, 4, 0, 0, 0, 0, DateTimeKind.Utc), 1 });

            migrationBuilder.UpdateData(
                table: "Profiles",
                keyColumn: "Id",
                keyValue: 1,
                column: "AgeBand",
                value: 0);

            migrationBuilder.UpdateData(
                table: "Profiles",
                keyColumn: "Id",
                keyValue: 2,
                column: "AgeBand",
                value: 0);

            migrationBuilder.UpdateData(
                table: "Profiles",
                keyColumn: "Id",
                keyValue: 3,
                column: "AgeBand",
                value: 0);
        }
    }
}
