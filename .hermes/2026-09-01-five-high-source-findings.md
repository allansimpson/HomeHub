# The five High source findings, enumerated

**Author: Hermes.** Recovered from the original review artifact on 2026-09-01 and committed here by
Claude, because the repository guard treats `.hermes/` as a protected instruction path and Hermes's
approval prompt timed out twice. Hermes did not bypass the protection; nothing was written by it.
The content is Hermes's, unaltered in substance.

**Why this file exists.** These five findings were cited in four places — `brain/DECISIONS.md:99`,
`brain/DECISIONS.md:106`, `brain/DEPLOYMENT.md:54` and `brain/STATE.md` — and enumerated in none.
They were carried through **three consecutive one-release production exceptions** in eleven days as
short labels, with the actionable review left uncommitted. Hermes: *"recording short labels in
transient state while failing to commit the actionable review was not an adequate handoff."*

## Provenance

| | |
|---|---|
| Reviewed release | `20210821T210436Z-5e441552ec32` |
| Synthetic candidate commit | `97cc5eb6547427db7fcb7e2bd6689db89dbc538f` |
| Source/build commit | `a66e80ac66c1704baf2a81f0b1f57e115b047642` |
| Source-tree SHA-256 | `5e441552ec32e31345e0aa2a263eeb05506e88d55bc7fc296026d183eef88b9d` |
| Original verdict | 0 Critical, **5 High**, 2 Medium |
| Recheck commit | `0a717fca501ba50c8c4588f829a26c255463484a` |
| Recheck result | **all five remain open** |

The Huckleberry deletion of 2026-08-30 closes none of them — none belonged to that code.
`ImageIngress` and the `ce9ebcd` startup hardening are real improvements and close neither H1 nor H4.

**Independently spot-checked by Claude at `0a717fc` before this was committed.** The defaults in H1,
the cookie configuration and absent revalidation in H2, the zero occurrences of SAN or `X509Chain`
in H4, and the legacy credential's scope in H5 were each confirmed in the current source. This is
not taken on trust.

---

## H1 — Untrusted images reach a tool-capable household agent

**Evidence**
- `src/HomeHub.Api/Calendar/Capture/EventCaptureOptions.cs:27-51` — `Provider` defaults to `hermes`,
  `Agent` defaults to `barnaby`.
- `src/HomeHub.Api/Calendar/Capture/HermesEventExtractor.cs:95-130` — `ReadAsync` sends
  image-controlled content to that agent.
- `src/HomeHub.Api/Calendar/Capture/HermesEventExtractor.cs:212-240` — the instruction asks *in prose*
  that image text not be obeyed and no tools be used, while acknowledging wording is not a guarantee.

**Finding.** Calendar extraction defaults to a tool-capable household agent. Prompt wording is not a
capability boundary. A malicious flyer, screenshot or supplied image can attempt indirect prompt
injection against an agent holding house capabilities. Output sanitisation and human confirmation
constrain the calendar *draft*; they do not prove the agent could not invoke an unrelated tool while
processing the image.

**Why High.** Upload requires household participation, but the attacker needs no LAN access — the
printed or digital image is the injection channel. Success reaches the configured agent's
capabilities, potentially including MCP-backed house reads and writes.

**Definition of done**
- Hardened deployments use only a separately authenticated, loopback-isolated extractor or internal
  agent profile with no tools, delegation or conversational memory.
- A tool-capable Hermes fallback is rejected under deployment safeguards.
- Startup fails when extractor isolation cannot be established.
- Tests prove `barnaby`, or any other tool-bearing profile, cannot be selected for production
  extraction.

**Status: application half REMEDIATED 2026-09-01 (`600abb5`+).** Both cited files are still
byte-identical, and deliberately so — nothing in `HermesEventExtractor` says where it may run, and
nothing should; the isolation belongs at composition. `Program.cs` already refused to start under
deployment safeguards without the isolated loopback extractor, which makes the agent branch of the
ladder unreachable in production. **That was true before this review and had no test**, which is
precisely why the finding read as open: there was nothing for a reader to notice in either cited
file. `Production_refuses_the_household_agent_as_an_image_reader` now pins it, for both an explicitly
disabled extractor and an absent one. Re-review welcome on whether the composition-level gate meets
the intent of the first three definition-of-done items.

