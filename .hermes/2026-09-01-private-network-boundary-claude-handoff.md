# Handoff: exact method-and-path authorization for the private-network boundary

**From:** Claude · **To:** Hermes (Geist) · **Date:** 2026-09-01
**Brief:** the source-code security remediation blocking HomeHub production promotion.

---

## Preconditions

All six confirmed as briefed. **No discrepancy report.**

| Precondition | Observed |
|---|---|
| Observed HEAD `3b84cb8ad53907104fe69a8d0d46b2f3b47f8f3b` | Matched exactly |
| Existing unrelated modification `brain/DEPLOYMENT.md` | Present (20 insertions, 17 deletions) |
| `PrivateSession` mounts the app subtree in both `offlineCare` and `confirmed` | True — only `locked` returns `<LockScreen />` |
| `client.ts` gates ordinary requests on `privateNetworkConfirmed` | True |
| Allowlist used `path.startsWith(...)` | True, `client.ts:232` |
| `streamAssistTurn` / `cancelAssistTurn` call `fetch()` directly | True, `client.ts:389` and `:816` |
| `speech.ts` calls `/api/voice/speak` directly | True, `speech.ts:190` |
| Vitest is Node-based with no DOM renderer | True |

One environment note, not a discrepancy: the brief gives the checkout as
`/workspace/homehub-dev`; this work was done in `/srv/dev/homehub`, which is the same repository and
the same HEAD.

---

## HEAD

| | |
|---|---|
| **Starting** | `3b84cb8ad53907104fe69a8d0d46b2f3b47f8f3b` |
| **Ending** | `1324cb6d18e5a9a44aad5d90e2f4085241598b53` |
| **Tree** | `3fd682efd67a83f4d16ecbdc9286c6d727fa9943` |

**Not pushed.** `origin/main` remains `dc7d026`. Your two commits `c14717c` and `3b84cb8` are
unpushed and are not mine to publish, so the push is left to you.

---

## Changed files

Nine, each staged by name. No `reset`, no `clean`, no blanket-stage.

| File | |
|---|---|
| `client/src/api/privateNetwork.ts` | **new** — the policy, the flag and the transport primitive |
| `client/src/api/privateNetwork.test.ts` | **new** |
| `client/src/app/speechBoundary.test.ts` | **new** |
| `client/src/api/client.ts` | delegates to the policy; both Assist paths use the primitive |
| `client/src/api/client.test.ts` | call-site proofs |
| `client/src/app/speech.ts` | server TTS through the primitive |
| `client/src/app/writeQueue.ts` | policy check before the durable send |
| `client/src/app/writeQueue.test.ts` | boundary coverage; existing tests confirm explicitly |
| `client/src/app/PrivateSession.tsx` | comment corrected |

---

## Design

### 1. Exact method-and-path authorization

The prefix was the defect, not merely imprecise. `startsWith('/profiles')` reads as *"the picker may
draw the roster"* and means *"anything under `/profiles`, by any method"*, so an unlocked but
server-unconfirmed panel could reach:

- `POST /profiles` — create a member
- `PUT /profiles/{id}` — rename, reorder, **change role**
- `DELETE /profiles/{id}`
- `PUT` and `DELETE /profiles/{id}/pin`
- `POST /profiles/{id}/lock`

Reading the roster to offer a sign-in does not license writing to it, and a prefix cannot tell those
apart.

Authorization is now a **normalised HTTP method and an exact pathname**, deny-by-default. Query and
fragment are stripped before matching, so a query string cannot widen authorization; a trailing slash
is normalised, so it cannot dodge it; a descendant route is a different operation that must be listed
on its own or be refused. Methods are upper-cased and default to `GET`, as `fetch` does. Paths are
**not** case-folded — server routes are case-sensitive, and folding here would authorise something the
server treats as a different endpoint.

**The four pre-confirmation operations, each with a reason true before authentication:**

| Operation | Why it must precede confirmation |
|---|---|
| `GET /profiles` | The picker draws the roster before anyone signs in; there is no way to offer a sign-in without it |
| `GET /session` | "Is this device signed in" must be answerable when the answer is no |
| `POST /session` | This *is* the confirmation step — gating it makes the boundary unopenable |
| `DELETE /session` | Sign-out, including recovery from a stale session a panel cannot otherwise escape |

**`/health` and `/build` were removed — they were dead entries.** Nothing routed them through the
gated helper: `ConnectionProvider` fetches `/api/health` directly and `UpdateProvider` fetches
`/build.json` (not even under `/api`). Both are unauthenticated by design.

### 2. One transport primitive, and the one deliberate exception

`authorizedFetch(path, init)` is the only way to reach an authenticated HomeHub endpoint. It
normalises, checks, and either throws `PrivateNetworkError` **before opening a connection** or
prefixes `/api` and fetches. It is used by the JSON helper, `streamAssistTurn`, `cancelAssistTurn`
and server TTS.

A check at each call site is a rule somebody has to remember. A primitive is a rule they have to
circumvent — a future caller reaching for `fetch` is refused by not being on the list, rather than by
someone forgetting to add a check.

**`writeQueue.executeDurably` is the exception, and deliberately so.** It owns a send deadline, an
abort controller a profile transition can pull, and an outcome vocabulary deciding whether an
operation is retained, retried or set aside. Routing it through a JSON-only helper would cost all of
that, exactly as the brief warned. It therefore inherits the *policy* rather than the transport, and
reports a refusal as `offline` — which is what it is from the queue's point of view: not sent, still
owed, retained for retry. Any new outcome would be a second vocabulary for a condition the queue
already handles correctly.

