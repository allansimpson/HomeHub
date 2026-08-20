# Handoff — work done in a stale checkout, to be re-evaluated before use

**To:** myself, working in the authoritative HomeHub checkout.
**From:** myself, on 2026-08-17, working in `c:\CODE\HomeHub` — which we now know was **not** the
authoritative source.
**Status of everything described here:** implemented and green *in the stale copy*. Unverified, and
possibly wrong, against the real one.

---

## 0. Read this before anything else

Two bodies of work were completed in a checkout that turns out to be stale:

- **Part A — durable queued writes + write-queue profile isolation.** A security/correctness change.
- **Part B — a redesigned lock/PIN entry screen** produced by Claude Design.

**Do not port either as a diff.** Both were written against `client/src/app/writeQueue.ts` and
`client/src/screens/LockScreen.tsx` as they exist in the stale tree, and the authoritative checkout
is known to contain *different* versions of both files, including security infrastructure the stale
copy never had. Applying these patches mechanically could destroy real work — in the worst case,
overwriting an encrypted per-profile storage layer with a plaintext `localStorage` one.

**What is portable is the defect list, not the patch.** The findings in §3 were derived by reading
code, and each one is stated with a way to re-verify it independently. Re-check every one against
the real source before writing a line. Some may already be fixed there. Some may not exist there.
Some may be worse there.

---

## 1. Why the stale copy was stale, and how we know

| Evidence | Value |
|---|---|
| Path | `c:\CODE\HomeHub` (Windows) |
| Branch / HEAD | `main`, `9b10553` — *"Initial commit"*, the only commit in the repo |
| Remote | `https://github.com/allansimpson/HomeHub`, `main` level with local |
| Authoritative checkout | `/srv/dev/homehub` (Linux) — promoted DEV → immutable artifact → TEST |
| Last local deploy artifact | `artifacts/homehub-20260809-160640.tar.gz`, Aug 9 — eight days stale |

The two checkouts had **diverged in both directions**, which is what made the staleness hard to see:

- The stale copy had the entire PIN redesign (`LockPinSheet.tsx`, `lockGating.ts`, a rewritten
  `LockScreen.tsx`, `PinPad.tsx` changes). The server had none of it.
- The server had a `LockScreen.tsx` change the stale copy did not: a non-401 PIN-verification failure
  message, `NO CONNECTION · PIN CANNOT BE CHECKED`. That string appears **nowhere** in the stale
  `client/src`.

So each side was missing work the other had, off a shared `9b10553` base, with neither committed.

**Lesson to carry:** before accepting any task that names files, confirm the checkout is the one the
work is meant for. `git log --oneline -5`, the remote, and the newest deploy artifact take seconds
and would have caught this at the start. This is the *second* time in one session that work was
attributed to the wrong checkout — the original `HomeHub_ChangePrompt.md` made the same mistake in
the opposite direction.

---

## 2. Orient first — run these before deciding anything

The single most important question: **how much of the security architecture already exists here?**

Hermes confirmed the authoritative candidate line contains six commits, of which these matter:

| Commit | Adds |
|---|---|
| `60fe650` | `client/src/app/privateStorage.ts` — per-profile vault, AES-GCM values in `localStorage`, non-extractable `CryptoKey` via IndexedDB, open/flush/close lifecycle, drain-before-dispose. Also abort controllers, a `cancelled` outcome, an active-request registry, `closeQueueExecution()` |
| `51d614b` | Queue moved onto that vault; `ownerProfileId` validated; cross-profile entries rejected; the old global plaintext `homehub.writequeue.v1` **removed rather than adopted** |
| `fc6b1fc` | *"Make queued writes durable before execution"* — write-ahead + terminal removal on top of the above |

Run these first:

```bash
git log --oneline -15
ls client/src/app/privateStorage.ts                      # does the vault exist?
grep -rn "ownerProfileId\|closeQueueExecution" client/src/app/
grep -rn "cancelled" client/src/app/writeQueue.ts        # is there an abort outcome?
grep -n "homehub.writequeue" client/src/app/*.ts         # which storage key, and is it scoped?
grep -rn "persistAhead\|executeDurable\|write-ahead" client/src/app/
ls client/src/app/writeQueue.test.ts                     # existing coverage?
cat client/vitest.config.ts 2>/dev/null; grep -n '"test"' client/package.json
grep -n "jsdom\|happy-dom\|testing-library" client/package.json
```

### Decision tree

- **`fc6b1fc` is present** (write-ahead already there) → the core durability work is **done**. Do not
  redo it. Skip to §3.6 — several defects survive it, confirmed by Hermes.
- **`51d614b` present, `fc6b1fc` absent** → ownership and the vault exist; write-ahead is the real
  task, and it must be built on `privateStorage`, **not** on the plaintext key scheme used in the
  stale copy.
