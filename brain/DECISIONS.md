# Decisions

Choices that are settled, and why. Append; do not reverse one silently — if it turns out to be
wrong, edit the entry to say so and add the reason underneath.

The test is whether someone would otherwise waste time re-deciding it, or undo it without knowing
what it was for.

---

## 2026-08-21 · A PIN, and the lock it controls, belong to one account only

Nobody may set, clear or re-key another member's PIN, or turn off their idle lock — administrators
included. Allan's call, and it closes a real escalation: an admin could set another member's PIN
without knowing the old one and then sign in as them at the lock screen. A test asserted exactly
that as a feature (`An_admin_can_reset_another_members_forgotten_pin`), which read back is a
demonstration of the hole.

The quieter half was `PUT /profiles/{id}`, administrator-only, which wrote `RequirePinWhenIdle`
straight from its payload — so a member's lock could be dropped without their PIN being touched.
Those two fields are now ignored there for anyone but the caller, and `PUT /profiles/{id}/lock` is
the self-only route that replaces them. Members could not previously set their own at all: editing a
profile was admin-only, so the one setting that is nobody else's business was the one setting only
somebody else could change.

**The cost, and it is real:** there is no longer an in-app recovery for a forgotten PIN. That was
the stated reason the admin exemption existed. Recovery now means the server rather than a tap on
the kitchen wall, and that asymmetry is what makes the lock worth having.

## 2026-08-21 · The shared brain lives in `brain/`, not in dated files

`.hermes/` had grown a file per conversation, which meant neither agent could answer "what is true
now" without reading ten reports. This folder holds six files by *type* and is edited in place.
`.hermes/` stays as an archive of long-form investigations; conclusions come back here.

## 2026-08-23 · Stopping a *pump* session is a hold; the other timed sessions stay a tap

Reverses the note on `CareRunning`, which said nothing on that panel is a hold because both ways out
are plainly labelled and one is reversible by logging the session again. That holds for nursing,
sleep and tummy time — you know roughly when they started, so a mis-tap costs a retype. It does not
hold for a pump: the session's value is the length the panel measured and the amount asked for
afterwards, and once the timer is discarded there is nothing to enter from memory. Both ways out are
guarded, not just `CANCEL` — finishing early truncates the session as surely as cancelling loses it.

Reported from the panel: a knee or a sleeve against the wall unit was ending real sessions.

No extra banner: the notice takes over the slot the warning already had. `Stopping · These are not
the same` was the right caution while both cards were one tap, because the risk then was picking the
wrong one of two adjacent controls. A held card cannot be picked by accident, so on a pump that line
now reads `Hold either to confirm` — somebody who taps and sees nothing happen needs to be told why,
and it is the only line on the panel that can tell them. It stays amber; at 10px caps a muted grey
disappears, and the row is still the cautionary one. The other timed sessions keep the original
warning, where the two-controls risk is the live one. What the two cards *do* differently is stated
in full either way, in the sentence under each name.

The rule is `holdsToStop` in `app/care.ts` rather than an inline `type === 'Pump'`, so a fifth timed
type has somewhere to be argued about, with `care.test.ts` covering every member of `TIMED_TYPES`.

## 2026-08-21 · Commits go straight to `main`, within the ownership split

History is linear, but authority is scope-based: Claude owns application-code commits; Geist owns
deployment and may commit deployment-owned or shared-brain material. Neither stages the other's
work. A branch-and-PR flow would leave Allan merging his own agents' work. Announce a push in
`STATE.md`.

## 2026-08-20 · Kitchen: the locked specs outrank the screenshots and the code comments

Where `design_handoff_kitchen/specs/*.md` and a PNG disagree, the spec is newer. Two implementations
had drifted and one carried a comment asserting the *opposite* of the spec it cited — `THE WEEK
NEEDS` listed nights when `PLAN_WEEK` §1 says it lists things.

## 2026-08-20 · Row heights inside a cut group are pinned, never `min-height`

