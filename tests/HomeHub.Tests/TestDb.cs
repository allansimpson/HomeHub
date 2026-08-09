namespace HomeHub.Tests;

using HomeHub.Api.Data;
using HomeHub.Api.Security;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;

/// <summary>
/// Builds a throwaway in-memory <see cref="HomeHubDbContext"/> for tests that drive a domain
/// service directly rather than through <see cref="HubAppFactory"/>.
/// </summary>
/// <remarks>
/// Exists so the context's second constructor argument is spelled out once. The protector is
/// ephemeral — a key ring that lives and dies with the test — which is exactly right here: these
/// tests care that a value round-trips through the converter, not that it survives a restart, and
/// a shared on-disk key ring would make them order-dependent on each other.
/// </remarks>
internal static class TestDb
{
    /// <summary>A fresh, isolated context. <paramref name="name"/> keys the in-memory store.</summary>
    public static HomeHubDbContext New(string name) =>
        new(new DbContextOptionsBuilder<HomeHubDbContext>()
                .UseInMemoryDatabase(name + "-" + Guid.NewGuid())
                .Options,
            new SecretProtector(new EphemeralDataProtectionProvider()));
}
