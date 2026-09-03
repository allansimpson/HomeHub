# HH1377-H2 scoped-acceptance re-review — FAIL CLOSED

Date: 2026-09-03
Reviewer: Geist

## Exact candidate

- Application commit: `616b9b29ba24b1876c81223cd9934785271af4cb`
- Git tree: `b6849ca2e4413cad1cb6acf6cca05e5a39e4e3e5`
- Tracked paths: 883
- Deterministic `git archive` SHA-256: `488fd352ed2fa84d87eae680ca1c94c326399e69cccc3839349f927cb045ebaf`
- Review/documentation tip at start: `1b19b92a5c9e0df15b9b879f939606213767f41d`
- Working tree at start: clean; `main` matched `origin/main`.

## Scoped verdict

- Critical found in the H2 patch: **0**
- HH1377-H2: **still High / open**
- Production eligible: **no**
- TEST promotion performed: **no**

The new shape is materially better: an integrity-protected challenge replaces the fail-open empty acknowledgement; the report fingerprint includes reachability and blockers; the acceptance names exact conversation IDs and expires; `RiskAccepted` is no longer household state; and background retention cannot be released by an acceptance. The original no-report/empty-list path now refuses.

Three defects still make the central claims false, however: the fingerprint omits successfully mapped remote sessions, the report is not held current through deletion, and acceptance consumption is not atomic with the destructive write.

## HH1377-H2a — successfully mapped remote sessions are absent from the fingerprint

`LineageFingerprint.Of` hashes agent reachability/error/truncation, the clean verdict, blocking reasons, non-clean findings, and HomeHub's local anchors at `src/HomeHub.Api/Assist/LineageRiskAcceptance.cs:75-106`. It does not hash the enumerated remote session identities or their parent relationships. `LineageAudit` classifies every member of a claimed lineage as `VerifiedAndMapped` at `LineageAudit.cs:194-236`, then deliberately removes all such findings from the returned report at `:269-285`. `SessionsSeen` and `Counts.VerifiedAndMapped` change, but the fingerprint does not include either.

The result is a direct stale-acceptance path without a narrow timing race. Suppose an unclean report has an unrelated standing blocker and conversation C is locally anchored only to Hermes session A. After authorization, Hermes compresses A into child B while HomeHub still knows only A. A fresh audit sees A and B, maps both to C through A, and regards both as verified. The fingerprint remains unchanged: B appears in no non-clean finding and no local anchor, and the changed session/count fields are omitted. Deletion therefore accepts the stale authorization, tombstones only A, removes C's local anchor, and leaves B's transcript permanently orphaned.

Required correction:

1. Fingerprint every security-relevant remote session identity and its lineage edges, not only adverse findings. At minimum bind agent key, session ID, parent session ID, source, end reason/classification, and mapped conversation/root; alternatively construct and hash an explicit canonical audit-evidence projection with equivalent completeness.
2. Do not rely on aggregate counts alone: equal counts can hide replacement sessions or changed parent edges.
3. Add a regression where an unclean report authorizes C, Hermes then gains a verified compression child B that is absent from local references, and deletion is refused until reconciliation/authorization is renewed. The test must fail on `616b9b2`.
4. Add load-bearing fingerprint tests for changed parentage, source, classification, agent reachability/blockers, and local session references.

## HH1377-H2b — the report can change between its final check and deletion

`AssistController.AuthorisedByAcceptanceAsync` re-runs the audit and computes the fingerprint at `src/HomeHub.Api/Controllers/AssistController.cs:265-293`. The actual conversations and session references are loaded only later at `:1181-1188`, and deletion commits at `:1224-1225`. No transaction or lock spans those operations.

The application already has the exact serialization primitive this path needs: `ConversationLocks`. Both chat paths acquire it before a turn can rotate `HermesSessionId` or append a `HermesSessionReference`; see `AssistController.cs:1006-1011` and the corresponding streamed path. `Delete` acquires none of those locks.

A live turn can therefore pass the acceptance's final audit/fingerprint check and then create or rotate a Hermes session while deletion is being prepared. If it lands after the rows/references are loaded, the delete request never creates a tombstone for that new session; the conversation and its references are then removed. That is the same irreversible loss of the local recovery anchor H2 exists to prevent, after the API has claimed that the accepted report was rechecked at deletion.

Required correction:

1. Resolve and acquire every target conversation lock in a canonical order before the final audit/fingerprint check.
2. Re-read ownership, conversation rows and references only after those locks are held.
3. Hold the locks until the local delete, tombstone writes and acceptance consumption have committed.
4. Add an adversarial regression that pauses a turn/session rotation at the boundary and proves deletion waits, then tombstones the session produced by the turn. The test must fail on `616b9b2`.

