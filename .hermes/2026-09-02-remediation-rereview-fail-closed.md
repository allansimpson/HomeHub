# HomeHub remediation re-review — fail-closed blocker record

Candidate commit: `d5769275ce84b2da7dee3bf00052352cd97bb3b6`
Application remediation commit: `2a82d53eaa1835ad0371454c021bb34bff0d31ee`
Git tree: `63545e407c55d75b2a972085725339f4bdb560d2`
Source SHA-256 (sorted path + NUL + bytes, excluding `REVIEW_IDENTITY.json`): `15bb3aeb7a9ac986b08ceca4b00043c1d500990fb595da61ec0f91fbd3a955c3`
Status: FAIL CLOSED — 0 Critical and at least 5 High findings. Promotion stops on the known Highs; the interrupted broad pass means this count is not asserted exhaustive.

Independent reconciliation confirmed that RR-01, RR-02, and RR-03 are exactly the three High findings from the dedicated client/offline review; they are not duplicate interpretations introduced during consolidation.

## RR-01 — Wrong-key Care-vault session overwrites the rightful encrypted blob (High)

Evidence:

- `client/src/screens/care/careVault.ts:129-165`: failed decryption starts an empty vault but retains the supplied `sealed` key and writable storage.
- `client/src/screens/care/careVault.ts:215-232`: the next vault mutation seals with that wrong key and replaces the same profile blob.
- `client/src/screens/care/careVault.test.ts:67-77`: the existing wrong-key test checks only that the session reads empty; unlike the queue test, it does not write afterward and prove the original blob remains intact.

Consequence: after a PIN/device-key mismatch for the same profile, a server refill, pending entry, or timer mutation can overwrite the rightful owner's encrypted offline Care state. Unsynced state and an active Care timer can be irrecoverably lost. This contradicts the handoff's claim that a failed decrypt leaves the blob available for the right key later.

Independent red-capable proof, run only in the disposable qualification snapshot:

`an unreadable care blob cannot be overwritten by the wrong key` failed because the stored ciphertext changed after opening with a wrong key and writing. The shared checkout was not modified.

Required fix: mirror the queue store's fail-closed behavior. A failed decrypt must make that Care-vault session memory-only/non-persisting while leaving the existing blob byte-identical. Add a regression that writes after wrong-key open, flushes, then reopens with the rightful key and recovers the original data.

## RR-02 — Plaintext-to-sealed queue migration deletes its source before the replacement is durable (High)

Evidence:

- `client/src/app/queueStore.ts:177-209`: `adoptLegacy` removes or rewrites plaintext source keys before the sealed replacement is written.
- `client/src/app/queueStore.ts:152-159`: `openQueueStore` calls `persistNow()` without awaiting it.
- `client/src/app/queueStore.ts:305-315`: a sealed-store write can reject, but by then the legacy source has already been removed.
- `client/src/app/queueStore.test.ts:210-282`: migration tests exercise success only; durability-failure tests start without legacy source data.

Consequence: quota exhaustion or another storage-write failure during upgrade can destroy ordinary unsent operations and the only quarantine notices for legacy private/orphaned writes. The migration is not transactional and does not meet the documented "decided once, durably" claim.

Independent red-capable proof, run only in the disposable qualification snapshot:

`migration does not delete plaintext until its sealed replacement is durable` failed: the sealed write rejected as expected, but `homehub.writequeue.v1` had already been deleted and no sealed replacement existed. The shared checkout was not modified.

Required fix: construct the migrated sealed state without mutating legacy keys; durably write and await the sealed replacement first; only then remove/rewrite the exact adopted/quarantined legacy entries. On sealed-write failure, leave legacy data byte-identical and surface the failure. Add success, quota-failure, retry, private-quarantine, orphan, and cross-profile regressions.

## RR-03 — Lock and session-loss do not synchronously close/drain authenticated transport (High)

Evidence:

- `client/src/app/SessionProvider.tsx:814-827`: `lockNow` advances only the React/session generation, closes stores, and sets state; it does not synchronously close the private-network boundary or drain operations.
- `client/src/app/SessionProvider.tsx:405-410`: authenticated transport is closed only later by the React effect responding to `locked`.
- `client/src/app/SessionProvider.tsx:423-435`: session-loss similarly closes stores and schedules locked state without first closing/draining all authenticated execution.
- `client/src/api/privateNetwork.ts:202-223`: `setPrivateNetworkConfirmed(false)` / `closeAndDrainPrivateNetwork()` is the actual admission close, abort, and settlement barrier.

Consequence: after idle lock or a detected session loss, an already-running authenticated body/stream consumer may continue until React commits and runs the effect. A private result may reach state after the user-visible transition that was supposed to end its authority.

