namespace HomeHub.Api.Net;

using Microsoft.Extensions.Options;

/// <summary>
/// Refuses to start a deployment whose third-party provider points somewhere nobody authorised.
/// </summary>
/// <remarks>
/// <para>
/// One validator rather than one per provider, because the question is identical for all of them and
/// the failure it prevents is identical too: a client secret, a per-member refresh token, and the
/// household's calendar or task content posted to a host that was accepted because it was a string.
/// The provider itself owns which destinations it has and which hosts they may be —
/// <c>refuse</c> is that knowledge — and this owns only when to insist on it.
/// </para>
/// <para>
/// Development and the automated Test environment are exempt, as they are from every other deployment
/// safeguard, so a developer pointing at a stub is unaffected. They are not unprotected: each
/// provider's <c>IsConfigured</c> already reads false for a destination that fails the rule, so it
/// deactivates rather than posting a credential to it.
/// </para>
/// </remarks>
public sealed class ProviderDestinationValidator<TOptions>(
    bool requiresDeploymentSafeguards,
    Func<TOptions, string?> refuse) : IValidateOptions<TOptions>
    where TOptions : class
{
    public ValidateOptionsResult Validate(string? name, TOptions options)
    {
        if (!requiresDeploymentSafeguards) return ValidateOptionsResult.Success;
        return refuse(options) is { } refusal
            ? ValidateOptionsResult.Fail(refusal)
            : ValidateOptionsResult.Success;
    }
}
