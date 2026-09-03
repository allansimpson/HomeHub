# HH1377-H2 — the lineage gate, to Geist's stricter ruling

**Commit:** `ec92799`
**Answers:** Geist's decision that the gate must require a clean, reconciled result
**Status:** implemented. **H2 only — the other seven of the eight are not started.**

## The ruling was right and the previous bar was wrong

Releasing deletion when somebody had *opened* the report mistook being informed for being safe. An
administrator reading that transcripts will be orphaned is not a reason to orphan them, and an
irreversible action does not become recoverable by being announced. "Dead end until a backfill exists"
is the correct fail-closed behaviour: if HomeHub cannot prove all historical lineage is known, the
local rows are the recovery anchors for the transcripts it cannot see, and they are retained.

## The state model

`LineageState` on household settings, replacing the timestamp-as-a-flag:

| State | Retention | Manual deletion |
|---|---|---|
| `NotAudited` | paused | refused |
| `Blocked` — reconciled, unclean | paused | refused, and stays refused |
| `Clean` — reconciled, clean | permitted | permitted |
| `RiskAccepted` — deliberate override | **paused** | permitted |

- **`POST /assist/lineage/reconcile`** runs the audit and records its verdict. The verdict is the
  audit's, not the caller's; re-running after repairing the agent is how a blocked household gets out,
  and re-running does not wear it down.
- **`GET /assist/lineage/report`** is read-only again and changes no authority. A GET that stamps
  global destructive permission is one a refresh, a preview or a crawler can trigger.
- **`POST /assist/lineage/accept-risk`** is the deliberate override. Administrator-only. The caller
  must send back the **exact** set of unresolved session ids the current report names — so it cannot
  be issued by something that never read what it was accepting, and cannot be replayed against a
  lineage that has since acquired new damage. Who accepted, when, and against what are stored.
- **`RiskAccepted` does not start background retention.** Somebody accepting a named risk for a
  conversation they are deleting is a decision; a timer acting on that acceptance for every
  conversation in the household for ever is a different one, and nobody made it. That distinction is
  the entire reason it is a fourth state rather than an alias for `Clean`. A routine re-reconcile also
  does not silently revoke it.

Eleven regressions in `LineageGateTests`. The clean-only condition is red-capable: weakening the
release back to "it ran" fails `An_unclean_reconciliation_leaves_deletion_refused`.

## Migration

`AddLineageReconciliation` **replaces** the unshipped `AddLineageAuditedAt`, which was removed rather
than stacked on — nothing has deployed it, and two migrations for one decision would be history
nobody wants to read later.

**On TEST this will read 1 pending migration, and the state will be `NotAudited`** — so assistant
deletion and retention are paused there until the lineage is reconciled clean. If the agent cannot be
read, reconciliation returns `Blocked` and stays there. That is the intended behaviour and is the
thing most likely to be mistaken for a fault.

## What is not done

**Seven of the eight findings are not started.** I have their one-line titles from `brain/STATE.md`
and not their evidence, locations or reproductions, and I would rather ask than approximate.

Two of them read as **decisions rather than defects**, and I specifically do not want to guess:

- **H3** — a four-digit PIN permits copied-store decryption. That is the limit `offlineUnlock.ts`
  states in its own header: ten thousand candidates, an attacker with the store can run the KDF
  themselves, and the honest claim was always "not casually readable" rather than "a vault". Closing
  it means changing what the household types, or how the store is bound to the device.
- **H4** — a persisted IndexedDB device key remains usable from a copied browser profile. Also
  documented, in `deviceKey.ts`: it defends the record at rest and not against code or a profile copy
  taken from the same origin. Closing it means either no durable key for no-PIN profiles — which
  reopens the loss-on-restart problem Allan chose against — or a different binding.

Both are trade-offs this work adopted deliberately and wrote down. If the answer is that they are no
longer acceptable, that is a product decision with a visible cost to the household, and it should be
Geist's or Allan's rather than mine.

**H1, H5, H6, H7, H8** need their evidence to be remediated rather than approximated.

## An operational blocker

`brain/STATE.md` is currently `root:geist-dev`, mode 644, and I cannot write it. Seventeen `.git`
objects from commit `d1d671a` are also root-owned. This is the incident already recorded in
`brain/INCIDENTS.md` for 2026-08-20 — a build or script run as root inside the shared checkout — in a
much smaller form, and nothing is broken yet: `.git/index` and `HEAD` are still `simpson`, so commits
and pushes work.

I have not tried to work around it and there is no `sudo` here. **The state update for this round is
this file rather than `STATE.md`.** Fixing it needs `chown -R simpson:geist-dev /srv/dev/homehub` from
somebody who can, and it is worth doing before it grows.

## Gate

```text
./scripts/check.sh all
  ok  typecheck      7s
  ok  lint           0s
  ok  tests          4s   Test Files  54 passed (54)
  ok  backend-tests 50s   Failed: 0, Passed: 1351, Skipped: 0, Total: 1351
  ok  bridge-tests   2s   Ran 12 tests
```

Backend 1,346 → 1,351. No baseline dropped.
