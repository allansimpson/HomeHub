namespace HomeHub.Api.Calendar.Capture;

using System.Globalization;
using System.Security.Cryptography;
using Microsoft.Extensions.Options;

/// <summary>
/// The photographs engagements were read from.
/// </summary>
/// <remarks>
/// <para>
/// <b>Kept on the event, never on the turn.</b> <c>Assist/Attachments.cs</c> holds the opposite rule
/// for chat — a turn stores a name, a kind and a size, because quietly turning a household's chat
/// history into a photo store is the decision nobody makes on purpose. That rule is untouched. This
/// is a different decision, made deliberately and at a different moment: a photograph is written
/// here when somebody presses ADD TO CALENDAR, not when they attach it, and it belongs to the
/// engagement rather than to the conversation. A flyer that was never confirmed leaves nothing
/// behind.
/// </para>
/// <para>
/// <b>Only what the panel can draw.</b> HEIC is the case that matters: it bypasses the panel's
/// downscale, because no browser outside Safari can decode it, and Chromium on the Pi cannot render
/// it either. Storing those bytes would buy a broken frame on the event's detail screen, so the
/// whitelist below is the same one the recipe cache uses and anything outside it is simply not kept
/// — the screen says "read from a photo · not kept" and means it.
/// </para>
/// <para>
/// The mechanics are lifted from <c>Meals.RecipeImportService.CacheImageAsync</c>, which has already
/// been through this once: content-hash filenames, an extension from the <i>sniffed</i> bytes rather
/// than from anything a caller said, storage outside <c>wwwroot</c> (which is the SPA build output
/// and is replaced wholesale on every deploy), and a traversal guard on every path that comes back
/// out of the database.
/// </para>
/// </remarks>
public sealed class EventPhotoStore
{
    private readonly EventCaptureOptions _options;
    private readonly IHostEnvironment _environment;
    private readonly ILogger<EventPhotoStore> _logger;

    public EventPhotoStore(IOptions<EventCaptureOptions> options, IHostEnvironment environment, ILogger<EventPhotoStore> logger)
    {
        ArgumentNullException.ThrowIfNull(options);
        _options = options.Value;
        _environment = environment;
        _logger = logger;
    }

