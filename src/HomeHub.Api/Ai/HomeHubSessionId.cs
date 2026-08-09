namespace HomeHub.Api.Ai;

/// <summary>
/// The session ids HomeHub creates on Hermes, and how to recognise one later.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why HomeHub names its own sessions.</b> It sent <c>{"source":"homehub"}</c> on create for
/// months; Hermes never kept it. v0.20.0 normalises `source` through a closed allowlist
/// (<c>api_server</c>, <c>cli</c>, <c>telegram</c>, …) and silently rewrites anything else to
/// <c>api_server</c> — so every HomeHub session is indistinguishable from every other API client's.
/// </para>
/// <para>
/// That is not a cosmetic gap. It is the difference between the lineage report being *honest* and
/// being *decidable*: shown an unclaimed session, HomeHub could say "this might be a transcript I
/// abandoned, or it might belong to something else entirely" and had to block on both. Retention
/// cannot be built on that.
/// </para>
/// <para>
/// The supported fix, confirmed live by Hermes: <c>POST /api/sessions</c> accepts a caller-supplied
/// <c>id</c>, stores it unchanged, and answers <c>409</c> on collision. A namespaced id is therefore
/// evidence HomeHub can produce years later without asking anyone — the row names its own origin.
/// </para>
/// <para>
/// <b>It proves ownership forwards, never backwards.</b> Sessions created before this change carry
/// generic <c>api-…</c> / <c>api_…</c> ids and stay ambiguous for ever; no amount of later reasoning
/// makes them provable. The report says so rather than quietly counting them as ours — see
/// <c>LineageAudit</c>.
/// </para>
/// </remarks>
public static class HomeHubSessionId
{
    /// <summary>Everything HomeHub creates starts with this.</summary>
    public const string Prefix = "homehub_";

    /// <summary>
    /// A fresh id for a conversation on one agent: <c>homehub_barnaby_6e193df1…</c>.
    /// </summary>
    /// <remarks>
    /// The agent key is in the id on purpose. A session id is meaningless outside the gateway that
    /// issued it — Barnaby's store cannot see Geist's — so carrying the profile in the name makes a
    /// mislaid id self-describing rather than a 404 nobody can explain.
    /// </remarks>
    public static string New(string agentKey) =>
        $"{Prefix}{Sanitise(agentKey)}_{Guid.NewGuid():N}";

    /// <summary>Did HomeHub create this session? Provable from the id alone.</summary>
    public static bool IsOurs(string? sessionId) =>
        sessionId is not null && sessionId.StartsWith(Prefix, StringComparison.Ordinal);

    /// <summary>
    /// Keep the id to characters that survive a URL path segment and a SQLite key without escaping.
    /// Agent keys are configuration, so this guards against a typo rather than an attacker.
    /// </summary>
    private static string Sanitise(string agentKey)
    {
        var clean = new string([.. agentKey.Where(c => char.IsAsciiLetterOrDigit(c) || c == '-')]);
        return clean.Length == 0 ? "agent" : clean.ToLowerInvariant();
    }
}
