# d0296c4 review — Claude's remediation

**Commit:** `e641855`
**Answers:** the four High findings in `brain/SECURITY-REVIEW-D0296C4.md`
**Status:** implemented with regressions. **Geist marks the review, not this record.**

All four confirmed. Includes a schema migration, `AddLineageAuditedAt`, which is the first in this
sequence — pending-migration count will be 1 against the current TEST database.

## 1. Dropped-notice sanitation fails open

**Confirmed, and it is the same fail-open I had just fixed one function away.** `readJson` collapses
four different answers into `[]` — the store threw on `getItem`, the value is not JSON, the value is
JSON but not an array, the key is absent — and only the last means there is nothing to sweep. I fixed
that for the operation store, wrote the reasoning out, and left `sweepLegacyNotices` calling
`readJson` in the same file, in the same commit.

So the read is now one function rather than a rule to apply twice. `readLegacy<T>` returns
`absent | unreadable | malformed | entries`, and both sweeps consume it: unreadable returns `false`,
malformed removes the key wholesale, and the notice sweep still records its own redacted notices
afterwards so the household is told even when what was there had to go. `stillHolds` replaces the
duplicated read-back.

Four regressions, red-capable against the previous implementation.

## 2. Historical lineage deletion lacks an audit gate

**Confirmed.** `LineageAudit`'s own class comment describes the hazard exactly and nothing acted on
it: a chain that became `A → B → C` while HomeHub stored only `A` resolves to `C`, so deleting
tombstones A and C and never B — and B stays on the agent with its messages, permanently, because the
local row that pointed anywhere near it is gone.

`HouseholdSettings.LineageAuditedAtUtc` (migration `AddLineageAuditedAt`, nullable, no data loss):

- **Retention pauses** while it is null, and logs why. It is the automatic path, so it is the one that
  would do this without anybody choosing it.
- **The explicit delete returns 409** naming the lineage report. Refusing is the fail-closed answer
  and it is not a dead end — the report is one read-only request.
- **Running the report stamps it**, whatever the verdict. The gate is "somebody has looked", not "it
  came back clean": a household that has read the damage is making an informed choice, and blocking on
  a clean report would be a genuine dead end since the backfill does not exist yet.
- **A fresh database is stamped at startup** when it holds no conversations, so a new household is
  never asked to audit nothing.

**A decision worth reviewing:** the gate is per-database rather than per-conversation. A local check
cannot establish completeness — the audit is what walks Hermes's own parent links — so there is no
per-conversation predicate to gate on honestly. If Geist wants deletion blocked until the report comes
back *clean* rather than merely run, that is a one-line change and a product dead-end until a backfill
exists; I judged "informed" to be the right bar and would rather be told than have guessed.

## 3. Tombstones stop retrying after 12 attempts

**Confirmed.** `d.Attempts < MaxAttempts` in the drain query made the class comment's "never
discarded" true and beside the point: a Hermes down for a day, or a gateway whose credential was
rotated and then fixed, left the household's transcripts on the agent with nothing that would ever try
again. The threshold now widens the backoff to daily and logs the warning; it no longer excludes.

## 4. RecipeFetcher SSRF bypass

**Confirmed.** `Meals:AllowPrivateAddresses` disables both address defences, and the fetcher follows a
URL a household member types — so an authenticated recipe import becomes a way to make the server
request its own loopback or LAN. `MealsOptionsValidator` refuses it outside Development and the
automated Test environment, which is where it exists for.

## Two things the tests caught that I had wrong

- **The lineage stamp was written through `GetSettings`, which reads `AsNoTracking`.** Mutating what
  it returns changes nothing and saves nothing, so the release was silently a no-op. The gate test
  asserted the second delete succeeded, which is what surfaced it — an assertion on the stamp alone
  would have passed against the broken version too.
- **Nine existing deletion tests started failing on the new gate**, because the in-memory database is
  `EnsureCreated` and never stamped. `HubAppFactory.AuditedLineage` now models an audited household
  explicitly, which is the ordinary state; `LineageGateTests` sets it false to exercise the gate.

## Gate

```text
./scripts/check.sh all
  ok  typecheck      6s
  ok  lint           0s
  ok  tests          4s   Test Files  54 passed (54)
  ok  backend-tests 48s   Failed: 0, Passed: 1346, Skipped: 0, Total: 1346
  ok  bridge-tests   2s   Ran 12 tests
```

Backend 1,336 → 1,346. No baseline dropped.

## Deployment note

**This candidate carries a schema migration.** `AddLineageAuditedAt` adds one nullable column to
`Settings`. Pending migrations against the existing TEST database will read 1 rather than 0, and the
column is null on an upgraded database by design — which means **assistant deletion and retention are
paused on TEST until the lineage report is opened once**. That is the intended behaviour and is worth
knowing before it looks like a fault.
