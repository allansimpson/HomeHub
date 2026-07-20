namespace HomeHub.Api.Tasks;

/// <summary>
/// Links a profile to a Microsoft account for To Do sync. One per profile. The refresh token is
/// stored server-side (encrypted at rest where practical) and used for silent access-token
/// refresh; the household member consents once. Only meaningful when Microsoft Graph is configured.
/// </summary>
public class MicrosoftAccountLink
{
    /// <summary>Profile id (primary key — one Microsoft link per profile).</summary>
    public int ProfileId { get; set; }

    public required string RefreshToken { get; set; }

    /// <summary>Which To Do list to use; null = the account's default Tasks list.</summary>
    public string? ListId { get; set; }

    public DateTime LinkedUtc { get; set; }
}