- **Neither present** → the checkout resembles the stale one, and §3 applies close to as written —
  but verify rather than assume, and re-read §5 on what the stale implementation got wrong for a
  vault-based world.

---

## 3. Part A — the durable-write and isolation work

### 3.1 The invariant Hermes was pursuing (this part is sound)

> A write must exist durably in the owning profile's queue before its fetch begins, and may be
> removed only after a terminal server response has been classified and that removal persisted.
> Offline or cancelled requests remain queued exactly once.

The reasoning is correct and worth defending regardless of which checkout you are in. The failure it
prevents: a mutation is sent, the page ends mid-request (reload, kiosk restart, power cut, profile
switch), and the change is applied on screen with nothing durable left to replay.

### 3.2 The bigger issue Hermes's original prompt missed

In the stale copy, the queue had **no ownership concept at all** — one global key,
`homehub.writequeue.v1`, on a shared multi-profile kitchen wall panel, while every sibling prefs
module was profile-scoped (`assistPrefs.ts`, `todoPrefs.ts`, `pantryPrefs.ts`).

Consequence: an operation queued while one member was signed in replays under whoever's session
cookie is on the device later, and the server attributes the mutation to them.

**Durability applied to an unauthorised path is negative value** — it makes a mis-attributing queue
more reliable at mis-attributing. Hermes agreed and reordered the work: ownership first, durability
second. `51d614b` is that fix on the authoritative line. **Verify it landed there before doing
anything else.**

Legacy policy, confirmed by Hermes: entries in the old un-owned global key must **never** be replayed
and must **never** be adopted by whoever happens to be signed in. Quarantine, and surface for manual
re-entry if the household should know.

### 3.3 Confirmed defects — re-verify each against the real source

Each was read out of the stale code. Recheck all of them; the numbering matches the earlier
`HomeHub_QuestionsForHermes.md` so Hermes's answers still map.

| # | Defect | How to re-verify |
|---|---|---|
| **D1** | **Keep-mine silently discards the edit when offline.** `resolveConflict('keep-mine')` removed the conflict from state, force-executed, and inspected the outcome *only* for `conflict`. `offline`/`error` fell through every branch, and the op had never been in `pending` — so nothing remained anywhere. **No race needed.** | Read `resolveConflict` in the provider. Does the force-overwrite path handle a non-`ok` outcome? Does the op re-enter durable storage? |
| **D2** | **Replay clobbers concurrent work.** Replay snapshotted the queue, worked through it, then assigned survivors back (`setPending(remaining)`), erasing anything queued meanwhile. **Hermes confirmed this race survives `fc6b1fc`.** | Does replay re-read storage each iteration, or iterate a snapshot and write once at the end? |
| **D3** | **Batch removal leaves a duplicate window.** Nothing left storage until the loop finished *and* a React effect committed; a reload mid-replay re-ran everything already applied. For a `POST`, a second row. | Is removal per-operation and synchronous, or batched? `fc6b1fc` reportedly fixed this. |
| **D4** | **Persistence deferred to a React effect** — `saveQueue` in `useEffect`, so nothing was durable at the moment `run()` returned `queued`. Hermes called this "the core defect". | Does `run()` persist synchronously before returning? |
| **D5** | **Conflicts not durable** — a conflict lived only in `useState`, so a reload while the resolution strip was on screen lost both the conflict and the local edit. **Hermes confirmed the candidate did NOT solve this.** | Is a 409'd operation persisted with the server's current value, and skipped by replay? |
| **D6** | **Permanent head-of-line block.** Replay treated any `error` as retryable and stopped, so a deterministic 400 parked at the head and silently froze every write behind it, for ever, with nothing on screen. | Does replay stop on `error`? Is there any bound or dead-letter path? |

### 3.4 The error-policy contradiction — still unresolved upstream

The original prompt said both:

- §2 — a non-retryable `error` is **terminal; remove it**;
- §5 — replay must **stop at the error boundary** "as currently intended".

Hermes confirmed this is not a drafting slip: `fc6b1fc` itself has the same tension —
`executeDurableOp()` removes every outcome except `offline`/`cancelled`, while `replay()` still
retains on `error`. Depending on subsequent React persistence, that can remove an op and then
reintroduce it.

