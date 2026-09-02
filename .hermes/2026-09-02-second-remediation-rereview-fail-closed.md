# HomeHub second remediation re-review — fail-closed record

Candidate commit: `d94666a086e4351bb5727fad2044f9e00a1764df`
Application remediation commit: `a25eb83281894ca1b788ab900fa40602acae094a`
Git tree: `7d7e664addc13a0e3558e661e2288a67832667ba`
Tracked paths: 858
Source SHA-256 (sorted path + NUL + bytes, excluding `REVIEW_IDENTITY.json`): `31819e72f73d065242122e3e65404bec12f06b1a80b3835284c3f82dfb34b711`

Status: **FAIL CLOSED — 0 Critical, 5 unique High findings.** RR-01, RR-02, and RR-03 are closed; RR-05 is only partially remediated; RR-04's initial URL check is closed but redirects escape it; the exhaustive complete-source review found three additional distinct egress-boundary Highs.

## Closure findings

- **RR-01 closed:** a failed Care-vault decrypt changes the session to memory-only; the full correct-key → wrong-key mutation/flush → correct-key recovery regression passes and was red-capable against the parent.
- **RR-02 closed as originally framed:** migration is planned without side effects, the sealed destination is awaited, and a failed destination write restores in-memory state while leaving source bytes unchanged. Private-source retirement failures are captured below as residual RR-05 confidentiality failures.
- **RR-03 closed:** `endSessionAuthority` synchronously closes network/queue admission before its first await, waits for settlement, and closes private stores last. Setting the visible lock immediately is safe and preferable: epoch invalidation prevents old work from reaching callers while private screens disappear without waiting for teardown.
- **RR-04's direct initial-URL weakness is closed, but redirect handling leaves the end-to-end destination boundary open below.**

## Confirmed residual — RR-05 remains open (High)

The new sweep does not establish the promised invariant that private and unowned legacy plaintext is removed immediately even without a key.

### A. Another profile's private records remain by design

Evidence:

- `client/src/app/queueStore.ts:212-230`: `sweepPrivateLegacy` sweeps only unowned records or records whose `ownerProfileId` equals the profile passed to `openQueueStore`.
- `client/src/app/queueStore.test.ts:216-225`: the suite explicitly requires another profile's private plaintext to remain.
- A locked boot opens no profile store at all, so no sweep runs until some profile reaches `openPrivateStores`.

Trigger: a legacy queue contains Care data owned by profile 3; the panel remains locked or opens profile 2 without a key; profile 3 does not subsequently open a key-bearing session.

Consequence: profile 3's Care path, body, label, child name, feeding data, and notes remain readable in shared `localStorage` for an unbounded time across the exact lock/restart/profile-switch states RR-05 was meant to close.

Independent disposable regression:

`a no-key session sweeps private plaintext for every owner, not only itself` failed. Opening profile 2 left profile 3's plaintext `Bottle 120ml for Wren` operation intact.

### B. A failed no-key rewrite leaves even the current profile's private records intact

Evidence:

- `queueStore.ts:225-229` rewrites the shared legacy key and notice key.
- `queueStore.ts:500-504` swallows every storage write/removal failure.

Trigger: a legacy queue contains both a private Care operation and an ordinary operation, so the sweep must replace rather than remove the key; the replacement is refused (quota, disabled storage, or `SecurityError`).

Consequence: the function returns as though the privacy sweep completed while the original private plaintext remains byte-for-byte readable.

Independent disposable regression:

`a refused legacy rewrite cannot leave current-owner private plaintext behind` failed; the original Care record remained.

### C. Successful sealing can still leave the private plaintext source behind

Evidence:

- `queueStore.ts:184-193` persists and awaits the sealed destination, then calls `commitLegacyMigration`.
- `queueStore.ts:318-322` retires the legacy source.
- Retirement uses the same best-effort `write` helper at `queueStore.ts:500-504`, so failure is neither detected nor surfaced.

Trigger: the sealed destination succeeds but retiring `homehub.writequeue.v1` is refused or interrupted.

Consequence: migration returns successfully with a sealed destination while the private plaintext source remains readable. ID deduplication prevents duplicate replay but does not close the confidentiality failure.

Independent disposable regression:

`successful sealing does not report migration complete while private plaintext retirement failed` failed: the sealed blob existed and the original Care plaintext also remained.

### Required correction

