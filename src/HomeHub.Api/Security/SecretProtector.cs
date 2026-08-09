namespace HomeHub.Api.Security;

using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;

/// <summary>
/// Encrypts the few database columns that hold a credential, at rest.
/// </summary>
/// <remarks>
/// <para>
/// The columns in question are the Google and Microsoft OAuth refresh tokens (AUDIT A2). Those are
/// not session state — a refresh token with calendar scope is durable access to a real cloud
/// account, it outlives the panel, and the only way to revoke it is for the account holder to
/// notice and go looking. Anyone with the connection string, a backup file, or plain <c>SELECT</c>
/// rights had that access in plaintext.
/// </para>
/// <para>
/// <b>Data Protection rather than a hand-rolled AES wrapper or Always Encrypted.</b> It is in-box,
/// it handles key generation, rotation and algorithm agility without this project having an
/// opinion about any of them, and — unlike Always Encrypted — it needs nothing of the database or
/// the client driver. The purpose string binds the ciphertext to this use: a payload protected for
/// the token purpose cannot be unprotected as anything else, so a future protector for some other
/// column cannot be tricked into reading these.
/// </para>
/// <para>
/// <b>Losing the key ring means the tokens are gone.</b> That is the honest trade and it is the
/// reason <c>Program.cs</c> pins the key directory explicitly instead of accepting the default. The
/// failure is recoverable — the household re-links Google and Microsoft in Config — but it is a
/// visible, annoying failure rather than a silent one, and it must not happen on an ordinary
/// deploy. See the key-ring comment at the registration.
/// </para>
/// </remarks>
public interface ISecretProtector
{
    /// <summary>Protect a value for storage. Null and empty pass through unchanged.</summary>
    string? Protect(string? plaintext);

    /// <summary>Reverse <see cref="Protect"/>, tolerating values written before it existed.</summary>
    string? Unprotect(string? stored);

    /// <summary>The EF converter that puts this protection on a column.</summary>
    ValueConverter<string, string> Converter();
}

/// <inheritdoc />
public sealed class SecretProtector : ISecretProtector
{
    /// <summary>
    /// Marks a column value as having been through <see cref="Protect"/>.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The prefix exists because this was retrofitted onto a table that already had rows. Data
    /// Protection payloads are base64url text with no delimiter a reader can rely on, so there is no
    /// way to look at a stored string and know whether it is ciphertext or a refresh token that
    /// happens to be base64url — and refresh tokens are. Guessing wrong in either direction is bad:
    /// treating ciphertext as plaintext sends garbage to Google, and treating plaintext as
    /// ciphertext throws on every read of a working link.
    /// </para>
    /// <para>
    /// So the format says which it is, out loud. A legacy row has no prefix and is returned as-is;
    /// <see cref="LegacySecretMigration"/> rewrites those once at startup and then there are none.
    /// The <c>v1</c> is there so a future format change is a new prefix rather than a guess about
    /// what the old rows were.
    /// </para>
    /// </remarks>
    public const string Envelope = "dp.v1:";

    /// <summary>
    /// Ties the ciphertext to this use. Changing this string makes every existing value
    /// unreadable — it is part of the data format, not a label.
    /// </summary>
    public const string Purpose = "HomeHub.Api.Security.SecretProtector.v1";

    private readonly IDataProtector _protector;

    public SecretProtector(IDataProtectionProvider provider) => _protector = provider.CreateProtector(Purpose);

    /// <inheritdoc />
    public string? Protect(string? plaintext)
    {
        if (string.IsNullOrEmpty(plaintext)) return plaintext;
        // Already enveloped: protecting twice would still round-trip, but it would mean the column
        // silently grew a layer on every save, and nothing would ever say so.
        if (plaintext.StartsWith(Envelope, StringComparison.Ordinal)) return plaintext;
        return Envelope + _protector.Protect(plaintext);
    }

    /// <inheritdoc />
    /// <remarks>
    /// An unprefixed value is a row written before this class existed and is returned unchanged, so
    /// the app keeps working through the rollout rather than failing every calendar sync until the
    /// migration has run. A <b>prefixed</b> value that will not unprotect is different in kind: it
    /// means the key ring is not the one that wrote it, and the only honest answer is to fail rather
    /// than hand a corrupt string to Google's token endpoint and report it as an auth problem.
    /// </remarks>
    public string? Unprotect(string? stored)
    {
        if (string.IsNullOrEmpty(stored)) return stored;
        if (!stored.StartsWith(Envelope, StringComparison.Ordinal)) return stored;
        return _protector.Unprotect(stored[Envelope.Length..]);
    }

    /// <summary>
    /// The EF converter that puts this on a column.
    /// </summary>
    /// <remarks>
    /// A converter rather than encrypting at the call sites, because there are five of them across
    /// three providers and a controller, and the one that gets forgotten is the bug. At this level
    /// no caller can write a plaintext token even by mistake — the property is plaintext in memory
    /// and ciphertext in the column, and nothing in between has to remember.
    /// <para>
    /// Nothing queries these columns by value (they are only ever read by <c>ProfileId</c>), which
    /// is what makes a non-deterministic encryption acceptable here. If anything ever needs to
    /// search one of them, this is the line that has to be reconsidered rather than worked around.
    /// </para>
    /// </remarks>
    /// <inheritdoc />
    public ValueConverter<string, string> Converter() =>
        new(plaintext => Protect(plaintext)!, stored => Unprotect(stored)!);
}
