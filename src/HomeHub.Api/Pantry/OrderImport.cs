namespace HomeHub.Api.Pantry;

/// <summary>
/// An order that arrived, waiting to be reviewed (PANTRY_DATA_CONTRACT §1).
/// </summary>
/// <remarks>
/// <b>Designed generically, on purpose</b> (DECISIONS P4). There is no public Walmart consumer API,
/// so the three durable routes — a forwarded order-confirmation email, the store app's share sheet,
/// a photo of a receipt — all produce the same thing: a list of abbreviated strings. Vendor is a
/// <see cref="VendorLabel"/> on the import, never a code path, and there is deliberately no vendor
/// client anywhere in this section.
/// <para>
/// Nothing is written to the pantry until <c>PUT n AWAY</c>. A bad import is twenty-four wrong rows,
/// where a bad scan is one — different risk, different write timing (DECISIONS PG3).
/// </para>
/// </remarks>
public class OrderImport
{
    public int Id { get; set; }

    public OrderImportSource Source { get; set; }

    /// <summary>"Walmart", "Kroger". A label, shown on the source card.</summary>
    public string? VendorLabel { get; set; }

    public DateTime? OrderedAtUtc { get; set; }

    /// <summary>
    /// When it landed. The median weekday of the last three of these is the only input to the
    /// delivery-day sentence on 9b, which is omitted entirely below three (§3).
    /// </summary>
    public DateTime? DeliveredAtUtc { get; set; }

    /// <summary>The payload exactly as received, retained so a parser improvement can re-read it.</summary>
    public string RawPayload { get; set; } = string.Empty;

    public OrderImportStatus Status { get; set; } = OrderImportStatus.Pending;

    public DateTime CreatedUtc { get; set; }
    public DateTime? AppliedAtUtc { get; set; }
    public int? AppliedByProfileId { get; set; }

    public List<OrderImportLine> Lines { get; } = [];
}

/// <summary>One line of an order, as read and as interpreted.</summary>
public class OrderImportLine
{
    public int Id { get; set; }

    public int ImportId { get; set; }
    public OrderImport? Import { get; set; }

    /// <summary>
    /// The raw string — `GV HVY WHP CRM 32Z`. <b>Kept forever and always displayed</b> (§1): it is
    /// the only way a wrong interpretation gets caught, and hiding it once the panel has guessed a
    /// name would make the guess look like a fact.
    /// </summary>
    public string RawText { get; set; } = string.Empty;

    public string? ProposedName { get; set; }
    public decimal? ProposedQuantity { get; set; }
    public string? ProposedUnit { get; set; }
    public PantryLocation ProposedLocation { get; set; } = PantryLocation.Cupboard;
    public TrackingClass ProposedTracking { get; set; } = TrackingClass.Counted;

    /// <summary>Set when the line resolved to something already in the pantry.</summary>
    public int? MatchedPantryItemId { get; set; }

    public ImportLineConfidence Confidence { get; set; } = ImportLineConfidence.New;

    /// <summary>The pack weight the <see cref="ImportLineConfidence.WeightGuess"/> was derived from,
    /// so the row can say "six is a guess from 2.5 lb" rather than just flagging itself.</summary>
    public decimal? GuessFromPounds { get; set; }

    /// <summary>Whether this line was included when the import was applied.</summary>
    public bool Applied { get; set; }

    public int Position { get; set; }
}
