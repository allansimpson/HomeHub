namespace HomeHub.Api.Pantry;

using System.Globalization;

/// <summary>
/// Barcode normalisation. Groceries carry <b>UPC/EAN, not QR</b> (DECISIONS PG4) — same camera,
/// different symbology — and the four in scope are UPC-A, UPC-E, EAN-8 and EAN-13.
/// </summary>
/// <remarks>
/// Everything is stored as 13 digits so the same physical pack resolves whichever symbology the
/// scanner reported. A UPC-A is an EAN-13 with a leading zero; an EAN-8 is zero-padded. UPC-E is a
/// <i>compressed</i> form whose digits are rearranged, so it has to be expanded rather than padded —
/// padding it would file one tin under two codes and the household would be asked to name it twice.
/// <para>
/// <b>Eight digits are genuinely ambiguous</b>: EAN-8 and UPC-E are both eight, and nothing in the
/// digits themselves settles it. That is why <paramref name="format"/> exists — the browser's
/// <c>BarcodeDetector</c> reports the symbology it decoded, and passing it through is the only way
/// to be right. With no format given an 8-digit code is read as EAN-8, the commoner of the two on
/// grocery packaging; a UPC-E scanned without its format simply fails to match and becomes an
/// unmatched row, which is a first-class state rather than an error.
/// </para>
/// </remarks>
public static class Barcodes
{
    /// <summary>Symbology names as the Barcode Detection API reports them.</summary>
    public const string UpcA = "upc_a";
    public const string UpcE = "upc_e";
    public const string Ean8 = "ean_8";
    public const string Ean13 = "ean_13";

    /// <summary>
    /// Normalise a scanned code to 13 digits, or null when it is not a grocery barcode.
    /// </summary>
    /// <param name="raw">The decoded digits, possibly with separators.</param>
    /// <param name="format">
    /// The symbology the scanner reported, when it reported one. Only consulted for the ambiguous
    /// 8-digit case; the other lengths are unambiguous on their own.
    /// </param>
    public static string? Normalise(string? raw, string? format = null)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;

        var digits = new string(raw.Where(char.IsDigit).ToArray());
        var symbology = format?.Trim().ToLowerInvariant();

        // An explicit UPC-E is expanded whatever its length, since a 6- or 7-digit payload is a
        // UPC-E written without its number system and/or check digit.
        if (symbology == UpcE) return ExpandUpcE(digits);

        return digits.Length switch
        {
            8 => digits.PadLeft(13, '0'),   // EAN-8, or an 8-digit code with no format to say otherwise
            12 => digits.PadLeft(13, '0'),  // UPC-A
            13 => digits,                   // EAN-13
            14 => digits[1..],              // GTIN-14 shipping case: drop the packaging indicator
            _ => null,
        };
    }

    /// <summary>
    /// Expand a UPC-E into its UPC-A form and then to 13 digits. Accepts the payload with or without
    /// its number-system prefix and check digit, supplying either when absent.
    /// </summary>
    private static string? ExpandUpcE(string digits)
    {
        if (!digits.All(char.IsDigit)) return null;

        // Normalise to the 8-digit form: number system + 6 payload + check.
        var eight = digits.Length switch
        {
            6 => "0" + digits + CheckDigitFor("0" + digits),
            7 when digits[0] is '0' or '1' => digits + CheckDigitFor(digits),
            // Seven digits not starting with a number system is a payload plus a check digit.
            7 => "0" + digits,
            8 => digits,
            _ => null,
        };
        if (eight is null) return null;

        var body = ExpandBody(eight);
        return body is null ? null : ("0" + body + eight[7]).PadLeft(13, '0');
    }

    /// <summary>
    /// The 11-digit UPC-A body (without check digit) a UPC-E expands to. The last payload digit
    /// selects one of six rearrangements — this is the published GS1 table, not a heuristic.
    /// </summary>
    private static string? ExpandBody(string eight)
    {
        var system = eight[0];
        if (system is not ('0' or '1')) return null;

        var d = eight.AsSpan(1, 6);
        return d[5] switch
        {
            '0' or '1' or '2' => $"{system}{d[0]}{d[1]}{d[5]}0000{d[2]}{d[3]}{d[4]}",
            '3' => $"{system}{d[0]}{d[1]}{d[2]}00000{d[3]}{d[4]}",
            '4' => $"{system}{d[0]}{d[1]}{d[2]}{d[3]}00000{d[4]}",
            _ => $"{system}{d[0]}{d[1]}{d[2]}{d[3]}{d[4]}0000{d[5]}",
        };
    }

    /// <summary>Standard GS1 mod-10 check digit, computed over the expanded UPC-A body.</summary>
    private static string CheckDigitFor(string sevenDigitUpcE)
    {
        var body = ExpandBody(sevenDigitUpcE + "0");
        if (body is null) return "0";

        var sum = 0;
        for (var i = 0; i < body.Length; i++)
        {
            var value = body[i] - '0';
            // Weight 3 on odd positions counting from the right of the full 12-digit code.
            sum += (body.Length - i) % 2 == 1 ? value * 3 : value;
        }
        // Invariant: this digit is concatenated onto a barcode, not shown to anyone. A locale with
        // non-ASCII digits (ar-SA, fa-IR) would otherwise format it into a character that is not a
        // barcode digit at all, and the check would fail against every scan on that machine.
        return ((10 - sum % 10) % 10).ToString(CultureInfo.InvariantCulture);
    }
}
