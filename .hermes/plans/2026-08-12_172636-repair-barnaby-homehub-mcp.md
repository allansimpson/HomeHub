# Repair Barnaby → HomeHub MCP Connection Plan

> **For Claude Code:** Execute this plan in `/srv/dev/homehub` using systematic debugging and strict TDD. Do not modify Barnaby’s SOUL.md, memory, persona editor, weather service, agent model/provider routing, or unrelated HomeHub behavior.

**Goal:** Restore Barnaby’s authenticated HomeHub MCP connection so the six allowlisted household tools are discovered and callable after gateway restart, without weakening bearer authentication or per-method authorization.

**Architecture:** Treat this as an integration-boundary failure between Hermes Agent v0.20.0’s Streamable HTTP MCP client and HomeHub’s ASP.NET MCP endpoint. First reproduce the exact startup failure with `hermes --profile barnaby mcp test homehub`, then trace the real request method, headers, status, redirect behavior, and content type. Change only the component proven responsible. Preserve HomeHub’s per-credential method allowlist and localhost-only topology.

**Tech stack:** Hermes Agent v0.20.0, Python MCP client, ASP.NET Core/.NET 10, ModelContextProtocol ASP.NET server, xUnit, systemd user gateway.

---

## Known evidence

- Barnaby gateway: `hermes-gateway-barnaby.service`, API port `8642`.
- HomeHub production: `homehub.service`, HTTP `127.0.0.1:5080`, MCP route `/mcp`.
- Exact startup symptom:

  ```text
  MCP server 'homehub' at http://127.0.0.1:5080/mcp returned Content-Type
  'text/html', not an MCP response (expected application/json or text/event-stream)
  ```

- An unauthenticated POST to production `/mcp` returns `401` with `WWW-Authenticate: Bearer`; therefore the endpoint and auth middleware are mapped.
- Existing in-process tests prove JSON-RPC `tools/list`, bearer rejection, and method scoping, but they do not prove compatibility with Hermes’s actual startup sequence.
- Barnaby’s MCP entry is configured for exactly these methods: `get_calendar`, `get_sensor_readings`, `get_climate_zones`, `set_climate_mode`, `set_climate_setpoint`, `add_todo`.
- Weather and persona-editor MCP servers are healthy and out of scope.
- Current uncommitted `Program.cs` changes concern SPA caching. Preserve them exactly; do not reset, clean, checkout, or overwrite the shared DEV tree.
- Never print, log, commit, or copy API keys. Compare secrets by SHA-256 digest only when necessary.

## Security invariants

1. `/mcp` remains unavailable unless at least one credential is configured.
2. Missing or wrong bearer tokens remain `401` before tool discovery.
3. Barnaby sees/calls only its six explicitly allowed methods.
4. Direct invocation of a method outside the allowlist remains denied.
5. HomeHub and Hermes gateways remain loopback-only.
6. No shared credential, query-string credential, anonymous fallback, wildcard method grant, or SPA exception that bypasses MCP auth.
7. Do not expose Geist or any other agent through Barnaby or alter Barnaby’s sole-assistant worldview.
8. Do not deploy to production as part of diagnosis. DEV→TEST is allowed only after tests pass; production requires separate owner approval.

---

## Task 1: Establish the exact red feedback loop

**Objective:** Reproduce the same failure through Hermes’s real MCP client before changing code or configuration.

**Read-only steps:**

1. From the host, run as the `hermes` account using the Hermes virtualenv—not system Python:

   ```bash
   sudo -iu hermes /home/hermes/.hermes/hermes-agent/venv/bin/python \
     -m hermes_cli.main --profile barnaby mcp test homehub
   ```

2. Capture status, elapsed time, and sanitized error. Do not print the configured headers or token.
3. Inspect recent Barnaby gateway logs around one test invocation:

   ```bash
   sudo -iu hermes journalctl --user -u hermes-gateway-barnaby.service \
     --since '-5 minutes' --no-pager
   ```

4. Record the exact command as the tight loop. Expected RED: connection fails specifically because the response is `text/html`.

**Stop condition:** If the real MCP test passes now, restart Barnaby once and verify startup discovery before doing anything else. Do not invent a code fix for a non-reproducing problem.

---

## Task 2: Inspect live configuration without exposing credentials

**Objective:** Determine whether the URL/header configuration and HomeHub production credential agree.

**Files/state to inspect:**

- `/home/hermes/.hermes/profiles/barnaby/config.yaml`
- `/etc/homehub/homehub.env`
- `/home/hermes/.hermes/hermes-agent/tools/mcp_tool.py` and related HTTP MCP client code
- Running unit environments for `homehub.service` and `hermes-gateway-barnaby.service`

**Steps:**

