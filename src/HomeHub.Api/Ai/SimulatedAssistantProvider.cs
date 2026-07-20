namespace HomeHub.Api.Ai;

/// <summary>
/// Built-in on-device fallback used when neither a cloud key nor a local model is configured, so
/// the assistant screen is demoable out of the box. Deterministic canned replies — honest about
/// being the demo assistant. Counts as a Local (on-LAN) origin. Replaced transparently by the
/// real providers once <c>Ai:*</c> is configured.
/// </summary>
public sealed class SimulatedAssistantProvider : IAssistantProvider
{
    public AssistantOrigin Origin => AssistantOrigin.Local;
    public bool IsAvailable => true;
    public bool SupportsImages => true;

    public Task<ProviderResult> CompleteAsync(AssistantRequest request, CancellationToken ct)
    {
        var text = Answer(request);
        return Task.FromResult(new ProviderResult(text, Model: "simulated"));
    }

    private static string Answer(AssistantRequest request)
    {
        if (request.HasImage)
            return "I can analyze uploaded images once a cloud assistant key is configured (Ai:OpenAiApiKey). For now I'm the on-device demo assistant.";

        var p = request.Prompt.ToLowerInvariant();

        if (p.Contains("teaspoon") && p.Contains("tablespoon"))
            return "There are 3 teaspoons in a tablespoon.";
        if (p.Contains("tablespoon") && p.Contains("cup"))
            return "There are 16 tablespoons in a cup.";
        if (p.StartsWith("set ") || p.Contains("turn on") || p.Contains("turn off") || p.Contains("degrees"))
            return "Assistant actions aren't wired up yet — you can adjust zones directly on the Climate screen. Add an OpenAI key to enable spoken/typed control.";
        if (p.StartsWith("add ") || p.Contains(" list") || p.Contains("task"))
            return "You can add that on the To-Do screen for now. Assistant actions arrive once an AI key is configured.";
        if (p.Contains("what's on") || p.Contains("whats on") || p.Contains("calendar") || p.Contains("tomorrow"))
            return "Your upcoming engagements are on the Calendar screen and the dashboard NEXT section. I'm the on-device demo assistant — add an OpenAI key for conversational answers.";

        return $"I'm Central's on-device demo assistant. Configure a local model (Ai:LocalEndpoint) or an OpenAI key (Ai:OpenAiApiKey) for full answers. You asked: “{request.Prompt.Trim()}”.";
    }
}
