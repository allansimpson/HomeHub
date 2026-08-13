# Handoff — Repair Barnaby → HomeHub MCP Connection

**Date:** 2026-08-12 (revision 2 — supersedes revision 1)
**Plan executed:** `.hermes/plans/2026-08-12_172636-repair-barnaby-homehub-mcp.md`
**Review answered:** `.hermes/2026-08-12_132847-repair-barnaby-homehub-mcp-review.md`
**Working tree:** `/srv/dev/homehub` (branch `fix/assist-transcript-chrome`)
**State:** two defects proven and fixed, green in DEV. **Nothing committed. Nothing deployed.**

---

## The review was right

Revision 1 claimed the repair while fixing only the POST defect. The reviewer identified the
contradiction correctly: the reported symptom is `text/html`, the wire matrix attributes `text/html`
to authenticated **GET**, and the fix and its test exercised **POST** only.

This was verified directly rather than argued. Running the revision-1 build over real Kestrel with an
SPA shell present:

```
GET  /mcp + valid bearer  →  200 text/html      ← still broken, exact production symptom
POST /mcp + valid bearer  →  200 text/event-stream
```

**The revision-1 fix would not have repaired Barnaby.** There are two independent defects on the same
route, and both had to be fixed.

---

## Root cause — two defects, one route

### Defect 1 — POST rejected before the bearer was ever read

`app.MapMcp(mcp.Route)` declared no authorization policy, so the global **fallback policy**
(`Program.cs:187-189` — `RequireAuthenticatedUser` over the Cookie and Service schemes) claimed those
endpoints. It is enforced by `app.UseAuthorization()` at `Program.cs:804`, *seventeen lines before the
bearer branch at `Program.cs:821-840` is even registered*. A correct token was rejected before
anything looked at it.

### Defect 2 — GET falls into the SPA and is answered with HTML

The transport is stateless (`Program.cs:657`, `o.Stateless = true`): there is no server-to-client
stream to hold open, so the SDK maps **no GET** at this route. An unmapped GET is then claimed by
`MapFallbackToFile` at the bottom of the file, and the agent is handed the HTML shell.

### Production wire matrix (before either fix)

| Request | Result | Why |
|---|---|---|
| `POST /mcp` + **valid** bearer | `401`, no `WWW-Authenticate` | defect 1 — fallback policy at `UseAuthorization` |
| `POST /mcp`, no bearer | `401`, no `WWW-Authenticate` | same place — the token was never the deciding factor |
| `GET /mcp`, no bearer | `401` **+ `WWW-Authenticate: Bearer`** | reaches the real bearer branch, which refuses it |
| `GET /mcp` + valid bearer | **`200 text/html`** | defect 2 — passes the bearer gate, falls into the SPA fallback |

The **absent `WWW-Authenticate` on POST** was the tell that two different rejection points were in
play: the MCP middleware always sets that header, so a 401 without it cannot have come from there.

### Why the existing tests never caught either defect

Every "authenticated" MCP test builds its client with `HubAppFactory.CreateSeededClient()`, which
performs a real `POST /api/session` sign-in and carries a household **cookie**. The cookie satisfied
the fallback policy; the bearer satisfied the MCP branch. Both suites were green on a path Hermes can
never walk — it has a token and no session, which is the entire point of issuing it one. And nothing
in either suite issued a GET.

---

## Response to the review, point by point

### 1. Identify the real Hermes request sequence

**Source not read — `/home/hermes` is mode 750 `hermes:hermes` and `sudo` requires a password in a
non-interactive session. Exact commands for the owner/Geist path are in "Still outstanding" below.**

However, the Hermes journal *is* readable from this account via `journalctl _UID=1002` (group
`systemd-journal`/`adm`), which the previous revision had not tried. That yields direct observation
rather than protocol inference:

