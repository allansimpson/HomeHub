namespace HomeHub.Api.Sensors;

/// <summary>Whether a zone is food-safety (fridge/freezer, tighter + more severe) or ambient.</summary>
public enum SensorCategory
{
    Ambient = 0,
    FoodSafety = 1,
}

/// <summary>Provider-agnostic zone descriptor returned by an <see cref="ISensorProvider"/>.</summary>
public record ProviderZone(string ProviderRef, string Name);

/// <summary>Provider-agnostic reading. Temperature is always Fahrenheit; humidity is percent.</summary>
public record ProviderReading(string ProviderRef, double TempF, double Humidity, DateTime TimestampUtc);
