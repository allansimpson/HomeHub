namespace HomeHub.Api.Assist;

using System.Security.Cryptography;
using System.Text;

/// <summary>
/// One administrator's authorisation to delete named conversations against a named lineage report.
/// </summary>
/// <remarks>
/// <para>
/// <b>A row rather than a state, because the previous version was durable global authority.</b> The
/// household used to sit in a <c>RiskAccepted</c> state and manual deletion read that enum and nothing
/// else — so an acceptance granted once, against one report, authorised every later deletion,
/// including of conversations that did not exist yet and lineage damage discovered afterwards. It also
/// survived a re-reconciliation that still came back unclean, on the reasoning that a routine re-run
/// should not undo a deliberate override; the effect was that the override outlived the evidence it
/// was granted against.
/// </para>
/// <para>
/// <b>And it could be granted by somebody who had read nothing.</b> The confirmation was the set of
/// unresolved session ids — which is empty when the agent is unreachable, because nothing could be
/// enumerated. So <c>accept-risk</c> with an empty list matched, and succeeded, with no report and no
/// reconciliation in front of it. Matching an enumeration cannot represent a failure *of* enumeration:
/// the very case that most needs a human to have looked was the one that proved nothing.
/// </para>
/// <para>
/// What is bound now is a digest of the whole report — every agent's reachability and error, every
/// blocking reason, every unresolved session, and the local anchors those would have been reconciled
/// against. An unreachable agent produces a distinct digest that can only have come from a report, and
/// a report that has changed in any of those respects produces a different one.
/// </para>
/// </remarks>
public class LineageRiskAcceptance
{
    public int Id { get; set; }

    /// <summary>The challenge nonce this acceptance was issued against. Unique; consumed once.</summary>
    public required string Nonce { get; set; }

    /// <summary>The report fingerprint at the moment of acceptance. Rechecked at deletion.</summary>
    public required string ReportDigest { get; set; }

    /// <summary>The conversations this authorises, and no others. Comma-separated ids.</summary>
    public required string ConversationIds { get; set; }

    /// <summary>What was accepted, in the report's own words, so the record is readable later.</summary>
    public string? BlockingReasons { get; set; }

    public int? AcceptedByProfileId { get; set; }

    public DateTime AcceptedAtUtc { get; set; }

    /// <summary>Past this it is refused. An authorisation nobody used is not one that keeps.</summary>
    public DateTime ExpiresAtUtc { get; set; }

    /// <summary>Set when it has authorised a deletion. Never a second one.</summary>
    public DateTime? ConsumedAtUtc { get; set; }
}

/// <summary>
/// What a lineage report looked like, reduced to something an acceptance can be bound to.
/// </summary>
/// <remarks>
/// <b>Reachability and blocking reasons are in the digest, not only the sessions.</b> That is the
/// whole correction: when an agent cannot be read there are no sessions to enumerate, so a digest over
/// sessions alone would be identical to a clean household's and an acceptance would prove nothing. The
/// inability to enumerate is itself part of what is being accepted, so it is part of what is signed.
/// </remarks>
public static class LineageFingerprint
{
    /// <summary>Field separator. A control character, so no value can forge a boundary.</summary>
    private const char Separator = '\u001f';

    /// <summary>A stable digest of everything an administrator would have had to read.</summary>
    public static string Of(LineageReport report, IEnumerable<string> localAnchors)
    {
        var canonical = new StringBuilder();
        void Field(string label, string value) =>
            canonical.Append(label).Append(Separator).Append(value).Append(Separator);

        // Ordered, so two readings of one situation agree and a changed situation does not.
        foreach (var agent in report.Agents.OrderBy(a => a.AgentKey, StringComparer.Ordinal))
        {
            Field("agent", agent.AgentKey);
            Field("reachable", agent.Reachable ? "yes" : "no");
            Field("error", agent.Error ?? "");
            Field("truncated", agent.Truncated ? "yes" : "no");
        }

        Field("clean", report.Clean ? "yes" : "no");

        foreach (var reason in report.BlockingReasons.OrderBy(r => r, StringComparer.Ordinal))
            Field("blocking", reason);

        foreach (var finding in report.Agents
                     .SelectMany(a => a.Findings.Select(f => $"{a.AgentKey}{Separator}{f.Kind}{Separator}{f.SessionId}"))
                     .Distinct(StringComparer.Ordinal)
                     .OrderBy(x => x, StringComparer.Ordinal))
        {
            Field("finding", finding);
        }

        foreach (var anchor in localAnchors.Distinct(StringComparer.Ordinal).OrderBy(x => x, StringComparer.Ordinal))
            Field("anchor", anchor);

        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical.ToString())));
    }
}
