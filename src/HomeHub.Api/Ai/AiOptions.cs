namespace HomeHub.Api.Ai;

/// <summary>
/// Hybrid assistant config, bound from the <c>Ai</c> section. The cloud key stays server-side;
/// the local model runs on the home server (never the Pi). Secrets never committed. With neither
/// configured, the router degrades to a built-in simulated on-device assistant so the panel is
/// still demoable. Routing hints are tunable config, not hard-coded (see PROJECT.md §6).
/// </summary>
public sealed class AiOptions
{
    public const string Section = "Ai";

    // ---- Cloud (OpenAI) ----
    public string? OpenAiApiKey { get; set; }
    public string OpenAiModel { get; set; } = "gpt-4o-mini";
    public string OpenAiBaseUrl { get; set; } = "https://api.openai.com";

    // ---- Local (server-hosted, Ollama-compatible) ----
    public string? LocalEndpoint { get; set; }
    public string LocalModel { get; set; } = "llama3.1";

    public RoutingOptions Routing { get; set; } = new();

    public bool CloudConfigured => !string.IsNullOrWhiteSpace(OpenAiApiKey);
    public bool LocalConfigured => !string.IsNullOrWhiteSpace(LocalEndpoint);

    public sealed class RoutingOptions
    {
        /// <summary>Substrings that bias a request toward the local model (commands, conversions, quick lookups).</summary>
        public List<string> LocalHints { get; set; } =
        [
            "set ", "turn on", "turn off", "add ", "remove", "delete", "how many", "convert",
            "teaspoon", "tablespoon", "timer", "remind", "what's on", "whats on", "temperature",
            "degrees", "list", "calendar", "todo", "task",
        ];

        /// <summary>Substrings that bias a request toward the cloud model (open-ended / reasoning-heavy).</summary>
        public List<string> CloudHints { get; set; } =
        [
            "recipe", "explain", "why ", "write ", "story", "poem", "essay", "plan a", "compare",
            "difference between", "how do i", "suggest", "ideas", "translate", "summarize",
        ];

        /// <summary>Where to send requests that match no hint. "cloud" or "local".</summary>
        public string DefaultOrigin { get; set; } = "cloud";

        /// <summary>A local answer shorter than this (chars) is treated as low-confidence.</summary>
        public int MinConfidentLength { get; set; } = 12;
    }
}
