namespace HomeHub.Tests;

using HomeHub.Api.Security;
using Microsoft.AspNetCore.DataProtection;

/// <summary>
/// AUDIT A2: the OAuth refresh tokens are encrypted at rest.
/// </summary>
/// <remarks>
/// These test <see cref="SecretProtector"/> directly rather than through the DbContext, because the
/// question worth asking is about the stored representation and the InMemory provider does not have
/// one — it holds CLR objects, so a converter round-trip there proves only that two functions are
/// inverses. That property is worth pinning anyway (the second test), but "the column does not
/// contain the token" has to be asked of the protector itself.
/// </remarks>
public class SecretProtectionTests
{
    private static SecretProtector NewProtector() => new(new EphemeralDataProtectionProvider());

    private const string Token = "1//0eXaMpLe-refresh-token-value_with.punctuation";

    /// <summary>The stored form must not contain the credential.</summary>
    /// <remarks>
    /// The point of the whole exercise: someone with a backup file or `SELECT` rights sees this
    /// string, and it must not be usable against Google. Asserting on the substring rather than on
    /// inequality, because an encoding that merely wrapped the token would pass the weaker check.
    /// </remarks>
    [Fact]
    public void A_protected_value_does_not_contain_the_plaintext()
    {
        var stored = NewProtector().Protect(Token);

        Assert.NotNull(stored);
        Assert.DoesNotContain(Token, stored, StringComparison.Ordinal);
        Assert.StartsWith(SecretProtector.Envelope, stored, StringComparison.Ordinal);
    }

    [Fact]
    public void A_protected_value_round_trips()
    {
        var protector = NewProtector();

        Assert.Equal(Token, protector.Unprotect(protector.Protect(Token)));
    }

    /// <summary>
    /// A row written before this existed still reads, so the rollout does not break every sync.
    /// </summary>
    /// <remarks>
    /// This is the tolerance that makes the retrofit safe, and it is also the one that must not
    /// become permanent — <see cref="LegacySecretMigration"/> is what removes the rows it applies
    /// to. If that ever stops running, this test keeps passing and nothing else notices, which is
    /// why the migration has its own log line.
    /// </remarks>
    [Fact]
    public void A_legacy_plaintext_value_is_returned_unchanged()
    {
        Assert.Equal(Token, NewProtector().Unprotect(Token));
    }

    /// <summary>Protecting twice must not wrap twice.</summary>
    [Fact]
    public void Protecting_an_already_protected_value_is_a_no_op()
    {
        var protector = NewProtector();
        var once = protector.Protect(Token);

        Assert.Equal(once, protector.Protect(once));
    }

    /// <summary>
    /// A value protected by one key ring must not silently read as something else under another.
    /// </summary>
    /// <remarks>
    /// This is the failure mode behind the `DataProtection:KeyPath` warning at startup: if the keys
    /// are not persisted, every restart is a new key ring. The honest behaviour is to throw — a
    /// corrupt string handed to Google's token endpoint comes back as an auth error, which sends
    /// the household to re-link an account when the real problem is a missing directory.
    /// </remarks>
    [Fact]
    public void A_value_from_a_different_key_ring_fails_loudly()
    {
        var stored = NewProtector().Protect(Token);

        Assert.ThrowsAny<Exception>(() => NewProtector().Unprotect(stored));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    public void Absent_values_pass_through(string? value)
    {
        var protector = NewProtector();

        Assert.Equal(value, protector.Protect(value));
        Assert.Equal(value, protector.Unprotect(value));
    }
}
