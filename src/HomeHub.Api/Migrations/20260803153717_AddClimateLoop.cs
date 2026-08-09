using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

#pragma warning disable CA1814 // Prefer jagged arrays over multidimensional

namespace HomeHub.Api.Migrations
{
    /// <summary>
    /// The Climate control loop: rooms, standing targets, two-hour loans and the write ledger.
    /// </summary>
    /// <remarks>
    /// <b>Hand-adjusted, deliberately.</b> The scaffolder saw the old <c>ClimateZones</c> table and the
    /// new entity of the same name and produced a column shuffle — <c>SetPointF</c> renamed to
    /// <c>ToleranceF</c>, <c>Mode</c> to <c>SortOrder</c> — which would have turned five cached
    /// mini-splits into five nonsensical rooms. The two tables are not the same thing wearing
    /// different columns: one is a machine's reported state, the other is a room the household names.
    /// <para>
    /// So the old table is dropped and both are created fresh. Nothing is lost by that: the unit table
    /// has always been a cache — Home Assistant re-upserts every <c>climate.*</c> entity on its next
    /// poll, and without HA it is seed data. The rooms, targets, loans and ledger that <em>are</em>
    /// worth keeping start here and are never dropped again.
    /// </para>
    /// <para>
    /// The demo seed is <b>conditional</b>; the schema is not. Scaffolded <c>HasData</c> assumes the
    /// simulated sensor zones 1–5 still exist, and on a household with a real provider they do not —
    /// see the guard in <c>Up</c> for what that cost. Fresh installs are unaffected.
    /// </para>
    /// </remarks>
    public partial class AddClimateLoop : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // The whole-house pause. Household state, so it survives a restart.
            migrationBuilder.AddColumn<bool>(
                name: "ClimateLoopPaused",
                table: "Settings",
                type: "bit",
                nullable: false,
                defaultValue: false);

            // The old unit cache, under the name the rooms now need.
            migrationBuilder.DropTable(name: "ClimateZones");

