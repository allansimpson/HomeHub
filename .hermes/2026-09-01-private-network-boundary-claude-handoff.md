# Handoff: the private-network boundary — H1, H2, H4, H5

**From:** Claude · **To:** Hermes (Geist) · **Date:** 2026-09-01
**Supersedes** the earlier version of this file, which covered only the exact method-and-path change.

**H3 is closed and was not reimplemented or touched**, per your reconciliation.

---

## HEAD

| | |
|---|---|
| **Reviewed commit (your inventory)** | `1324cb6d18e5a9a44aad5d90e2f4085241598b53` |
| **Ending** | `28da029` — plus this document's own commit |
| `origin/main` | `dc7d026` — **nothing pushed** |

Unpushed commits now come from **two** Claude Code sessions working in this one checkout. I have not
pushed, because publishing another session's work is not mine to do. **Worth settling before you cut
an artifact**, given the rule that changed bytes invalidate a candidate.

### My commits since `1324cb6`

| | |
|---|---|
| `76152f1` | H5 — the picker gets four fields |
| `3bc69c7` | H4 — every authenticated 401 closes the boundary |
| `19380c9` | H2 — subject/epoch binding, and drain on transition |
| `28da029` | H1 — device-only mounts the Care log, not the application |
| `f5532bb` | Committed the working tree at Allan's instruction — see the caveat at the foot |

---

## Changed files

Thirteen, mine. Everything else in the range belongs to the concurrent session.

**Client** — `api/privateNetwork.ts`, `api/privateNetwork.test.ts`, `api/client.ts`,
`api/client.test.ts`, `api/types.ts`, `app/OfflineCare.tsx` *(new)*, `app/PrivateSession.tsx`,
`app/SessionProvider.tsx`, `screens/SettingsScreen.tsx`

**Server** — `Controllers/ProfilesController.cs`, `Profiles/ProfileDtos.cs`,
`tests/AuthBoundaryTests.cs`, `tests/ProfilesApiTests.cs`

---

## H1 — device-only mounts the Care log, not the application

`PrivateSession` rendered the same children for `offlineCare` and `confirmed`. I had argued that was
safe because nothing could be fetched; the argument was wrong for the reason you gave, and the
reasoning is worth keeping: **"the server is currently unreachable" is a fact about this second, not a
capability boundary.**

`OfflineCare` mounts **one screen and no providers**.

- **Not the router.** Rendering `App` with providers suspended leaves every other screen reachable and
  empty, and each is a promise the panel cannot keep without a server. It would also put "may this
  screen run" back inside eleven components.
- **Not `CareScreen`.** That reaches `useCareSubjects`, hence `useBaby` and `useLitter` — two
  authenticated polling providers, which is exactly what this excludes. `CareLogView` needs only the
  connection and the write queue, both above the gate; the queue is owner-bound and stays suspended
  until the server confirms.
- The child's name is absent because it lives in `/api/settings`, which is private and uncached. The
  log reads `Baby`, which is what an offline care session has always shown.

---

## H2 — requests bound to the identity that authorised them

`authorizedFetch` checked one module-global Boolean *when a request started* and never again.
"Somebody is confirmed" is not "the same somebody who asked for this".

The boundary now carries a **subject and an epoch**. Every transition advances the epoch, **including
confirming** — signing in replaces the cookie exactly as signing out does. A request captures the
epoch at the start and is checked at the end; a mismatch is refused **before the body is read**,
because that response was produced for whoever the cookie names now.

`closeAndDrainPrivateNetwork()` shuts the boundary, aborts everything in flight, and **awaits its
unwinding**. The awaiting is the substance: `abort()` returns before a request's own `catch`/`finally`
has run, so a transition proceeding straight after would race the teardown it just requested. It is
awaited inside `duringSessionTransition`, which every sign-in, sign-out, unlock and profile switch
already passes through. Sign-in still works with the boundary shut, since `POST /session` may precede
confirmation.

Locking closes and aborts without awaiting — both are synchronous inside the drain, so nothing new
starts and everything running is cancelled the moment the panel locks.

The caller's own signal survives: the JSON helper's watchdog and the Assist stream's Stop are combined
with the boundary's controller via `AbortSignal.any`, not replaced by it.

---

## H4 — every authenticated 401 closes the session boundary

Three of the four transports did not announce a lost session. The JSON helper did; Assist streaming
did not, Assist cancellation swallowed every response and error, and server TTS read a 401 as "TTS not
configured" and fell back to the browser voice. A panel with an expired cookie could hold a stream
open, cancel into the void and keep talking, while the privacy transition never fired.

The announcement moved into `authorizedFetch`, the one place all four meet.

**The wrong-PIN exclusion was `path.includes('/pin')`** — which excuses a 401 from any path with
`/pin` anywhere in it, and an excused 401 is a session loss that never reaches the lock screen. It is
now exact operations: `POST /session`, `DELETE /session`, `PUT`/`DELETE /profiles/{id}/pin`. A test
asserts `/pantry/pinned` is not one.

---

## H5 — the picker gets four fields, not the household's policy

Anonymous `GET /api/profiles` returned `role`, `hasPin`, `requirePinWhenIdle`, `stayLoggedIn`,
`displayOrder` and stable ids. No single field is a secret; the set is a map of who to attack and how
well they are defended.

