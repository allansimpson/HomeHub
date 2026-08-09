namespace HomeHub.Api.Assist;

using HomeHub.Api.Ai;
using HomeHub.Api.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

/// <summary>
/// Names a conversation after it has said something worth naming.
/// </summary>
/// <remarks>
/// <para>
/// A chat's provisional title is its opening turn, trimmed (<see cref="AssistTitle.From"/>). That is
/// the right thing to write the instant the row exists — it is true, it is instant, and it needs
/// nothing to be reachable — and it is a poor thing to still be reading a week later. "Can you have a
/// look at the boiler manual and tell me what E24 means, the…" is the first twenty words of a
/// question, not the name of a conversation, and a list of them is a list of openings rather than a
/// list of subjects.
/// </para>
/// <para>
/// So once the first turn has been answered, the agent is asked to name it in a few words. Three
/// properties of how that is done are deliberate:
/// </para>
/// <list type="bullet">
/// <item>
/// <b>Sessionless.</b> The request carries no <c>X-Hermes-Session-Id</c>, so it is a one-shot
/// completion against the agent's own listener and touches neither the conversation's session nor its
/// memory. Naming a chat must not become a turn inside it — the household would find the agent
/// remembering that it was asked to write a title, and the next reply arriving in a context that has
/// one more exchange in it than the transcript shows.
/// </item>
/// <item>
/// <b>Off the household's clock.</b> Scheduled rather than awaited, because nobody is waiting for it:
/// the reply is already on screen and the row already has a name. A title that cost a second of
/// latency on every new chat would be a bad trade for a cosmetic improvement.
/// </item>
/// <item>
/// <b>Conditional on write.</b> The row is only renamed if it still holds the exact provisional title
/// — see <see cref="TitleAsync"/>. That single comparison is what makes this safe to run in the
/// background beside a household that can rename its own chats.
/// </item>
/// </list>
/// <para>
/// Failure is silence. An unreachable agent, a model that answered with a paragraph, a gateway that
/// refused the credential — all of them leave the provisional title exactly where it was, which is a
/// worse title and a perfectly usable one. Nothing here is load-bearing.
/// </para>
/// </remarks>
public sealed class ConversationTitler
{
    /// <summary>
    /// How much of the exchange is sent. Enough to name a subject, not enough to be a second turn.
    /// </summary>
    /// <remarks>
    /// A long paste — a recipe, an error log — is exactly the case that most needs a real title and
    /// least needs to be sent in full to get one: the subject is in the first few lines. Capping it
    /// also bounds what a naming call can cost when somebody pastes a book at the agent.
    /// </remarks>
    private const int MaterialChars = 1_000;

    private readonly HermesClient _hermes;
    private readonly IOptionsMonitor<HermesOptions> _options;
    private readonly IServiceScopeFactory _scopes;
    private readonly ILogger<ConversationTitler> _logger;

    public ConversationTitler(
        HermesClient hermes,
        IOptionsMonitor<HermesOptions> options,
        IServiceScopeFactory scopes,
        ILogger<ConversationTitler> logger)
    {
        _hermes = hermes;
        _options = options;
        _scopes = scopes;
        _logger = logger;
    }

    /// <summary>
    /// Name this conversation in the background. Returns immediately; never throws at the caller.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Fire-and-forget on purpose, and the request's cancellation token is deliberately <b>not</b>
    /// passed on: the browser closing the connection the moment it has its reply is the ordinary case
    /// here, not a reason to abandon the work. It carries its own scope for the same reason — the
    /// request's <c>DbContext</c> is disposed the instant the response completes.
    /// </para>
    /// <para>
    /// This is the only path <c>Hermes:NameConversations</c> switches off, and the gate is here rather
    /// than in <see cref="TitleAsync"/> deliberately: the setting is about whether HomeHub names chats
    /// <i>by itself</i>, not about whether the titler works. Somebody asking for a name explicitly
    /// should get one.
    /// </para>
    /// </remarks>
    public void Schedule(int conversationId, string agentKey, string provisionalTitle, string prompt, string reply)
    {
        if (conversationId <= 0 || !_options.CurrentValue.NameConversations) return;

        _ = Task.Run(async () =>
        {
            try
            {
                await TitleAsync(conversationId, agentKey, provisionalTitle, prompt, reply, CancellationToken.None);
            }
            catch (Exception ex)
            {
                // Nothing above this catches: there is no caller left to tell. A chat that keeps its
                // opening turn as a title is a cosmetic disappointment, not a fault, so this is a
                // debug line rather than a warning the household's log has to carry.
                _logger.LogDebug(ex, "Naming conversation {Id} failed.", conversationId);
            }
        });
    }

