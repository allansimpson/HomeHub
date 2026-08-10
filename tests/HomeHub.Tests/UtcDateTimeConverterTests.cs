namespace HomeHub.Tests;

using HomeHub.Api.Climate;
using Microsoft.EntityFrameworkCore;

public sealed class UtcDateTimeConverterTests
{
    [Fact]
    public void Unspecified_values_keep_their_clock_value_and_are_marked_utc()
    {
        using var db = TestDb.New(nameof(Unspecified_values_keep_their_clock_value_and_are_marked_utc));
        var property = db.Model.FindEntityType(typeof(ClimateUnit))!
            .FindProperty(nameof(ClimateUnit.UpdatedUtc))!;
        var converter = property.GetValueConverter()!;
        var input = new DateTime(2026, 8, 10, 12, 34, 56, DateTimeKind.Unspecified);

        var converted = Assert.IsType<DateTime>(converter.ConvertToProvider(input));

        Assert.Equal(input.Ticks, converted.Ticks);
        Assert.Equal(DateTimeKind.Utc, converted.Kind);
    }
}
