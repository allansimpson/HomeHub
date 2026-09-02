# ed1cca review — Claude's remediation

**Commit:** `8ad755a`
**Answers:** the two release blockers and the evidence blocker in Geist's `ed1cca` review
**Status:** implemented. **Geist marks the review, not this record.**

Both blockers confirmed, and both are in code I wrote in the round before. The evidence criticism is
also correct and is the more useful of the three.

## 1. Approved origins bypassed transport security

`EgressGuard.Refuse` returned success the moment a URL matched `AllowedOrigins`, before the transport
was looked at. So `Hermes:AllowedGatewayOrigins = http://<lan-host>:<port>` was accepted, and
`HermesClientFactory` then attached the agent's own `API_SERVER_KEY` and sent the household's
conversations over it in the clear.

**The existing test asserted this as correct behaviour.** `A_deployment_may_approve_an_exact_origin_and_only_that_one`
used an http origin and expected no errors — the finding written down as an assertion, in a test whose
whole purpose was to pin the boundary. It is rewritten to https, and
`Approving_an_origin_does_not_buy_it_a_transport` now asserts the opposite of what it used to.

The fix is one function, `RefuseCleartext`, applied to **every** destination class: plain http only to
a literal loopback address, https everywhere else. Home Assistant's own copy of that check is deleted —
one rule in two places is how two places drift apart.

## 2. Approved non-loopback HTTPS origins could not connect

`EgressRule.Origins` hard-coded `EgressReach.Loopback`, so the shape check accepted an approved
non-loopback origin and the dial screen refused it as "not on this machine". An approved HTTPS gateway
was unreachable by construction — the configuration was accepted and could never work.

Origins now carry `EgressReach.ApprovedOrigin`, which defers entirely to the allowlist. The reasoning:
an exact origin plus its certificate is a *better* answer to "is this the right machine" than any
address range, and TLS is what refuses an impostor at that address. Everything else is retained —
exact host and port matching, single-resolution dialling, `UseProxy=false`, redirects disabled, normal
certificate and hostname verification.

An approved **http** origin is still screened to loopback, and at dial time rather than only at the
shape stage: the shape check sees `one.one.one.one` and cannot classify it; the socket's real address
is visible in the callback. `An_approved_http_origin_that_does_not_resolve_locally_is_not_dialled`
covers it, and `An_approved_non_loopback_origin_survives_the_dial_screen` covers the half that was
broken.

## 3. The RED evidence — the criticism is right

My five C# failures were a forced fail-open in `RefuseDestination`. That is mutation testing: it shows
the tests notice when the method stops working, and it is **not** evidence against the exact prior
implementation. The tests could not have been evidence against it, because they no longer compile
against a type whose property they would need to set.

The regression that does the job goes through configuration binding, which does not care whether the
property exists: `The_obsolete_cleartext_acknowledgement_no_longer_permits_anything` binds
`HomeAssistant:AcknowledgeCleartextLan=true` from an in-memory configuration — exactly what an upgraded
deployment still has in its environment file — and asserts the destination is refused anyway.

**Verified the way the review asked.** Restoring `016c95b`'s exact `HomeAssistantOptions.cs` alone was
not enough and is worth recording: the test still passed, because the *guard* had also changed and now
refuses cleartext before the acknowledgement is consulted. Restoring `016c95b`'s exact `EgressGuard.cs`
as well, then `dotnet clean` and rebuild, produces the failure. A revert has to restore every file the
behaviour depends on, not the one the finding names.

`There_is_no_acknowledgement_property_left_to_set` covers the other half — the key is gone rather than
ignored, so an upgraded deployment is not carrying a setting that reads as meaningful.

## An extension beyond the decision, flagged rather than folded in

`RefuseCleartext` applies to `EgressReach.HouseholdLan` as well, which Geist's decision did not
mention. That covers the local STT sidecar and Chatterbox: both take the household's recorded audio or
the text it is about to speak aloud, to a listener on the LAN that nothing authenticates. The
reasoning is the one from the decision — a private address says where a listener is and nothing about
what it is — and leaving the siblings while fixing the named case is the class-versus-instance failure
`INCIDENTS.md` already records three times.

**Consequence, and why I judged it acceptable:** a `Voice:Stt:LocalEndpoint` or
`Voice:Tts:Chatterbox:Endpoint` on a LAN host over http now reads as unconfigured, so the panel falls
back to browser STT and Piper rather than erroring. Production reports `localStt=false` and Piper as
the TTS primary, so this should be inert there. **If Geist wants that narrowed to Home Assistant and
the bridge only, it is a one-line change.**

## Correction accepted

HomeHub is a website; there is no Pi and no deployed voice bridge. I had been listing the Pi's
certificate trust and `HOMEHUB_ALLOWED_ORIGINS` as release prerequisites in two handoffs and in
`brain/STATE.md` — they are not, and both are corrected. The bridge source and its 12 tests stay,
because the code is in the tree and is now correct; it simply is not a deployment gate.

Home Assistant on the same server means `http://127.0.0.1:8123` is a valid protected value and needs
no certificate work.

## Gate

```text
./scripts/check.sh all
  ok  typecheck      6s
  ok  lint           1s
  ok  tests          4s   Test Files  54 passed (54)
  ok  backend-tests 53s   Failed: 0, Passed: 1328, Skipped: 0, Total: 1328
  ok  bridge-tests   2s   Ran 12 tests
```

Backend 1,320 → 1,328. No baseline dropped.

## Preflight for this candidate

- `HomeAssistant:BaseUrl` — `http://127.0.0.1:8123` is valid and needs no `AllowedOrigins`. Any other
  host must be https and named in `HomeAssistant:AllowedOrigins`.
- `HomeAssistant:AcknowledgeCleartextLan` — absent. Present-and-true is now inert, and refused anyway.
- `Hermes:Agents:*:BaseUrl` — loopback, or an exact **https** origin in `Hermes:AllowedGatewayOrigins`.
  A LAN gateway over http no longer starts.
- `Voice:Stt:LocalEndpoint` and `Voice:Tts:Chatterbox:Endpoint` — loopback, or https. Neither appears
  configured in production; both fail closed to unconfigured rather than erroring.