    /// <summary>
    /// Ask the agent for a title and write it, if the row is still called what it was called.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The comparison against <paramref name="provisionalTitle"/> is the whole concurrency story. This
    /// runs seconds after the turn it names, and in that window the household can open the chat and
    /// rename it themselves — a person's own words must never be overwritten by a model's, however
    /// much later the model got there. Comparing rather than holding a lock also means a rename made
    /// from a phone, by somebody who never saw this run, is respected for free.
    /// </para>
    /// <para>
    /// Public and awaitable so a test can drive it without racing a background task.
    /// </para>
    /// </remarks>
    /// <returns>The title written, or null when nothing was.</returns>
    public async Task<string?> TitleAsync(
        int conversationId, string agentKey, string provisionalTitle, string prompt, string reply,
        CancellationToken ct)
    {
        // An agent with no address cannot be asked. Checked before the scope so the ordinary
        // no-Hermes deployment does no database work at all for a feature it cannot have.
        if (!_hermes.IsConfigured(agentKey)) return null;

        var suggestion = await SuggestAsync(agentKey, prompt, reply, ct);
        if (suggestion is null || string.Equals(suggestion, provisionalTitle, StringComparison.Ordinal)) return null;

        using var scope = _scopes.CreateScope();
        var db = scope.ServiceProvider.GetService<HomeHubDbContext>();
        if (db is null) return null;

        var convo = await db.Conversations.FirstOrDefaultAsync(c => c.Id == conversationId, ct);
        if (convo is null) return null;

        // Renamed since the turn — by the household, or by a second turn that raced this one. Either
        // way this suggestion is about a chat that has already been named by somebody with more right
        // to name it.
        if (!string.Equals(convo.Title, provisionalTitle, StringComparison.Ordinal)) return null;

        convo.Title = suggestion;
        await db.SaveChangesAsync(ct);
        return suggestion;
    }

    /// <summary>
    /// Ask one agent to name an exchange. Null when it could not, or would not, produce a title.
    /// </summary>
    /// <remarks>
    /// The instruction is written to be answerable by a small model with no context: it says what the
    /// output is for, bounds its length in words, and puts the material behind explicit markers so a
    /// prompt that itself contains instructions is read as the subject rather than followed. The worst
    /// case if that fails is a strange title on one row, which <see cref="AssistTitle.Clean"/> length-
    /// caps and the household can rename.
    /// </remarks>
    public async Task<string?> SuggestAsync(string agentKey, string prompt, string reply, CancellationToken ct)
    {
        var instruction =
            $"""
            Name the conversation below, as a heading in a list of chats.

            Rules:
            - Three to six words. Never a sentence.
            - Name the subject, not the request: "Boiler fault E24", not "User asks about a boiler".
            - No quotation marks, no trailing full stop, no preamble.
            - Reply with the title and nothing else.

            <conversation>
            Them: {Clip(prompt)}
            You: {Clip(reply)}
            </conversation>
            """;

        try
        {
            // A turn's ceiling is ten minutes, because a household question may deserve one. This is
            // not a household question — it is six words for a list row, asked after the answer the
            // member actually wanted has already been delivered. Its own short leash, so a slow agent
            // delays a title and nothing else.
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
            deadline.CancelAfter(TimeSpan.FromSeconds(60));

            // No session id: a one-shot completion that leaves no trace in the agent's memory.
            var answer = await _hermes.ChatAsync(agentKey, null, [new HermesContent(instruction)], deadline.Token);
            var title = AssistTitle.Clean(answer.Text);

            if (title is null)
                _logger.LogDebug("Agent '{Agent}' did not return a usable conversation title.", agentKey);

            return title;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Includes the unreachable agent, which is the common one. Debug, not warning: the turn
            // this names already succeeded or already reported its own failure, and a second line
            // about the title would be noise beside it.
            _logger.LogDebug(ex, "Could not ask agent '{Agent}' for a conversation title.", agentKey);
            return null;
        }
    }

    private static string Clip(string text)
    {
        var t = (text ?? "").Trim();
        return t.Length <= MaterialChars ? t : t[..MaterialChars] + "…";
    }
}
