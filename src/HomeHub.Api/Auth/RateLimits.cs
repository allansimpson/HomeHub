namespace HomeHub.Api.Auth;

/// <summary>
/// Names of the rate-limiting policies, so the registration and the attribute cannot drift.
/// </summary>
/// <remarks>
/// A mistyped policy name on an <c>[EnableRateLimiting]</c> attribute throws at request time rather
/// than at startup — which is a bad way to find out, on the endpoint whose whole job is to still be
/// standing when something goes wrong.
/// </remarks>
public static class RateLimits
{
    /// <summary>Sign-in: reachable without a credential, so volume is the only thing to bound.</summary>
    public const string SignIn = "sign-in";

    /// <summary>An assist turn: spends the household's inference budget.</summary>
    public const string AssistTurn = "assist-turn";
}
