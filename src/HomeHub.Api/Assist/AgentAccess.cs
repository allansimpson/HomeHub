namespace HomeHub.Api.Assist;

using HomeHub.Api.Ai;
using HomeHub.Api.Data;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// Which agents a member may reach — the roster (configuration) crossed with the assignments
/// (household data).
///
/// One place rather than a LINQ join repeated in each endpoint, because the floor rule below is easy
/// to write four times and get wrong once, and getting it wrong means either a member with no
/// assistant or a member with one nobody gave them.
/// </summary>
public sealed class AgentAccess
{
    private readonly HomeHubDbContext _db;
    private readonly AgentRoster _roster;

    public AgentAccess(HomeHubDbContext db, AgentRoster roster)
    {
        _db = db;
        _roster = roster;
    }

    /// <summary>
    /// The agents this member may use, in roster order.
    /// </summary>
    /// <remarks>
    /// The default agent is always included, assigned or not — see <see cref="ProfileAgent"/> for why
    /// a member with no agent is not a state worth being able to reach. Everything else is present
    /// only if somebody granted it.
    /// <para>
    /// Assignments naming an agent that is no longer in <c>Hermes:Agents</c> are ignored rather than
    /// resolved: <see cref="AgentRoster.Resolve"/> falls back to the default so a *conversation* whose
    /// agent was removed still opens, but access must not fall back the same way, or deleting an
    /// agent from config would quietly hand its members the household agent's switcher entry twice.
    /// </para>
    /// </remarks>
    public async Task<IReadOnlyList<Ai.Agent>> ForAsync(int? profileId, CancellationToken ct)
    {
        var def = _roster.Default;

        // No profile is the guest panel: the household agent and nothing else. There is nobody to
        // have granted a second one to.
        if (profileId is not { } id)
            return [def];

        var granted = await _db.ProfileAgents
            .Where(a => a.ProfileId == id)
            .Select(a => a.AgentKey)
            .ToListAsync(ct);

        var allowed = new HashSet<string>(granted, StringComparer.OrdinalIgnoreCase);

        return [.. _roster.All.Where(a => string.Equals(a.Key, def.Key, StringComparison.OrdinalIgnoreCase) || allowed.Contains(a.Key))];
    }

