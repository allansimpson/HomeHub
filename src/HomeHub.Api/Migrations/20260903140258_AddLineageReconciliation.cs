using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace HomeHub.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddLineageReconciliation : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTime>(
                name: "LineageAuditedAtUtc",
                table: "Settings",
                type: "datetime2",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "LineageState",
                table: "Settings",
                type: "int",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.CreateTable(
                name: "LineageRiskAcceptances",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    Nonce = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    ReportDigest = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    ConversationIds = table.Column<string>(type: "nvarchar(2000)", maxLength: 2000, nullable: false),
                    BlockingReasons = table.Column<string>(type: "nvarchar(2000)", maxLength: 2000, nullable: true),
                    AcceptedByProfileId = table.Column<int>(type: "int", nullable: true),
                    AcceptedAtUtc = table.Column<DateTime>(type: "datetime2", nullable: false),
                    ExpiresAtUtc = table.Column<DateTime>(type: "datetime2", nullable: false),
                    ConsumedAtUtc = table.Column<DateTime>(type: "datetime2", nullable: true),
                    RowVersion = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_LineageRiskAcceptances", x => x.Id);
                });

            migrationBuilder.UpdateData(
                table: "Settings",
                keyColumn: "Id",
                keyValue: 1,
                columns: new[] { "LineageAuditedAtUtc", "LineageState" },
                values: new object[] { null, 0 });

            migrationBuilder.CreateIndex(
                name: "IX_LineageRiskAcceptances_ConsumedAtUtc_ExpiresAtUtc",
                table: "LineageRiskAcceptances",
                columns: new[] { "ConsumedAtUtc", "ExpiresAtUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_LineageRiskAcceptances_Nonce",
                table: "LineageRiskAcceptances",
                column: "Nonce",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "LineageRiskAcceptances");

            migrationBuilder.DropColumn(
                name: "LineageAuditedAtUtc",
                table: "Settings");

            migrationBuilder.DropColumn(
                name: "LineageState",
                table: "Settings");
        }
    }
}
