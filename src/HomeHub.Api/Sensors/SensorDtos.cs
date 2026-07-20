namespace HomeHub.Api.Sensors;

/// <summary>A zone plus its latest reading, for the dashboard house widget and the zone list.</summary>
public record ZoneReadingDto(
    int Id,
    string Name,
    string Category,
    string Source,
    int DisplayOrder,
    double? TempF,
    double? Humidity,
    DateTime? TimestampUtc);

/// <summary>One bar in the temperature chart (a time bucket's average).</summary>
public record TempBarDto(string Label, double? TempF);

/// <summary>One humidity meter row (period average); Current marks the row for the present period.</summary>
public record HumidityPeriodDto(string Label, double? Humidity, bool Current);

/// <summary>Everything the Sensor History screen renders for one zone over a time window.</summary>
public record ZoneHistoryDto(
    int ZoneId,
    string Name,
    string Category,
    double? CurrentTempF,
    double? CurrentHumidity,
    DateTime? CurrentTimestampUtc,
    double? TodayHighF,
    string? TodayHighAt,
    double? TodayLowF,
    string? TodayLowAt,
    IReadOnlyList<TempBarDto> TempBars,
    IReadOnlyList<HumidityPeriodDto> HumidityPeriods);
