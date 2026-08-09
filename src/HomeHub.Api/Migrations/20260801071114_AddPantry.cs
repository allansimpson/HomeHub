using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace HomeHub.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddPantry : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "GroceryMirror",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false),
                    TodoListId = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: true),
                    TodoListName = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: true),
                    OwnerProfileId = table.Column<int>(type: "int", nullable: true),
                    LastSyncedUtc = table.Column<DateTime>(type: "datetime2", nullable: true),
                    LastAttemptUtc = table.Column<DateTime>(type: "datetime2", nullable: true),
                    LastError = table.Column<string>(type: "nvarchar(300)", maxLength: 300, nullable: true),
                    ConsecutiveFailures = table.Column<int>(type: "int", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_GroceryMirror", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "OrderImports",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    Source = table.Column<int>(type: "int", nullable: false),
                    VendorLabel = table.Column<string>(type: "nvarchar(120)", maxLength: 120, nullable: true),
                    OrderedAtUtc = table.Column<DateTime>(type: "datetime2", nullable: true),
                    DeliveredAtUtc = table.Column<DateTime>(type: "datetime2", nullable: true),
                    RawPayload = table.Column<string>(type: "nvarchar(max)", maxLength: 200000, nullable: false),
                    Status = table.Column<int>(type: "int", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "datetime2", nullable: false),
                    AppliedAtUtc = table.Column<DateTime>(type: "datetime2", nullable: true),
                    AppliedByProfileId = table.Column<int>(type: "int", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_OrderImports", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "PantryItems",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    Name = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: false),
                    Location = table.Column<int>(type: "int", nullable: false),
                    Tracking = table.Column<int>(type: "int", nullable: false),
                    Quantity = table.Column<decimal>(type: "decimal(9,3)", precision: 9, scale: 3, nullable: true),
                    Unit = table.Column<string>(type: "nvarchar(40)", maxLength: 40, nullable: true),
                    EstimateState = table.Column<int>(type: "int", nullable: true),
                    CatalogueRef = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: true),
                    IsArchived = table.Column<bool>(type: "bit", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "datetime2", nullable: false),
                    UpdatedUtc = table.Column<DateTime>(type: "datetime2", nullable: false),
                    Version = table.Column<int>(type: "int", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_PantryItems", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "ProductCatalogue",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    Barcode = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    Name = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: false),
                    DefaultUnit = table.Column<string>(type: "nvarchar(40)", maxLength: 40, nullable: true),
                    DefaultLocation = table.Column<int>(type: "int", nullable: false),
                    DefaultTracking = table.Column<int>(type: "int", nullable: false),
                    PackSize = table.Column<decimal>(type: "decimal(9,3)", precision: 9, scale: 3, nullable: true),
                    Scope = table.Column<int>(type: "int", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "datetime2", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ProductCatalogue", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "StockCheckDismissals",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    PlanEntryId = table.Column<int>(type: "int", nullable: false),
                    AtUtc = table.Column<DateTime>(type: "datetime2", nullable: false),
                    ByProfileId = table.Column<int>(type: "int", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_StockCheckDismissals", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "OrderImportLines",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    ImportId = table.Column<int>(type: "int", nullable: false),
                    RawText = table.Column<string>(type: "nvarchar(400)", maxLength: 400, nullable: false),
                    ProposedName = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: true),
                    ProposedQuantity = table.Column<decimal>(type: "decimal(9,3)", precision: 9, scale: 3, nullable: true),
                    ProposedUnit = table.Column<string>(type: "nvarchar(40)", maxLength: 40, nullable: true),
                    ProposedLocation = table.Column<int>(type: "int", nullable: false),
                    ProposedTracking = table.Column<int>(type: "int", nullable: false),
                    MatchedPantryItemId = table.Column<int>(type: "int", nullable: true),
                    Confidence = table.Column<int>(type: "int", nullable: false),
                    GuessFromPounds = table.Column<decimal>(type: "decimal(9,3)", precision: 9, scale: 3, nullable: true),
                    Applied = table.Column<bool>(type: "bit", nullable: false),
                    Position = table.Column<int>(type: "int", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_OrderImportLines", x => x.Id);
                    table.ForeignKey(
                        name: "FK_OrderImportLines_OrderImports_ImportId",
                        column: x => x.ImportId,
                        principalTable: "OrderImports",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "GroceryLines",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    Text = table.Column<string>(type: "nvarchar(300)", maxLength: 300, nullable: false),
                    Quantity = table.Column<decimal>(type: "decimal(9,3)", precision: 9, scale: 3, nullable: true),
                    Unit = table.Column<string>(type: "nvarchar(40)", maxLength: 40, nullable: true),
                    PantryItemId = table.Column<int>(type: "int", nullable: true),
                    SourceKind = table.Column<int>(type: "int", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "datetime2", nullable: false),
                    AddedByProfileId = table.Column<int>(type: "int", nullable: true),
                    CheckedAtUtc = table.Column<DateTime>(type: "datetime2", nullable: true),
                    CheckedByProfileId = table.Column<int>(type: "int", nullable: true),
                    TodoTaskId = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: true),
                    MirrorPending = table.Column<bool>(type: "bit", nullable: false),
                    Version = table.Column<int>(type: "int", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_GroceryLines", x => x.Id);
                    table.ForeignKey(
                        name: "FK_GroceryLines_PantryItems_PantryItemId",
                        column: x => x.PantryItemId,
                        principalTable: "PantryItems",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateTable(
                name: "IngredientAliases",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    Alias = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: false),
                    PantryItemId = table.Column<int>(type: "int", nullable: false),
                    Confidence = table.Column<int>(type: "int", nullable: false),
                    CreatedUtc = table.Column<DateTime>(type: "datetime2", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_IngredientAliases", x => x.Id);
                    table.ForeignKey(
                        name: "FK_IngredientAliases_PantryItems_PantryItemId",
                        column: x => x.PantryItemId,
                        principalTable: "PantryItems",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "PantryEvents",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    PantryItemId = table.Column<int>(type: "int", nullable: false),
                    Kind = table.Column<int>(type: "int", nullable: false),
                    Delta = table.Column<decimal>(type: "decimal(9,3)", precision: 9, scale: 3, nullable: true),
                    ResultingQuantity = table.Column<decimal>(type: "decimal(9,3)", precision: 9, scale: 3, nullable: true),
                    SetsAbsolute = table.Column<bool>(type: "bit", nullable: false),
                    ResultingState = table.Column<int>(type: "int", nullable: true),
                    AtUtc = table.Column<DateTime>(type: "datetime2", nullable: false),
                    ByProfileId = table.Column<int>(type: "int", nullable: true),
                    SourceKind = table.Column<int>(type: "int", nullable: true),
                    SourceId = table.Column<int>(type: "int", nullable: true),
                    UndoneByEventId = table.Column<int>(type: "int", nullable: true),
                    ScanRunId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    ScanSequence = table.Column<int>(type: "int", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_PantryEvents", x => x.Id);
                    table.ForeignKey(
                        name: "FK_PantryEvents_PantryItems_PantryItemId",
                        column: x => x.PantryItemId,
                        principalTable: "PantryItems",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "GroceryLineSources",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    GroceryLineId = table.Column<int>(type: "int", nullable: false),
                    RecipeId = table.Column<int>(type: "int", nullable: true),
                    RecipeTitle = table.Column<string>(type: "nvarchar(300)", maxLength: 300, nullable: true),
                    ForDate = table.Column<DateOnly>(type: "date", nullable: true),
                    ByProfileId = table.Column<int>(type: "int", nullable: true),
                    CreatedUtc = table.Column<DateTime>(type: "datetime2", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_GroceryLineSources", x => x.Id);
                    table.ForeignKey(
                        name: "FK_GroceryLineSources_GroceryLines_GroceryLineId",
                        column: x => x.GroceryLineId,
                        principalTable: "GroceryLines",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.InsertData(
                table: "GroceryMirror",
                columns: new[] { "Id", "ConsecutiveFailures", "LastAttemptUtc", "LastError", "LastSyncedUtc", "OwnerProfileId", "TodoListId", "TodoListName" },
                values: new object[] { 1, 0, null, null, null, null, null, null });

            migrationBuilder.CreateIndex(
                name: "IX_GroceryLines_CheckedAtUtc",
                table: "GroceryLines",
                column: "CheckedAtUtc");

            migrationBuilder.CreateIndex(
                name: "IX_GroceryLines_PantryItemId",
                table: "GroceryLines",
                column: "PantryItemId");

            migrationBuilder.CreateIndex(
                name: "IX_GroceryLines_TodoTaskId",
                table: "GroceryLines",
                column: "TodoTaskId");

            migrationBuilder.CreateIndex(
                name: "IX_GroceryLineSources_GroceryLineId",
                table: "GroceryLineSources",
                column: "GroceryLineId");

            migrationBuilder.CreateIndex(
                name: "IX_IngredientAliases_Alias",
                table: "IngredientAliases",
                column: "Alias",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_IngredientAliases_PantryItemId",
                table: "IngredientAliases",
                column: "PantryItemId");

            migrationBuilder.CreateIndex(
                name: "IX_OrderImportLines_ImportId_Position",
                table: "OrderImportLines",
                columns: new[] { "ImportId", "Position" });

            migrationBuilder.CreateIndex(
                name: "IX_OrderImports_DeliveredAtUtc",
                table: "OrderImports",
                column: "DeliveredAtUtc");

            migrationBuilder.CreateIndex(
                name: "IX_OrderImports_Status_CreatedUtc",
                table: "OrderImports",
                columns: new[] { "Status", "CreatedUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_PantryEvents_PantryItemId_AtUtc",
                table: "PantryEvents",
                columns: new[] { "PantryItemId", "AtUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_PantryEvents_ScanRunId_ScanSequence",
                table: "PantryEvents",
                columns: new[] { "ScanRunId", "ScanSequence" },
                unique: true,
                filter: "[ScanRunId] IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_PantryEvents_SourceKind_SourceId",
                table: "PantryEvents",
                columns: new[] { "SourceKind", "SourceId" });

            migrationBuilder.CreateIndex(
                name: "IX_PantryItems_CatalogueRef",
                table: "PantryItems",
                column: "CatalogueRef");

            migrationBuilder.CreateIndex(
                name: "IX_PantryItems_IsArchived_Location_Name",
                table: "PantryItems",
                columns: new[] { "IsArchived", "Location", "Name" });

            migrationBuilder.CreateIndex(
                name: "IX_ProductCatalogue_Barcode_Scope",
                table: "ProductCatalogue",
                columns: new[] { "Barcode", "Scope" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_StockCheckDismissals_PlanEntryId",
                table: "StockCheckDismissals",
                column: "PlanEntryId",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "GroceryLineSources");

            migrationBuilder.DropTable(
                name: "GroceryMirror");

            migrationBuilder.DropTable(
                name: "IngredientAliases");

            migrationBuilder.DropTable(
                name: "OrderImportLines");

            migrationBuilder.DropTable(
                name: "PantryEvents");

            migrationBuilder.DropTable(
                name: "ProductCatalogue");

            migrationBuilder.DropTable(
                name: "StockCheckDismissals");

            migrationBuilder.DropTable(
                name: "GroceryLines");

            migrationBuilder.DropTable(
                name: "OrderImports");

            migrationBuilder.DropTable(
                name: "PantryItems");
        }
    }
}