**Agreed policy** (Hermes's words, matching the recommendation made here):

- deterministic 4xx → **terminal**: remove, surface the server's message, fire `homehub:sync` to
  reconcile the optimistic UI, show a visible failure notice;
- `409` → the dedicated conflict path, not generic error;
- `404` → terminal/gone; remove and resync;
- `408`, `429`, transient 5xx → **retryable**, bounded, with backoff;
- network failure → retryable/offline, and **must not** spend the retry budget (this panel is
  offline as a matter of course);
- abort from an intentional session transition → retain exactly once for the authenticated owner,
  where that architecture exists.

**This still needs applying on the authoritative line even if `fc6b1fc` is present.**

### 3.5 What the stale implementation actually built

For reference only. Files in the stale tree:

- `client/src/app/writeQueue.ts` — rewritten: durability rules as pure functions over an injected
  `QueueStore`; `persistAhead` (in-place upsert, so re-persisting does not shuffle an op behind later
  writes and break FIFO); `removeOp`/`updateOp` re-reading storage every time; `executeDurably`
  (ownership check → persist → send → terminal removal); `replayQueue` re-reading each turn;
  `isRetryable` splitting 408/429/5xx from deterministic 4xx; `MAX_ATTEMPTS = 5`; a durable `dropped`
  collection with per-entry reason; legacy quarantine.
- `client/src/app/WriteQueueProvider.tsx` — thin coordinator; per-profile store; durable conflicts
  derived for the UI; keep-mine on the durable path with `baseVersion` cleared; in-flight id tracking
  so write-ahead does not blink the pending bar on every tap.
- `client/src/app/App.tsx` + `client/src/components/ledger.css` — a "did not go through" strip listing
  each set-aside write by label and reason, dismissible.
- `client/src/app/writeQueue.test.ts` — 26 tests, node environment, no new dependencies.

Gates in the stale copy: 270 tests passing (244 baseline + 26), oxlint clean, `tsc -b && vite build`
green.

### 3.6 What is genuinely additive — keep this even if `fc6b1fc` is present

Per Hermes's own answers, these are **not** solved by the candidate line and remain open work:

1. **D1** — keep-mine offline data loss.
2. **D2** — the replay/concurrent-enqueue race (explicitly confirmed as surviving `fc6b1fc`).
3. **D5** — durable conflicts.
4. **The §3.4 error policy** — including the removal of unbounded stop-and-hold.
5. **Visible reconciliation** — the `dropped` collection unifying three failure classes
   (legacy-orphaned, retry-exhausted, deterministically-rejected) into one dismissible notice. This
   was invented here, not ported; it is what stops "fail closed" meaning "vanish silently". Worth
   keeping in any architecture.
6. **Keep-mine durability detail** — clearing `baseVersion` when the household chooses keep-mine, not
   merely passing `forceOverwrite`. Otherwise an offline resolution is replayed later by the ordinary
   path still carrying its original version, conflicts again, and asks the same question twice.

### 3.7 Known limit — state it, do not claim past it

Client-side ordering **cannot** deliver exactly-once after an ambiguous network result. If the server
commits a `POST` and the response is lost, replay still duplicates it. Creates need a
server-recognised idempotency key. Hermes notes the care domain has a `clientKey`; other create
domains may not. That is separate `.NET` work and the only thing that closes the window.

---

## 4. Part B — the PIN / lock screen redesign

### 4.1 What exists in the stale tree

Written by Claude Design on 2026-08-17, 11:01–11:03. All untracked or uncommitted:

- `client/src/screens/LockPinSheet.tsx` *(new)* — the PIN sheet raised over a scrim, headed by the
  chosen person's name.
- `client/src/screens/lockGating.ts` *(new)* — gating rules extracted so they are testable:
  `rowAction` (`hasPin` → `enter-pin` | `sign-in`), `CLOSED` sheet state, `profileCount`, `rowMeta`,
  `pinSubline` (which also carries the 5-attempt/30s cooldown text).
- `client/src/screens/lockGating.test.ts` *(new)*.
- `client/src/screens/LockScreen.tsx` *(rewritten)* — renders the sheet at line ~188.
- `client/src/components/PinPad.tsx`, `client/src/components/ledger.css` *(modified)*.
- `client/src/screens/SettingsScreen.tsx`, `client/src/components/DashboardHeader.tsx` *(modified)*.

Design intent, from the code's own comments: **choose a person, then enter a key** — an ordering the
previous screen did not enforce. The old meta slot read `ELEANOR'S PIN REQUIRED` before Eleanor had
been chosen; `profileCount` now counts the list and never names anyone.

One correctness note already folded in: `rowAction` uses `hasPin` alone, **not**
`requirePinWhenIdle && hasPin`, matching `SessionProvider.needsPinToSignIn`. Conflating the two signs
a profile in with no PIN and then reports that its PIN was wrong. Preserve that.

### 4.2 The divergence that must be resolved

The authoritative `LockScreen.tsx` contains a change the stale rewrite does not: a message shown when
PIN verification fails with something **other than** HTTP 401 —

```
NO CONNECTION · PIN CANNOT BE CHECKED
```

Verified absent from the entire stale `client/src`.

**Therefore: the redesign cannot simply replace the authoritative `LockScreen.tsx`.** Doing so
silently reverts that error-path fix, which is currently live on TEST. Fold the non-401 branch into
the redesigned sheet — `pinSubline` is the natural home for it, since it already owns the cooldown
message and is the only surface that can explain why the keys stopped answering.

### 4.3 Checks before porting

- Does the authoritative `LockScreen.tsx` differ in any *other* way from `9b10553`?
- Does the authoritative tree already have its own `lockGating`/`LockPinSheet` equivalent?
- Do `PinPad.tsx` / `ledger.css` differ there? (Hermes reported `PinPad.tsx` unmodified on DEV, but
  re-check — that report was about the promotion snapshot, not necessarily current HEAD.)
- Does `ProfileDto` still expose `hasPin` and `requirePinWhenIdle` with the same meaning?

### 4.4 Why it never appeared on TEST

Not a caching problem. The code has never existed on the server, was never committed, and postdates
the newest local deploy artifact by eight days. Hermes's point about a kiosk tab running its old
bundle until a hard refresh is true in general but irrelevant here — no refresh surfaces code that
was never built.

---

## 5. Where the stale implementation is likely *wrong* for the real checkout

Read this before reusing any of §3.5.

1. **Storage layer.** The stale work uses plaintext `localStorage` keyed
   `homehub.writequeue.v2.<profileId>`. If `privateStorage.ts` exists, that is **wrong** — the queue
   belongs in the encrypted per-profile vault, and introducing a plaintext key alongside it would be
   a security regression. The `QueueStore` interface should adapt cleanly; the `localQueueStore`
   implementation should not survive.
2. **Legacy migration.** The stale work quarantines `homehub.writequeue.v1` itself. `51d614b`
   reportedly already removes it. Do not do it twice, and do not resurrect a key the authoritative
   line has deliberately dropped.
3. **Abort / `cancelled`.** The stale work deliberately adds none, because nothing there aborted a
   queued write. If the real checkout has abort plumbing and a `cancelled` outcome, `executeDurably`
   must treat `cancelled` as **non-terminal, retained exactly once** — and the terminal-write decision
   must complete before session-transition code closes the owning profile's vault.
4. **Session coupling.** The stale work adds no `SessionProvider` ↔ `WriteQueueProvider` coupling,
   correctly, as there was no storage to drain. If `closeQueueExecution()` exists, ordering becomes
   real: apply privacy/UI state → abort and drain active executions while the old owner's vault is
   still writable → wait for every terminal write-ahead decision → *then* close storage and forget
   key material.
5. **Test harness.** The stale copy had no `vitest.config.ts`, no jsdom, no testing-library — all 244
   tests pure-logic in a DOM-less node environment. The pure-function-plus-injected-store design was
   chosen *because of that constraint*. If the real checkout has a DOM environment, the design is
   still preferable (it tests observable queue contents rather than React internals) but is no longer
   forced.

---

## 6. What not to do

- **Do not** `git apply` or hand-copy the stale diffs.
- **Do not** overwrite `writeQueue.ts` or `LockScreen.tsx` wholesale. Both are known to differ.
- **Do not** assume a defect in §3.3 still exists — verify each.
- **Do not** re-add write-ahead if `fc6b1fc` is present. Check first.
- **Do not** ship durability onto a queue that still lacks ownership. That ordering is the one thing
  Hermes was most insistent about, and it is right.
- **Do not** claim exactly-once. See §3.7.

## 7. Gates

In the stale copy: `npm test`, `npm run lint`, `npm run build` (`tsc -b && vite build`), all in
`client/`. No separate typecheck script. A `.NET` run was **not** required for a client-only change —
but it becomes required if idempotency keys or server-side duplicate suppression are added.

Confirm the real checkout's gates rather than assuming these carry over.

## 8. Ask Hermes for

1. `git log --oneline` on `/srv/dev/homehub`, to establish which of the six candidate commits landed.
2. The current `client/src/app/writeQueue.ts` and `WriteQueueProvider.tsx` from that checkout.
3. The current `LockScreen.tsx`, or its diff against `9b10553`, so the non-401 branch can be folded
   into the redesign.
4. Whether `privateStorage.ts` is present and what its read/write surface looks like.
5. Confirmation of which of D1–D6 are already fixed there.

## 9. Companion documents in this stale tree

- `HomeHub_ChangePrompt.md` — the original task prompt. **Retracted by its author**; do not
  implement as written.
- `HomeHub_QuestionsForHermes.md` — the 15 questions and Hermes's full answers. The most useful of
  the three; §D and §C of the answers are the load-bearing parts.
- `HomeHub_LessonsLearned.md` — post-mortem on the hand-off failure.