1. Inspect only the structural shape of `mcp_servers.homehub`: URL, header names, include list, timeout fields. Redact every header value.
2. Confirm URL is exactly `http://127.0.0.1:5080/mcp`, not `/`, `/mcp/`, TEST port `5180`, or the dashboard.
3. Confirm the configured header name is exactly `Authorization` and the value is structurally `Bearer <token>` with no quotes, newline, duplicate `Bearer`, or unresolved `${...}` placeholder.
4. Compute SHA-256 digests in-process for:
   - token portion of Barnaby’s configured Authorization header;
   - `Mcp__Credentials__barnaby__ApiKey` loaded by production HomeHub.

   Print only `match=true/false`; never print either digest unless needed, and never print raw values.
5. Confirm production has all six `Mcp__Credentials__barnaby__Methods__N` entries.
6. Inspect Hermes v0.20.0 source to determine:
   - whether startup validation uses GET, POST initialize, or both;
   - whether custom headers are attached to validation/preflight as well as the persistent MCP session;
   - redirect handling;
   - expected Accept header and protocol version.

**Decision:**

- If token/config drift is proven, repair configuration—not HomeHub code—and proceed to Task 6.
- If headers are omitted only by Hermes’s validation path, fix/update Hermes or its configuration; do not weaken HomeHub auth.
- If a correctly authenticated request reaches HomeHub but falls through to the SPA, continue to Tasks 3–5.

---

## Task 3: Build a sanitized wire-level request matrix

**Objective:** Identify which exact request shape returns HTML.

Create a temporary diagnostic script outside the repo, e.g. `/tmp/probe-homehub-mcp.py`. It must read the existing Barnaby Authorization header in-process and never print it.

Probe against `http://127.0.0.1:5080/mcp`:

1. `POST` MCP `initialize` with:
   - `Content-Type: application/json`
   - `Accept: application/json, text/event-stream`
   - configured Authorization header
   - Hermes’s actual protocol version and client-info shape.
2. `POST` `tools/list` in the same way, including `Mcp-Session-Id` if initialize returns one.
3. `GET` with `Accept: text/event-stream` and Authorization.
4. Repeat each without Authorization to confirm `401`.
5. Repeat with redirect following disabled.

For each request print only:

```text
method status content-type location? mcp-session-id-present? body-prefix-redacted
```

Never print response bodies containing household data; for HTML print only enough to identify the SPA shell.

**Root-cause signal:** The first authenticated request returning `text/html` identifies the exact route/method/negotiation gap. Compare this against Hermes source from Task 2.

---

## Task 4: Add the failing regression test first

**Objective:** Encode Hermes’s exact failing startup sequence before production code changes.

**Likely files:**

- Modify: `tests/HomeHub.Tests/McpServerTests.cs`
- Modify only if needed: `tests/HomeHub.Tests/McpMethodScopingTests.cs`

**Steps:**

1. Add one focused xUnit test reproducing the exact authenticated request shape found in Task 3—not a guessed approximation.
2. Assert all of:
   - response does not route to `text/html`;
   - expected MCP content type (`application/json` or `text/event-stream`);
   - correct JSON-RPC result or protocol-specific status;
   - no redirect to SPA;
   - bearer authentication remains required.
3. If the failure involves `initialize` followed by session-bearing `tools/list`, exercise the complete sequence and propagate `Mcp-Session-Id`.
4. Run only the new test:

   ```bash
   /root/.dotnet/dotnet test tests/HomeHub.Tests/HomeHub.Tests.csproj \
     --filter 'FullyQualifiedName~McpServerTests.<new_test_name>'
   ```

   Use the host’s actual .NET 10 path if different.
5. Verify RED for the observed reason: `text/html`/SPA fallback, not a test typo.

**Do not proceed if the test passes immediately.** The test does not reproduce production; return to Tasks 2–3.

---

## Task 5: Apply the minimal proven fix

**Objective:** Correct only the component responsible for the authenticated HTML response.

### Branch A — Barnaby credential/config drift

- Correct `mcp_servers.homehub.headers.Authorization` through supported Hermes configuration/MCP commands where possible.
- Preserve include-only six-method list.
- Do not commit secrets or place them in HomeHub source.
- Restart only Barnaby’s gateway and verify.

### Branch B — Hermes client header/preflight defect

- Prefer upgrading to an upstream Hermes release only if release notes/source show the exact fix and compatibility is verified.
- Otherwise patch Hermes so every HTTP MCP initialization/preflight request carries configured headers.
- Add a Hermes-side regression test proving custom headers reach both validation and persistent connection requests.
- Do not work around this by making HomeHub anonymous.

### Branch C — HomeHub route/transport/fallback defect

**Likely file:** `src/HomeHub.Api/Program.cs`

