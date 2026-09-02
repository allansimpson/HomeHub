namespace HomeHub.Tests;

using HomeHub.Api.Data;

/// <summary>
/// HH-07 — a deployment may not accept whatever certificate answers on 1433.
/// </summary>
/// <remarks>
/// <para>
/// The bootstrap template emitted <c>TrustServerCertificate=True</c> next to a <c>Server=</c> the
/// operator is told to point at another host. With validation off the app takes any certificate, so
/// anything that can take up a position between the panel and the database on a house LAN is handed
/// the login and every row after it.
/// </para>
/// <para>
/// The exemption that survives is loopback, and only loopback: a connection that never leaves the
/// machine has no position for anybody to take up. These say where the line is, in both directions —
/// a policy that refused everything would be as useless as one that refused nothing, because the
/// deployment that cannot express its local database goes back to the setting this removed.
/// </para>
/// </remarks>
public class SqlConnectionPolicyTests
{
    private const string Credentials = "Database=HomeHub;User Id=homehub_app;Password=hunter2";

    // ---- Refused ----

    [Theory]
    [InlineData("sql.house.lan")]
    [InlineData("192.168.1.50")]
    [InlineData("10.0.0.4,1433")]
    [InlineData("tcp:sql.house.lan,1433")]
    [InlineData(@"SQLBOX\SQLEXPRESS")]
    public void Trusting_any_certificate_from_a_remote_host_is_refused(string server)
    {
        var refusal = SqlConnectionPolicy.Refuse(
            $"Server={server};{Credentials};Encrypt=True;TrustServerCertificate=True");

        Assert.NotNull(refusal);
        Assert.Contains("TrustServerCertificate", refusal);
    }

    [Fact]
    public void An_unencrypted_connection_is_refused_wherever_it_points()
    {
        var refusal = SqlConnectionPolicy.Refuse($"Server=localhost;{Credentials};Encrypt=False");

        Assert.NotNull(refusal);
        Assert.Contains("encrypted", refusal);
    }

    /// <summary>The message goes into a startup log and a journal, so it may not carry the password.</summary>
    [Theory]
    [InlineData("Server=sql.house.lan;Database=HomeHub;User Id=homehub_app;Password=hunter2;Encrypt=True;TrustServerCertificate=True")]
    [InlineData("Server=localhost;Database=HomeHub;User Id=homehub_app;Password=hunter2;Encrypt=False")]
    [InlineData("Server=;;;=broken=;Password=hunter2")]
    public void A_refusal_never_names_the_credential_it_inspected(string connectionString)
    {
        var refusal = SqlConnectionPolicy.Refuse(connectionString);

        Assert.NotNull(refusal);
        Assert.DoesNotContain("hunter2", refusal);
        Assert.DoesNotContain("homehub_app", refusal);
    }

    [Fact]
    public void A_string_that_cannot_be_parsed_is_refused_rather_than_assumed_safe()
    {
        Assert.NotNull(SqlConnectionPolicy.Refuse("Server=;;;=broken=;Password=hunter2"));
    }

    // ---- Allowed ----

    [Fact]
    public void A_trusted_chain_against_a_named_host_is_the_shape_production_should_use()
    {
        Assert.Null(SqlConnectionPolicy.Refuse($"Server=sql.house.lan;{Credentials};Encrypt=True"));
    }

    /*
     * The one exemption. A connection that never leaves the machine has no network position to take
     * up, and the certificate it would validate is one SQL Server signed for itself.
     */
    [Theory]
    [InlineData("localhost")]
    [InlineData("LOCALHOST")]
    [InlineData("127.0.0.1")]
    [InlineData("127.0.0.1,1433")]
    [InlineData(".")]
    [InlineData("(local)")]
    [InlineData(@"localhost\SQLEXPRESS")]
    [InlineData("tcp:127.0.0.1,1433")]
    [InlineData("[::1]")]
    public void Trusting_the_certificate_of_a_server_on_this_machine_is_allowed(string server)
    {
        Assert.Null(SqlConnectionPolicy.Refuse(
            $"Server={server};{Credentials};Encrypt=True;TrustServerCertificate=True"));
    }

    /*
     * Addresses are compared as addresses. `127.1` and `127.000.000.001` are both loopback and neither
     * is the string "127.0.0.1", so a textual check would send a perfectly local deployment looking
     * for a certificate it cannot get — and the way out of that is the setting this exists to remove.
     */
    [Theory]
    [InlineData("127.1")]
    [InlineData("127.000.000.001")]
    [InlineData("127.9.9.9")]
    public void Loopback_is_recognised_by_address_and_not_by_spelling(string server)
    {
        Assert.True(SqlConnectionPolicy.IsLoopback(server));
    }

    /*
     * And the direction that matters more: anything not positively identified as loopback is remote.
     * A hostname that merely begins with the right letters is somebody else's machine.
     */
    [Theory]
    [InlineData("localhost.attacker.example")]
    [InlineData("notlocalhost")]
    [InlineData("127.0.0.1.attacker.example")]
    [InlineData("192.168.0.1")]
    [InlineData("")]
    [InlineData(null)]
    public void Anything_not_provably_local_is_treated_as_remote(string? server)
    {
        Assert.False(SqlConnectionPolicy.IsLoopback(server));
    }
}