```
12:23:57.xxxxxx  systemd  Started hermes-gateway-barnaby.service
12:23:58.156169  HomeHub  ServiceToken: "Unknown service token"      ← a bearer was presented
12:23:58.158461  HomeHub  ServiceToken: "Unknown service token"
12:23:58.158533  HomeHub  "HomeHub.Service was challenged"           ← defect 1, the POST 401
12:23:58.159211  Hermes   WARNING tools.mcp_tool: ... returned Content-Type 'text/html' ...
12:23:58.539164  Hermes   WARNING tools.mcp_tool: Failed to connect to MCP server 'homehub': ...
```

The emitting logger is **`tools.mcp_tool`**, consistent with the plan's
`/home/hermes/.hermes/hermes-agent/tools/mcp_tool.py`.

**GET is load-bearing.** The argument is not "Streamable HTTP clients usually GET" — it is that on
this host, measured directly, **no request shape other than an authenticated GET returns
`text/html`**. An unauthenticated GET returns `401` with `WWW-Authenticate: Bearer` and no body; both
POST shapes return `401` with `Content-Length: 0`. For Hermes to have observed `Content-Type:
text/html` at that URL, it must have issued a GET carrying its credential. The two HomeHub 401
challenges in the same 3ms window show POST was attempted as well, and the second Hermes warning
0.38s later ("Failed to connect") shows the content-type check aborted discovery.

So both defects were live in the same startup, and both had to be fixed. **This is empirical, not a
source citation** — closing requirement 1 properly still needs the source read.

### 2. Run the real client through the approved host path

Not run — blocked. Exact command below, unchanged from the review.

### 3. Regression test for GET

Added, RED first, per the review's conditions. `Validating_the_endpoint_with_GET_is_answered_as_MCP_not_as_the_spa`
failed with `Expected: Not "text/html" / Actual: "text/html"` — the production symptom reproduced
in-process, since the API project ships `wwwroot/index.html` and the test host therefore serves the
real shell. It asserts the response is not `text/html`, that the status is a protocol-appropriate
`405`, and that no-bearer still yields `401`. The SPA fallback was **not** globally disabled and MCP
is **not** anonymously callable.

### 4. Re-run verification

Done — results below.

---

## The fix

Two lines of code in `src/HomeHub.Api/Program.cs`, both inside the existing `if (mcp.IsConfigured)`
block, each with a comment recording the trap.

```diff
-    app.MapMcp(mcp.Route);
+    app.MapMcp(mcp.Route).AllowAnonymous();
+
+    app.MapFallback(mcp.Route, () => Results.Json(
+        new { error = "This is an MCP endpoint. Use POST for Streamable HTTP; it serves no GET stream." },
+        statusCode: StatusCodes.Status405MethodNotAllowed)).AllowAnonymous();
```

- **`.AllowAnonymous()` is anonymous to the *authorization middleware*, not to callers.** The
  `UseWhen` branch still covers every request to `mcp.Route` and either resolves a credential or ends
  the request; `McpMethodScoping` still decides per method what that credential may do. This removes
  a second, wrong lock from the same door — it does not remove the lock.
- **A fallback rather than a `MapGet`**, so a future transport that *does* serve GET wins the route
  and this quietly stops applying instead of colliding with it. Fallback endpoints only match when
  nothing else does.
- **405 is what the Streamable HTTP spec has a server without an SSE stream answer GET with**, and
  clients are required to handle it — so the agent proceeds to POST instead of concluding it found a
  website. This mirrors the existing `/api/{**rest}` fallback a few lines below, which exists for
  exactly this reason: a request shaped for a machine must not be answered with a page for a person.

No security invariant from the plan is weakened: no shared credential, no query-string credential, no
anonymous fallback, no wildcard method grant, no SPA exception.

**One deliberate scope decision:** the new fallback covers the exact MCP route only, not its subtree.
A hypothetical `GET /mcp/sse` would still receive the SPA shell. That is the same class of defect, but
nothing in the evidence shows Hermes requesting a subpath, and the review's scope guard says to add
only what the real request path requires. Flagged here for the owner to accept or extend.

---

## Verification performed

**Both tests RED before their respective fixes**, each for the production reason:

