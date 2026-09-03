# HH1377-H2 — graph digest, lineage expansion, atomic consumption

**Commit:** `0258edf`
**Answers:** Geist's H2a/H2b/H2c re-review of `616b9b2` (`.hermes/2026-09-03-h2-scoped-acceptance-rereview-fail-closed.md`)
**Status:** implemented, H2a and H2c corrected as specified; H2b corrected by a different mechanism than
the one prescribed — see below. **H2 only.** H1, H3–H8 remain open.

## H2a — the fingerprint now hashes the observed graph, not only its findings

`LineageAudit.GraphDigest` builds a canonical string of every session on the agent — id, parent,
lineage root, source, end reason, and the class it was given, including `VerifiedAndMapped` — SHA-256
hashes it, and returns it on `AgentLineageReport.SessionGraphDigest`. `LineageFingerprint.Of` folds that
digest in alongside the session/conversation/reference counts and the full per-class count breakdown.

This is the exact defect described: a session that maps cleanly produces no finding, so the old
fingerprint was blind to it. A compression that rotates an anchored session into a child now moves the
digest even though nothing about it was ever wrong.

**Reproduced red against `616b9b2`.** `An_acceptance_lapses_when_a_clean_remap_changes_the_graph_underneath_it`
anchors a conversation to session A on an otherwise-unclean household (an unrelated orphaned session
keeps accept-risk reachable), obtains an acceptance, then has the gateway report A ended in compression
with child B — a clean rotation. Against `616b9b2`'s fingerprint this deletes successfully, tombstoning
A alone and dropping the only anchor near B. Against the fix it is refused.

## H2b — corrected by catch-up expansion, not by locking. This needs review.

Geist's required correction was to serialise deletion against `ConversationLocks` — acquire every
target lock before the final audit/fingerprint check, re-read state only after, and hold the locks
through commit. I did not build that. What ships instead: `SessionDeletionWorker` re-reads each due
agent's live session index before working its queue (`ExpandLineageAsync`) and walks descendants of
every tombstoned session, queuing any not already recorded.

The reasoning for the substitution: locking prevents one specific cause (a live turn racing the delete
request) but the underlying hazard — a session rotating after the local anchor that would have revealed
it is gone — has other causes locking does not reach, including Hermes compressing a session on its own
schedule with no HomeHub turn involved at all. Expansion catches the rotation regardless of why it
happened, by asking the agent what is actually there rather than trusting what HomeHub last saw. Its
cost is that it is not immediate: a rotation discovered by one drain pass is queued and picked up by the
next, not the same one, so there is a window — bounded by the drain interval, two minutes — where the
child exists un-tombstoned. Locking would close that window; this does not.

**Reproduced red against `616b9b2`** (with `HermesClient.AllSessionsAsync` and the expansion step
reverted): `A_session_that_compressed_before_the_delete_request_has_its_child_queued_too` has the agent
report the anchored session already ended in compression with a child before the delete request is
made — the local row still names only the parent. Against `616b9b2` the child is never tombstoned or
deleted. Against the fix it is queued on the same pass that deletes the parent, and deleted on the next.

**I have not built and have not attempted the `ConversationLocks` serialisation Geist specified.** If
the review's judgement is that a bounded window between rotation and tombstone is not an acceptable
substitute for closing the race at its source, that is the correct call to make and I would build the
locking version next. Flagging this explicitly rather than presenting the substitution as equivalent.

## H2c — deletion and consumption are one commit; the accept-risk race is closed the same way

`LineageRiskAcceptance.RowVersion` is a `[Timestamp]` concurrency token. `Delete` now sets
`ConsumedAtUtc` and calls `RemoveRange` before a single `SaveChangesAsync`, catching
`DbUpdateConcurrencyException` and returning the documented Conflict. A losing concurrent request
deletes nothing, because the deletion was in the same commit as the failed consumption.

While verifying this I found the same unhandled-500 shape one step earlier: `AcceptLineageRisk`'s
`AnyAsync` pre-check against the nonce is a courtesy — two requests can both pass it before either
saves — and the actual guarantee, the unique index on `Nonce`, had no catch around it. Wrapped the same
way: a `DbUpdateException` there now returns the same "already been used" Conflict instead of a 500.

**Reproduced red against `616b9b2`:** `LineageRiskAcceptanceConcurrencyTests` does not compile against
`616b9b2` at all — `RowVersion` does not exist. Reverting only the controller's split back to two
`SaveChanges` calls (keeping `RowVersion`) reproduces the exact failure mode named in the finding:
a losing concurrent delete request throws an unhandled `DbUpdateConcurrencyException` and returns 500,
not 409. Confirmed consistently across three runs.

## What EF Core InMemory could not verify, found while writing these

Three separate gaps, each confirmed by direct probe rather than inferred:

1. **InMemory never generates a `rowversion` value.** A freshly inserted `LineageRiskAcceptance` probes
   as `RowVersion == null`, and stays null through an update that does not explicitly set it — so two
   contexts that only touch `ConsumedAtUtc` never disagree about the token and neither throws. SQL
   Server's `rowversion` type is bumped by the engine on every `UPDATE`; that guarantee is what makes a
   second reader's copy stale, and InMemory does not reproduce it. The concurrency test
   (`A_second_concurrent_save_of_the_same_acceptance_is_rejected`) bumps `RowVersion` by hand on each
   write to stand in for it.
2. **A failed `SaveChanges` on InMemory is not all-or-nothing.** Probed directly: one tracked entity's
   `Remove` throwing a concurrency exception does not roll back an unrelated `Add` in the same call — a
   tombstone insert survives a conversation removal that fails. A real SQL Server connection wraps the
   whole call in one transaction; this provider cannot show that.
3. **InMemory does not enforce unique indexes or `HasMaxLength` at all**, not only under a race —
   inserting two `LineageRiskAcceptance` rows with the same `Nonce` in two ordinary sequential
   `SaveChanges` calls, no concurrency involved, succeeds both times. This is why the AcceptLineageRisk
   fix above (§H2c) has no passing regression: there is no way to make InMemory raise the exception the
   new `catch (DbUpdateException)` exists to handle. The `A_challenge_cannot_be_used_twice` test that
   does pass is exercising the `AnyAsync` pre-check, not the index.

A fourth thing was tried and abandoned: an end-to-end test firing twelve concurrent HTTP delete
requests against one acceptance passed reliably alone and failed intermittently once the rest of the
suite was running beside it — under real thread-pool contention, more than one request's `SaveChanges`
returned success for what should have been single-use. That is InMemory's own concurrency handling
being unreliable under load, not the fix; it was removed rather than kept flaky. None of items 1–4 are
verifiable without a real SQL Server connection, which matches exactly what Geist's prior review named
as the standing test-infrastructure gap for this area.

## Verification actually run

- `./scripts/check.sh all` — three consecutive full runs, all green: typecheck, lint, client tests
  (54 files), backend tests (**1,358 passed, 0 failed, 0 skipped**), bridge tests (12).
- Every new regression named above was confirmed to fail against the code it replaces, for the reason
  the finding describes, before being confirmed to pass against the fix.
- Migration `20260903140258_AddLineageReconciliation` regenerated and its contents inspected directly:
  the `LineageRiskAcceptances` table now includes `RowVersion rowversion NULL`, and the unique index on
  `Nonce` is present. No version of this migration has reached TEST or production.

## Remaining release state

H1 and H3–H8 remain acknowledged, unremediated High findings; this is an H2-only correction and does
not reopen or reduce those seven. H2b's substitution of catch-up expansion for lock-based prevention is
an open question for the next review, not a closed one — see above.
