namespace HomeHub.Api.Profiles;

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
}