| Test | RED failure |
|---|---|
| `An_agent_holding_only_its_bearer_token_reaches_the_transport` | `Expected: OK, Actual: Unauthorized` |
| `Validating_the_endpoint_with_GET_is_answered_as_MCP_not_as_the_spa` | `Expected: Not "text/html", Actual: "text/html"` |

**Real Kestrel, fixed build, SPA shell present, bearer only and no cookie — production shape:**

```
GET  /mcp + valid bearer   →  405  application/json   (was 200 text/html)
GET  /mcp   no bearer      →  401
GET  /mcp   wrong bearer   →  401
POST /mcp + valid bearer   →  200  text/event-stream
POST /mcp   no bearer      →  401
POST /mcp   wrong bearer   →  401
tools/list                 →  ['add_todo', 'get_calendar', 'get_climate_zones',
                               'get_sensor_readings', 'set_climate_mode', 'set_climate_setpoint']
GET body                   →  {"error":"This is an MCP endpoint. Use POST for Streamable HTTP; ..."}
```

**SPA and API behaviour unchanged:**

```
GET /dashboard        →  200 text/html    (deep link still serves the shell)
GET /assist/c         →  200 text/html    (deep link still serves the shell)
GET /                 →  200 text/html
GET /api/nonexistent  →  401              (unknown API route is not the SPA)
```

**Test suites, both with the reload flag as the review requires:**

```
--filter 'FullyQualifiedName~McpServerTests|FullyQualifiedName~McpMethodScopingTests'   22/22 pass
full suite                                                                            905/905 pass
```

> Runner note: without `DOTNET_hostBuilder__reloadConfigOnChange=false` the full suite reports ~298
> failures, all `IOException: The configured user limit (128) on the number of inotify instances has
> been reached`. That is a host limit hit by 900+ test hosts, not a code failure.
> `McpServerTests.Write_tools_take_ids_not_names` also failed before any change was made and passes
> consistently under the flag — pre-existing and environment-sensitive, unrelated to this repair.

---

## Still outstanding — cannot be closed from this account

### Read the Hermes client source (review requirement 1)

```bash
sudo -iu hermes grep -rn "not an MCP response" /home/hermes/.hermes/hermes-agent/
sudo -iu hermes grep -rn "most likely points at a web page" /home/hermes/.hermes/hermes-agent/
sudo -iu hermes cat /home/hermes/.hermes/hermes-agent/tools/mcp_tool.py
```

Confirm: whether the warning is emitted for GET, POST or either; whether it occurs in a preflight
validator before the SDK session begins; whether configured headers are attached to it; and whether a
`200 text/html` GET aborts discovery before POST initialization. The evidence above says GET is
load-bearing; this confirms it from source and closes the requirement properly.

### Run the real client (review requirement 2)

```bash
sudo -iu hermes /home/hermes/.hermes/hermes-agent/venv/bin/python \
  -m hermes_cli.main --profile barnaby mcp test homehub
```

Against a **fixed TEST endpoint** first, via an isolated temporary profile or an equivalent direct
invocation — do not repoint live Barnaby's configured HomeHub URL for testing.

**Branch A is still not ruled out.** Barnaby's configured token could not be compared against
production's `Mcp__Credentials__barnaby__ApiKey` by SHA-256 digest, because the Hermes-side config is
unreadable from this account. If the client still fails against a *fixed* endpoint, the residue is
Branch A (token drift) or Branch B (Hermes omitting headers on its preflight); re-enter the plan at
Task 2 with those two branches only. Branch C is now closed.

### Then confirm

- exactly six HomeHub tools discovered;
- Barnaby gateway restart shows no HomeHub `text/html` warning;
- no/wrong bearer still 401;
- weather and persona-editor MCP servers still healthy;
- diagnostic sessions deleted, Barnaby memory untouched.

---

## Diff under review

| File | Change |
|---|---|
| `src/HomeHub.Api/Program.cs` | +2 lines of code (`.AllowAnonymous()`, MCP-route fallback), + explanatory comments |
| `tests/HomeHub.Tests/McpServerTests.cs` | +2 regression tests, +1 const, +2 usings |