**This closes a genuine hole.** `WriteQueueProvider` already refused to *replay* while locked or
device-only, but a fresh write goes straight to `executeDurably`, so connectivity returning before
confirmation would have sent it under a cookie nobody had checked. Connectivity returning is not
authorization.

### 3. Queued-write safety — verified, not assumed

| Property | Finding |
|---|---|
| Execution closed before cookie/profile transitions | Already enforced by `closeQueueExecution`; existing test intact |
| Active requests aborted and drained | Already enforced; existing drain test intact |
| Replay disabled while locked or device-only | Already enforced in `WriteQueueProvider` (`locked \|\| deviceOnly`) |
| Reconnect cannot replay before confirmation | **Was reachable via `executeDurably`; now closed** |
| An operation executes only for its confirmed owner | Already enforced by `canExecuteQueuedOp` — `queueIdentity != null && op.ownerProfileId === queueIdentity` |

Four of five already held. Only the reconnect path needed fixing, and it was fixed atomically with
this change.

### 4. Corrected documentation

`PrivateSession.tsx` claimed the mounted tree was safe *"because every private call passes through
`request()`"*. **That was false when written, in two ways at once**: four authenticated paths went
round the helper, and the allowlist it relied on matched prefixes. The comment now names what is
actually enforced and where.

---

## Tests added

Each proves **no request was made**, not merely that one failed.

| Test | Proves |
|---|---|
| `client.test.ts` › starts no Assist stream while unconfirmed | Assist streaming blocked |
| `client.test.ts` › sends no Assist cancellation while unconfirmed | Cancellation blocked, and does not throw at the call site — a Stop that explodes is worse than one with nothing to cancel |
| `speechBoundary.test.ts` › sends nothing while unconfirmed | Server TTS blocked, browser-voice fallback preserved |
| `client.test.ts` › refuses the profile writes the prefix allowlist admitted | `POST /profiles`, `PUT`/`DELETE /profiles/{id}`, `/pin`, `/lock` |
| `client.test.ts` › still lets the picker read the roster | Exact `GET /profiles` remains available |
| `client.test.ts` › coming back from device-only *(existing)* | Reconnect: nothing private starts until confirmation, then everything does |
| `writeQueue.test.ts` › does not send while unconfirmed | Queued replay blocked pre-confirmation; op retained; outcome `offline` |
| `writeQueue.test.ts` › sends once confirmation arrives | Nothing lost in between |
| `privateNetwork.test.ts` › what the prefix version wrongly admitted | Every write under `/profiles`; descendants; alternate methods |
| `privateNetwork.test.ts` › normalisation cannot widen authorisation | Query strings, fragments, trailing slashes |
| `privateNetwork.test.ts` › the transport primitive | Refuses before connecting; prefixes `/api`; opens on confirmation; **closes again when lost** |
| `privateNetwork.test.ts` › agrees with the predicate | Primitive and predicate cannot drift apart |

Existing `writeQueue.test.ts` cases now confirm the boundary explicitly in `beforeEach` and close it
in `afterEach`, so a leaked-open flag cannot hide the regression this exists to catch.

No DOM test stack was introduced. The policy is pure and tested directly.

---

## Verification

```
./scripts/check.sh all

--- check: all ---
  ok    typecheck          6s
  ok    lint               0s
  ok    tests              4s   Test Files  50 passed (50)
  ok    backend-tests     50s   Failed: 0, Passed: 1156, Skipped: 0, Total: 1156
```

**No count drop.** Client 47 → 50 files (+3 mine). Backend 1145 → 1156 (your additions in
`c14717c`/`3b84cb8`; none of mine).

### `git status --short`

```
 M brain/DEPLOYMENT.md
```

**`brain/DEPLOYMENT.md` was not modified by me** — it is your 20+/17− edit, never staged, never opened
for writing. It is the only entry, and the tree is otherwise clean.

---

## Remaining raw network primitives

Every occurrence in the final client source, classified.

| Location | Call | Classification |
|---|---|---|
| `app/ConnectionProvider.tsx:119` | `fetch('/api/health')` | **Deliberately public.** Unauthenticated health check; must work on a panel where every private feed is gone |
| `app/UpdateProvider.tsx:74` | `fetch('/build.json')` | **Deliberately public.** Static build stamp, not under `/api`; whether a newer panel is served is a fact about the server's files |
| `api/privateNetwork.ts:129` | `fetch(\`/api${path}\`)` | **The primitive itself** — the single authorised egress |
| `app/writeQueue.ts:304` | `fetch(url)` | **Protected by an equivalent boundary** — the same policy checked directly, preserving abort/deadline/drain |
| `screens/WeatherScreen.tsx:345` | `fetch('https://api.rainviewer.com/…')` | **External third party, not HomeHub.** Public tile index, no credentials, unaffected by session state — see the note below |

No `XMLHttpRequest`. No `WebSocket`. The `EventSource` matches in `EventEditorScreen.tsx` are a
**local interface of that name**, not the browser API — a grep false positive.

---

## Two things for your review

**1. The rainviewer call needs your separate assessment.** It is not an authenticated HomeHub call
and is correctly outside this boundary, but it is an outbound request to a third party from a
household panel, and you asked for that to be assessed separately rather than folded in here.

**2. I did not audit `ProfileDto`'s shape.** `GET /profiles` remains the widest entry on the list and
is the one worth re-reading. Your third verification point asks that it expose only minimum picker
data — no roles, PIN or security metadata, private settings, or unnecessary stable identifiers. That
is a server-side DTO question inside your review's scope, and I left it rather than guess at what the
picker needs. It may currently carry `role`.

---

## Not done, by instruction

No deployment, no deployment tooling, no push. The source-hash correction, installer transaction
repair, fresh DEV → TEST promotion, independent review and production deployment remain yours.
