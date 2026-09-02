# Independent production review — `ed1cca` — FAIL CLOSED

Date: 2026-09-02
Reviewer: Geist

## Candidate

- Exact commit: `ed1cca08144eb42d95facb69dfd71b85a52041e7`
- Application remediation: `6486cdac5fb2bd6e9412c20fa9043f3f466383e7`
- Git tree: `111d57a36fe3e87f1c5fea1bc5bf8dc1d6ac014e`
- Source SHA-256: `74ecf61766fc6835810112765f0affabe6821be05b79ae9f47e60110f035c04b`
- Inventory: 865 tracked entries; 834 UTF-8 text; 31 binary assets; 0 decode failures
- `origin/main` and the authoritative checkout were at the exact candidate when pinned; the worktree was clean.

## Verdict

**FAIL CLOSED — not eligible for TEST promotion or production.**

- Critical: 0
- High: 2
- Release-evidence blocker: 1

The five High findings against `c0c6234` are closed in source. The new Home Assistant and Python bridge transport policy also closes non-loopback cleartext in those two components. A complete-source review found two broader exact-origin defects outside that narrow change.

## Qualification

The exact immutable candidate independently passed:

- Typecheck
- Lint
- Client tests: 54 files
- Backend tests: 1,320 passed; 0 failed; 0 skipped
- Bridge tests: 12
- npm production audit: 0 vulnerabilities
- NuGet vulnerable-package query: none

Candidate and shared worktrees remained clean after qualification. Generated build files were confined to the disposable review checkout.

## High 1 — exact origins bypass transport policy for Hermes

`EgressGuard.Refuse` returns success as soon as a URL matches `AllowedOrigins`, before the HTTP/HTTPS policy at lines 173–181. `HermesOptionsValidator.GatewayRule` uses `EgressRule.Origins` whenever `Hermes:AllowedGatewayOrigins` is populated. `HermesClientFactory.Create` then attaches the agent bearer to the accepted base URL.

Result: a protected setting may explicitly approve `http://<non-loopback-host>:<port>`, and HomeHub will send the Hermes API key and household conversation content over unauthenticated cleartext. Existing `EgressGuardTests.A_deployment_may_approve_an_exact_origin_and_only_that_one` positively asserts this unsafe behavior.

A disposable compiled diagnostic against the exact candidate confirmed that `EgressGuard.Refuse("http://192.168.5.15:8642", EgressRule.Origins(...))` returns success.

Required remediation:

- Exact origin and authenticated transport must be separate invariants.
- Permit HTTP only when the request host is a literal loopback address.
- Require trusted HTTPS for every non-loopback Hermes origin, with no acknowledgement or allowlist bypass.
- Add caller-path regressions for the validator and `HermesClientFactory`.

## High 2 — every approved non-loopback exact origin is rejected at dial time

`EgressRule.Origins` hard-codes `EgressReach.Loopback`. The shape check accepts a matching non-loopback HTTPS origin, but `EgressGuard.CreateHandler` subsequently applies `RefuseAddress` using that loopback reach and refuses every resolved non-loopback address.

This makes the newly documented non-loopback HTTPS Home Assistant configuration unusable. It also contradicts the non-loopback Hermes override. The protected configuration can pass startup/availability checks and still fail on every real connection.

A disposable compiled diagnostic against the exact candidate confirmed both halves:

1. `EgressGuard.Refuse("https://192.168.5.15:5081", EgressRule.Origins(...))` returned success.
2. The guarded `HttpClient` refused the same destination with `not on this machine` before TLS negotiation.

Required remediation:

- Do not encode every exact-origin rule as loopback reach.
- Preserve literal-loopback enforcement for cleartext.
- For non-loopback HTTPS, match the exact scheme/host/port, dial only the screened address set, disable proxy/redirect behavior, and retain normal certificate and hostname verification.
- Add a real dial-path regression showing that an approved non-loopback HTTPS listener is reachable and the listener beside it is not.

## Release-evidence blocker — C# prior-policy RED claim is inaccurate

The remediation report says five backend regressions failed against the previous policy. Independent reproduction restored the exact `016c95b` `HomeAssistantOptions` beneath the current tests, performed `dotnet clean`, rebuilt, and ran all current `EgressGuardTests`:

- 81 total
- 1 failed: `Cleartext_to_the_name_localhost_is_not_a_loopback_exemption`
- 80 passed

The current tests never exercise the old `AcknowledgeCleartextLan=true` caller/configuration path. A broad deliberate fail-open may make five cases fail, but it is not the exact prior policy and does not prove that the removed escape hatch stays removed.

The Python result did reproduce honestly: restoring the exact prior `api.py` under all 12 current bridge tests produced 2 failures.

Required remediation:

- Add a configuration/caller-path regression proving the legacy acknowledgement key cannot enable non-loopback cleartext.
- Run it against exact `016c95b` after a clean rebuild and require failure.
- Treat a green revert and a non-compiling revert as failed evidence, never as proof.

## Closed prior findings

Independent focused review confirmed source closure of:

1. The unnamed/default `IHttpClientFactory` client is configured under `Options.DefaultName`, resolved through real DI, and driven to a refused connection.
2. `UseProxy=false` is set on the guarded, blocking, and recipe-fetcher handler families; redirects remain disabled.
3. Home Assistant itself requires exact origins and HTTPS outside literal loopback; its acknowledgement flag is removed.
4. The standalone bridge requires an exact origin, refuses redirects, uses `trust_env=False`, and requires HTTPS outside literal loopback.
5. RR-05 propagates post-seal sanitation failure, revokes both stores' durability without dropping held unsent operations, opens private storage memory-only, and renders the `storageUntrusted` warning.

## Deployment and configuration state

- `ed1cca` was not deployed.
- TEST remains on release `20260902T142524Z-d6496e6c3a98`, build `c0c6234+`, healthy with zero pending migrations.
- Production remains on build `a66e80a+`, healthy and unchanged.
- HomeHub is currently a website. There is no Raspberry Pi or deployed voice bridge; Pi certificate/configuration preflight is not a current release prerequisite.
- Home Assistant listens on the same server. Literal-loopback HTTP is valid if the protected `BaseUrl` is an actual loopback address such as `127.0.0.1`, but that protected TEST value has not yet been independently read.

## Review limitations

- Binary assets were inventoried and classified but not semantically decoded beyond their file types.
- No new candidate browser run was performed because the candidate failed source review before TEST promotion.
- The restricted deployment identity cannot read the root-protected HomeHub environment. Protected configuration preflight remains deferred until a qualifying candidate exists.
