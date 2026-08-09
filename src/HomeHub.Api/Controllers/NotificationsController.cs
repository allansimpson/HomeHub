namespace HomeHub.Api.Controllers;

using HomeHub.Api.Notifications;
using Microsoft.AspNetCore.Mvc;

/// <summary>
/// The one notification queue, behind the live cards, the drawer and the inbox.
/// </summary>
/// <remarks>
/// Distinct from <c>/api/alerts</c> on purpose. An alert is a <em>condition that is true now</em> and
/// the engine clears it when it stops being true; a notification is a <em>thing that happened</em>
/// and stays until read or until seven days pass. The two would destroy each other in one table.
/// </remarks>
[ApiController]
[Route("api/notifications")]
public class NotificationsController : ControllerBase
{
    private readonly NotificationService _notifications;

    public NotificationsController(NotificationService notifications) => _notifications = notifications;

    /// <summary>The last seven days, newest first, with the unread count and the source switches.</summary>
    [HttpGet]
    public async Task<NotificationFeedDto> Get(CancellationToken ct)
    {
        var rows = await _notifications.ListAsync(ct);
        return new NotificationFeedDto(
            rows.Select(NotificationDto.From).ToList(),
            rows.Count(n => n.ReadAtUtc is null),
            await _notifications.GetSourcesAsync(ct));
    }

    /// <summary>Mark one read. Reading is not clearing, and clearing is not undoing.</summary>
    [HttpPut("{id:int}/read")]
    public async Task<IActionResult> MarkRead(int id, CancellationToken ct) =>
        await _notifications.MarkReadAsync(id, ct) ? NoContent() : NotFound();

    /// <summary>
    /// Empty the list, optionally only one severity.
    /// </summary>
    /// <remarks>
    /// Not labelled with a count anywhere in the UI: the count depends on the active tab, and a
    /// hardcoded number contradicts what is on screen.
    /// </remarks>
    [HttpDelete]
    public async Task<IActionResult> Clear([FromQuery] string? severity, CancellationToken ct)
    {
        await _notifications.ClearAsync(severity, ct);
        return NoContent();
    }

    /// <summary>Allow or silence a source. Off means nothing new enters the store from it.</summary>
    [HttpPut("sources/{source}")]
    public async Task<IActionResult> SetSource(string source, [FromBody] SourceInput input, CancellationToken ct)
    {
        if (input is null) return BadRequest("No state provided.");
        if (!NotificationSources.All.Contains(source, StringComparer.Ordinal))
            return BadRequest($"Unknown source '{source}'. Use one of: {string.Join(", ", NotificationSources.All)}.");

        await _notifications.SetSourceAsync(source, input.Enabled, ct);
        return NoContent();
    }
}

public sealed record SourceInput(bool Enabled);

public sealed record NotificationFeedDto(
    IReadOnlyList<NotificationDto> Items,
    int Unread,
    IReadOnlyDictionary<string, bool> Sources);

public sealed record NotificationDto(
    int Id,
    string Source,
    string Label,
    string Severity,
    string Accent,
    string Headline,
    string? Meta,
    string? Route,
    DateTime AtUtc,
    bool Read)
{
    public static NotificationDto From(Notification n) => new(
        n.Id, n.Source, n.Label, n.Severity, n.Accent, n.Headline, n.Meta, n.Route, n.AtUtc, n.ReadAtUtc is not null);
}
