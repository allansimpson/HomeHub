using HomeHub.Api.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace HomeHub.Api.Migrations
{
    /// <summary>
    /// Care logging HomeHub owns: ten types, a real timestamp, and rows that can be corrected.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Hand-written, like the three before it — <c>dotnet-ef</c> cannot run on the build account.
    /// <b>Schema operations only:</b> a migration with no <c>BuildTargetModel</c> has an empty target
    /// model, so <c>InsertData</c>, <c>UpdateData</c> and <c>DeleteData</c> throw at apply time on
    /// the deployment rather than failing in the test suite, which runs on InMemory and never applies
    /// a migration at all. That cost one rolled-back promotion already; <c>MigrationShapeTests</c>
    /// now generates the SQL for every migration offline so it cannot recur.
    /// </para>
    /// <para>
    /// Nothing here is nullable by accident. <c>Amount</c> null means "not measured" — the ordinary
    /// case for a pump session — and is deliberately distinct from a measured zero, which is what
    /// Huckleberry stores instead and then reports back as though somebody had weighed it.
    /// </para>
    /// </remarks>
    [DbContext(typeof(HomeHubDbContext))]
    [Migration("20260814090000_AddCareLog")]
    public partial class AddCareLog : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "CareEntries",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    ChildKey = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    Type = table.Column<int>(type: "int", nullable: false),
                    AtUtc = table.Column<DateTime>(type: "datetime2", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "datetime2", nullable: false),
                    UpdatedUtc = table.Column<DateTime>(type: "datetime2", nullable: true),
                    Amount = table.Column<double>(type: "float", nullable: true),
                    Unit = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: true),
                    DurationMinutes = table.Column<double>(type: "float", nullable: true),
                    Kind = table.Column<string>(type: "nvarchar(120)", maxLength: 120, nullable: true),
                    Side = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: true),
                    PeeAmount = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: true),
                    PooAmount = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: true),
                    Color = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: true),
                    Consistency = table.Column<string>(type: "nvarchar(24)", maxLength: 24, nullable: true),
                    DiaperRash = table.Column<bool>(type: "bit", nullable: true),
                    Pounds = table.Column<double>(type: "float", nullable: true),
                    Ounces = table.Column<double>(type: "float", nullable: true),
                    HeightInches = table.Column<double>(type: "float", nullable: true),
                    HeadInches = table.Column<double>(type: "float", nullable: true),
                    Notes = table.Column<string>(type: "nvarchar(500)", maxLength: 500, nullable: true),
                    Source = table.Column<int>(type: "int", nullable: false),
                    ExternalKey = table.Column<string>(type: "nvarchar(160)", maxLength: 160, nullable: true),
                    Version = table.Column<int>(type: "int", nullable: false, defaultValue: 1),
                },
                constraints: table => table.PrimaryKey("PK_CareEntries", x => x.Id));

            migrationBuilder.CreateTable(
                name: "CareTimers",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    ChildKey = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    Type = table.Column<int>(type: "int", nullable: false),
                    Side = table.Column<string>(type: "nvarchar(16)", maxLength: 16, nullable: true),
                    StartedUtc = table.Column<DateTime>(type: "datetime2", nullable: false),
                    PausedUtc = table.Column<DateTime>(type: "datetime2", nullable: true),
                    AccumulatedMinutes = table.Column<double>(type: "float", nullable: false),
                    PhaseOneMinutes = table.Column<int>(type: "int", nullable: true),
                    PhaseTwoMinutes = table.Column<int>(type: "int", nullable: true),
                    Phase = table.Column<int>(type: "int", nullable: true),
                },
                constraints: table => table.PrimaryKey("PK_CareTimers", x => x.Id));

            // The two questions every Care screen asks: the newest of a kind, and everything today.
            migrationBuilder.CreateIndex(
                name: "IX_CareEntries_ChildKey_Type_AtUtc",
                table: "CareEntries",
                columns: ["ChildKey", "Type", "AtUtc"]);

            migrationBuilder.CreateIndex(
                name: "IX_CareEntries_ChildKey_AtUtc",
                table: "CareEntries",
                columns: ["ChildKey", "AtUtc"]);

            // Idempotent import: the same upstream event writes one row however often it is pulled.
            migrationBuilder.CreateIndex(
                name: "IX_CareEntries_ExternalKey",
                table: "CareEntries",
                column: "ExternalKey",
                unique: true,
                filter: "[ExternalKey] IS NOT NULL");

            // One running session per child per type — two nursing timers is not a state the domain
            // has an answer for, so it is made unrepresentable rather than guarded against.
            migrationBuilder.CreateIndex(
                name: "IX_CareTimers_ChildKey_Type",
                table: "CareTimers",
                columns: ["ChildKey", "Type"],
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "CareEntries");
            migrationBuilder.DropTable(name: "CareTimers");
        }
    }
}
