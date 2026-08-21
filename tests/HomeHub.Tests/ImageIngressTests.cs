namespace HomeHub.Tests;

using HomeHub.Api.Calendar.Capture;

public class ImageIngressTests
{
    // One opaque 1×1 PNG. The ingress boundary must decode and re-encode it rather than forwarding
    // caller-controlled bytes and metadata to an extractor.
    private const string TinyPng =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    [Fact]
    public void A_valid_png_is_canonicalized_to_jpeg()
    {
        var image = ImageIngress.Normalize(TinyPng, "image/png");

        Assert.Equal("image/jpeg", image.MediaType);
        var bytes = Convert.FromBase64String(image.Base64);
        Assert.True(bytes.Length > 4);
        Assert.Equal(0xFF, bytes[0]);
        Assert.Equal(0xD8, bytes[1]);
        Assert.NotEqual(Convert.FromBase64String(TinyPng), bytes);
    }

    [Fact]
    public void A_claimed_type_that_disagrees_with_the_bytes_is_refused()
    {
        var error = Assert.Throws<InvalidDataException>(() =>
            ImageIngress.Normalize(TinyPng, "image/jpeg"));

        Assert.Contains("media type", error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Base64_that_is_not_an_image_is_refused()
    {
        Assert.Throws<InvalidDataException>(() =>
            ImageIngress.Normalize("aGVsbG8=", "image/png"));
    }

    [Fact]
    public void An_image_header_with_an_excessive_pixel_count_is_refused_before_decode()
    {
        var bytes = Convert.FromBase64String(TinyPng);
        // PNG IHDR width and height are big-endian at offsets 16 and 20. CRC validity is irrelevant:
        // the bounded header check must reject this before asking a decoder to allocate pixels.
        WriteBigEndian(bytes, 16, 100_000);
        WriteBigEndian(bytes, 20, 100_000);

        var error = Assert.Throws<InvalidDataException>(() =>
            ImageIngress.Normalize(Convert.ToBase64String(bytes), "image/png"));

        Assert.Contains("dimensions", error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void A_decoded_payload_past_the_byte_ceiling_is_refused()
    {
        var bytes = new byte[EventCaptureLimits.MaxImageBytes + 1];
        bytes[0] = 0x89;
        bytes[1] = 0x50;
        bytes[2] = 0x4E;
        bytes[3] = 0x47;

        Assert.Throws<InvalidDataException>(() =>
            ImageIngress.Normalize(Convert.ToBase64String(bytes), "image/png"));
    }

    private static void WriteBigEndian(byte[] bytes, int offset, int value)
    {
        bytes[offset] = (byte)(value >> 24);
        bytes[offset + 1] = (byte)(value >> 16);
        bytes[offset + 2] = (byte)(value >> 8);
        bytes[offset + 3] = (byte)value;
    }
}