- Ensure the exact authenticated MCP request shape maps to `app.MapMcp(mcp.Route)` and cannot be claimed by `MapFallbackToFile`.
- Prefer explicit routing constraints or an MCP-path terminal fallback with a protocol-appropriate error over global SPA behavior changes.
- Preserve current SPA cache-control edits.
- Do not duplicate MCP authentication logic or weaken the existing `UseWhen` bearer boundary.

After the minimal fix, rerun the new test and verify GREEN.

---

## Task 6: Run security and regression tests

**Objective:** Prove the repair did not broaden access.

Run targeted suites:

```bash
/root/.dotnet/dotnet test tests/HomeHub.Tests/HomeHub.Tests.csproj \
  --filter 'FullyQualifiedName~McpServerTests|FullyQualifiedName~McpMethodScopingTests'
```

Then run the complete test project:

```bash
/root/.dotnet/dotnet test tests/HomeHub.Tests/HomeHub.Tests.csproj
```

Required assertions:

- no token → `401`;
- wrong token → `401`;
- Barnaby discovers six tools;
- direct out-of-scope calls are denied;
- read-only credentials cannot write;
- legacy behavior remains only where intentionally supported;
- unknown `/api/*` routes do not return the SPA;
- ordinary SPA deep links still return `index.html`;
- no secret appears in test output or logs.

Do not alter tests merely to accommodate a broader or weaker behavior.

---

## Task 7: Verify the real host integration before deployment

**Objective:** Prove the actual Barnaby client connects to the actual production HomeHub endpoint using the repaired component/config.

1. Run:

   ```bash
   sudo -iu hermes /home/hermes/.hermes/hermes-agent/venv/bin/python \
     -m hermes_cli.main --profile barnaby mcp test homehub
   ```

2. Expected: successful connection and exactly six discovered HomeHub tools.
3. Restart Barnaby gateway once.
4. Check startup logs: no `text/html` warning and HomeHub MCP discovery succeeds.
5. Run a read-only tool through a fresh isolated Barnaby diagnostic session (e.g. climate zones or sensor readings).
6. Run one reversible/low-risk authorized write only if a safe test target exists; otherwise rely on the integration tests and do not alter the house merely to prove access.
7. Confirm weather and persona-editor MCP servers still connect.
8. Delete diagnostic sessions; do not change Barnaby memory.

---

## Task 8: DEV → TEST promotion and TEST verification

**Objective:** If source code changed, validate the exact fix in TEST without touching production.

1. Preserve the shared DEV checkout; do not reset, clean, stage, commit, or overwrite concurrent work.
2. Use the established isolated HomeHub fast DEV→TEST pipeline.
3. Verify:
   - `homehub-test.service` active;
   - deep health reports database OK and zero pending migrations;
   - TEST HTTPS `5181` returns 200;
   - production remains active and healthy;
   - an authenticated MCP handshake against TEST `5180/mcp` returns MCP JSON/SSE, not HTML;
   - missing/wrong TEST bearer remains 401.
4. Do not point live Barnaby at TEST unless explicitly approved; use a temporary diagnostic client/config.

---

## Task 9: Review and production handoff

**Objective:** Leave an auditable, minimal change ready for owner approval.

1. Review the final diff for unrelated changes and secret leakage.
2. Do not discard the pre-existing SPA cache-control edits in `Program.cs`; clearly separate them from the MCP repair in the review.
3. Report:
   - confirmed root cause;
   - failing test and why it was red;
   - exact minimal fix;
   - targeted and full test results;
   - real Hermes MCP test result;
   - TEST health and MCP result;
   - remaining risks.
4. Commit only with owner approval and only the intended files.
5. Production deployment requires separate explicit owner approval and a clean qualification of the exact artifact. Do not silently rebuild DEV for production.

## Files likely to change

Only after root cause is proven:

- `tests/HomeHub.Tests/McpServerTests.cs`
- possibly `tests/HomeHub.Tests/McpMethodScopingTests.cs`
- possibly `src/HomeHub.Api/Program.cs`
- alternatively Hermes Agent MCP client/config outside this repo if the defect is on the client side

Do not change all of these by default. The investigation decides which one owns the bug.

## Acceptance criteria

The repair is complete only when:

1. `hermes --profile barnaby mcp test homehub` succeeds.
2. Barnaby gateway restart discovers HomeHub without an HTML-content warning.
3. Exactly six approved HomeHub tools are available to Barnaby.
4. Authentication and method-scoping tests remain green.
5. A new regression test would fail on the old behavior and pass on the fix.
6. Weather and persona-editor tools remain healthy.
7. No secrets are printed, committed, or copied into source.
8. No production deployment occurs without explicit approval.