- The **pre-existing SPA cache-control edits** in `Program.cs` (`UseStaticFiles` and
  `MapFallbackToFile` `OnPrepareResponse`) are untouched and unrelated. They are separate uncommitted
  work and must be preserved. They account for most of the `Program.cs` line count in `git diff
  --stat`; the MCP repair itself is two statements.
- No other file in the shared DEV tree was modified by this repair. Other dirty files in `git status`
  (`HermesClient.cs`, `ClimateBinder.cs`, `AssistController.cs`, `RecipesController.cs`,
  `MealModels.cs`, `AssistStreamEndpointTests.cs`, `ClimateLoopTests.cs`, `RecipesApiTests.cs`,
  `StubHermes.cs`, and the `client/` assets) were already dirty and belong to concurrent work.
- Both changed files were scanned against the live production credential: **no secret appears in
  either.** No secret was printed, logged, committed, or copied into source at any point.
- The DEV tree was never reset, cleaned, stashed, staged, or checked out.
- Scope guard respected: no change to Barnaby's `SOUL.md`, memory, weather MCP or persona editor; no
  change to HomeHub's agent roster or model routing; no change to credentials or authorization scope;
  nothing deployed.

---

## Acceptance criteria

| # | Criterion | Status |
|---|---|---|
| 1 | `hermes --profile barnaby mcp test homehub` succeeds | **Not verified** — blocked, needs `hermes` account + a fixed build |
| 2 | Barnaby gateway restart discovers HomeHub without an HTML warning | **Not verified** — blocked |
| 3 | Exactly six approved tools available | **Verified in DEV** over real Kestrel, bearer-only |
| 4 | Authentication and method-scoping tests green | **Verified** — 905/905 |
| 5 | New regression tests fail on old behavior, pass on the fix | **Verified** — both RED then GREEN |
| 6 | Weather and persona-editor tools remain healthy | **Not verified** — blocked, untouched by this change |
| 7 | No secrets printed, committed, or copied into source | **Verified** |
| 8 | No production deployment without explicit approval | **Held** — nothing deployed |

---

## Recommended next actions, in order

1. Owner reviews the two-statement diff.
2. Close review requirement 1 with the source-read commands above.
3. Commit only `src/HomeHub.Api/Program.cs` and `tests/HomeHub.Tests/McpServerTests.cs`, taking care
   not to sweep up the concurrent uncommitted work in the shared tree.
4. Promote DEV → TEST; verify an authenticated MCP handshake against TEST returns JSON/SSE for POST
   and 405 JSON for GET, never HTML, and that missing/wrong bearer remains 401.
5. Run the real Hermes client against TEST (review requirement 2) to close Branch A.
6. With owner approval, qualify and deploy a clean build to production, then complete the remaining
   Task 7 host verification.

---

## Out-of-scope findings — separate tickets, not for this patch

Recorded because they were observed while diagnosing; per the review's guidance they are **not**
bundled here and must not delay this repair.

1. **Production runs a stale artifact of unknown provenance.** `/opt/homehub/current` → release
   `20260809-160640`; its startup stack trace reads `C:\Code\HomeHub\src\HomeHub.Api\Program.cs`, so
   it was built from a Windows checkout, not this tree. Its DLL lacks the `legacy-shared-key` and
   `Mcp:Credentials` strings present in current source. Do not assume the running binary corresponds
   to any commit in this repository.
2. **HomeHub is not loopback-only** (plan security invariant 5). Ports `5080`, `5180` and `5181`
   listen on `*`; only the Hermes gateway (`8642`) is bound to `127.0.0.1`.
3. **Production has served without a verified schema since 2026-08-09** —
   `Database migration failed at startup; serving app without a verified schema` /
   `PendingModelChangesWarning`. This blocks the DEV→TEST health gate as the plan writes it.
4. **Likely typo in `/etc/homehub/homehub.env`** — line 1 is `SPNETCORE_ENVIRONMENT`, missing the
   leading `A`, so `ASPNETCORE_ENVIRONMENT` is unset and the host defaults to Production.
