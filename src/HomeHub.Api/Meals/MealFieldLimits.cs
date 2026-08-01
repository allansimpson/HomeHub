namespace HomeHub.Api.Meals;

/// <summary>
/// Column lengths for the Meals tables, in one place because two callers have to agree on them:
/// <see cref="Data.HomeHubDbContext"/> configures the columns, and the controllers reject overlong
/// input before it reaches SQL Server.
/// </summary>
/// <remarks>
/// Duplicating these numbers is exactly how a 400 turns into a 500 — the write path stops rejecting
/// precisely what the column stops accepting, and the caller gets "String or binary data would be
/// truncated" instead of being told which field was too long. Note the test suite cannot catch that
/// drift: <c>HubAppFactory</c> runs on the EF in-memory provider, which ignores
/// <c>HasMaxLength</c> entirely.
/// </remarks>
public static class MealFieldLimits
{
    public const int Title = 300;
    public const int Description = 2000;

    /// <summary>Recipe URLs carry long tracking tails; generous rather than a guess to revisit.</summary>
    public const int Url = 1000;

    public const int SourceName = 120;
    public const int YieldText = 120;
    public const int ImagePath = 260;
    public const int IncompleteReason = 300;

    /// <summary>A short paragraph or a couple of lines — "pork out Friday night", not a method.</summary>
    public const int PrepNote = 600;

    public const int IngredientRawText = 500;
    public const int Unit = 40;
    public const int IngredientName = 200;
    public const int Note = 200;
    public const int SectionHeading = 120;

    public const int StepText = 4000;

    public const int Tag = 40;

    /// <summary>Also the ceiling a deleted recipe's title is truncated to when its plans become text.</summary>
    public const int FreeText = 200;
}