**`GET /api/profiles` stays anonymous and now returns id, name, initial, `hasPin`.** `hasPin` looks
like policy and is not — the server demands the PIN of any profile that has one, so a picker unable to
ask would simply fail. The full roster moved to **`GET /api/profiles/detail`, `[Authorize]`**.

> **I committed this the other way round first** — the picker on a new path, `/profiles`
> authenticated — and the browser showed why that is worse. Five harness fixtures serve
> `/api/profiles`; moving the anonymous path silently rendered a locked panel in all of them. This
> direction fails soft: an un-updated caller gets *less than it expected* rather than a 401.

Client-side, the policy fields are optional on `ProfileDto`, which is the honest type — they do not
exist before confirmation. Two Settings call sites say what absent means.

**A test asserted this was already safe and passed.** `The_anonymous_roster_leaks_no_secret` checked
only that the PIN hash was absent. Replaced with one asserting on the **wire text** rather than a
deserialised DTO, because a field added to the picker record later is invisible to a typed assertion —
that is exactly how this grows back.

---

## Tests

All in the existing Node Vitest harness. No DOM stack introduced.

| Proves | Where |
|---|---|
| No fetch for Assist stream / cancel / TTS while unconfirmed | `client.test.ts`, `speechBoundary.test.ts` |
| No fetch for `POST /profiles`, `PUT`/`DELETE /profiles/{id}`, `/pin`, `/lock` | `client.test.ts` |
| Queued replay refused pre-confirmation; op retained; sends after | `writeQueue.test.ts` |
| Reconnect as a **sequence**, not two states | `client.test.ts` |
| Query strings cannot turn denied into allowed | `privateNetwork.test.ts` |
| `GET /profiles/detail` denied pre-confirmation; `GET /profiles` allowed | `privateNetwork.test.ts` |
| 401 announces once per outage, on any transport | `privateNetwork.test.ts` |
| A 401 on `/pantry/pinned` is **not** excused | `privateNetwork.test.ts` |
| A reply arriving after the identity changed is discarded | `privateNetwork.test.ts` |
| Drain leaves nothing in flight, and the boundary shut | `privateNetwork.test.ts` |
| Anonymous roster carries no role/lock/session policy | `AuthBoundaryTests.cs` |
| The full roster answers anonymous with 401 | `AuthBoundaryTests.cs` |

The 401 tests use a real `EventTarget` as `window` rather than a spy, so "was it announced" is
answered by the mechanism `SessionProvider` actually listens with.

---

## Verification

```
./scripts/check.sh all

  ok  typecheck          6s
  ok  lint               1s
  ok  tests              4s   Test Files  50 passed (50)
  ok  backend-tests     52s   Failed: 0, Passed: 1157, Total: 1157
```

No count drop. Browser at 540×1169: a device-only panel with every call aborted renders the Care log
and makes **zero** private requests over four seconds; a confirmed panel renders the dashboard; no
page errors either way.

### `git status --short`

Clean.

---

## Remaining raw network primitives

| Location | Classification |
|---|---|
| `app/ConnectionProvider.tsx:119` `/api/health` | **Deliberately public.** Must work when every private feed is gone |
| `app/UpdateProvider.tsx:74` `/build.json` | **Deliberately public.** Static build stamp, not under `/api` |
| `api/privateNetwork.ts:262` | **The primitive itself** — the single authorised egress |
| `app/writeQueue.ts:304` | **Equivalent boundary** — same policy checked directly, preserving abort/deadline/drain |
| `screens/WeatherScreen.tsx:345` rainviewer.com | **External third party, not HomeHub.** Public tile index, no credentials — still wants your separate assessment |

No `XMLHttpRequest`, no `WebSocket`, no `EventSource` (the `EventEditorScreen` matches are a local
interface of that name).

---

## Two bugs the browser found that no suite did

Both mine, both from this session, both invisible to 50 test files:

1. **`if (fullProfiles) setProfiles(fullProfiles)` accepted any truthy body.** A malformed response
   replaced the roster with something lacking `.find` and white-screened the panel. Now
   `Array.isArray`, and the picker's list stays standing.
2. **The endpoint direction in H5**, above.

Recorded because they are the argument for the browser step, not an apology: the client suite renders
nothing, and neither of these was reachable from it.

---

## Caveats you should weigh

- **`f5532bb` committed another session's in-flight work**, at Allan's instruction — including 165
  lines of `CalendarScreen.tsx` I did not write and have not reviewed. I verified the tree was green
  at those exact bytes before capturing it; that is the only assurance the commit carries. Worth
  confirming with its author that it was at a point they would have chosen.
- **Two sessions are committing into one checkout.** Nothing is pushed. Given the changed-bytes rule,
  settle who pushes before cutting the artifact.
- **`ProfileDto`'s remaining shape** — I cut it to four fields for the anonymous path, but did not
  audit `/profiles/detail` against "minimum for an authenticated caller". It is authenticated now, so
  it is a smaller question than it was.

## Not done, by instruction

No deployment, no deployment tooling, no push, no H3. The source-hash correction, installer
transaction repair, fresh DEV → TEST promotion, independent review and production deployment remain
yours.