The bisected cut is arithmetic — `N × rowH + rowH/2` — and it is only true while the rows really are
`rowH` tall. A floor lets one long name push the cut onto a row boundary, at which point the group
silently reads as a complete list. `RECIPES` §6 records this going wrong three times in one segment.
Enforced by `client/src/app/kitchenCut.test.ts`, which pairs every `CutGroup` with the CSS height of
the rows actually inside it and **fails on anything it cannot resolve** rather than skipping it.

## 2026-08-20 · `CAN'T FIND IT` on the pantry check writes nothing

It changes no number *and* is not a sighting. Refreshing `lastSeenAt` because somebody failed to
find something would stamp the row as confirmed on the strength of its absence. The cost — the row
keeps its place at the front of the next check — is the correct price.

## 2026-08-20 · A source-reading test gets its own tsconfig project

`tsconfig.checks.json` exists so `kitchenCut.test.ts` can use Node's `fs` without adding Node types
to `tsconfig.app.json`. With them in the app project, any component could import `node:fs` and still
typecheck in a browser bundle. (vitest stubs CSS imports to an empty string, so `?raw` cannot read a
stylesheet — `fs` is the only route.)

## 2026-08-19 · The image extractor runs tool-less

The reader for photographs is a private profile with no callable tools, no memory and no delegation,
so printed words in an image cannot reach a tool call. The household's own agent remains reachable
by explicit config but is not the default; Hermes reviewed that path and declined it for production.

## 2026-08-21 · One-time production exception for `20260821T210436Z-5e441552ec32`

Allan explicitly accepted the five known High source findings for this exact TEST release and directed
its exact bytes to production. This is a one-release exception, not removal of the normal
Critical/High production gate. The checksum-pinned privileged installer must still pass its own
independent safety review, preserve rollback, and verify production live.

## 2026-08-22 · One-time production exception for `20260822T121531Z-bcb8362feba6`

Allan explicitly directed the exact current TEST bytes to production while accepting the five known
High application-source findings for this release, as a one-release exception like the prior release.
The normal Critical/High gate remains in force for later releases. The independently reviewed,
checksum-pinned privileged installer retained database backup/restore, application rollback, deep
readiness, migration, trusted TLS, exact bundle/service-worker, and MCP authorization gates; it passed
with no Critical/High installer findings.

## 2026-08-25 · The care cache is sealed rather than purged, and a PIN can be proved offline

The rule was that private persisted data is readable only behind a *currently confirmed server
session*, enforced by purging the care cache on every lock, idle timeout, expired cookie and
offline boot. That rule was right for what it guarded — plaintext JSON in `localStorage` — and it
made the offline case hopeless: a launch out of range destroyed the log on the way to a keypad that
could not be answered, because `SignIn` is the only thing that checks a PIN and the hash never
leaves the server.

Both halves changed together, and neither works without the other:

- **`careVault.ts`** holds one blob per profile, AES-GCM sealed, decrypted into memory at unlock.
  Closing (lock, idle, 401) leaves the blob; only signing out erases it. Reads stay synchronous —
  `useCareLog` seeds state on first render and a log that fills in a frame later says `NO RECORD` at
  4am and then contradicts itself — so only the write back is async.
- **`offlineUnlock.ts`** wraps that blob's data key under PBKDF2(PIN). The right four digits unwrap
  it; the wrong four fail GCM's tag. There is no stored comparison value, so the verifier and the
  thing protected are the same object.

**What this is not.** A four-digit PIN is ten thousand candidates; someone holding the device and
running the KDF themselves gets through it, and the attempt lockout only binds an attacker coming
through our code. The honest claim is that the log is no longer plaintext in a browser store and
casual inspection does not read it — better than a purge, which protected the data by destroying the
feature, and not a vault. Stated at the top of `offlineUnlock.ts` so nobody later reads "encrypted"
as more than it is.

**The queue is deliberately not included.** An offline unlock opens local access to local data and
nothing else: `deviceOnly` keeps write-queue execution shut until `getSession` confirms the identity,
so one member's queued entries can never go out under another's cookie. That confirmation is also
what triggers the replay — the connection returning is *not* the last event in the sequence, and
missing that left entries durable, correct and permanently unsent.

