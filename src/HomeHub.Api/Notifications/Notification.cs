namespace HomeHub.Api.Notifications;

/// <summary>
/// One thing the household was told, at a moment in time.
/// </summary>
/// <remarks>
/// Deliberately not an <see cref="Alerts.ActiveAlert"/>, and the distinction is the whole design:
/// an alert says "this condition is <em>true now</em>" and the engine clears it when it stops being
/// true; a notification says "this <em>happened</em> at 7:41 PM" and stays until someone reads it or
/// seven days pass. Fold them together and the record deletes itself — the globe really did stop
/// partway through a cycle, whether or not it has since recovered.
///
/// <para><b>Clearing is not undoing.</b> Nothing here is an action on the thing it reports. Clearing
/// "globe stopped partway through a cycle" does not cancel the retry, and clearing a Baby entry
/// certainly does not unlog it — nothing in Baby can be unlogged at all.</para>
/// </remarks>
public class Notification
{
    public int Id { get; set; }

    /// <summary>Which switchable source this came from — see <see cref="NotificationSources"/>.</summary>
    public required string Source { get; set; }

    /// <summary>
    /// What the accent-coloured row label reads. Usually the source's own name, but for <c>tasks</c>
    /// it is the To Do list's name, so a row says which list gained an item rather than a flat
    /// "TASKS". The list is named by the household and can be renamed, which is exactly why it is a
    /// label and not a source.
    /// </summary>
    public required string Label { get; set; }

    /// <summary>`wants-you` or `worth-knowing`. Two levels; there is no "critical".</summary>
    public required string Severity { get; set; }

    /// <summary>`terracotta` · `verdigris` · `brass` · `brass-bright`. The accent carries the level.</summary>
    public required string Accent { get; set; }

    public required string Headline { get; set; }

    /// <summary>The single small-caps line beneath the headline.</summary>
    public string? Meta { get; set; }

    /// <summary>Where tapping it should go, e.g. <c>/litter</c>.</summary>
    public string? Route { get; set; }

    /// <summary>
    /// Stable identity for the underlying occurrence, so a re-poll or a restart cannot tell the
    /// household the same thing twice.
    /// </summary>
    public required string DedupeKey { get; set; }

    /// <summary>When the thing happened — not when the row was written.</summary>
    public DateTime AtUtc { get; set; }

    /// <summary>Set when someone has looked at it. Null while unread.</summary>
    public DateTime? ReadAtUtc { get; set; }
}

/// <summary>
/// Whether a source may notify at all. Off means nothing enters the store from it — a notification
/// that existed but was hidden in one view would break the one-queue rule.
/// </summary>
public class NotificationSourceSetting
{
    public int Id { get; set; }

    public required string Source { get; set; }

    public bool Enabled { get; set; }
}

/// <summary>The six sources that may notify.</summary>
/// <remarks>
/// Six, not the seven the mockups drew. <c>GROCERY</c> there is not a source — it is the name of a
/// Microsoft To Do list, and could equally read <c>HOUSEHOLD</c>. List notifications arrive as
/// <c>tasks</c> carrying the list's own name as their label; making it a source would mean offering
/// a switch for a list that might be renamed tomorrow.
/// </remarks>
public static class NotificationSources
{
    public const string Litter = "litter";
    public const string Calendar = "calendar";
    public const string Tasks = "tasks";
    public const string Climate = "climate";
    public const string Baby = "baby";

    /// <summary>Meals: what needs starting tonight, and what someone else changed (MEALS_BEHAVIOURS §4).</summary>
    public const string Meals = "meals";

    /// <summary>No camera integration exists. Present, and off, rather than quietly absent.</summary>
    public const string Cameras = "cameras";

    public static readonly string[] All = [Litter, Calendar, Meals, Tasks, Climate, Baby, Cameras];

    /// <summary>Sources that are on unless the household says otherwise.</summary>
    public static bool DefaultFor(string source) => source != Cameras;
}

/// <summary>The two levels. The accent carries which, so the UI never branches on a third.</summary>
public static class NotificationSeverities
{
    /// <summary>A fault, a failure, or a thing a person must go and do. Never times out.</summary>
    public const string WantsYou = "wants-you";

    /// <summary>Times out on screen; kept in the record.</summary>
    public const string WorthKnowing = "worth-knowing";
}