    /// <summary>
    /// Store a photograph, returning the filename to hang on the event — or null if it was not kept.
    /// </summary>
    /// <remarks>
    /// Null is an ordinary outcome, not an error: an unrenderable format, or a write that failed.
    /// Neither is worth losing the engagement over, so the caller carries on and the detail screen
    /// records that no source survived.
    /// </remarks>
    public async Task<string?> KeepAsync(string base64, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(base64)) return null;

        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(base64);
        }
        catch (FormatException)
        {
            return null;
        }
        if (bytes.Length == 0 || bytes.Length > EventCaptureLimits.MaxImageBytes) return null;

        var extension = SniffExtension(bytes);
        if (extension is null) return null;

        try
        {
            var directory = Directory();
            System.IO.Directory.CreateDirectory(directory);

            var hash = Convert.ToHexString(SHA256.HashData(bytes))[..32].ToLowerInvariant();
            var fileName = hash + extension;
            var path = Path.Combine(directory, fileName);
            // Content-addressed, so one flyer photographed twice — or backing four engagements from
            // a single reading — is written once.
            if (!File.Exists(path)) await File.WriteAllBytesAsync(path, bytes, ct);
            return fileName;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogWarning(ex, "Could not keep the photograph an engagement was read from.");
            return null;
        }
    }

    /// <summary>The absolute path of a stored photograph, or null if it is missing or not one of ours.</summary>
    /// <remarks>
    /// The name is ours, but it round-trips through the database, so it is treated as untrusted:
    /// anything carrying a separator or a parent segment is refused rather than combined into a path
    /// that could climb out of the directory.
    /// </remarks>
    public string? Resolve(string? fileName)
    {
        if (string.IsNullOrWhiteSpace(fileName)
            || fileName.Contains('/', StringComparison.Ordinal)
            || fileName.Contains('\\', StringComparison.Ordinal)
            || fileName.Contains("..", StringComparison.Ordinal))
        {
            return null;
        }
        var path = Path.Combine(Directory(), fileName);
        return File.Exists(path) ? path : null;
    }

    /// <summary>
    /// Remove a stored photograph. Best-effort, and only ever called once nothing references it.
    /// </summary>
    /// <remarks>
    /// <b>Siblings are the whole difficulty.</b> One flyer can produce four engagements, and they
    /// share a file because the name is a hash of its contents. Deleting one of those four must not
    /// take the photograph away from the other three, so the count happens before this is called —
    /// see <c>CalendarController</c>. A file that is already gone, locked or unreadable is not worth
    /// failing a delete over: the row is what the household asked to remove.
    /// </remarks>
    public void Forget(string? fileName)
    {
        var path = Resolve(fileName);
        if (path is null) return;
        try
        {
            File.Delete(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogWarning(ex, "Could not remove a kept photograph.");
        }
    }

    /// <summary>
    /// How long a photograph is safe from the sweep regardless of whether anything references it.
    /// </summary>
    /// <remarks>
    /// A file is written before the row that points at it is committed — <c>KeepAsync</c> runs, then
    /// the event is inserted — so there is a window, however short, in which a perfectly wanted
    /// photograph has no reference. An hour is enormous compared with that window and costs nothing:
    /// orphans are rare and the next sweep collects whatever this one skipped.
    /// </remarks>
    private static readonly TimeSpan SweepGrace = TimeSpan.FromHours(1);

    /// <summary>
    /// Delete kept photographs that nothing points at any more. Returns how many went.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>For the deletions nobody performed.</b> A person removing an engagement releases its
    /// photograph on the way out (<c>CalendarController</c> counts the siblings first). A *sync* does
    /// not: when a calendar is deselected, or an engagement is deleted on somebody's phone, the rows
    /// are pruned wholesale by <c>SyncProfileRangeAsync</c> and their files were simply left behind.
    /// That is a slow leak of exactly the data this feature promises to look after — photographs of
    /// the household's post, accumulating on disk with nothing on any screen referring to them.
    /// </para>
    /// <para>
    /// <b>Referenced is the whole test, and it is passed in rather than read here.</b> The store owns
    /// files and knows nothing about engagements; the caller holds the database. One flyer can back
    /// four engagements — content-addressed, so they share a file — which is why the set is of every
    /// name still referenced rather than of the rows that just went.
    /// </para>
    /// </remarks>
    public int Sweep(IReadOnlySet<string> referenced, DateTime nowUtc)
    {
        ArgumentNullException.ThrowIfNull(referenced);

        string[] files;
        try
        {
            var directory = Directory();
            if (!System.IO.Directory.Exists(directory)) return 0;
            files = System.IO.Directory.GetFiles(directory);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogWarning(ex, "Could not read the kept-photograph directory to tidy it.");
            return 0;
        }

        var removed = 0;
        foreach (var path in files)
        {
            var name = Path.GetFileName(path);
            if (referenced.Contains(name)) continue;

            try
            {
                // Young enough that its engagement may still be on its way to being committed.
                if (nowUtc - File.GetLastWriteTimeUtc(path) < SweepGrace) continue;
                File.Delete(path);
                removed++;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // Locked, or gone since the listing. Neither is worth failing a sync over — the next
                // sweep will find it again.
                _logger.LogWarning(ex, "Could not tidy away an unreferenced photograph.");
            }
        }

        if (removed > 0) _logger.LogInformation("Tidied {Count} photograph(s) no engagement points at.", removed);
        return removed;
    }

    /// <summary>The media type to serve a stored file as, or null when the name is not one of ours.</summary>
    public static string? ContentTypeFor(string fileName) =>
        Path.GetExtension(fileName).ToLowerInvariant() switch
        {
            ".jpg" => "image/jpeg",
            ".png" => "image/png",
            ".webp" => "image/webp",
            ".gif" => "image/gif",
            _ => null,
        };

    /// <summary>
    /// What these bytes actually are.
    /// </summary>
    /// <remarks>
    /// Read from the bytes rather than from the media type the panel reported, because that field is
    /// a claim by a caller and this one chooses a file extension. A device that says <c>image/jpeg</c>
    /// over a HEIC — which is exactly what happens when a file picker guesses — would otherwise
    /// produce a <c>.jpg</c> the panel cannot draw.
    /// </remarks>
    private static string? SniffExtension(byte[] bytes)
    {
        if (bytes.Length >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF) return ".jpg";
        if (bytes.Length >= 8 && bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47) return ".png";
        if (bytes.Length >= 6 && bytes[0] == 0x47 && bytes[1] == 0x49 && bytes[2] == 0x46) return ".gif";
        // WEBP: "RIFF" .... "WEBP"
        if (bytes.Length >= 12
            && bytes[0] == 0x52 && bytes[1] == 0x49 && bytes[2] == 0x46 && bytes[3] == 0x46
            && bytes[8] == 0x57 && bytes[9] == 0x45 && bytes[10] == 0x42 && bytes[11] == 0x50)
        {
            return ".webp";
        }
        return null;
    }

    private string Directory() =>
        string.IsNullOrWhiteSpace(_options.PhotoPath)
            ? Path.Combine(_environment.ContentRootPath, "event-photos")
            : _options.PhotoPath;

    /// <summary>A stored photograph's own date, formatted for the SOURCE label.</summary>
    internal static string TakenLabel(DateTime takenUtc) =>
        takenUtc.ToLocalTime().ToString("d MMM", CultureInfo.CurrentCulture).ToUpperInvariant();
}
