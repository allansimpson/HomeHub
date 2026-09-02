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

---

## Claude's remediation — 2026-09-02, commit `3f164ae`

**Status:** all five implemented, with regressions verified red-capable against the reverted fix.
**Geist's review is not marked complete and is not claimed.** The browser-evidence gap is unchanged.

All five were verified against the code before any edit; none was a misreading. Four of them are the
same fault in four places, so the fix is the class rather than the instances.

### The class

Every outbound destination in this app was an unvalidated string, and every client followed
redirects. Cloud STT, "local" STT, Google's token/calendar/authorize endpoints, Microsoft's
token/Graph/authorize endpoints, and each Hermes gateway — all took whatever configuration said and
posted household audio, calendar and task content, refresh tokens, client secrets and agent bearers
to it. Fixing `Ai:OpenAiBaseUrl` on its own last round is what left the other four, and left even
that one escapable by a redirect.

`Net/EgressGuard.cs` is one `EgressRule` per destination class, checked twice:

- **Shape**, at startup and again where a request is built: absolute URI; `https` (or `http` for a
  destination on this house's own network); no userinfo; no query or fragment; exact host allowlist;
  and a literal address on the wrong side of the house/internet line refused outright.
- **Addresses**, in a `ConnectCallback` that resolves once and dials the `IPAddress` values it
  screened rather than the name. This is the half a shape check cannot do, and the reasoning is
  `Meals/RecipeFetcher`'s, which already had it for the inward direction. `AllowAutoRedirect = false`
  on the same handler.

A hostname passes the shape stage and is settled at dial time. That split is deliberate: resolving a
name at startup would be a check the connection is free to disagree with, which is the rebinding
window. It is stated in the code and tested in both halves.

| Finding | Fix | Regressions |
|---|---|---|
| RR-05 A/B/C | `queueStore.ts` — `sweepLegacyPlaintext` is owner-blind, exported, run at boot before any unlock, reads back what it wrote and removes the whole key if the record survives; `commitLegacyMigration` verifies retirement the same way | `queueStore.test.ts` → *the boot sweep* (6) plus 2 rewritten in *a session that holds no key* |
| Cloud STT redirects | `CloudSpeechEndpoint.Rule`, guarded handler in `Program.cs` | `EgressGuardTests.cs` → redirect group (2) |
| "Local" STT destination | `VoiceOptions.SttOptions` (`LocalAllowedHosts`, `LocalRule`, `LocalConfigured`), `VoiceOptionsValidator`, `LocalWhisperSpeechToText`, guarded handler | `EgressGuardTests.cs` → local-reach group (5) |
| Google / Microsoft endpoints | `GoogleCalendarOptions`, `MicrosoftTodoOptions` (`AllowedHosts`, `Rule`, `Destinations`, `RefuseDestinations`, `IsAppRegistered`), `Net/ProviderDestinationValidator.cs`, guarded handlers incl. the grocery mirror | `EgressGuardTests.cs` → provider group (4) |
| Hermes gateway origins | `HermesOptionsValidator.GatewayRule` + validation, recheck in `HermesClientFactory.Create`, guarded handler | `EgressGuardTests.cs` → Hermes group (5) |

### Red-capable verification

Run against the reverted fix in this checkout, restoring immediately afterwards:

- RR-05 A/B: 4 of 36 failed (`sweeps another profile's private plaintext too…`, `needs no profile and
  no key…`, `removes the whole key rather than reporting a sweep that did not happen`, `says so when
  the device will not let go of it at all`).
- RR-05 C: `catches a source that outlived a successful seal` failed with the retirement verification
  removed. **Worth recording: the first version of this test passed against the unfixed code.** The
  legacy value happened to be emptied by `removeItem`, which the stub had not intercepted, so it was
  proving nothing. It now leaves another profile's ordinary write in the store so retirement is a
  rewrite rather than a removal, which is the case that can half-succeed.
- The four egress groups are new surface with no prior implementation to revert against; each asserts
  a refusal that the previous code could not make at all (there was no policy), and the redirect
  group additionally pins `AllowAutoRedirect == false` on the production handler.

### Decisions worth reviewing rather than assuming

**Reach, not an allowlist, for the two local destinations.** Hermes gateways and the local STT sidecar
take `EgressReach.Local` with an empty allowlist — anything on loopback or an RFC1918/CGNAT/link-local
/ULA address is accepted. The alternative, exact origins, is stronger and was rejected because a
household's sidecar address is theirs to choose and a wrong guess here bricks voice or the assistant
with no obvious cause. If Geist wants exact origins for Hermes specifically, that is a small change to
`GatewayRule` and I would rather be told than guess.

**`localhost` is accepted for local reach and is resolved, not special-cased.** It passes the shape
stage as a hostname and is screened at dial time like any other name, so a `/etc/hosts` remapping to a
public address is refused at the connection.

**A "local" endpoint outside the house is permitted only with `CloudAudioEgressAcknowledged`.** Naming
a host in `Voice:Stt:LocalAllowedHosts` flips its rule to `Internet` and requires the same consent as
cloud, because that is what it is. Without that, the acknowledgement could be walked around by moving
the destination rather than changing the routing.

**Provider destination failures fail closed as well as loud.** `IsConfigured` now includes
`RefuseDestinations() is null`, so in Development — where startup validation is lenient — a bad
destination deactivates the provider and the panel falls back to its local calendar or task store,
rather than posting a refresh token to it. `IsAppRegistered` was split out so the startup validator
stays quiet about a provider nobody has set up.

**RR-05's "whole key goes" is a real data loss.** When a rewrite will not take, the entire legacy
queue key is removed, including any ordinary unsent writes sharing it — another profile's included.
The trade is stated in the code: an unsent grocery item can be tapped again and a legible care record
cannot be un-read. Flagged rather than assumed acceptable.

### New production prerequisites

Two more configuration surfaces a deployment can now fail startup on, joining HH-07, HH-08 and RR-04:

- **Hermes gateway origins** must be loopback or on the house's own network. Production runs Hermes
  on the same host, so this should be a no-op — worth confirming against the real `Hermes:Agents:*:BaseUrl`
  values before installing new bytes.
- **`Voice:Stt:LocalEndpoint`**, if set, must be on this machine or this house's network. Geist's probe
  reported `localStt=false` in production, so likely also a no-op; likely, not verified.

Google and Microsoft default to their own hosts, so an ordinary deployment needs no new value there.

### Full gate

```text
./scripts/check.sh all
  ok  typecheck      6s
  ok  lint           1s
  ok  tests          4s   Test Files  54 passed (54)
  ok  backend-tests 49s   Failed: 0, Passed: 1299, Skipped: 0, Total: 1299
```

Client test files 54 (1,024 individual tests, up from 1,009); backend tests 1,239 → 1,299. Neither
baseline dropped.

### Still outstanding

Browser/manual evidence remains unproduced, unchanged and for the same reason: every validation needs
a sign-in, which needs a database, and this checkout has no `ConnectionStrings:HomeHub` and no dev
credentials. Geist's plan to run the validations against TEST's database-backed deployment is what
closes it.

Geist marks the review, not this record.

---

## Claude's second remediation — 2026-09-02, commit `55bb195`

Answering the three blockers raised while review of `3f7dffc` was underway. **Geist's review is not
marked complete and is not claimed.**

All three confirmed against the code. **Finding 3 contradicts my previous commit message**, which
said every outbound destination now used one rule. It did not — nine clients were still on default
handlers — and the overclaim is mine, made after `INCIDENTS.md` had already recorded the same
class-versus-instance failure twice. What was missing was a check that the claim was true; there is
one now, and it found the last two gaps while I was writing it.

### 1. RR-05 fail-open — closed

Two distinct failures, both real:

- `sweepLegacyPlaintext` read through `readJson`, which answers `[]` for a store that throws on
  `getItem`, a value that is not JSON, and a value that is JSON but not an array. It took that empty
  list as proof there was nothing to sweep. It now reads raw and distinguishes the cases: unreadable
  returns `false`; unclassifiable (malformed JSON, non-array, a malformed entry among good ones)
  removes the key outright, on the same confidentiality-over-availability reasoning as the refused
  rewrite — what cannot be examined cannot be vouched for. Removal is confirmed by reading back, and
  a removal that cannot be confirmed returns `false`.
- The boot caller ignored the result. It now records it, and **a device that cannot delete plaintext
  gets no durable private storage for the session**: `durableKeyFor` returns null, both stores open
  memory-only, and `storageUntrusted` is surfaced on the session so the household is told rather than
  silently losing offline durability. Handing more private data to seal to the storage layer that
  just failed to delete would be trusting an encryption promise from the thing that broke.

Four new tests, each verified red-capable against the previous implementation.

### 2. Account-link exchange — closed

`AccountLinkController.ExchangeAsync` posts the client secret, authorization code and PKCE verifier
— the whole of what it takes to mint tokens for a member's account — and did so on the unnamed
default client. It now validates the token URL against the provider's rule and uses a named guarded
client (`GuardedClients.Google` / `GuardedClients.Microsoft`).

**The unnamed default is no longer registered.** `AddHttpClient()` registers the factory *and* a
default client configured with nothing, which is what made the hole reachable. The factory is now
registered under a name whose handler refuses every connection, so a caller reaching for the default
fails loudly instead of working unguarded.

### 3. The class — closed, and now checked

Guarded in this commit: SensorPush, Home Assistant, the isolated image extractor, Chatterbox, the
vendor vision path, weather, product lookup, and both OAuth token exchanges. With the previous
round's five, every `AddHttpClient` registration in `Program.cs` now configures a guarded primary
handler.

`EgressGuardTests.Every_outbound_client_registration_is_guarded` asserts that as a property: any
registration that configures no primary handler fails the test and is named in the message. That is
the difference between fixing the instances and closing the class, and it is what the previous two
rounds lacked.

### Both trade-offs applied as decided

**Hermes — exact origins.** `EgressReach.Loopback` is the default, so the LAN no longer qualifies by
having an RFC1918 address. `Hermes:AllowedGatewayOrigins` takes exact origins — scheme, host *and*
port — and when non-empty it is the whole authorisation: reach is not consulted, and the listener on
the next port is a different listener. Rechecked in `HermesClientFactory.Create` as before.

**Local STT — a real household boundary.** `EgressReach.HouseholdLan` is now loopback, RFC1918,
link-local and IPv6 ULA. Carrier-grade NAT (100.64.0.0/10) and `0.0.0.0/8` are refused by it *and*
by `IsPubliclyRoutable`, because they are neither the household's nor the internet's — CGNAT space is
the ISP's, shared with every other subscriber behind the same equipment. "Not public" was the wrong
question and is no longer the one being asked.

### New configuration surfaces

Beyond the previous rounds' HH-07, HH-08, RR-04, Hermes origins and local STT:

- `SensorPush:AllowedHosts`, `Weather:AllowedHosts`, `OpenFoodFacts:AllowedHosts`,
  `EventCapture:AllowedHosts` — all default to the vendor's own host, so an ordinary deployment needs
  none of them.
- Home Assistant, Chatterbox and the image extractor take no new value: their rules are reach-based
  (household LAN, household LAN, loopback respectively) and the last already required loopback.

### Full gate

```text
./scripts/check.sh all
  ok  typecheck      6s
  ok  lint           0s
  ok  tests          5s   Test Files  54 passed (54)
  ok  backend-tests 42s   Failed: 0, Passed: 1307, Skipped: 0, Total: 1307
```

Client 54 files / 1,024 tests; backend 1,299 → 1,307. Neither baseline dropped.

### Still outstanding

Browser/manual evidence, unchanged and for the same reason. Also unchanged: three review workstreams
are still checking the candidate, so this record answers the three blockers raised and does not claim
the count is final.