Required fix: at transition entry, synchronously close the private-network epoch so new admissions fail and active operations are aborted; then await their drain before closing old-owner stores or completing the visible transition. Do not rely on the later `[locked]` effect. Add provider-level suspended-body and Assist-stream tests for both direct lock and session loss, asserting immediate admission refusal, no old-owner continuation, and no durability settlement after its store is closed.

## RR-04 — Cloud STT can send audio and bearer credentials to an unrestricted endpoint (High)

Evidence:

- `src/HomeHub.Api/Ai/AiOptions.cs:29-36`: `Ai:OpenAiBaseUrl` accepts an arbitrary string; cloud availability checks only key presence.
- `src/HomeHub.Api/Ai/OpenAISpeechToText.cs:28-42`: raw household audio and `Authorization: Bearer` are sent to that base URL plus `/v1/audio/transcriptions`.
- `src/HomeHub.Api/Ai/VoiceOptions.cs:196-223`: startup validates route preference and egress acknowledgement but not HTTPS or provider/destination identity.

Consequence: an acknowledged cloud configuration can transmit household audio and the cloud credential over cleartext HTTP or to a mistyped/unintended host. The acknowledgement says that audio may leave the LAN; it does not authorize an arbitrary recipient or insecure transport.

Required fix: validate an absolute HTTPS URI and fail closed on userinfo, fragments, insecure schemes, and unintended destinations. Prefer an exact provider-host allowlist; if custom compatible endpoints are a supported requirement, require an explicit exact destination allowlist/acknowledgement. Add startup-validator and request-destination tests.

## RR-05 — Private legacy queue data can remain plaintext indefinitely when no key is available (High)

Evidence:

- `client/src/app/queueStore.ts:106-122`: opening without a usable key returns before legacy migration/quarantine.
- `client/src/app/queueStore.test.ts:139-164`: the behavior is explicit: the legacy plaintext store remains intact when no key is available.
- Legacy queue bodies include Care paths, child-related labels, feed volumes, and notes.

Consequence: after upgrade, private Care records can remain readable in `localStorage` across lock, restart, and profile changes whenever a key-bearing session is not opened. This can persist indefinitely and defeats the release's at-rest guarantee.

Required fix: process sensitive legacy records fail-closed even when the profile key is unavailable. Remove or quarantine private plaintext immediately without retaining sensitive fields, preserve only a generic household-visible recovery notice, and never replay it. Preserve non-private writes until they can be adopted safely. Add restart/locked/no-key/corrupt-key migration tests and direct storage inspection.

## Qualification evidence

- Exact isolated candidate full gate under Node `v24.13.0` and .NET SDK `10.0.110`: typecheck pass, lint pass, 53/53 client test files pass, 1,210/1,210 backend tests pass.
- The initial Node v20 run exposed a five-second PBKDF2 timeout under parallel load; the failing file passed alone, and the project/deployment Node 24 toolchain passed the unchanged full suite. This was an environment mismatch, not treated as a source failure.
- Remediation-focused client tests: 7/7 files, 124/124 tests passed.
- npm production audit: 0 vulnerabilities.
- NuGet vulnerability scan: no vulnerable packages.

Passing existing tests do not close RR-01 or RR-02 because both have independently demonstrated red-capable counterexamples.

## Production prerequisite observations

- Production remained unchanged on build `a66e80a` during these probes.
- Live established SQL traffic on the production host was loopback-to-loopback on port 1433. This confirms the database is operationally local, but it does **not** prove `SqlConnectionPolicy` will classify the configured `Server=` token as loopback; a hostname resolving locally is still non-loopback to the validator. `Encrypt` and `TrustServerCertificate` also remain protected configuration values. A privileged read-only preflight is therefore still required before installing new bytes.
- Authenticated production voice capabilities reported `serverStt=false`, `localStt=false`, `cloudStt=false`, and `serverTts=false`. Production is not currently operationally relying on cloud STT fallback. Direct protected-environment key presence remains unreadable to the restricted deployment identity and must be checked before installing new bytes.

No TEST promotion or production configuration mutation was performed.

---

## Claude's remediation — 2026-09-02, commit `a25eb83`

**Status:** all five implemented, with focused regressions. **Geist's re-review is not marked
complete and is not claimed.** The browser-evidence gap recorded in the previous handoff is
unchanged and still open.

All five findings were verified against the code before any edit. None was a misreading, and RR-01
is a mistake of mine that this record should state plainly: I found that exact hazard while writing
the queue store's acceptance test, fixed it there, wrote the reasoning down in `queueStore.ts` — and
did not carry it back to `careVault.ts`, which is opened under the same key and holds the same rows.
The vault's existing wrong-key test stopped after the read, so it could not catch it. It writes now.

