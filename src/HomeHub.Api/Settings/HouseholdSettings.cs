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

    /// <summary>Minutes of inactivity before the panel locks.</summary>
    /// <remarks>
    /// <b>Only the lock.</b> It used to govern a return to the dashboard as well, and that behaviour
    /// is gone — see <c>app/useIdleReset.ts</c>: a few quiet minutes does not distinguish "finished"
    /// from "went to fetch something", and navigating away threw out whatever somebody was in the
    /// middle of. Locking survives because a PIN is a decision a member made in advance and it
    /// protects something; for a profile without one this timeout now has no visible effect at all.
    /// </remarks>
    public int IdleTimeoutMinutes { get; set; } = 5;

    /// <summary>
    /// Whether the panel dims itself on a schedule at all — the switch above the window below.
    /// </summary>
    /// <remarks>
    /// Off means the panel never dims by itself. It does <b>not</b> mean the panel cannot be dimmed:
    /// the manual override is a separate, panel-local gesture, so "I want it dark now" and "dim
    /// yourself every night" stay two different decisions. Turning the schedule off to get one
    /// evening's brightness back, and then living with a panel that never dims again, is exactly the
    /// trade this separation exists to avoid.
    /// </remarks>
    public bool IdleDimmingEnabled { get; set; } = true;

    /// <summary>When the panel starts dimming. Local wall time, not UTC.</summary>
    /// <remarks>
    /// <b>Local on purpose.</b> This is a fact about the room — when the household stops wanting a
    /// bright screen in it — and a UTC column would shift that by an hour twice a year, which is the
    /// one behaviour nobody would ever ask for from a night light. The panel evaluates it against
    /// its own clock, which is the clock in the same room.
    /// <para>
    /// Defaults to the 22:00–06:00 the window was hard-coded to before it was configurable, so an
    /// existing panel behaves identically until somebody changes it.
    /// </para>
    /// </remarks>
    public TimeOnly NightDimStart { get; set; } = new(22, 0);

    /// <summary>When it stops. Earlier than the start is normal — the window crosses midnight.</summary>
    public TimeOnly NightDimEnd { get; set; } = new(6, 0);

    /// <summary>High-ambient token boost mode: "auto" (light sensor / daytime), "on", or "off".</summary>
    public string DaylightBoost { get; set; } = "auto";

    /// <summary>
    /// Whether a photograph an engagement was read from is kept alongside it.
    /// </summary>
    /// <remarks>
    /// <b>On by default, because the picture is the receipt.</b> This feature manufactures uncertain
    /// data — a year nobody printed, a finish nobody stated — and marks it amber so somebody checks
    /// it. Checking means looking at the flyer, which only works if the flyer is still there.
    /// <para>
    /// Turning it off changes nothing that already exists: the switch governs new engagements, and
    /// photographs already kept stay kept. It is off-by-choice rather than off-by-neglect, so the
    /// confirmation receipt stops claiming the photo was kept the moment it changes.
    /// </para>
    /// </remarks>
    public bool KeepEventPhotos { get; set; } = true;

    // Alert thresholds moved to per-zone AlertThreshold rows in Stage 2 (the engine's source of
    // truth); the Settings screen edits those directly.

    /// <summary>Which profile is currently active on the panel (persists across reboots). Null = none chosen.</summary>
    public int? ActiveProfileId { get; set; }

    /// <summary>
    /// Where the weather is for. Null on both means "use whatever the deployment was configured with".
    /// </summary>
    /// <remarks>
    /// <b>Household data, not deployment config.</b> These were <c>Weather:Latitude</c> /
    /// <c>Weather:Longitude</c> in the environment and nowhere else, which made the single most local
    /// fact in the whole product — which town the household lives in — the one thing they could not
    /// change without editing a file on the server and restarting it. A panel that moves house, or one
    /// set up from its own screen, had no way to say so.
    /// <para>
    /// Nullable rather than seeded from the config value, so the two do not silently fork. Null means
    /// the household has never said, and <see cref="Weather.WeatherOptions"/> is still the answer —
    /// which keeps an existing deployment behaving exactly as it did, including when somebody later
    /// changes the environment variable. Once the household sets a location here, it wins: they said
    /// it more recently and from the room in question.
    /// </para>
    /// <para>
    /// Stored as coordinates because that is what the forecast provider takes. The <i>name</i> of the
    /// place is not stored at all — it is read back from NWS on each refresh (<see cref="Weather.PlaceDto"/>),
    /// so the panel reports where the provider thinks it is rather than what somebody typed, which is
    /// the only version of that label worth trusting when the digits are wrong.
    /// </para>
    /// </remarks>
    public double? WeatherLatitude { get; set; }

    /// <inheritdoc cref="WeatherLatitude"/>
    public double? WeatherLongitude { get; set; }

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
    /// What the household calls the child — the name the Baby tab leads with.
    /// </summary>
    /// <remarks>
    /// Kept by the panel for the same reason as <see cref="CatName"/>: the household edits it, so it
    /// cannot sit in a config file. It also cannot come from the integration it used to come from —
    /// the Care log is HomeHub's own now, and a panel whose header says "Baby" until an upstream
    /// service is reachable is a panel naming a child after a system outage.
    /// <para>
    /// Null falls back to the literal word "Baby", which is what the nav cell says in every state.
    /// </para>
    /// </remarks>
    public string? BabyName { get; set; }

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

    /// <summary>
    /// The whole-house climate pause, from the Climate screen's footer.
    /// </summary>
    /// <remarks>
    /// Household state rather than a runtime flag, and stored here for one reason: it has to survive
    /// a restart. A paused house is a decision someone made, and coming back up holding rooms nobody
    /// asked it to hold would be the loop overriding a person (CLIMATE_BEHAVIOURS §5). Pausing turns
    /// nothing off — every unit keeps exactly the set point it already had.
    /// </remarks>
    public bool ClimateLoopPaused { get; set; }

    /// <summary>Whether Assist keeps conversations at all.</summary>
    /// <remarks>
    /// Off means the chat in front of you is all there is — no list, no history, nothing to search.
    /// Default on: the household can see what the panel heard, which is the whole argument for
    /// keeping history inside the chat rather than behind the gear.
    /// <para>
    /// <b>Household state now, not panel state.</b> This and <see cref="ConversationRetentionDays"/>
    /// were <c>localStorage</c> on the panel, and the reasoning was sound at the time: a retention
    /// window held on a server that keeps none of the data it governs is a policy with nothing to
    /// enforce it against. Moving the transcripts to <see cref="Assist.Conversation"/> inverts that
    /// exactly — a panel-local window would now govern nothing, and the phone and the panel would
    /// disagree about how long the household keeps its own conversations.
    /// </para>
    /// </remarks>
    public bool StoreConversations { get; set; } = true;

    /// <summary>How many days Assist keeps a conversation after its last message. <b>Zero is never.</b></summary>
    /// <remarks>
    /// Enforced on read rather than by a timer, keeping the panel's original argument intact: a
    /// household that has been showing the clock for a week has run no sweep, and a policy that only
    /// holds while something is warm is not a policy. Expired rows are deleted during the sweep, so
    /// `KEPT 30 DAYS` is true of the stored data and not merely of what the list is willing to show.
    /// <para>
    /// Zero switches the sweep off entirely — conversations are kept until somebody deletes them. It
    /// is a different answer from <see cref="StoreConversations"/> being false, which keeps nothing at
    /// all; this keeps everything. Both are things a household can reasonably want, and neither can
    /// stand in for the other.
    /// </para>
    /// </remarks>
    public int ConversationRetentionDays { get; set; } = 30;

    /// <summary>
    /// Whether this database's historical Hermes lineage is known well enough to delete against.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>The gate on deleting a conversation whose intermediates nobody has enumerated.</b> The
    /// lineage table works prospectively — each turn records the session Hermes answered in — and that
    /// cannot rebuild a chain that already existed. A conversation that became <c>A → B → C</c> while
    /// HomeHub stored only <c>A</c> resolves to <c>C</c>: deleting it tombstones A and C and leaves B
    /// on the agent with its messages, permanently, while the panel reports the deletion as done. The
    /// local row is the only anchor by which B could ever have been found, so the order is one-way —
    /// reconcile then delete is recoverable, delete then reconcile is not.
    /// </para>
    /// <para>
    /// <b>An earlier version released this the moment somebody opened the report, clean or not.</b>
    /// That was the wrong bar: being informed that transcripts will be orphaned is not a reason to
    /// orphan them, and an irreversible action does not become safe by being announced. Blocked stays
    /// blocked, which is a dead end until a backfill exists and is the correct one —
    /// <see cref="LineageState.RiskAccepted"/> is the deliberate way out, not a side effect.
    /// </para>
    /// </remarks>
    public LineageState LineageState { get; set; } = LineageState.NotAudited;

    /// <summary>When the lineage was last reconciled, whatever the verdict was.</summary>
    public DateTime? LineageAuditedAtUtc { get; set; }

    /*
     * There were three `LineageRiskAccepted*` columns here and they are gone.
     *
     * They made an acceptance into durable, household-wide deletion authority: manual deletion read
     * one enum and nothing else, so an acceptance issued once against one report authorised every
     * later deletion, including of conversations and damage that did not exist when it was granted.
     * An acceptance is now a scoped, expiring, single-use row — see `LineageRiskAcceptance`.
     */
}
