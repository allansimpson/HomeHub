namespace HomeHub.Api.Profiles;

/// <summary>
/// What a member may do on the panel. Arrived with A1 alongside an <c>AgeBand</c> that has since
/// been removed (ai-assistant.md rev. 2 — no children use the panel, so the assistant no longer
/// varies its register by audience). <see cref="Role"/> is kept on its own merits: gating who may
/// change settings on a shared panel is a plausible use independent of the assistant.
/// </summary>
public enum ProfileRole
{
    /// <summary>The default. Full use of the panel.</summary>
    Member = 0,

    /// <summary>A household administrator.</summary>
    Admin = 1,
}

/// <summary>
/// A household member. PIN is opt-in (<see cref="PinHash"/> nullable): only profiles that
/// set a PIN and turn on <see cref="RequirePinWhenIdle"/> hit the Lock screen after idle.
/// The stored PIN is a salted PBKDF2 hash (see <see cref="PinHasher"/>) — never plaintext.
/// </summary>
public class Profile
{
    public int Id { get; set; }

    /// <summary>Display name, e.g. "Astrid".</summary>
    public required string Name { get; set; }

    /// <summary>1–2 character monogram shown on tiles, e.g. "A".</summary>
    public required string Initial { get; set; }

    /// <summary>Salted PBKDF2 hash of the PIN, or null when the profile has no PIN.</summary>
    public string? PinHash { get; set; }

    /// <summary>When true (and a PIN is set) this profile is asked for its PIN after idle.</summary>
    public bool RequirePinWhenIdle { get; set; }

    /// <summary>When true the profile is never prompted for a PIN (footer "stays signed in").</summary>
    public bool StayLoggedIn { get; set; } = true;

    /// <summary>Order the profile appears in tiles / the switcher (ascending).</summary>
    public int DisplayOrder { get; set; }

    /// <summary>What this member may do on the panel. New profiles start as <see cref="ProfileRole.Member"/>.</summary>
    public ProfileRole Role { get; set; } = ProfileRole.Member;

    /// <summary>
    /// Which agent Assist opens on for this member. Null means the household agent.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Only meaningful for a member who has been given more than one (<c>Assist.ProfileAgent</c>).
    /// With one agent there is nothing to choose between, and the household agent is a floor nobody
    /// can be below — so this is a preference among agents someone already has, never a grant.
    /// </para>
    /// <para>
    /// <b>A roster key, not a foreign key</b>, for the same reason as everywhere else Assist stores
    /// one: the roster is configuration and can lose an entry between restarts. An unresolvable key is
    /// treated as "not set" on read rather than repaired on write — the agent may be coming back, and
    /// clearing somebody's preference because a config file was briefly wrong is not a repair.
    /// </para>
    /// <para>
    /// Household data rather than panel data, unlike the last-agent memory the panel keeps in
    /// <c>assistPrefs</c>. That one is "which agent was this screen last showing", which two devices
    /// may reasonably disagree about; this is "who Assist should open on for me", which they should
    /// not.
    /// </para>
    /// </remarks>
    public string? DefaultAgentKey { get; set; }
}