| Finding | Fix | Regressions |
|---|---|---|
| RR-01 | `careVault.ts` — a failed decrypt sets `openSeal = { kind: 'memory' }`, so the session is memory-only and the blob is untouched | `careVault.test.ts` → *a session holding the wrong key* (2) |
| RR-02 | `queueStore.ts` — `planLegacyMigration` (pure) → `persistNow` → `await flushQueueStore()` → `commitLegacyMigration`; rollback of `held` on failure; `byId` makes adoption idempotent | `queueStore.test.ts` → *migration is not allowed to lose the data it is migrating* (6) |
| RR-03 | `sessionAuthority.ts` (new) — synchronous close/abort, awaited drain, stores closed last; used by `lockNow`, session-loss, profile switch and device-only demotion; the `[locked]` effect is now a backstop | `sessionAuthority.test.ts` (7) |
| RR-04 | `CloudSpeechEndpoint.cs` (new), `AiOptions.cs` (+`AiOptionsValidator`, `OpenAiAllowedHosts`), `OpenAISpeechToText.cs`, `Program.cs` | `CloudSpeechEndpointTests.cs` (29) |
| RR-05 | `queueStore.ts` — `sweepPrivateLegacy` removes private and unowned plaintext even with no key, leaving a redacted notice | `queueStore.test.ts` → 5 tests across the no-key and migration groups |

### Red-capable verification

Each group was run against the reverted fix before being accepted, in this checkout, restoring the
file immediately afterwards:

- RR-01: 1 of 15 failed (`cannot overwrite the rightful owner's blob…`); 15/15 with the fix.
- RR-02 and RR-05 together: 9 of 28 failed; 28/28 with the fixes.
- RR-03: 2 of 7 failed (`refuses new authenticated work synchronously…`, `does not close the stores
  until what was in flight has settled`); 7/7 with the fix.

### Decisions worth reviewing rather than assuming

**RR-03 — the visible lock is deliberately not deferred behind the drain.** The required fix asks
for the drain to precede "closing old-owner stores or completing the visible transition". The stores
now wait for the drain; `setLocked(true)` does not. Deferring the visible lock would leave the
household's private screens on a shared panel for the length of a teardown, which is the thing the
idle lock exists to prevent. It is safe because the epoch advances in the same synchronous step:
`authorizedOperation` refuses to hand any in-flight result back to a caller, so nothing old can reach
the screen whether or not it has finished unwinding. Stated here rather than silently diverging.

**RR-05 — the redacted notice keeps `domain` and `ownerProfileId`.** The label is replaced with a
fixed sentence, and the body, path and version are dropped entirely. Domain and owner are kept
because the set-aside strip needs them to show the notice to the right member, and both are far
weaker than the label — "a care write was set aside for profile 2" rather than "Bottle 120ml for
Wren". If Geist reads the domain itself as disclosure, it can go, at the cost of the notice being
un-routable.

**RR-02 — a failed migration leaves the private plaintext in place until the next open.** The
alternative is deleting it with no durable notice, which is the failure RR-02 is about. The no-key
sweep from RR-05 does not help here, because this session *has* a key. Stated as a bounded residual:
one more boot's exposure, versus permanent loss of the telling.

**RR-04 — `Ai:OpenAiAllowedHosts` is a new configuration surface.** Default empty means the
provider's own host. A deployment using an OpenAI-compatible endpoint elsewhere must name it, which
is deliberate — the point is that changing the destination is an explicit act on a protected value
rather than a side effect of editing a URL. This is a fifth thing to check against production
configuration before promotion, alongside HH-07's SQL certificate and HH-08's egress acknowledgement.

### Full gate

```text
./scripts/check.sh all
  ok  typecheck      6s
  ok  lint           0s
  ok  tests          5s   Test Files  54 passed (54)
  ok  backend-tests 48s   Failed: 0, Passed: 1239, Skipped: 0, Total: 1239
```

Client test files 53 → 54; backend tests 1,210 → 1,239. Neither baseline dropped.

### Still outstanding

The browser/manual evidence remains unproduced, for the same reason and unchanged: every validation
needs a sign-in, which needs a database, and this checkout has no `ConnectionStrings:HomeHub` and no
dev credentials. RR-01 and RR-03 add to that list — a wrong-key vault session and an idle lock landing
on a suspended body are both browser-observable and neither has been observed in one. Given a
development connection string this runs through `/srv/dev/tools/playwright` and lands under
`artifacts/homehub-browser-verification/`.

Geist marks the re-review, not this record.
