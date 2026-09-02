namespace HomeHub.Api.Data;

using Microsoft.Data.SqlClient;

/// <summary>
/// What a deployment's database connection string must promise before the app will use it.
/// </summary>
/// <remarks>
/// <para>
/// <b>The bootstrap template shipped <c>TrustServerCertificate=True</c> alongside a <c>Server=</c>
/// the operator is told to point at another host.</b> Those two lines together are the finding: with
/// validation off, the app accepts whatever certificate answers on 1433, so a redirected or
/// intercepted endpoint on the house LAN is handed the database login and every row that follows. The
/// setting is there because it is what makes a local SQL Server work without a trusted chain, and
/// nothing distinguished that convenience from the case it was silently also covering.
/// </para>
/// <para>
/// <b>So the exemption is scoped to the only case that justifies it.</b> Loopback is a connection
/// that never leaves the machine — there is no network position to take up between the app and the
/// server — and the certificate it would validate is a self-signed one SQL Server generated for
/// itself. Anywhere else, a certificate is the only thing that says the host answering is the host
/// asked for, and disabling that check is disabling the whole of it.
/// </para>
/// <para>
/// Development and the automated Test environment are exempt from all of this, as they are from the
/// other deployment safeguards. The point is not to make local work harder; it is that a deployment
/// cannot arrive at the unsafe combination by copying a template.
/// </para>
/// </remarks>
public static class SqlConnectionPolicy
{
    /// <summary>
    /// The reason this connection string may not be used in a deployment, or null when it may.
    /// </summary>
    /// <remarks>
    /// Returns a sentence rather than throwing, so the caller decides whether this is fatal and so the
    /// message can be logged, tested and read without a stack trace around it. <b>It names no
    /// credential</b> — the string it inspects carries a password, and a validator that echoed its
    /// input would put that password in a startup log and a journal.
    /// </remarks>
    public static string? Refuse(string connectionString)
    {
        SqlConnectionStringBuilder builder;
        try
        {
            builder = new SqlConnectionStringBuilder(connectionString);
        }
        catch (Exception ex)
        {
            // Deliberately not `ex.Message`: the parser quotes the offending fragment, which for a
            // malformed string is as likely to be the password as anything else.
            return $"ConnectionStrings:HomeHub could not be parsed ({ex.GetType().Name}).";
        }

        if (!builder.Encrypt)
        {
            return "Production requires an encrypted SQL connection. Remove Encrypt=False from "
                + "ConnectionStrings:HomeHub; the database login and every row travel in the clear without it.";
        }

        if (!builder.TrustServerCertificate) return null;

        if (!IsLoopback(builder.DataSource))
        {
            return "ConnectionStrings:HomeHub sets TrustServerCertificate=True against a remote host. "
                + "That accepts any certificate, so a redirected SQL endpoint is handed the database "
                + "login. Install a certificate the app's host trusts, whose subject or SAN matches the "
                + "Server= name, and remove TrustServerCertificate.";
        }

        return null;
    }

    /// <summary>
    /// Whether this <c>Server=</c> names the machine the app is running on.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Parsed rather than pattern-matched, and conservative in the direction that matters: anything
    /// this cannot positively identify as loopback is treated as remote. A wrong answer one way is a
    /// deployment that has to install a certificate it should have anyway; a wrong answer the other way
    /// is the finding, reopened.
    /// </para>
    /// <para>
    /// The forms SQL Server accepts and this recognises: <c>localhost</c>, <c>.</c>, <c>(local)</c>,
    /// <c>127.0.0.1</c>, <c>::1</c>, each optionally with an instance name (<c>\SQLEXPRESS</c>), a port
    /// (<c>,1433</c>) and a protocol prefix (<c>tcp:</c>, <c>np:</c>, <c>lpc:</c>). A named pipe or
    /// shared-memory connection to any of them is local by construction.
    /// </para>
    /// </remarks>
    public static bool IsLoopback(string? dataSource)
    {
        if (string.IsNullOrWhiteSpace(dataSource)) return false;

        var host = dataSource.Trim();

        // Protocol prefix. `lpc:` is shared memory and `np:` a named pipe, neither of which reaches a
        // network; they are still required to name a local host below rather than being trusted alone.
        var colon = host.IndexOf(':');
        if (colon > 0 && host[..colon] is "tcp" or "np" or "lpc" or "admin")
            host = host[(colon + 1)..];

        // A named pipe path: \\host\pipe\...
        if (host.StartsWith(@"\\", StringComparison.Ordinal))
        {
            var parts = host[2..].Split('\\', 2);
            host = parts.Length > 0 ? parts[0] : string.Empty;
        }

        // Instance name and port, in either order as SQL Server accepts them.
        var backslash = host.IndexOf('\\');
        if (backslash >= 0) host = host[..backslash];
        var comma = host.IndexOf(',');
        if (comma >= 0) host = host[..comma];

        host = host.Trim();
        if (host.StartsWith('[') && host.EndsWith(']')) host = host[1..^1];

        if (host is "." or "(local)" or "(localdb)") return true;
        if (string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase)) return true;

        // An address is checked as an address rather than as text: `127.1` and `127.000.000.001` are
        // both loopback and neither is the string "127.0.0.1".
        return System.Net.IPAddress.TryParse(host, out var address) && System.Net.IPAddress.IsLoopback(address);
    }
}
