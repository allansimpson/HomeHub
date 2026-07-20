namespace HomeHub.Api.Profiles;

using System.Security.Cryptography;

/// <summary>
/// Salted PBKDF2 (SHA-256) hashing for profile PINs. Dependency-free (BCL only). The stored
/// value is <c>iterations.saltBase64.hashBase64</c>; verification is constant-time. PINs are
/// short by nature, so this only raises the bar against a stolen database — it is not a
/// substitute for the physical trust boundary of the wall panel.
/// </summary>
public static class PinHasher
{
    private const int Iterations = 100_000;
    private const int SaltSize = 16; // bytes
    private const int HashSize = 32; // bytes (SHA-256)
    private static readonly HashAlgorithmName Algorithm = HashAlgorithmName.SHA256;

    /// <summary>Hashes a PIN with a fresh random salt. Returns an opaque, storable string.</summary>
    public static string Hash(string pin)
    {
        var salt = RandomNumberGenerator.GetBytes(SaltSize);
        var hash = Rfc2898DeriveBytes.Pbkdf2(pin, salt, Iterations, Algorithm, HashSize);
        return $"{Iterations}.{Convert.ToBase64String(salt)}.{Convert.ToBase64String(hash)}";
    }

    /// <summary>Constant-time verification of a PIN against a stored hash. False on any malformed input.</summary>
    public static bool Verify(string pin, string? stored)
    {
        if (string.IsNullOrEmpty(stored)) return false;

        var parts = stored.Split('.');
        if (parts.Length != 3) return false;
        if (!int.TryParse(parts[0], out var iterations)) return false;

        byte[] salt, expected;
        try
        {
            salt = Convert.FromBase64String(parts[1]);
            expected = Convert.FromBase64String(parts[2]);
        }
        catch (FormatException)
        {
            return false;
        }

        var actual = Rfc2898DeriveBytes.Pbkdf2(pin, salt, iterations, Algorithm, expected.Length);
        return CryptographicOperations.FixedTimeEquals(actual, expected);
    }
}
