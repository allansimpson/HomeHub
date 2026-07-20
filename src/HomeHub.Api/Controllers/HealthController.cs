namespace HomeHub.Api.Controllers;

using System.Reflection;
using Microsoft.AspNetCore.Mvc;

/// <summary>
/// Liveness endpoint. Used by the kiosk boot check and by monitoring to confirm the
/// app is up before pointing Chromium at it.
/// </summary>
[ApiController]
[Route("api/[controller]")]
public class HealthController : ControllerBase
{
    private static readonly string Version =
        Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "0.0.0";

    [HttpGet]
    public IActionResult Get() => Ok(new
    {
        status = "ok",
        service = "HomeHub.Api",
        version = Version,
    });
}
