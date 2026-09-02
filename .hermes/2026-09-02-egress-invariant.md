# The egress class, mechanically enforced

**Commit:** `e6bf3ba`
**Answers:** Geist's instruction to build the mechanical invariant before the next review
**Status:** built to the specified design. Ready for review as the final candidate.

Five reviews each found one instance of one class, and each round closed the instance. The design
below is Geist's; what follows is what was built and the two places reality pushed back.

## 1. Request-level guard

`Net/EgressRequestGuard.cs` — a `DelegatingHandler` that calls `EgressGuard.Refuse` on the request's
origin before anything is sent. It exists because the connect callback cannot see the scheme: a socket
is opened to an address and a port, and whether the request riding it is `http` or `https` is not a
fact available at that layer. That is exactly how Chatterbox was screened at the socket and sent
household text in the clear anyway.

**It checks the origin, not the whole URL.** A request URI legitimately carries a path and a query — a
barcode lookup, a calendar range — and `Refuse` rejects those deliberately, because in a *configured
base URL* they are how a destination is disguised. So it is handed `scheme://host:port`.

The socket handler is unchanged underneath: single-resolution dialling of the addresses it screened,
`UseProxy=false`, `AllowAutoRedirect=false`.

## 2. Centralised registration

`Net/GuardedHttpClientExtensions.cs` — `AddGuardedHttpClient` in named, typed and typed-with-interface
forms, plus `AddDenyAllDefaultHttpClient`. `Guard` is private, so there is no way to attach one half.

Every registration in `Program.cs` now goes through it. The rule is resolved per call rather than
captured, so an options reload cannot leave a stale one in a pooled handler.

## 3. Source enumeration

`Every_outbound_client_registration_goes_through_the_guarded_helper` reads every `.cs` under
`src/HomeHub.Api` and fails on any bare `AddHttpClient` that is not the helper, the deny-all default,
or a named exception. One exception: `RecipeFetcher`, which screens *outward* — a household-typed URL
must not reach the LAN — and carries its own invariant test.

It skips comment lines. Several of these files explain at length why the bare registration is the
hole and would otherwise report themselves; that is a real refinement rather than a loosening, and it
is stated in the test.

## 4. Real-DI negative sweep

`EgressBoundaryTests.No_registered_client_can_reach_a_destination_no_rule_permits`. Client names come
from the container — `IConfigureOptions<HttpClientFactoryOptions>` carries the name of every
registration — so nothing is written down. Fifteen are discovered today; the test fails if fewer than
ten are, so a broken discovery cannot make the sweep vacuous.

Each is driven at a live listener with a POST body, at `http://localhost:<port>`, which is refused for
two independent reasons and is genuinely reachable: `localhost` is a name rather than a literal
loopback address, so the transport rule refuses it, and it is on no allowlist. Assertions are zero
requests and zero bytes.

**Two places the design met reality:**

- **The app will not start with the misconfigured values**, because `ValidateOnStart` refuses them.
  That is stronger than refusing at the request and is pinned separately
  (`A_misconfigured_voice_destination_refuses_to_start`), and it is why the sweep configures
  *permitted* destinations and proves the boundary by where each client is **driven**. A permitted
  base address must not become permission to go elsewhere.
- **The first listener was `HttpListener` and the test was vacuous.** Its prefixes match on the `Host`
  header, so a probe addressed to `localhost` against a listener bound to `127.0.0.1` is rejected
  inside the framework and never reaches `GetContextAsync`. The count stayed at zero whether or not
  the guard was doing anything. I found this only by running the revert. It is now a raw socket that
  counts connections and bytes where nothing can filter them.

**Red-capable.** With `EgressRequestGuard` removed from the helper, the sweep fails and names them:
`ChatterboxTextToSpeech`, `HomeAssistantClient`, `LocalWhisperSpeechToText`, `hermes`. That is the
class this was built for, caught by enumeration rather than by memory.

## 5. Positive topology

- `A_literal_loopback_http_destination_is_delivered_where_the_rule_allows_it` — the guard is not
  merely refusing everything, which would pass every security test and ship a panel that talks to
  nothing.
- `An_approved_origin_is_delivered_and_its_neighbour_is_not` — approved origin delivers; the listener
  on the next port does not.
- `The_request_guard_refuses_a_scheme_the_socket_screen_cannot_see` — `localhost` resolves to an
  address the socket screen would happily dial, so only the request guard can refuse it.

## Gate

```text
./scripts/check.sh all
  ok  typecheck      6s
  ok  lint           1s
  ok  tests          4s   Test Files  54 passed (54)
  ok  backend-tests 52s   Failed: 0, Passed: 1336, Skipped: 0, Total: 1336
  ok  bridge-tests   3s   Ran 12 tests
```

Backend 1,330 → 1,336. No baseline dropped.

## What this does and does not cover

It covers every `HttpClient` the app registers. It does **not** cover a component that constructs an
`HttpClient` directly with `new`, or a non-HTTP egress — a raw socket, a mail client, a database
connection to somewhere unexpected. The source enumeration would not see `new HttpClient()` today
because nothing does it; if that changes, the pattern to extend is the enumeration rather than the
inventory. Saying so here rather than leaving it implied, since the failure this replaces was
precisely a boundary that was believed to be complete.
