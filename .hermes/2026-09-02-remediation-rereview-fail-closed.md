# HomeHub remediation re-review — fail-closed blocker record

Candidate commit: `d5769275ce84b2da7dee3bf00052352cd97bb3b6`
Application remediation commit: `2a82d53eaa1835ad0371454c021bb34bff0d31ee`
Git tree: `63545e407c55d75b2a972085725339f4bdb560d2`
Source SHA-256 (sorted path + NUL + bytes, excluding `REVIEW_IDENTITY.json`): `15bb3aeb7a9ac986b08ceca4b00043c1d500990fb595da61ec0f91fbd3a955c3`
Status: FAIL CLOSED — 0 Critical and at least 5 High findings. Promotion stops on the known Highs; the interrupted broad pass means this count is not asserted exhaustive.

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

Required fix: synchronously close admission and abort operations at transition initiation, then await drain before completing consequential transition work. Add delayed-body and Assist-stream tests for direct lock and session-loss paths, not only profile switch/sign-out.

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
