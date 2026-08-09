namespace HomeHub.Api.Auth;

using HomeHub.Api.Data;
using HomeHub.Api.Profiles;
using Microsoft.AspNetCore.Authorization;
using Microsoft.EntityFrameworkCore;

/// <summary>Requires a household administrator (AUDIT A1.4).</summary>
public sealed class HouseholdAdminRequirement : IAuthorizationRequirement;

/// <summary>
/// Grants <see cref="HouseholdAdminRequirement"/> to <see cref="ProfileRole.Admin"/> — and, while
/// the household has no administrator at all, to any signed-in member.
/// </summary>
/// <remarks>
/// <para>
/// <b>The second clause is the whole reason this is a handler rather than
/// <c>RequireRole("Admin")</c>.</b> <c>Profile.Role</c> has existed since A1 and has been purely
/// decorative: every profile in every existing household is a <c>Member</c>, because nothing has
/// ever set it to anything else. Shipping a plain role check would mean that the first restart
/// after this deploy locks every household permanently out of Config — including out of the screen
/// where a role could be granted. The only ways out would be editing the database by hand or a
/// migration guessing which member ought to be in charge.
/// </para>
/// <para>
/// So: no administrators means the household has not made this decision yet, and any member may
/// make it. The instant one profile is promoted the clause stops applying — for everyone,
/// including the member who did the promoting. It is a bootstrap, not a fallback, and it closes
/// permanently the first time it is used for what it is for.
/// </para>
/// <para>
/// It is <b>not</b> an open door in the meantime: the caller still has to be a signed-in member,
/// which is exactly the boundary that did not exist before this tranche. Anonymous callers and
/// service tokens fail here regardless — a machine credential has no business editing the roster,
/// and it has no <c>ProfileId</c> to have a role with.
/// </para>
/// </remarks>
public sealed class HouseholdAdminHandler : AuthorizationHandler<HouseholdAdminRequirement>
{
    private readonly HomeHubDbContext? _db;
    private readonly ILogger<HouseholdAdminHandler> _logger;

    /// <param name="db">
    /// Nullable because the app runs without a database (the design-system shell). With no roster
    /// there is nothing to administer and nothing to protect, so the bootstrap clause applies.
    /// </param>
    public HouseholdAdminHandler(ILogger<HouseholdAdminHandler> logger, HomeHubDbContext? db = null)
    {
        _logger = logger;
        _db = db;
    }

    protected override async Task HandleRequirementAsync(
        AuthorizationHandlerContext context, HouseholdAdminRequirement requirement)
    {
        // A service token is a machine. It may read and write house data through its own scoped
        // endpoints; it may not change who lives here.
        if (context.User.IsService()) return;
        if (context.User.ProfileId() is not { } profileId) return;

        if (context.User.IsHouseholdAdmin())
        {
            context.Succeed(requirement);
            return;
        }

        if (_db is null)
        {
            context.Succeed(requirement);
            return;
        }

        if (await _db.Profiles.AnyAsync(p => p.Role == ProfileRole.Admin)) return;

        // Logged every time rather than once, because this is a household running without the
        // boundary it is entitled to, and the line is what makes that visible in the journal
        // instead of being a thing nobody knew was true.
        _logger.LogInformation(
            "Profile {ProfileId} allowed an admin action because no household administrator is set. "
            + "Promote a member in Config to close this.",
            profileId);

        context.Succeed(requirement);
    }
}
