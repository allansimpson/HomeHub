# c0c6234 review — Claude's remediation

**Commit:** `9db29e0`
**Answers:** the five blockers in Geist's `c0c6234` production review
**Status:** implemented with regressions. **Geist marks the review, not this record.**

All five confirmed against the code. **Two are faults in my own previous round**, and that is the part
of this record worth reading first.

## The two self-inflicted ones

**The deny-all invariant was false, and the test I wrote to guard it agreed with it.** I registered a
*named* client called `unconfigured` believing it left the unnamed default unregistered.
`CreateClient()` returns whatever sits under `Options.DefaultName` — the empty string — and that slot
was still the framework's: redirects on, no address screen. `Every_outbound_client_registration_is_guarded`
passed because it read registration lines, which cannot see this.

That is the same failure `INCIDENTS.md` already records twice, in a new form: last round's lesson was
"when a fix claims to close a class, write the test that asserts the class is closed", and I wrote a
test that asserted the *appearance* of the class being closed. The regression now resolves
`IHttpClientFactory` through real DI and drives a connection, and it fails against the previous
implementation. `INCIDENTS.md` carries the sharpened version: a test for an invariant must exercise
the path the caller takes, not the declaration the author wrote.

**Proxies were enabled on every confined handler**, including the one predating this work
(`RecipeFetcher`). This is the more serious of the two, because it silently voids the entire address
screen: with a proxy the connection is made to the proxy, so the addresses screened are the proxy's,
and the destination is reached by asking it to go there. `HttpClient` reads `HTTP_PROXY` from the
environment by default, so it needs no attacker — a variable left in a shell, a unit file or a
package-install script reroutes everything. I wrote the connect-callback reasoning out at length and
did not ask what else could bypass it.

## The five, and what was done

| Blocker | Fix | Regressions |
|---|---|---|
| 1. Unnamed client not deny-all | `Program.cs` configures `Options.DefaultName` with `CreateBlockingHandler`; the `GuardedClients.Unconfigured` name is gone | `The_default_client_refuses_every_connection` — resolves through real DI, red-capable against the previous attempt |
| 2. Proxies enabled | `UseProxy = false` on `EgressGuard.CreateHandler`, `CreateBlockingHandler` and `RecipeFetcher.CreateGuardedHandler` | `No_confined_handler_will_use_a_proxy`, and `Every_handler_family_refuses_redirects_and_proxies` extends the class check to handler properties |
| 3. Home Assistant cleartext LAN | `HomeAssistant:AllowedOrigins` (exact, loopback by default); non-loopback must be https — see the transport correction below; `IsConfigured` fails closed; handler uses the rule | 9 tests in `EgressGuardTests` |
| 4. Voice bridge unrestricted | `approve_origin`, `allow_redirects=False` with a 3xx raised, `trust_env=False`, `HOMEHUB_ALLOWED_ORIGINS` | `voice-bridge/tests/test_api_destination.py` — 9 tests, 2 with real listeners; 3 red-capable |
| 5. RR-05 post-seal | `commitLegacyMigration` returns its sweep result; `openQueueStore` propagates it and calls `revokeQueueDurability`; both stores demoted together; `storageUntrusted` rendered | 4 tests in `queueStore.test.ts`, 3 red-capable |

## Decisions worth reviewing rather than assuming

**Home Assistant cleartext — resolved by Geist's decision, see the correction below.** I had
implemented an explicit acknowledgement rather than a refusal and flagged it for a ruling. The ruling
was to refuse, and it is right for a reason I had not weighted properly: an acknowledgement records
that a deployment accepts a readable bearer, and does not authenticate the listener receiving it.

**`revokeQueueDurability` keeps what the store already holds.** It withdraws the right to be written
to, not the contents: reopening with no key would read an empty store back over unsent work. The blob
the migration itself sealed also stays — it is ciphertext, the disclosure is the plaintext original
the device refused to remove, and it holds the household's queued writes. What is withheld is anything
further.

**The bridge tests use `unittest`, not pytest.** The bridge's only dependency is `requests`, which it
already needs; adding pytest would put a package on the panel's Pi that nothing else uses. They are
wired into `scripts/check.sh` under `all` and a new `bridge` scope, so they run rather than existing.

## New configuration surfaces

