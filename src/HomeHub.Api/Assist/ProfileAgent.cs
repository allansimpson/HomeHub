namespace HomeHub.Api.Assist;

/// <summary>
/// Which agents a household member may talk to (ASSIST.md · Agents).
///
/// <para>
/// The roster itself is configuration — an endpoint, a profile prefix and a credential, which is the
/// only place that mapping can live because Hermes exposes no profile-discovery API. *Who gets which
/// agent* is household data and belongs here: it is a decision the household makes about people, not
/// a fact about the deployment, and it has to be editable from Config rather than from a file on the
/// server.
/// </para>
/// <para>
/// One row means "this member has this agent". <b>Absence is not access.</b> Adding an agent to
/// <c>Ai:Agents</c> gives it to nobody until somebody assigns it — a research agent with the
/// household's toolset should not arrive on every member's switcher because a config file grew a
/// line.
/// </para>
/// </summary>
/// <remarks>
/// The one exception is the default agent, which every member always has. A member with no agent at
/// all would have an Assist tab that cannot do anything, and there is no useful screen to draw for
/// that: the composer would have nothing to send to and the list would be permanently empty. So the
/// household agent is a floor rather than a grant, and <see cref="AgentAccess"/> enforces it on read
/// rather than by seeding rows that would then need keeping in step with config.
/// </remarks>
public class ProfileAgent
{
    public int ProfileId { get; set; }

    /// <summary>The roster key. Not a foreign key — see <see cref="Conversation.AgentKey"/>.</summary>
    public required string AgentKey { get; set; }
}