    /// <summary>Whether this member may use this agent. The guard on every write path.</summary>
    public async Task<bool> CanUseAsync(int? profileId, string agentKey, CancellationToken ct)
    {
        var agents = await ForAsync(profileId, ct);
        return agents.Any(a => string.Equals(a.Key, agentKey, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// The agent Assist opens on for this member — their own choice, or the household agent.
    /// </summary>
    /// <remarks>
    /// <b>Resolved against what they may use, every time.</b> A stored preference naming an agent that
    /// has since been revoked, or removed from <c>Hermes:Agents</c>, is read as no preference rather
    /// than repaired: the agent may be coming back, and clearing somebody's choice because a config
    /// file was briefly wrong is not a repair. What it must never do is hand back an agent they no
    /// longer have.
    /// </remarks>
    public async Task<Ai.Agent> DefaultForAsync(int? profileId, CancellationToken ct) =>
        Prefer(await ForAsync(profileId, ct), await PreferredKeyAsync(profileId, ct));

    /// <summary>
    /// Resolve a requested agent key to one the member may actually use.
    /// </summary>
    /// <remarks>
    /// An unknown or unassigned key resolves to the member's default rather than being rejected. The
    /// panel is shared and the key can be stale in ordinary ways — a member switched agents, then
    /// somebody else signed in; an admin revoked an agent while its tab was open. Answering with the
    /// member's own default agent is the useful outcome; a 403 on the list endpoint would blank a tab
    /// over a race.
    /// </remarks>
    public async Task<Ai.Agent> ResolveForAsync(int? profileId, string? agentKey, CancellationToken ct)
    {
        var agents = await ForAsync(profileId, ct);
        return agents.FirstOrDefault(a => string.Equals(a.Key, agentKey, StringComparison.OrdinalIgnoreCase))
            ?? Prefer(agents, await PreferredKeyAsync(profileId, ct));
    }

    /// <summary>Replace a member's assignments. The default agent is implicit and never stored.</summary>
    /// <remarks>
    /// Revoking an agent that was this member's chosen default clears the choice as well. Leaving it
    /// pointing at an agent they no longer have would be inert — <see cref="DefaultForAsync"/> resolves
    /// it away — but it would also mean the choice silently came back if the agent were ever
    /// re-assigned, which is not something anybody asked for.
    /// </remarks>
    public async Task SetAsync(int profileId, IEnumerable<string> agentKeys, CancellationToken ct)
    {
        var def = _roster.Default;
        var wanted = _roster.All
            .Where(a => !string.Equals(a.Key, def.Key, StringComparison.OrdinalIgnoreCase))
            .Where(a => agentKeys.Any(k => string.Equals(k, a.Key, StringComparison.OrdinalIgnoreCase)))
            .Select(a => a.Key)
            .ToList();

        var existing = await _db.ProfileAgents.Where(a => a.ProfileId == profileId).ToListAsync(ct);

        var revoked = existing
            .Where(e => !wanted.Any(w => string.Equals(w, e.AgentKey, StringComparison.OrdinalIgnoreCase)))
            .ToList();
        _db.ProfileAgents.RemoveRange(revoked);

        foreach (var key in wanted)
        {
            if (existing.Any(e => string.Equals(e.AgentKey, key, StringComparison.OrdinalIgnoreCase))) continue;
            _db.ProfileAgents.Add(new ProfileAgent { ProfileId = profileId, AgentKey = key });
        }

        var profile = await _db.Profiles.FirstOrDefaultAsync(p => p.Id == profileId, ct);
        if (profile?.DefaultAgentKey is { Length: > 0 } chosen
            && revoked.Any(r => string.Equals(r.AgentKey, chosen, StringComparison.OrdinalIgnoreCase)))
        {
            profile.DefaultAgentKey = null;
        }

        await _db.SaveChangesAsync(ct);
    }

    /// <summary>
    /// Choose which of this member's agents Assist opens on. Null, or the household agent, clears it.
    /// </summary>
    /// <remarks>
    /// Refuses an agent the member does not have, rather than granting it: this is a preference among
    /// agents somebody already gave them, and the two decisions are made by different people for
    /// different reasons. Setting the household agent stores null instead of the key — that is not the
    /// same as an arbitrary choice that happens to coincide, because the household agent is the one
    /// thing that cannot be taken away, so "no preference" and "prefers the floor" behave identically
    /// forever and only one of them needs a row.
    /// </remarks>
    /// <returns>False when the key names an agent this member may not use.</returns>
    public async Task<bool> SetDefaultAsync(int profileId, string? agentKey, CancellationToken ct)
    {
        var profile = await _db.Profiles.FirstOrDefaultAsync(p => p.Id == profileId, ct);
        if (profile is null) return false;

        string? chosen = null;
        if (agentKey is { Length: > 0 })
        {
            var mine = await ForAsync(profileId, ct);
            var match = mine.FirstOrDefault(a => string.Equals(a.Key, agentKey, StringComparison.OrdinalIgnoreCase));
            if (match is null) return false;
            if (!string.Equals(match.Key, _roster.Default.Key, StringComparison.OrdinalIgnoreCase))
                chosen = match.Key;
        }

        profile.DefaultAgentKey = chosen;
        await _db.SaveChangesAsync(ct);
        return true;
    }

    /// <summary>The stored preference, or null. Says nothing about whether it still resolves.</summary>
    public async Task<string?> PreferredKeyAsync(int? profileId, CancellationToken ct)
    {
        if (profileId is not { } id) return null;
        return await _db.Profiles.Where(p => p.Id == id).Select(p => p.DefaultAgentKey).FirstOrDefaultAsync(ct);
    }

    /// <summary>The preferred agent if it is still one of theirs, else the household agent.</summary>
    private static Ai.Agent Prefer(IReadOnlyList<Ai.Agent> mine, string? preferred) =>
        mine.FirstOrDefault(a => string.Equals(a.Key, preferred, StringComparison.OrdinalIgnoreCase))
        ?? mine.FirstOrDefault(a => a.IsDefault)
        ?? mine[0];
}