Run a profile-independent privacy sweep at application upgrade/boot, before unlock is required, removing every private and unowned legacy operation regardless of owner. Preserve only sanitized generic notices. The privacy-critical source retirement must be verified rather than silently swallowed; a function must not report successful migration while private plaintext remains. Tests must cover locked boot, other-profile records, current-profile mixed private/ordinary records under rewrite refusal, and retirement failure after successful sealing.

## Additional High — cloud STT redirects escape the destination allowlist

`CloudSpeechEndpoint` correctly validates the initial URL, but `Program.cs:883` registers `OpenAISpeechToText` with the default redirect-capable `HttpClient` handler. `OpenAISpeechToText.cs:39-54` then sends multipart audio through that client. A 307/308 from an allowlisted HTTPS origin can preserve the POST and retransmit raw household audio to an unvalidated host. .NET clears the manually supplied Authorization header on automatic cross-host redirect, so bearer leakage was not established; the audio disclosure is sufficient.

Required fix: disable automatic redirects and reject 3xx, or follow redirects manually only after validating every hop under the same HTTPS and exact-host policy. Test that an allowed origin returning 307/308 to an unlisted host delivers neither audio nor credentials to the second server.

## Additional High — the "local" STT endpoint can be public or cleartext

`VoiceOptions.Stt.LocalEndpoint` is accepted when merely non-empty (`VoiceOptions.cs:111-174`); the deployment validator checks cloud preference/acknowledgement but does not constrain this endpoint (`:196-223`). `LocalWhisperSpeechToText.cs:26-38` posts raw household audio directly to it. Therefore `Prefer=local`, cloud fallback disabled, and no egress acknowledgement can still send speech to an arbitrary public or cleartext endpoint while the UI and policy call it local.

Required fix: validate the local endpoint as absolute and constrained to loopback or an explicitly defined private/LAN policy, with no userinfo/query/fragment and fail-closed redirect behavior. If non-private endpoints are supported, they must enter the same explicit egress-consent and destination-allowlist boundary as cloud STT. Validate at startup, availability, and request sink; add public-IP, hostname-resolution, HTTP, and redirect tests.

## Additional High — Google and Microsoft provider endpoints are unrestricted

`GoogleCalendarOptions.cs:14-39` accepts arbitrary `TokenUrl` and `ApiBaseUrl` while enabling the provider solely from client ID/secret presence. `GoogleCalendarProvider.cs:441-486` posts the client secret and per-profile refresh token to `TokenUrl`, then sends bearer tokens and household calendar data to `ApiBaseUrl`. `MicrosoftTodoOptions.cs:13-35` and `MicrosoftTodoProvider.cs:338-375` do the equivalent for Microsoft credentials and household task data; the grocery mirror shares the Microsoft endpoints.

Required fix: introduce provider-specific absolute-HTTPS exact-host policies for authorization, token, and API endpoints; validate hardened deployments at startup and again at request construction; disable or validate redirects; test lookalike hosts, userinfo, cleartext, custom-host acknowledgement if supported, and 307/308 hops. Avoid sending credentials or household data until every sink is permitted.

## Additional High — Hermes gateway origins are not constrained to the trusted local deployment boundary

`HermesOptions.cs:99-125` documents loopback-only gateways carrying separate `API_SERVER_KEY` credentials, but `HermesOptionsValidator` at `:150-183` accepts any absolute URL. `HermesClientFactory.cs:55-67` assigns that origin and sends the agent-specific bearer credential; HomeHub then sends household conversation content and receives tool-bearing responses through it. An accidental or malicious public/cleartext origin can therefore receive an agent credential and private household content despite the architecture's declared local-gateway boundary. Automatic redirects also remain unconstrained.

Required fix: enforce deployment-approved loopback/private Hermes origins under an explicit transport policy, preferably exact origins rather than host-only matching; validate resolved addresses to prevent public resolution/rebinding where hostnames are permitted; disable or validate every redirect; and recheck at client construction. Test startup rejection of public/cleartext nonlocal origins, acceptance of the intended loopback listeners, cross-agent key separation, redirects, and zero credential/content transmission to rejected destinations.

## Qualification evidence

The exact isolated candidate passed its existing gate under the release toolchains:

- Node `v24.13.0`
- .NET SDK `10.0.110`
- Typecheck: pass
- Lint: pass
- Client: 54/54 test files
- Backend: 1,239/1,239 tests
- npm production audit: 0 vulnerabilities
- NuGet vulnerability scan: no vulnerable packages

The three independent counterexamples above fail despite that green suite.

No TEST promotion or production mutation was performed.