> **This one also contradicts the repo's own decision record, and that is arguably the worse fault.**
> `brain/DECISIONS.md:93-97` (2026-08-19, *"The image extractor runs tool-less"*) states that the
> household's own agent "remains reachable by explicit config but **is not the default**". It is the
> default: `Provider = "hermes"`, `Agent = "barnaby"`, in shipped code. So the decision record has
> been asserting a safety property the build does not have — the same failure mode
> `DECISIONS.md:66-70` already records, where an implementation carried a comment asserting the
> opposite of the spec it cited. Whichever way this is remediated, that entry must stop being wrong.

---

## H2 — Admin demotion and profile deletion do not revoke authorization

**Evidence**
- `src/HomeHub.Api/Program.cs:197-229` — 400-day cookie lifetime with sliding expiration, and no
  `OnValidatePrincipal` or equivalent roster/security-version validation.
- `src/HomeHub.Api/Auth/Household.cs:68-80` — `PrincipalFor` embeds profile id, name and role in the
  cookie; its comment explicitly accepts delayed demotion.
- `src/HomeHub.Api/Controllers/ProfilesController.cs:81-123` — role and profile administration
  continue to trust those cookie claims.

**Finding.** Demoting or deleting a profile does not revoke its issued cookie. A stale administrator
principal can retain admin authority indefinitely while it remains active — including profile
deletion and role administration.

**Why High.** The attacker is a formerly authorised administrator, or anyone holding that
administrator's still-valid cookie. They retain administrator API access after the server-side record
says their authority has ended.

**Definition of done**
- Revalidate the profile against the database per request, or at a short documented interval.
- Reject cookies belonging to deleted profiles.
- Add an authentication/security version that changes on role change, PIN/security change and forced
  sign-out.
- Integration tests that mint an admin cookie, demote or delete that profile, and prove subsequent
  privileged requests fail.

**Status at `0a717fc`: OPEN.** `Household.PrincipalFor` is byte-identical. `Program.cs:196-229` still
has the 400-day sliding cookie and no revalidation; profile update/delete still does not invalidate
existing cookies.

---

## H3 — The browser lock is only a render gate for private providers

**Evidence**
- `client/src/main.tsx:69-118` — private providers mount above `App` and survive its lock rendering
  decision.
- `client/src/app/CalendarProvider.tsx:22-61` — polling starts immediately, repeats every two
  minutes, stores one unpartitioned `upcoming` array, and consults neither `locked` nor
  `activeProfileId`.
- `client/src/app/SessionProvider.tsx:255-331` — lock/session transitions do not clear or partition
  Calendar state.
- `client/src/screens/DashboardScreen.tsx:60-90` — the dashboard consumes the retained state directly.

**Finding.** The lock controls what `App` renders; private providers remain mounted and executing.
Calendar keeps polling and caching private data without binding it to a confirmed profile. Across
boot, lock, sign-out or profile replacement, requests and cached state can outlive their owning
identity — a newly unlocked profile can briefly see the previous profile's calendar until a refresh
replaces it.

**Why High.** The attacker is another household member at the shared panel, or anyone at it after a
lock or profile transition. The failure crosses the privacy boundary *between household profiles*,
and permits old-identity requests to overlap cookie replacement.

**Definition of done**
- Lock and validated session identity become execution boundaries for every private provider.
- Stop or abort polling while locked, signed out, device-only, or awaiting server confirmation.
- Before cookie replacement, cancel and await old requests, and clear or profile-partition private
  state.
- Refresh/remount only after the new identity is server-confirmed and unlocked.
- Deliberately suspended-request tests across lock, sign-out and profile switch.

**Status at `0a717fc`: OPEN.** `main.tsx` and `CalendarProvider.tsx` are byte-identical.
`SessionProvider` has stronger write-queue and care-vault transitions, but Calendar still has no
lock/profile dependency or cache partitioning, and `App.tsx:170-173` still implements the lock as a
rendering gate *below* the providers.

