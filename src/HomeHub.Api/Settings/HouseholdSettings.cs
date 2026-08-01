namespace HomeHub.Api.Settings;

/// <summary>
/// Single household-level settings row (id fixed to 1). Modelled as one extensible record so
/// later stages can add fields (Stage 2 populates the alert thresholds this stage only stores).
/// Per-user preferences live on <see cref="Profiles.Profile"/>; this is the shared surface.
/// </summary>
public class HouseholdSettings
{
    /// <summary>Always 1 — there is exactly one household settings row.</summary>
    public int Id { get; set; } = 1;

    /// <summary>Minutes of inactivity before the panel returns to the dashboard / Lock.</summary>
    public int IdleTimeoutMinutes { get; set; } = 5;

    /// <summary>Dim the dashboard to 40% after 10 PM (see the daylight/idle behaviour).</summary>
    public bool IdleDimmingEnabled { get; set; } = true;

    /// <summary>High-ambient token boost mode: "auto" (light sensor / daytime), "on", or "off".</summary>
    public string DaylightBoost { get; set; } = "auto";

    // Alert thresholds moved to per-zone AlertThreshold rows in Stage 2 (the engine's source of
    // truth); the Settings screen edits those directly.

    /// <summary>Which profile is currently active on the panel (persists across reboots). Null = none chosen.</summary>
    public int? ActiveProfileId { get; set; }

    /// <summary>
    /// What the household calls the cat, used wherever the litter box reports one.
    /// </summary>
    /// <remarks>
    /// Kept by the panel, not the robot. The Litter-Robot reports that <em>a</em> cat is present and
    /// never which one, so this is not identity — with one cat in the household it is simply the
    /// better word than "cat", and every sentence that uses it falls back to the literal word when it
    /// is unset. It is the only litter setting that needs no round-trip to Home Assistant, which is
    /// why it lives here rather than in <c>CatOptions</c>: the household edits it, so it cannot sit in
    /// a config file.
    /// </remarks>
    public string? CatName { get; set; }

    /// <summary>
    /// Waste-drawer fullness, as a percentage, at which the panel asks for the litter to be changed.
    /// </summary>
    /// <remarks>
    /// Household-editable and therefore here rather than in <c>CatOptions</c>, for the same reason as
    /// <see cref="CatName"/>: a config file is not a surface the household can reach.
    /// <para>
    /// This is deliberately <b>ahead</b> of the robot's own drawer-full fault, which only fires once
    /// the box has stopped cycling. By then the choice has already been made for you. Eighty percent
    /// is roughly a day or two of warning at a typical fill rate — enough to change it at a convenient
    /// moment rather than at the moment the cat is waiting.
    /// </para>
    /// </remarks>
    public int LitterFullPercent { get; set; } = 80;
}
