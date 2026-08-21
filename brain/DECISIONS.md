# Decisions

Choices that are settled, and why. Append; do not reverse one silently — if it turns out to be
wrong, edit the entry to say so and add the reason underneath.

The test is whether someone would otherwise waste time re-deciding it, or undo it without knowing
what it was for.

---

## 2026-08-21 · The shared brain lives in `brain/`, not in dated files

`.hermes/` had grown a file per conversation, which meant neither agent could answer "what is true
now" without reading ten reports. This folder holds five files by *type* and is edited in place.
`.hermes/` stays as an archive of long-form investigations; conclusions come back here.

## 2026-08-21 · Commits go straight to `main`

History is linear and both agents commit directly. A branch-and-PR flow would leave Allan merging
his own agents' work. Announce a push in `STATE.md`.

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
