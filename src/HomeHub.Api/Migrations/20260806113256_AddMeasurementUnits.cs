using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

#pragma warning disable CA1814 // Prefer jagged arrays over multidimensional

namespace HomeHub.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddMeasurementUnits : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "MeasurementUnits",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    Canonical = table.Column<string>(type: "nvarchar(40)", maxLength: 40, nullable: false),
                    DisplayName = table.Column<string>(type: "nvarchar(60)", maxLength: 60, nullable: true),
                    IsSeeded = table.Column<bool>(type: "bit", nullable: false),
                    SortOrder = table.Column<int>(type: "int", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "datetime2", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_MeasurementUnits", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "MeasurementUnitAliases",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    UnitId = table.Column<int>(type: "int", nullable: false),
                    Alias = table.Column<string>(type: "nvarchar(40)", maxLength: 40, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_MeasurementUnitAliases", x => x.Id);
                    table.ForeignKey(
                        name: "FK_MeasurementUnitAliases_MeasurementUnits_UnitId",
                        column: x => x.UnitId,
                        principalTable: "MeasurementUnits",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.InsertData(
                table: "MeasurementUnits",
                columns: new[] { "Id", "Canonical", "CreatedUtc", "DisplayName", "IsSeeded", "SortOrder" },
                values: new object[,]
                {
                    { 1, "ea", new DateTime(2026, 8, 6, 0, 0, 0, 0, DateTimeKind.Utc), "each", true, 0 },
                    { 2, "tsp", new DateTime(2026, 8, 6, 0, 0, 0, 0, DateTimeKind.Utc), "teaspoons", true, 1 },
                    { 3, "tbsp", new DateTime(2026, 8, 6, 0, 0, 0, 0, DateTimeKind.Utc), "tablespoons", true, 2 },
                    { 4, "cup", new DateTime(2026, 8, 6, 0, 0, 0, 0, DateTimeKind.Utc), "cups", true, 3 },
                    { 5, "fl oz", new DateTime(2026, 8, 6, 0, 0, 0, 0, DateTimeKind.Utc), "fluid ounces", true, 4 },
                    { 6, "pint", new DateTime(2026, 8, 6, 0, 0, 0, 0, DateTimeKind.Utc), "pints", true, 5 },
                    { 7, "quart", new DateTime(2026, 8, 6, 0, 0, 0, 0, DateTimeKind.Utc), "quarts", true, 6 },
                    { 8, "gallon", new DateTime(2026, 8, 6, 0, 0, 0, 0, DateTimeKind.Utc), "gallons", true, 7 },
                    { 9, "mL", new DateTime(2026, 8, 6, 0, 0, 0, 0, DateTimeKind.Utc), "millilitres", true, 8 },
                    { 10, "L", new DateTime(2026, 8, 6, 0, 0, 0, 0, DateTimeKind.Utc), "litres", true, 9 },
                    { 11, "oz", new DateTime(2026, 8, 6, 0, 0, 0, 0, DateTimeKind.Utc), "ounces", true, 10 },
                    { 12, "lb", new DateTime(2026, 8, 6, 0, 0, 0, 0, DateTimeKind.Utc), "pounds", true, 11 },
                    { 13, "g", new DateTime(2026, 8, 6, 0, 0, 0, 0, DateTimeKind.Utc), "grams", true, 12 },
                    { 14, "kg", new DateTime(2026, 8, 6, 0, 0, 0, 0, DateTimeKind.Utc), "kilograms", true, 13 },
                    { 15, "clove", new DateTime(2026, 8, 6, 0, 0, 0, 0, DateTimeKind.Utc), "cloves", true, 14 },
                    { 16, "slice", new DateTime(2026, 8, 6, 0, 0, 0, 0, DateTimeKind.Utc), "slices", true, 15 },
                    { 17, "stick", new DateTime(2026, 8, 6, 0, 0, 0, 0, DateTimeKind.Utc), "sticks", true, 16 },
                    { 18, "sprig", new DateTime(2026, 8, 6, 0, 0, 0, 0, DateTimeKind.Utc), "sprigs", true, 17 },
                    { 19, "bunch", new DateTime(2026, 8, 6, 0, 0, 0, 0, DateTimeKind.Utc), "bunches", true, 18 },
                    { 20, "head", new DateTime(2026, 8, 6, 0, 0, 0, 0, DateTimeKind.Utc), "heads", true, 19 },
                    { 21, "pinch", new DateTime(2026, 8, 6, 0, 0, 0, 0, DateTimeKind.Utc), "pinches", true, 20 },
                    { 22, "dash", new DateTime(2026, 8, 6, 0, 0, 0, 0, DateTimeKind.Utc), "dashes", true, 21 },
                    { 23, "can", new DateTime(2026, 8, 6, 0, 0, 0, 0, DateTimeKind.Utc), "cans", true, 22 },
                    { 24, "tin", new DateTime(2026, 8, 6, 0, 0, 0, 0, DateTimeKind.Utc), "tins", true, 23 },
                    { 25, "jar", new DateTime(2026, 8, 6, 0, 0, 0, 0, DateTimeKind.Utc), "jars", true, 24 },
                    { 26, "bottle", new DateTime(2026, 8, 6, 0, 0, 0, 0, DateTimeKind.Utc), "bottles", true, 25 },
                    { 27, "box", new DateTime(2026, 8, 6, 0, 0, 0, 0, DateTimeKind.Utc), "boxes", true, 26 },
                    { 28, "bag", new DateTime(2026, 8, 6, 0, 0, 0, 0, DateTimeKind.Utc), "bags", true, 27 },
                    { 29, "pack", new DateTime(2026, 8, 6, 0, 0, 0, 0, DateTimeKind.Utc), "packs", true, 28 },
                    { 30, "packet", new DateTime(2026, 8, 6, 0, 0, 0, 0, DateTimeKind.Utc), "packets", true, 29 },
                    { 31, "loaf", new DateTime(2026, 8, 6, 0, 0, 0, 0, DateTimeKind.Utc), "loaves", true, 30 }
                });

            migrationBuilder.InsertData(
                table: "MeasurementUnitAliases",
                columns: new[] { "Id", "Alias", "UnitId" },
                values: new object[,]
                {
                    { 1, "ea", 1 },
                    { 2, "each", 1 },
                    { 3, "ct", 1 },
                    { 4, "cnt", 1 },
                    { 5, "count", 1 },
                    { 6, "pc", 1 },
                    { 7, "pcs", 1 },
                    { 8, "piece", 1 },
                    { 9, "pieces", 1 },
                    { 10, "tsp", 2 },
                    { 11, "tsps", 2 },
                    { 12, "teaspoon", 2 },
                    { 13, "teaspoons", 2 },
                    { 14, "tbsp", 3 },
                    { 15, "tbsps", 3 },
                    { 16, "tbs", 3 },
                    { 17, "tablespoon", 3 },
                    { 18, "tablespoons", 3 },
                    { 19, "cup", 4 },
                    { 20, "cups", 4 },
                    { 21, "fl oz", 5 },
                    { 22, "floz", 5 },
                    { 23, "fluid ounce", 5 },
                    { 24, "fluid ounces", 5 },
                    { 25, "pint", 6 },
                    { 26, "pints", 6 },
                    { 27, "pt", 6 },
                    { 28, "pts", 6 },
                    { 29, "quart", 7 },
                    { 30, "quarts", 7 },
                    { 31, "qt", 7 },
                    { 32, "qts", 7 },
                    { 33, "gallon", 8 },
                    { 34, "gallons", 8 },
                    { 35, "gal", 8 },
                    { 36, "gals", 8 },
                    { 37, "ml", 9 },
                    { 38, "mls", 9 },
                    { 39, "milliliter", 9 },
                    { 40, "milliliters", 9 },
                    { 41, "millilitre", 9 },
                    { 42, "millilitres", 9 },
                    { 43, "cc", 9 },
                    { 44, "l", 10 },
                    { 45, "ls", 10 },
                    { 46, "liter", 10 },
                    { 47, "liters", 10 },
                    { 48, "litre", 10 },
                    { 49, "litres", 10 },
                    { 50, "oz", 11 },
                    { 51, "ozs", 11 },
                    { 52, "ounce", 11 },
                    { 53, "ounces", 11 },
                    { 54, "lb", 12 },
                    { 55, "lbs", 12 },
                    { 56, "pound", 12 },
                    { 57, "pounds", 12 },
                    { 58, "g", 13 },
                    { 59, "gs", 13 },
                    { 60, "gram", 13 },
                    { 61, "grams", 13 },
                    { 62, "gm", 13 },
                    { 63, "gms", 13 },
                    { 64, "kg", 14 },
                    { 65, "kgs", 14 },
                    { 66, "kilogram", 14 },
                    { 67, "kilograms", 14 },
                    { 68, "kilo", 14 },
                    { 69, "kilos", 14 },
                    { 70, "clove", 15 },
                    { 71, "cloves", 15 },
                    { 72, "slice", 16 },
                    { 73, "slices", 16 },
                    { 74, "stick", 17 },
                    { 75, "sticks", 17 },
                    { 76, "sprig", 18 },
                    { 77, "sprigs", 18 },
                    { 78, "bunch", 19 },
                    { 79, "bunches", 19 },
                    { 80, "head", 20 },
                    { 81, "heads", 20 },
                    { 82, "pinch", 21 },
                    { 83, "pinches", 21 },
                    { 84, "dash", 22 },
                    { 85, "dashes", 22 },
                    { 86, "can", 23 },
                    { 87, "cans", 23 },
                    { 88, "tin", 24 },
                    { 89, "tins", 24 },
                    { 90, "jar", 25 },
                    { 91, "jars", 25 },
                    { 92, "bottle", 26 },
                    { 93, "bottles", 26 },
                    { 94, "box", 27 },
                    { 95, "boxes", 27 },
                    { 96, "bag", 28 },
                    { 97, "bags", 28 },
                    { 98, "pack", 29 },
                    { 99, "packs", 29 },
                    { 100, "pk", 29 },
                    { 101, "pks", 29 },
                    { 102, "pkg", 29 },
                    { 103, "pkgs", 29 },
                    { 104, "packet", 30 },
                    { 105, "packets", 30 },
                    { 106, "loaf", 31 },
                    { 107, "loaves", 31 }
                });

            migrationBuilder.CreateIndex(
                name: "IX_MeasurementUnitAliases_Alias",
                table: "MeasurementUnitAliases",
                column: "Alias",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_MeasurementUnitAliases_UnitId",
                table: "MeasurementUnitAliases",
                column: "UnitId");

            migrationBuilder.CreateIndex(
                name: "IX_MeasurementUnits_Canonical",
                table: "MeasurementUnits",
                column: "Canonical",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_MeasurementUnits_SortOrder",
                table: "MeasurementUnits",
                column: "SortOrder");

            // ---- What is already on the shelves ----
            //
            // A canonical-units table that only governs what gets typed from now on would leave the
            // duplicates it exists to prevent sitting in the database: a pantry holding "ounces" and
            // a recipe holding "oz" are still two units to the stock check, and the row that fixes
            // itself is the row somebody happens to edit. So the five columns that hold a unit are
            // brought into line here, once.
            //
            // In two passes, and the order matters. Adopt every spelling the seed does not know
            // ("sleeve", "tins") as a unit of its own first, so the second pass has something to map
            // it to; then rewrite every column against the alias table. Nothing is lost and nothing
            // is merged that the seed would not merge — a unit the household invented keeps its own
            // word, folded to one spelling.
            //
            // The fold is LOWER + TRIM + drop periods, matching UnitRegistry.Fold. It does not
            // collapse inner whitespace, which that method does: stored units are single tokens
            // written into a 40-character box, so the case does not arise, and a run of spaces left
            // unmatched here is adopted verbatim rather than mangled.
            migrationBuilder.Sql("""
                WITH typed AS (
                    SELECT Unit AS Raw FROM PantryItems WHERE Unit IS NOT NULL
                    UNION ALL SELECT Unit FROM RecipeIngredients WHERE Unit IS NOT NULL
                    UNION ALL SELECT Unit FROM GroceryLines WHERE Unit IS NOT NULL
                    UNION ALL SELECT DefaultUnit FROM ProductCatalogue WHERE DefaultUnit IS NOT NULL
                    UNION ALL SELECT ProposedUnit FROM OrderImportLines WHERE ProposedUnit IS NOT NULL
                ),
                folded AS (
                    SELECT DISTINCT LOWER(LTRIM(RTRIM(REPLACE(Raw, '.', '')))) AS Alias FROM typed
                )
                INSERT INTO MeasurementUnits (Canonical, DisplayName, IsSeeded, SortOrder, CreatedUtc)
                SELECT f.Alias, NULL, 0, 1000, '2026-08-06T00:00:00'
                FROM folded f
                WHERE f.Alias <> '' AND LEN(f.Alias) <= 40
                  AND NOT EXISTS (SELECT 1 FROM MeasurementUnitAliases a WHERE a.Alias = f.Alias);
                """);

            // Every unit answers to its own spelling, so one lookup answers everything.
            migrationBuilder.Sql("""
                INSERT INTO MeasurementUnitAliases (UnitId, Alias)
                SELECT u.Id, u.Canonical
                FROM MeasurementUnits u
                WHERE u.IsSeeded = 0
                  AND NOT EXISTS (SELECT 1 FROM MeasurementUnitAliases a WHERE a.UnitId = u.Id);
                """);

            // No `WHERE Unit <> Canonical` guard: SQL Server's default collation is case-insensitive,
            // so such a guard would read "OZ" as already equal to "oz" and skip the one row that most
            // needed rewriting. Writing a value that is already right costs nothing.
            foreach (var (table, column) in new[]
            {
                ("PantryItems", "Unit"),
                ("RecipeIngredients", "Unit"),
                ("GroceryLines", "Unit"),
                ("ProductCatalogue", "DefaultUnit"),
                ("OrderImportLines", "ProposedUnit"),
            })
            {
                migrationBuilder.Sql($"""
                    UPDATE t SET t.{column} = u.Canonical
                    FROM {table} t
                    JOIN MeasurementUnitAliases a
                      ON a.Alias = LOWER(LTRIM(RTRIM(REPLACE(t.{column}, '.', ''))))
                    JOIN MeasurementUnits u ON u.Id = a.UnitId
                    WHERE t.{column} IS NOT NULL;
                    """);
            }
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // The tables go; the units the Up backfill rewrote stay rewritten. There is no undo for
            // that and there should not be — "ounces" and "oz" meant the same shelf before this
            // migration ran, so restoring the four spellings would restore a bug, not a fact.
            migrationBuilder.DropTable(
                name: "MeasurementUnitAliases");

            migrationBuilder.DropTable(
                name: "MeasurementUnits");
        }
    }
}