- `HomeAssistant:AllowedOrigins` — **required** for any Home Assistant not on loopback. A deployment
  with HA on another box will refuse to configure the integration until this names its exact origin.
- `HomeAssistant:AllowedOrigins` must name an **https** origin unless Home Assistant is on a loopback address.
- `HOMEHUB_ALLOWED_ORIGINS` (voice bridge) — required for any HomeHub not on loopback. A bridge on a
  separate Pi will now fail at startup until this is set.

All three are startup failures by design, and all three are worth checking against the real
deployment before installing bytes — the Pi bridge especially, since it has no screen to report on.

## Full gate

```text
./scripts/check.sh all
  ok  typecheck      6s
  ok  lint           0s
  ok  tests          5s   Test Files  54 passed (54)
  ok  backend-tests 42s   Failed: 0, Passed: 1315, Skipped: 0, Total: 1315
  ok  bridge-tests   2s   Ran 9 tests
```

Client 54 files / 1,029 tests; backend 1,307 → 1,315; bridge 0 → 9. No baseline dropped.

## Note on the browser evidence

Geist's browser verification at 540×1169 is the first real-browser pass on any of this and closes the
gap I could not. Two of the changes in this commit are browser-visible and are **not** covered by it,
since it predates them: the `storageUntrusted` warning strip, and the memory-only demotion behind it.


---

## Transport correction — 2026-09-02, commit `6486cda`

Geist's decision: **refuse non-loopback cleartext outright, no acknowledgement escape hatch.** Applied
in full, and extended to the second boundary the review found.

The reasoning is worth restating because it is the part I got wrong. An exact origin and an
authenticated transport answer different questions — *where* the listener is, and *what* it is. I had
treated the first as most of the second and offered an acknowledgement for the gap. An acknowledgement
records consent to a risk; it does not authenticate the machine that answers at that address, so a
device taking it by DHCP lease, or claiming the name, still receives a long-lived service-call token.
Accepting a risk is not closing it, and the transport is what to correct.

| Change | Where |
|---|---|
| `AcknowledgeCleartextLan` removed | `HomeAssistantOptions` |
| Non-loopback http refused | `HomeAssistantOptions.RefuseDestination` |
| Non-loopback http refused, including an explicitly allowlisted origin | `voice-bridge/homehub_voice/api.py` — `approve_origin` |
| Test fixture moved to https | `LitterRobotProviderTests` |
| Shipped bridge default moved to `http://127.0.0.1:5220` | `config.py`, `voice-bridge/README.md` |

**Loopback is by literal address in both, which is stricter than the review asked and deliberate.**
`Uri.IsLoopback` is true for the string `localhost`, and `localhost` is a name — what it resolves to is
`/etc/hosts`, a search domain, a DHCP-supplied suffix, none of which either component controls. The
exemption being claimed is that the traffic cannot reach a wire, so it is granted to addresses that
cannot rather than to a string that usually means one. This is why the bridge's shipped default moved:
`http://localhost:5220` would now be refused.

**Red-capable verification.** 5 backend tests and 2 bridge tests fail against the previous policy.

One note on method, because it nearly cost me the evidence: my first revert of the C# side used
`if (true) return null;`, which does not compile under this project's warning settings, so the test run
used a stale binary and reported no failures at all. A revert that does not build looks exactly like a
fix that works. The second attempt used a reachable condition and produced the 5 failures above.

### Preflight, restated against this commit

- `HomeAssistant:AllowedOrigins` — the exact **https** HA origin. A non-loopback http origin now
  refuses to configure the integration, and the panel falls back to simulated climate.
- `HomeAssistant:AcknowledgeCleartextLan` — **must be absent**; the key no longer exists.
- `HOMEHUB_ALLOWED_ORIGINS` on the Pi — the exact **https** HomeHub origin.
- The Pi must trust that certificate/CA **before** the headless bridge is restarted. It has no screen,
  so a TLS failure there presents as the house going quiet.

### Gate

```text
./scripts/check.sh all
  ok  typecheck      6s
  ok  lint           0s
  ok  tests          5s   Test Files  54 passed (54)
  ok  backend-tests 49s   Failed: 0, Passed: 1320, Skipped: 0, Total: 1320
  ok  bridge-tests   2s   Ran 12 tests
```

Backend 1,315 → 1,320; bridge 9 → 12. No baseline dropped.
