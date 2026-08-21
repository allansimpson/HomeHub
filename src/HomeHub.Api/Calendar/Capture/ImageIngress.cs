namespace HomeHub.Api.Calendar.Capture;

using SkiaSharp;

/// <summary>
/// The only boundary at which caller-supplied image text becomes extractor input.
/// </summary>
/// <remarks>
/// Size checks happen before decode, dimensions before pixel allocation, and the decoded pixels are
/// re-encoded into a fresh JPEG. Extractors therefore never receive caller-controlled media labels,
/// metadata, polyglot suffixes, or compressed bytes.
/// </remarks>
public static class ImageIngress
{
    public const int MaxDimension = 8_192;
    public const long MaxPixels = 40_000_000;
    private const int JpegQuality = 90;
    private static readonly int MaxBase64Chars = checked(((EventCaptureLimits.MaxImageBytes + 2) / 3) * 4);

    public static NormalizedImage Normalize(string? imageBase64, string? claimedMediaType)
    {
        if (string.IsNullOrEmpty(imageBase64))
            throw new InvalidDataException("A photograph is required.");
        if (imageBase64.Length > MaxBase64Chars || imageBase64.Any(char.IsWhiteSpace))
            throw new InvalidDataException("That picture is too large or is not canonical base64.");

        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(imageBase64);
        }
        catch (FormatException ex)
        {
            throw new InvalidDataException("The photograph is not valid base64.", ex);
        }

        if (bytes.Length == 0 || bytes.Length > EventCaptureLimits.MaxImageBytes)
            throw new InvalidDataException("That picture is too large to read.");

        var sniffed = Sniff(bytes);
        var claimed = NormalizeMediaType(claimedMediaType);
        if (claimed is not null && !string.Equals(claimed, sniffed, StringComparison.Ordinal))
            throw new InvalidDataException("The claimed image media type does not match its bytes.");

        // PNG dimensions are fixed in the first chunk. Checking them before invoking a decoder makes
        // a forged huge IHDR harmless even if a codec would otherwise attempt a large allocation.
        if (sniffed == "image/png")
            ValidateDimensions(ReadBigEndian(bytes, 16), ReadBigEndian(bytes, 20));

        using var codec = SKCodec.Create(new SKMemoryStream(bytes))
            ?? throw new InvalidDataException("The supplied bytes are not a decodable image.");
        ValidateDimensions(codec.Info.Width, codec.Info.Height);

        using var decoded = SKBitmap.Decode(bytes)
            ?? throw new InvalidDataException("The supplied bytes are not a complete decodable image.");
        ValidateDimensions(decoded.Width, decoded.Height);

        // Draw onto an opaque pixel buffer before encoding. This strips metadata and makes alpha
        // deterministic (white rather than codec/platform-dependent black) in the JPEG output.
        using var canonical = new SKBitmap(
            decoded.Width, decoded.Height, SKColorType.Rgba8888, SKAlphaType.Premul);
        using var decodedImage = SKImage.FromBitmap(decoded);
        using (var canvas = new SKCanvas(canonical))
        {
            canvas.Clear(SKColors.White);
            canvas.DrawImage(decodedImage, 0, 0, new SKSamplingOptions());
            canvas.Flush();
        }

        using var image = SKImage.FromBitmap(canonical);
        using var encoded = image.Encode(SKEncodedImageFormat.Jpeg, JpegQuality)
            ?? throw new InvalidDataException("The photograph could not be canonicalized.");
        var canonicalBytes = encoded.ToArray();
        if (canonicalBytes.Length == 0 || canonicalBytes.Length > EventCaptureLimits.MaxImageBytes)
            throw new InvalidDataException("The canonical photograph is too large to read.");

        return new NormalizedImage(Convert.ToBase64String(canonicalBytes), "image/jpeg");
    }

    private static string Sniff(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length >= 24
            && bytes[..8].SequenceEqual(new byte[] { 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a })
            && bytes.Slice(12, 4).SequenceEqual("IHDR"u8))
            return "image/png";
        if (bytes.Length >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff)
            return "image/jpeg";
        if (bytes.Length >= 12
            && bytes[..4].SequenceEqual("RIFF"u8)
            && bytes.Slice(8, 4).SequenceEqual("WEBP"u8))
            return "image/webp";
        throw new InvalidDataException("Only PNG, JPEG, and WebP photographs are accepted.");
    }

    private static string? NormalizeMediaType(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        return value.Trim().ToLowerInvariant() switch
        {
            "image/jpeg" or "image/jpg" => "image/jpeg",
            "image/png" => "image/png",
            "image/webp" => "image/webp",
            _ => throw new InvalidDataException("That image media type is not supported."),
        };
    }

    private static int ReadBigEndian(ReadOnlySpan<byte> bytes, int offset)
    {
        if (bytes.Length < offset + 4) throw new InvalidDataException("The image header is incomplete.");
        return (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    }

    private static void ValidateDimensions(int width, int height)
    {
        if (width <= 0 || height <= 0 || width > MaxDimension || height > MaxDimension
            || (long)width * height > MaxPixels)
        {
            throw new InvalidDataException(
                $"Image dimensions must be at most {MaxDimension} pixels per side and {MaxPixels:N0} pixels total.");
        }
    }
}