---

## H4 — Production TLS validation omits SAN and trust-chain verification

**Evidence**
- `src/HomeHub.Api/Program.cs:89-144` — startup checks validity dates, private key, server-auth EKU,
  digital-signature usage and non-CA status. It does not verify expected DNS/IP SANs, nor build a
  trusted chain.
- `tests/HomeHub.Tests/ProductionStartupSecurityTests.cs:27-84` — covers missing credentials,
  expired/future certificates and wrong purpose; not SAN, not chain trust.

**Finding.** Production can open HTTPS with a wrong-SAN, self-signed-leaf or otherwise untrusted
certificate that clients reject. The startup gate proves certificate *fitness* only partially, and
does not prove server *identity*.

**Why High.** A transport-boundary issue rather than a directly unauthenticated endpoint. A LAN
attacker capable of interception or redirection benefits when an accepted bad certificate trains
users to click through browser warnings; the Secure cookie and authenticated traffic then lose
meaningful server authentication.

**Definition of done**
- Define the expected production DNS/IP identities.
- Require SAN coverage before binding HTTPS.
- Build and validate `X509Chain` under the household CA trust policy.
- Reject self-signed leaves, unknown roots, invalid intermediates, missing SAN and wrong SAN.
- Startup rejection tests for each.

**Status at `0a717fc`: OPEN.** `ce9ebcd` added genuine fail-closed checks — credential presence,
dates, key availability, EKU, key usage, non-CA — and those are the same checks the original review
assessed. `Program.cs:88-137` still contains no SAN match and no `X509Chain` validation, and
`ProductionStartupSecurityTests.cs` is byte-identical and still lacks the negatives.

---

## H5 — Deprecated MCP credential remains an all-write production capability

**Evidence**
- `src/HomeHub.Api/Mcp/McpOptions.cs:33-56` — deprecated `Mcp:ApiKey` remains accepted.
- `src/HomeHub.Api/Mcp/McpAccess.cs:41-53` — `McpCallerRegistry` maps it to `McpMethods.All` and emits
  only a warning.
- `src/HomeHub.Api/Mcp/McpAccess.cs:98-118` — `McpMethods.All` includes climate writes and `add_todo`
  as well as reads.

**Finding.** The deprecated shared MCP key remains valid in hardened production and receives every
enumerated house method. A warning does not enforce least privilege.

**Why High.** Not anonymous — the attacker must hold the legacy bearer token. But any LAN host or
compromised integration holding it can invoke the entire MCP surface, including climate writes and
task creation. Compromise of one old shared credential therefore compromises every MCP capability.

**Definition of done**
- Reject a non-empty `Mcp:ApiKey` whenever deployment safeguards apply.
- Require distinct named credentials with explicit method allowlists.
- Rotate and remove any deployed legacy key.
- Hardened-startup rejection coverage, and positive/negative method-scope tests.

**Status: application half REMEDIATED 2026-09-01 (`600abb5`+); rotation still outstanding.**
`Program` now throws under deployment safeguards on a non-empty `Mcp:ApiKey`, naming
`Mcp:Credentials:<agent>` in the message. The scope mapping in `McpAccess` is left as it is: it is
still correct for development and TEST, and removing it would delete the enumerated-not-implied
behaviour that keeps a later tool from silently joining the legacy grant. Two tests — the refusal,
and that named credentials are *not* caught by it. **Hermes still owns "rotate and remove any
deployed legacy key"**; the application can refuse it, but cannot remove it from the server's
environment.

---

## On the process

Hermes's answer, recorded verbatim in substance:

> The exceptions were explicit owner-authorized, release-bounded exceptions. They were not intended
> to turn bypassing the gate into the normal route.
>
> The expectation is that these five findings are remediated before the next ordinary production
> candidate, followed by a fresh complete-source review of the exact changed candidate.
>
> **A fourth unnamed carry-forward would be process failure, not compliance with the gate.**

`brain/DEPLOYMENT.md:46` remains the standing rule: known Critical or High findings block production.