Three cases, not two: a profile with a PIN seals; one without has no secret to seal under and is
stored plainly (it declined the gate); and one that reached an unlocked panel *without* typing its
PIN — `requirePinWhenIdle` off — gets a memory-only session rather than having its records written
back in the clear.

Enrolment reuses the existing data key when the PIN still opens it. Minting a fresh one per sign-in
would silently discard the offline log, queued-but-unsent entries included, on every ordinary
unlock. Verified end to end in a browser: `artifacts/offline-care-verification/`.

## 2026-08-31 · The bisected cut and the full-bleed band are gone, by handoff

Both were locked decisions with reasons recorded in the code, and both were reversed on purpose by
`design_handoff_kitchen_lists/` (Allan, supplied as a zip; it supersedes the divider and Pantry-list
portions of `design_handoff_kitchen`, and says so in its own README). Recording it here because the
old reasoning is good and will otherwise be re-argued by whoever reads `PANTRY_SHELVES` §1 next.

**The cut** — a group sized `N × rowH + rowH/2` so the next row is visibly bisected, the section's
only scroll affordance — was right about the thing it solved: a height landing on a row boundary
clips padding and the group then reads as a complete list. What it could not solve is that four such
groups on one panel showed sixteen of forty-one rows and *no* group could be read to its end. The
new bundle removes every fixed-height group window and gives each screen one scrolling region. The
trade is explicit: you lose the glance across four shelves and gain the ability to finish reading
one, and on the Pantry the shelf switch's counts are what preserve the glance.

**The band** — full-bleed, tinted, 3px brass stub, 11px/0.3em caps, rows shaded beneath it — is
replaced by a hairline divider that keeps the gutter: a 19px Marcellus name in sentence case, a rule
to the count. `box-shadow: inset 0 20px 16px -18px` is deleted everywhere and §1 says not to
reintroduce it.

**Two panels keep neither.** The Kitchen home and Add-to-pantry panels ship byte-identical to the
previous handoff and draw plain heading rows — brass label, door opposite, no rule. The build had
them on `.ml-band`, which *neither* handoff ever drew there, so the change is a correction rather
than an exemption. `.ml-kitchen__homehead` exists for exactly those two.

**What is now unbaselined:** `artifacts/handoff-sweep/`'s geometry passes measure against the old
`.dc.html` files. Every band and cut finding in them is stale until they are pointed at the new
bundle. The text pass is mostly unaffected; the geometry pass is not.

## 2026-09-01 · The pantry writes `½ pot`, reversing the decision against it

`trimNumber` carried an explicit decision in its own docblock: a pantry count is a number of packs
read off a shelf, so rendering `2.5` as a fraction would dress a stock figure up as a recipe amount.
`STATE.md` had listed the resulting `0.5 pot` as **open, needing a ruling rather than a quiet
reversal** — because the code disagreeing with a signed-off spec is not something to fix by
preference.

Allan ruled on 2026-09-01: follow the spec. `PANTRY_SHELVES` §2 draws `½ pot`, and so do both Pantry
drawings in `design_handoff_kitchen` and `design_handoff_kitchen_lists` — six occurrences across the
two bundles, plus `½ pot turning` on the List panel. The old reasoning was defensible and was
costing the section the one notation a person actually uses out loud about a half-full jar.

**Only exact fractions convert, and exactness is judged at three decimal places** — the precision the
value was already rounded to. `0.667` is `⅔`; `0.67` stays `0.67`. A quantity written as a decimal
does not acquire a fraction it was never given, which is the same rule `mealsDomain.formatAmount`
applies to a scaled ingredient, and nothing is forced to the nearest eighth: a shelf count has no
equivalent of a recipe's "near enough". Mixed numbers are set tight (`1½`), as the handoff draws.

**It reaches one place beyond the shelves, kept on purpose.** `usageAmount` renders a recipe's pack
figure through the same helper, so `30 oz · 2.5 cans` is now `30 oz · 2½ cans`. That is the same
count on the same shelf as the row above it, and half a can is exactly what `½` is for.

Reversals are cheap to make and expensive to discover, so: the argument against fractions is
recorded above rather than deleted, and it is still the right argument for anywhere a pantry figure
is compared down a column rather than read aloud.