If any path can mutate lineage without `ConversationLocks`, it must participate in the same database serialization boundary or the review remains time-of-check/time-of-use.

## HH1377-H2c — deletion and single-use consumption are two commits

The code says the acceptance is spent "in the same save as the deletion", but it does the opposite:

- `AssistController.cs:1224-1225` removes conversations and commits the tombstones/deletion.
- Only afterwards, `:1227-1232`, it marks `ConsumedAtUtc` and performs a second `SaveChangesAsync`.

Cancellation, process termination, SQL failure, or a concurrency failure between those saves leaves the irreversible deletion committed while the acceptance remains unspent. The unique nonce index at `HomeHubDbContext.cs:972-974` prevents issuing two acceptance rows from one challenge; it does **not** make consumption of an existing row single-use. Nor is `ConsumedAtUtc` a concurrency token or guarded by an atomic conditional update.

The split is externally meaningful because deletion filters a requested batch to the current caller at `AssistController.cs:1181-1188`. An acceptance can name conversations belonging to more than one profile. If the first caller deletes their subset and the consumption save fails, a second caller can present the same requested ID set and delete their subset under the still-unspent row.

Required correction:

1. Claim/consume the acceptance and write tombstones/remove conversations in one database transaction and one atomic authorization decision.
2. Use a conditional consume (`ConsumedAtUtc IS NULL`, unexpired, matching digest/scope) or a concurrency token, and require exactly one affected row.
3. Decide explicitly whether an acceptance is bound to the deleting profile or is an administrator's delegation to the named owners. Enforce that model rather than relying on the later ownership filter.
4. Add regressions for a forced failure at the former second-save boundary and for two concurrent delete requests. Prove that exactly one commits and that there is no state where deletion committed while the acceptance remains usable. These must exercise SQL Server semantics, not only EF's in-memory provider.

## Secondary robustness gaps

These are not the reason for the High verdict, but should be closed with the correction:

- Concurrent uses of one challenge race past the `AnyAsync` check at `AssistController.cs:233-247`; the unique index fails closed, but the loser is likely an unhandled `DbUpdateException`/500 rather than the documented 409.
- The H2 tests run against EF Core InMemory, so they cannot establish unique-index enforcement, row-locking, transaction isolation, or production SQL Server concurrency behavior.
- There is no direct expiry regression for either the challenge or the accepted authorization.
- The only report-change regression changes `Conversation.HermesSessionId`; it does not cover the omitted verified remote-session graph, changed parentage/source/classification, agent reachability/blocking reasons, or `HermesSessionReference` changes.
- There are no concurrent challenge-replay or concurrent deletion tests, and no injected failure at the split-save boundary.
- `accept-risk` accepts arbitrary/nonexistent/negative IDs and can overrun the 2,000-character `ConversationIds` column, producing a 500. Validate bounds and target existence/ownership according to the chosen delegation model.

## Migration assessment

The regenerated `20260903120856_AddLineageReconciliation` migration is structurally coherent for an environment where no earlier version of `AddLineageReconciliation` was applied: it adds `LineageState`, `LineageAuditedAtUtc`, the acceptance table, and a unique nonce index. The recorded deployment history says no version of this migration reached TEST or production, so regeneration rather than stacking is acceptable.

That is a source assessment, not a live database authorization. Protected TEST configuration and pending migrations were not read because this candidate failed before promotion.

## Verification actually run

- Repository identity and archive hash were recomputed as the repository owner.
- Full backend suite passed: **1,355 passed, 0 failed, 0 skipped**.
- Bridge suite passed: **12**.
- Typecheck and lint passed.
- Client full-suite gate did **not** pass in this review environment: `offlineUnlock.test.ts > enrolment > never opens a different profile` exceeded its 5-second timeout in two full-gate runs. The same file passed alone (**17/17**) in 4.97 seconds, indicating a timing-sensitive gate rather than an H2 functional failure. Release policy still requires the exact gate to be green; a near-deadline standalone pass does not qualify it.

No artifact was built or deployed.

## Remaining release state

H1 and H3-H8 remain acknowledged, unremediated High findings. This was an H2-only re-review and does not reopen or reduce those seven. The next candidate must correct H2a/H2b/H2c, make the regressions load-bearing, pass the exact full gate, and then receive fresh review of the changed bytes before any TEST promotion.
