namespace HomeHub.Api.Controllers;

using System.Collections.Concurrent;
using System.Linq;
using HomeHub.Api.Data;
using HomeHub.Api.Profiles;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// Household profile CRUD plus PIN set/clear/verify. PIN verification is lockout-friendly:
/// repeated failures on one profile trigger a short cooldown so the deco keypad can't be
/// brute-forced. Hashes are never returned to the client (see <see cref="ProfileDto"/>).
/// </summary>
[ApiController]
[Route("api/[controller]")]
public class ProfilesController : ControllerBase
{
    private const int PinLength = 4;
    private const int MaxAttempts = 5;
    private static readonly TimeSpan LockoutWindow = TimeSpan.FromSeconds(30);

    // Per-profile failed-attempt tracking. In-memory is sufficient: a single panel process,
    // and a lockout only needs to survive across the seconds of an attack, not a restart.
    private static readonly ConcurrentDictionary<int, (int Failures, DateTime? LockedUntil)> Attempts = new();

    private readonly HomeHubDbContext _db;

    public ProfilesController(HomeHubDbContext db) => _db = db;

    [HttpGet]
    public async Task<IReadOnlyList<ProfileDto>> List() =>
        await _db.Profiles
            .OrderBy(p => p.DisplayOrder)
            .Select(p => ProfileDto.From(p))
            .ToListAsync();

    [HttpPost]
    public async Task<ActionResult<ProfileDto>> Create(CreateProfileRequest req)
    {
        var name = req.Name?.Trim();
        if (string.IsNullOrEmpty(name)) return BadRequest("Name is required.");

        var nextOrder = await _db.Profiles.AnyAsync()
            ? await _db.Profiles.MaxAsync(p => p.DisplayOrder) + 1
            : 0;

        var profile = new Profile
        {
            Name = name,
            Initial = NormalizeInitial(req.Initial, name),
            DisplayOrder = nextOrder,
            StayLoggedIn = true,
        };
        _db.Profiles.Add(profile);
        await _db.SaveChangesAsync();

        return CreatedAtAction(nameof(List), new { id = profile.Id }, ProfileDto.From(profile));
    }

    [HttpPut("{id:int}")]
    public async Task<ActionResult<ProfileDto>> Update(int id, UpdateProfileRequest req)
    {
        var profile = await _db.Profiles.FindAsync(id);
        if (profile is null) return NotFound();

        var name = req.Name?.Trim();
        if (string.IsNullOrEmpty(name)) return BadRequest("Name is required.");

        profile.Name = name;
        profile.Initial = NormalizeInitial(req.Initial, name);
        profile.RequirePinWhenIdle = req.RequirePinWhenIdle;
        profile.StayLoggedIn = req.StayLoggedIn;
        profile.DisplayOrder = req.DisplayOrder;

        await _db.SaveChangesAsync();
        return ProfileDto.From(profile);
    }

    [HttpDelete("{id:int}")]
    public async Task<IActionResult> Delete(int id)
    {
        var profile = await _db.Profiles.FindAsync(id);
        if (profile is null) return NotFound();

        _db.Profiles.Remove(profile);
        await _db.SaveChangesAsync();
        Attempts.TryRemove(id, out _);
        return NoContent();
    }

    [HttpPut("{id:int}/pin")]
    public async Task<IActionResult> SetPin(int id, SetPinRequest req)
    {
        if (!IsValidPin(req.Pin)) return BadRequest($"PIN must be {PinLength} digits.");

        var profile = await _db.Profiles.FindAsync(id);
        if (profile is null) return NotFound();

        profile.PinHash = PinHasher.Hash(req.Pin);
        // Setting a PIN implies the profile wants to be lockable when idle.
        profile.RequirePinWhenIdle = true;
        profile.StayLoggedIn = false;
        await _db.SaveChangesAsync();
        Attempts.TryRemove(id, out _);
        return NoContent();
    }

    [HttpDelete("{id:int}/pin")]
    public async Task<IActionResult> ClearPin(int id)
    {
        var profile = await _db.Profiles.FindAsync(id);
        if (profile is null) return NotFound();

        profile.PinHash = null;
        profile.RequirePinWhenIdle = false;
        profile.StayLoggedIn = true;
        await _db.SaveChangesAsync();
        Attempts.TryRemove(id, out _);
        return NoContent();
    }

    [HttpPost("{id:int}/verify-pin")]
    public async Task<ActionResult<VerifyPinResult>> VerifyPin(int id, VerifyPinRequest req)
    {
        var profile = await _db.Profiles.FindAsync(id);
        if (profile is null) return NotFound();

        var state = Attempts.GetValueOrDefault(id);
        if (state.LockedUntil is { } until && until > DateTime.UtcNow)
        {
            var remaining = (int)Math.Ceiling((until - DateTime.UtcNow).TotalSeconds);
            return new VerifyPinResult(false, remaining);
        }

        if (PinHasher.Verify(req.Pin, profile.PinHash))
        {
            Attempts.TryRemove(id, out _);
            return new VerifyPinResult(true);
        }

        // Record the failure; lock the profile out once the attempt ceiling is hit.
        var failures = state.Failures + 1;
        if (failures >= MaxAttempts)
        {
            Attempts[id] = (0, DateTime.UtcNow.Add(LockoutWindow));
            return new VerifyPinResult(false, (int)LockoutWindow.TotalSeconds);
        }

        Attempts[id] = (failures, null);
        return new VerifyPinResult(false);
    }

    private static bool IsValidPin(string? pin) =>
        pin is { Length: PinLength } && pin.All(char.IsDigit);

    /// <summary>Uppercase 1–2 char monogram; falls back to the first letter of the name.</summary>
    private static string NormalizeInitial(string? initial, string name)
    {
        var source = string.IsNullOrWhiteSpace(initial) ? name : initial.Trim();
        source = source.ToUpperInvariant();
        return source.Length > 2 ? source[..2] : source;
    }
}
