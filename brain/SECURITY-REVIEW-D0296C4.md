# Production security review — `d0296c4` — FAIL CLOSED

Date: 2026-09-02
Reviewer: Geist

## Exact candidate

- Documentation tip: `d0296c4e525c5b7bb0bfc55d20b98583d8a0b704`
- Application commit: `e6bf3ba8d90cba822a4c74bb03b6bc83e08c39e9`
- Git tree: `ab19a53272a641a79d97c19bc813c4ac8e7dea0f`
- Tracked paths: 873 (842 UTF-8 text, 31 binary assets)
- `git archive` SHA-256: `886bd7cc95032ad17d2cd1706ac2ed34acb9222b4ada89392e78938c8cf069f1`
- Immutable review export was clean after review.

## Verdict

- Critical: **0**
- High: **4**
- Production eligible: **no**
- TEST promotion performed: **no**

The exact candidate independently passed typecheck, lint, 54 client test files, 1,336 backend tests, 12 bridge tests, and production npm/NuGet vulnerability checks. Those results do not override the source findings below.

## D029-H1 — RR-05 dropped-notice sanitation still fails open

`client/src/app/queueStore.ts:351-362` reads and verifies `homehub.writequeue.dropped.v1` with `readJson()`. At `:664-671`, that helper maps an absent key, refused read, malformed JSON, and non-array JSON to the same `[]`. Writes/removals at `:678-686` are best-effort and swallow failure. Consequently, malformed or unreadable private notice bytes can remain while `sweepLegacyPlaintext()` returns `true`; `SessionProvider.tsx:529-533` trusts that result, so the durability demotion and visible `storageUntrusted` boundary are not entered.

This was independently reproduced against exact candidate source with (a) selectively refused notice reads and (b) malformed Care notice plaintext plus silent `removeItem` refusal. Both returned `true` rather than `false`; in the latter case the plaintext remained.

Definition of done:

- Raw-read the notice key and distinguish absent, unreadable, malformed, wrong-shaped, and valid states.
- Purge malformed/wrong-shaped values and verify absence with a raw readback.
- Return `false` whenever inspection or the postcondition cannot be established.
- Regress refused read and both throwing and silent-no-op removal; prove failure propagates to memory-only private stores and `storageUntrusted`.
- Prove RED against `d0296c4`.

## D029-H2 — Historical lineage deletion is enabled before audit/backfill

On an upgraded populated deployment, a historical Hermes lineage such as `A → B → C` may have only A and C in HomeHub. `src/HomeHub.Api/Assist/LineageAudit.cs:12-22` states that tracking is prospective and audit/backfill is a prerequisite. The migration creates an empty reference table rather than backfilling historical lineage (`src/HomeHub.Api/Migrations/20260901164422_AddHermesSessionLineage.cs:12-47`). Despite that, default 30-day retention is active, its household worker starts at `Program.cs:943-949`, and `AssistRetention.cs:64-105,144-157` tombstones only known IDs before deleting the conversation and cascading references. Explicit deletion does the same at `AssistController.cs:939-992`. Unknown intermediate transcript B can therefore become permanently orphaned.

Definition of done:

- Persist a durable deployment-wide state proving the lineage audit completed and required backfill was applied.
- Fail closed at both retention and explicit-deletion entry points until that state is valid.
- Regress an upgraded populated database containing a missing intermediate lineage session and prove local deletion cannot erase recovery capability.

## D029-H3 — Durable deletion tombstones permanently stop retrying

`src/HomeHub.Api/Assist/SessionDeletionWorker.cs:34` caps attempts at 12. Its due query at `:76-82` permanently excludes incomplete rows once `Attempts >= MaxAttempts`. Configuration absence and Hermes failures consume attempts at `:89-123`; after the twelfth failure the worker only logs a warning at `:129-133`. The tombstone remains in the database but has no automatic retry or requeue path. An overnight outage, credential failure, or temporarily removed agent can therefore leave a transcript permanently undeleted even after recovery.

Definition of done:

- Retry incomplete tombstones indefinitely with capped backoff; or implement a durable dead-letter state with actionable alerting and an explicit automatic/operator requeue path.
- Regress twelve failures followed by restored Hermes/configuration, proving the same tombstone is attempted again and reaches completion.

## D029-H4 — Production-bindable RecipeFetcher SSRF bypass

`src/HomeHub.Api/Meals/MealsOptions.cs:35-40` exposes `Meals:AllowPrivateAddresses`. At `RecipeFetcher.cs:100-104` and `:272-289`, setting it true disables both private-address defenses. `Program.cs:560-570` binds those ordinary options directly into the production handler; no hardened-deployment validator rejects the bypass. The repository test `RecipeImportTests.cs:90-106` proves that enabling the option lets a loopback hostname reach the socket rather than being blocked. An authenticated household user controlling recipe-import URLs can then target loopback/LAN services.

Definition of done:

- Remove the production-bindable bypass; preferred: tests replace the handler through test DI.
- If retained, hardened deployment startup must unconditionally reject `Meals:AllowPrivateAddresses=true`.
- Add a production-environment startup regression and prove RED against `d0296c4`.

## Egress invariant assessment

The new `EgressRequestGuard` plus guarded-registration helpers materially closes the prior class-versus-instance gap for application-registered `HttpClient`s. The source enumeration, deny-all default, runtime discovery floor, raw-listener sweep, request-body assertion, mutation evidence, and positive topology checks were inspected and independently exercised. The remaining RecipeFetcher issue is in the expressly enumerated dynamic-destination exception, not a bypass of the new guarded-client composition.

Stated coverage boundary remains accurate: direct `new HttpClient(...)` construction and non-HTTP egress require separate enumeration if introduced.

## Deployment state at verdict

- TEST stayed on `f961a0a` and remained healthy with zero pending migrations.
- Production stayed on `a66e80a` and remained healthy.
- No TEST or production installation of `d0296c4` occurred.
