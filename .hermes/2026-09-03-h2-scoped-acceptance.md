# HH1377-H2 — risk acceptance rebuilt as a scoped authorisation

**Commit:** `616b9b2`
**Answers:** Geist's finding that accept-risk remained fail-open, and the five-point required correction
**Status:** implemented. **H2 only.** H1, H3–H8 remain open; see the plan at the end.

## Both halves of the finding were right, and the first one was my claim

I wrote that an acceptance "cannot be issued by something that never read what it was accepting". The
confirmation was the set of unresolved session ids — and that set is **empty precisely when the agent
cannot be read**, because nothing could be enumerated. An empty acknowledgement matched it, no GET or
reconciliation was required, and the case with the most to accept proved the least. Matching an
enumeration cannot represent a failure *of* enumeration. The candidate's own test suite encoded it:
it obtained an empty list from the unreachable test agent and accepted it.

The second half was structural and equally real. `RiskAccepted` was a household state; deletion read
that enum and nothing else. One acceptance authorised every later deletion — conversations that did
not exist when it was granted, damage discovered afterwards — and re-reconciliation deliberately
preserved it, so the override outlived the evidence.

## The correction, against the five required points

1. **Challenge issued by reconciliation** — `LineageChallenges` produces a Data Protection payload
   carrying a report digest, a nonce and an expiry (15 minutes). Opaque and integrity-protected, so a
   caller cannot construct one. `LineageFingerprint.Of` digests **agent reachability and error**,
   truncation, the clean verdict, **every blocking reason**, every finding (`agent∙kind∙session`), and
   the local anchors — each conversation's id and current session, plus every recorded session
   reference. Reachability being in the digest is the specific fix: an unreachable agent now yields a
   distinct fingerprint that could only have come from a report.
2. **accept-risk requires the challenge**, not a reconstructible list. Absent → 400. Unreadable or
   forged → 409. Expired → 409. Digest no longer matching a fresh audit → 409.
3. **Acceptance names the conversations.** An empty list is refused: a blanket acceptance is not one.
4. **Deletion consumes it once.** When the state is not `Clean`, deletion re-runs the audit,
   recomputes the digest, and requires an unspent, unexpired acceptance whose conversation set matches
   exactly — then marks it consumed in the same save. Replay is refused by a **unique index on the
   nonce**, so single use is a property of the schema rather than a check somebody remembered.
5. **Retention can never be released by an acceptance**, structurally: `RiskAccepted` is gone from
   `LineageState` altogether, the household stays `Blocked` throughout, and retention reads the state.

### Verification

- **Geist's probe reproduced** — no GET, no reconcile, empty acknowledgement, agent unreachable — now
  refuses, and the subsequent deletion returns 409.
- **The challenge requirement is load-bearing**: removing it fails
  `An_acceptance_cannot_be_issued_without_a_challenge` and `A_forged_challenge_is_refused`.
- Fifteen tests in `LineageGateTests`, including: authorises only the conversations it names; one
  deletion only; a challenge cannot be used twice; an acceptance lapses when the lineage changes
  underneath it; an acceptance never starts background retention; non-administrators refused.

**A note on method.** My first reproduction of Geist's probe passed against a deliberately weakened
build — because the probe's empty conversation list was refused by a *different* check. A probe that
passes for the wrong reason proves nothing, which is the same trap as the stale binary and the
`HttpListener` that could not observe its own failure. The isolating revert is the one recorded above.

## Migration

`AddLineageReconciliation` is regenerated for the final shape rather than stacked: two columns on
`Settings` (`LineageState`, `LineageAuditedAtUtc`) and a `LineageRiskAcceptances` table. Nothing has
deployed any version of it.

**On TEST:** 1 pending migration, state `NotAudited` — assistant deletion and retention paused until
reconciled clean, and `Blocked` thereafter if the agent cannot be read.

## Gate

```text
./scripts/check.sh all
  ok  typecheck      6s
  ok  lint           1s
  ok  tests          4s   Test Files  54 passed (54)
  ok  backend-tests 50s   Failed: 0, Passed: 1355, Skipped: 0, Total: 1355
  ok  bridge-tests   2s   Ran 12 tests
```

Backend 1,351 → 1,355.

## The rest, and how I propose to sequence it

Thank you for the evidence — it is enough to work from. Nothing below is started. Taking them all in
one pass would mean seven half-considered security changes, so I propose this order and would rather
you correct it than have me guess:

1. **H8** — Care boot sanitation. Self-contained, client-side, same family as work already done, and
   the closure invariant is unambiguous. Smallest gap between "specified" and "shipped".
2. **H5** — Grocery cleanup outbox. Well-bounded, and `HermesSessionDeletion` is an existing template
   for exactly this shape (durable obligation, transactional write, indefinite bounded retry).
3. **H7** — Profile deletion as a resumable revocation workflow. Larger: a state machine, a security
   generation, callback revalidation, and cascade decisions across four tables.
4. **H1** — MCP initiating subject. Architectural: a per-turn, integrity-protected delegated subject
   threaded from the Assist turn through MCP to the provider call, and `ActiveProfileId` removed as an
   authorization input.
5. **H6** — media isolation. Also architectural, and it interacts with H1: the extractor path, the
   untrusted-evidence marking, and a confirmation boundary before any derived tool call.
6. **H3/H4** — the platform-bound key. **This one needs a spike before a design.** Your rule is clear;
   what is not yet established is whether a genuinely non-migratable secret is reachable from a
   browser on this panel. The realistic candidate is the WebAuthn PRF extension against a platform
   authenticator, which would need the panel to have one, would add an unlock gesture, and may simply
   not be available on a wall-mounted kiosk. If it is not, your rule resolves to **memory-only durable
   private state** — which is the option Allan weighed and declined for the loss-on-restart cost, so
   that reversal should be his rather than mine. I will report what the platform can actually do
   before proposing either.

I will start on H8 unless you would rather a different order.

## Ownership

`brain/STATE.md` is still `root:geist-dev` and unwritable by me, so this file carries the round. The
repair command you gave is correct and needs running on the host; I have not attempted a workaround.
