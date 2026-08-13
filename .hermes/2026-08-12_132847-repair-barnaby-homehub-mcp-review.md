# Review Follow-up — Barnaby → HomeHub MCP Repair

**Reviewed handoff:** `.hermes/2026-08-12_132847-repair-barnaby-homehub-mcp-handoff.md`

## Decision

The POST authorization diagnosis is credible and the one-line production change is appropriately minimal:

```csharp
app.MapMcp(mcp.Route).AllowAnonymous();
```

The new bearer-only `initialize → tools/list` regression test is valuable and closes a real gap in the previous tests, whose seeded client carried a household cookie.

However, the repair is **not yet accepted as complete** because the handoff contains an unresolved contradiction:

1. The reported Hermes startup symptom is `Content-Type 'text/html', not an MCP response`.
2. The wire matrix identifies authenticated `GET /mcp → 200 text/html` as the request producing that exact symptom.
3. The fix changes authorization metadata on the mapped MCP transport, but the handoff states GET matches no MCP endpoint and still falls into `MapFallbackToFile`.
4. The fixed-build verification and new test exercise POST `initialize → tools/list` only.
5. The real `hermes --profile barnaby mcp test homehub` was not run.

Therefore the POST defect is proven fixed, but the claimed end-to-end Barnaby repair remains unproven. If Hermes v0.20.0 performs a GET validation/preflight before POST initialization, the startup failure will remain unchanged after deployment.

## Required follow-up

### 1. Identify the real Hermes request sequence

Read the installed Hermes v0.20.0 MCP client source under:

```text
/home/hermes/.hermes/hermes-agent/
```

Search for the exact warning text:

```text
returned Content-Type
not an MCP response
most likely points at a web page
```

Determine precisely:

- whether the warning is emitted for GET, POST, or either;
- whether it occurs in a preflight validator before the MCP SDK session begins;
- whether configured headers are attached;
- whether a `200 text/html` GET aborts discovery before POST initialization.

Do not infer this from protocol expectations; cite the actual source path and function.

### 2. Run the real client through the approved host path

The constrained Geist host helper now permits Barnaby gateway operations but does not expose arbitrary shell access. If your own session cannot run as `hermes`, provide the exact read-only command and the owner/Geist path will run it. The required command is:

```bash
sudo -iu hermes /home/hermes/.hermes/hermes-agent/venv/bin/python \
  -m hermes_cli.main --profile barnaby mcp test homehub
```

Run this against a fixed TEST endpoint/config before production where possible. Do not change live Barnaby’s configured HomeHub URL merely for testing; use an isolated temporary Hermes profile or a direct invocation with equivalent config.

### 3. Add a regression test for GET if GET is load-bearing

If Hermes’s source confirms an authenticated GET is part of its connection validation:

- Add a regression test reproducing the exact GET headers and expected response.
- Verify RED before any further production change.
- Ensure `/mcp` never falls into the SPA fallback for an MCP-shaped request.
- Return a protocol-appropriate response/status rather than HTML.
- Preserve the bearer `UseWhen` gate: no bearer and wrong bearer remain 401.

Do not globally disable the SPA fallback or make MCP anonymously callable.

If Hermes’s source proves GET is not load-bearing and the warning can only originate from POST, explain why the production GET matrix was a red herring and cite the exact source path.

### 4. Re-run verification

Required before acceptance:

```bash
DOTNET_hostBuilder__reloadConfigOnChange=false \
  /root/.dotnet/dotnet test tests/HomeHub.Tests/HomeHub.Tests.csproj \
  --filter 'FullyQualifiedName~McpServerTests|FullyQualifiedName~McpMethodScopingTests'
```

Then full suite with the same reload flag.

Finally prove:

- real Hermes MCP test succeeds;
- exactly six HomeHub tools are discovered;
- Barnaby gateway restart has no HomeHub `text/html` warning;
- no/wrong bearer remains 401;
- weather and persona-editor MCPs remain healthy.

## Scope guard

Do not alter:

- Barnaby’s `SOUL.md`, memory, weather MCP, or persona editor;
- HomeHub’s agent roster/model routing;
- concurrent DEV changes;
- production deployment;
- credentials or authorization scope.

Keep the existing `.AllowAnonymous()` fix and bearer-only POST regression unless new evidence disproves them. Add only what the real Hermes request path requires.

## Notes on out-of-scope findings

The stale production artifact, listen addresses, pending-model warning, and environment-variable typo may deserve separate tickets, but they should not be bundled into this MCP repair. Do not let them delay proving the specific client/server handshake or broaden this patch.