            migrationBuilder.CreateTable(
                name: "ClimateUnits",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    Name = table.Column<string>(type: "nvarchar(60)", maxLength: 60, nullable: false),
                    Source = table.Column<string>(type: "nvarchar(30)", maxLength: 30, nullable: false),
                    ProviderRef = table.Column<string>(type: "nvarchar(160)", maxLength: 160, nullable: false),
                    CurrentTempF = table.Column<double>(type: "float", nullable: false),
                    SetPointF = table.Column<double>(type: "float", nullable: false),
                    Mode = table.Column<int>(type: "int", nullable: false),
                    FanMode = table.Column<string>(type: "nvarchar(30)", maxLength: 30, nullable: true),
                    DisplayOrder = table.Column<int>(type: "int", nullable: false),
                    UpdatedUtc = table.Column<DateTime>(type: "datetime2", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ClimateUnits", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "ClimateZones",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    Name = table.Column<string>(type: "nvarchar(60)", maxLength: 60, nullable: false),
                    Class = table.Column<int>(type: "int", nullable: false),
                    SensorZoneId = table.Column<int>(type: "int", nullable: true),
                    ClimateUnitId = table.Column<int>(type: "int", nullable: true),
                    StandingTargetF = table.Column<double>(type: "float", nullable: true),
                    StandingSetAtUtc = table.Column<DateTime>(type: "datetime2", nullable: true),
                    PreviousStandingTargetF = table.Column<double>(type: "float", nullable: true),
                    ToleranceF = table.Column<double>(type: "float", nullable: false),
                    Correction = table.Column<int>(type: "int", nullable: false),
                    QuietFrom = table.Column<TimeSpan>(type: "time", nullable: false),
                    QuietTo = table.Column<TimeSpan>(type: "time", nullable: false),
                    IsPaused = table.Column<bool>(type: "bit", nullable: false),
                    PausedAtUtc = table.Column<DateTime>(type: "datetime2", nullable: true),
                    HandedBackAtUtc = table.Column<DateTime>(type: "datetime2", nullable: true),
                    UnreachableSinceUtc = table.Column<DateTime>(type: "datetime2", nullable: true),
                    OfferShownAtUtc = table.Column<DateTime>(type: "datetime2", nullable: true),
                    OfferSuppressedUntilUtc = table.Column<DateTime>(type: "datetime2", nullable: true),
                    OfferSuppressedWindowHour = table.Column<int>(type: "int", nullable: true),
                    RangeLowF = table.Column<double>(type: "float", nullable: true),
                    RangeHighF = table.Column<double>(type: "float", nullable: true),
                    SortOrder = table.Column<int>(type: "int", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ClimateZones", x => x.Id);
                    // A probe or a unit going away must not delete the room it served: the row lives
                    // on with an empty band, which is exactly what a probe-less room should look like.
                    table.ForeignKey(
                        name: "FK_ClimateZones_ClimateUnits_ClimateUnitId",
                        column: x => x.ClimateUnitId,
                        principalTable: "ClimateUnits",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                    table.ForeignKey(
                        name: "FK_ClimateZones_SensorZones_SensorZoneId",
                        column: x => x.SensorZoneId,
                        principalTable: "SensorZones",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateTable(
                name: "ZoneOverrides",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    ZoneId = table.Column<int>(type: "int", nullable: false),
                    TargetF = table.Column<double>(type: "float", nullable: false),
                    StartedAtUtc = table.Column<DateTime>(type: "datetime2", nullable: false),
                    ExpiresAtUtc = table.Column<DateTime>(type: "datetime2", nullable: false),
                    ByProfileId = table.Column<int>(type: "int", nullable: true),
                    PromotedAtUtc = table.Column<DateTime>(type: "datetime2", nullable: true),
                    CancelledAtUtc = table.Column<DateTime>(type: "datetime2", nullable: true),
                    ClosedAtUtc = table.Column<DateTime>(type: "datetime2", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ZoneOverrides", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ZoneOverrides_ClimateZones_ZoneId",
                        column: x => x.ZoneId,
                        principalTable: "ClimateZones",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "LoopWrites",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    ZoneId = table.Column<int>(type: "int", nullable: false),
                    AtUtc = table.Column<DateTime>(type: "datetime2", nullable: false),
                    ProbeF = table.Column<double>(type: "float", nullable: true),
                    TargetF = table.Column<double>(type: "float", nullable: false),
                    SetPointFrom = table.Column<double>(type: "float", nullable: true),
                    SetPointTo = table.Column<double>(type: "float", nullable: false),
                    Reason = table.Column<int>(type: "int", nullable: false),
                    Outcome = table.Column<int>(type: "int", nullable: false),
                    Error = table.Column<string>(type: "nvarchar(500)", maxLength: 500, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_LoopWrites", x => x.Id);
                    table.ForeignKey(
                        name: "FK_LoopWrites_ClimateZones_ZoneId",
                        column: x => x.ZoneId,
                        principalTable: "ClimateZones",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            // --- Demo seed, applied only to a database that is still a demo install ---
            //
            // Scaffolded from HasData, which assumes the seeded simulated sensor zones 1–5 are
            // present. On a household with a real provider they are not: SensorPollingService
            // deletes the simulated zones after the first successful discovery (commit 2dc1da2),
            // and the IDs are then reused by real hardware. Against such a database the scaffolded
            // form fails twice over — a PK collision on SensorZones 6, which is a real sensor, and
            // FK violations for every room binding to zones 1–5 that no longer exist — so the whole
            // migration rolls back and the schema never lands. That is not hypothetical: it is what
            // this migration did to the live database before the guard was added.
            //
            // So the seed is conditional and the schema above is not. A fresh install still gets
            // the full demo Climate screen; a household with real sensors gets the tables and
            // `ClimateLoopPaused`, and fills the rooms from Home Assistant instead.
            //
            // Raw SQL rather than InsertData because there is no conditional form of it. The model
            // keeps its HasData: the snapshot describes the intended seed, and nothing later
            // re-inserts it. `HasData` stays the single source for a fresh install.
            //
            // The guard is deliberately all-or-nothing — every row below depends on zones 1–5, so
            // seeding "as much as fits" would leave rooms bound to whatever now owns those IDs.
            migrationBuilder.Sql("""
                IF NOT EXISTS (SELECT 1 FROM [SensorZones] WHERE [Source] <> N'simulated')
                   AND (SELECT COUNT(*) FROM [SensorZones] WHERE [Id] IN (1, 2, 3, 4, 5)) = 5
                   AND NOT EXISTS (SELECT 1 FROM [SensorZones] WHERE [Id] = 6)
                   AND NOT EXISTS (SELECT 1 FROM [AlertThresholds] WHERE [Id] = 6)
                BEGIN
                    -- Probes first: the rooms below reference them. The demo sensor set is renamed
                    -- and extended so the six climate rows bind to something real without hardware.
                    UPDATE [SensorZones] SET [Name] = N'Master Bedroom' WHERE [Id] = 5;

                    SET IDENTITY_INSERT [SensorZones] ON;
                    INSERT INTO [SensorZones] ([Id], [Category], [DisplayOrder], [Name], [ProviderRef], [Source])
                    VALUES (6, 0, 5, N'Upstairs Office', N'sim-office', N'simulated');
                    SET IDENTITY_INSERT [SensorZones] OFF;

                    -- The freezer's alert ceiling, brought down to the in-range ceiling the Climate
                    -- row draws. At 10° the row went terracotta five degrees before anything told
                    -- anyone.
                    UPDATE [AlertThresholds] SET [Value] = 5.0 WHERE [Id] = 1;

                    SET IDENTITY_INSERT [AlertThresholds] ON;
                    INSERT INTO [AlertThresholds] ([Id], [Direction], [DurationMinutes], [Enabled], [Metric], [Severity], [Value], [ZoneId])
                    VALUES (6, 0, 10, 1, 1, 1, 65.0, 6);
                    SET IDENTITY_INSERT [AlertThresholds] OFF;

                    SET IDENTITY_INSERT [ClimateUnits] ON;
                    INSERT INTO [ClimateUnits] ([Id], [CurrentTempF], [DisplayOrder], [FanMode], [Mode], [Name], [ProviderRef], [SetPointF], [Source], [UpdatedUtc])
                    VALUES
                        (1, 73.0, 0, N'Auto',  1, N'Kitchen',         N'sim-kitchen', 72.0, N'simulated', '0001-01-01T06:00:00'),
                        (2, 74.0, 1, N'Quiet', 1, N'Master Bedroom',  N'sim-bedroom', 70.0, N'simulated', '0001-01-01T06:00:00'),
                        (3, 76.0, 2, N'Auto',  1, N'Upstairs Office', N'sim-office',  68.0, N'simulated', '0001-01-01T06:00:00');
                    SET IDENTITY_INSERT [ClimateUnits] OFF;

                    SET IDENTITY_INSERT [ClimateZones] ON;
                    INSERT INTO [ClimateZones] ([Id], [Class], [ClimateUnitId], [Correction], [HandedBackAtUtc], [IsPaused], [Name], [OfferShownAtUtc], [OfferSuppressedUntilUtc], [OfferSuppressedWindowHour], [PausedAtUtc], [PreviousStandingTargetF], [QuietFrom], [QuietTo], [RangeHighF], [RangeLowF], [SensorZoneId], [SortOrder], [StandingSetAtUtc], [StandingTargetF], [ToleranceF], [UnreachableSinceUtc])
                    VALUES
                        (1, 0, 1,    1, NULL, 0, N'Kitchen',         NULL, NULL, NULL, NULL, NULL, '22:00:00', '06:00:00', NULL, NULL, 4, 0, NULL, 72.0, 1.0, NULL),
                        (2, 0, 2,    1, NULL, 0, N'Master Bedroom',  NULL, NULL, NULL, NULL, NULL, '22:00:00', '06:00:00', NULL, NULL, 5, 1, NULL, 71.0, 1.0, NULL),
                        (3, 0, 3,    1, NULL, 0, N'Upstairs Office', NULL, NULL, NULL, NULL, NULL, '22:00:00', '06:00:00', NULL, NULL, 6, 2, NULL, 72.0, 1.0, NULL),
                        (4, 1, NULL, 1, NULL, 0, N'Living Room',     NULL, NULL, NULL, NULL, NULL, '22:00:00', '06:00:00', NULL, NULL, 3, 3, NULL, NULL, 1.0, NULL),
                        (5, 2, NULL, 1, NULL, 0, N'Fridge',          NULL, NULL, NULL, NULL, NULL, '22:00:00', '06:00:00', 40.0, 34.0, 2, 4, NULL, NULL, 1.0, NULL),
                        (6, 2, NULL, 1, NULL, 0, N'Freezer',         NULL, NULL, NULL, NULL, NULL, '22:00:00', '06:00:00',  5.0, -5.0, 1, 5, NULL, NULL, 1.0, NULL);
                    SET IDENTITY_INSERT [ClimateZones] OFF;
                END
                """);

            migrationBuilder.CreateIndex(
                name: "IX_ClimateUnits_DisplayOrder",
                table: "ClimateUnits",
                column: "DisplayOrder");

            migrationBuilder.CreateIndex(
                name: "IX_ClimateUnits_Source_ProviderRef",
                table: "ClimateUnits",
                columns: new[] { "Source", "ProviderRef" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_ClimateZones_ClimateUnitId",
                table: "ClimateZones",
                column: "ClimateUnitId");

            migrationBuilder.CreateIndex(
                name: "IX_ClimateZones_SensorZoneId",
                table: "ClimateZones",
                column: "SensorZoneId");

            migrationBuilder.CreateIndex(
                name: "IX_ClimateZones_SortOrder",
                table: "ClimateZones",
                column: "SortOrder");

            migrationBuilder.CreateIndex(
                name: "IX_ZoneOverrides_StartedAtUtc",
                table: "ZoneOverrides",
                column: "StartedAtUtc");

            migrationBuilder.CreateIndex(
                name: "IX_ZoneOverrides_ZoneId_ExpiresAtUtc",
                table: "ZoneOverrides",
                columns: new[] { "ZoneId", "ExpiresAtUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_LoopWrites_ZoneId_AtUtc",
                table: "LoopWrites",
                columns: new[] { "ZoneId", "AtUtc" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(name: "LoopWrites");
            migrationBuilder.DropTable(name: "ZoneOverrides");
            migrationBuilder.DropTable(name: "ClimateZones");
            migrationBuilder.DropTable(name: "ClimateUnits");

            migrationBuilder.DeleteData(table: "AlertThresholds", keyColumn: "Id", keyValue: 6);
            migrationBuilder.UpdateData(
                table: "AlertThresholds",
                keyColumn: "Id",
                keyValue: 1,
                column: "Value",
                value: 10.0);
            migrationBuilder.DeleteData(table: "SensorZones", keyColumn: "Id", keyValue: 6);
            migrationBuilder.UpdateData(
                table: "SensorZones",
                keyColumn: "Id",
                keyValue: 5,
                column: "Name",
                value: "Bedroom");

            migrationBuilder.DropColumn(name: "ClimateLoopPaused", table: "Settings");

            // The unit cache as it was, seeds and all.
            migrationBuilder.CreateTable(
                name: "ClimateZones",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    CurrentTempF = table.Column<double>(type: "float", nullable: false),
                    DisplayOrder = table.Column<int>(type: "int", nullable: false),
                    FanMode = table.Column<string>(type: "nvarchar(30)", maxLength: 30, nullable: true),
                    Mode = table.Column<int>(type: "int", nullable: false),
                    Name = table.Column<string>(type: "nvarchar(60)", maxLength: 60, nullable: false),
                    ProviderRef = table.Column<string>(type: "nvarchar(160)", maxLength: 160, nullable: false),
                    SetPointF = table.Column<double>(type: "float", nullable: false),
                    Source = table.Column<string>(type: "nvarchar(30)", maxLength: 30, nullable: false),
                    UpdatedUtc = table.Column<DateTime>(type: "datetime2", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ClimateZones", x => x.Id);
                });

            migrationBuilder.InsertData(
                table: "ClimateZones",
                columns: new[] { "Id", "CurrentTempF", "DisplayOrder", "FanMode", "Mode", "Name", "ProviderRef", "SetPointF", "Source", "UpdatedUtc" },
                values: new object[,]
                {
                    { 1, 74.0, 0, "Quiet", 1, "Living Room", "sim-living", 72.0, "simulated", new DateTime(1, 1, 1, 6, 0, 0, 0, DateTimeKind.Utc) },
                    { 2, 71.0, 1, "Auto", 1, "Bedroom", "sim-bedroom", 70.0, "simulated", new DateTime(1, 1, 1, 6, 0, 0, 0, DateTimeKind.Utc) },
                    { 3, 73.0, 2, "Auto", 3, "Kitchen", "sim-kitchen", 73.0, "simulated", new DateTime(1, 1, 1, 6, 0, 0, 0, DateTimeKind.Utc) },
                    { 4, 72.0, 3, null, 0, "Study", "sim-study", 72.0, "simulated", new DateTime(1, 1, 1, 6, 0, 0, 0, DateTimeKind.Utc) },
                    { 5, 72.0, 4, null, 0, "Loft", "sim-loft", 72.0, "simulated", new DateTime(1, 1, 1, 6, 0, 0, 0, DateTimeKind.Utc) }
                });

            migrationBuilder.CreateIndex(
                name: "IX_ClimateZones_DisplayOrder",
                table: "ClimateZones",
                column: "DisplayOrder");

            migrationBuilder.CreateIndex(
                name: "IX_ClimateZones_Source_ProviderRef",
                table: "ClimateZones",
                columns: new[] { "Source", "ProviderRef" },
                unique: true);
        }
    }
}
