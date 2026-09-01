# State

What is true right now. **Overwrite this file** — it is a snapshot, not a log. Anything worth
keeping once it stops being current belongs in `DECISIONS.md` or `INCIDENTS.md`.

_Updated: 2026-08-31T21:05Z by Claude and Geist. Deployment facts were live-verified by Geist; code
work-in-flight notes remain Claude's._

**Everything previously marked "working tree only" is now committed as `9eed27e` and pushed.** It is
still unshipped — nothing deploys on push, so the household has none of it until Geist promotes a
build. The notes below are unchanged apart from that status; they describe what is built, not what is
running.

## Source

| | |
|---|---|
| Branch | `main` |
| `HEAD` / `origin/main` | `9eed27e` / `9eed27e` (0 ahead, 0 behind) |
| Working tree at verification | Clean. The 151 paths that had accumulated were committed as `9eed27e` at Allan's direction — one commit rather than eight, deliberately |
| Verified at that commit | `./scripts/check.sh all` green: typecheck, lint, 872 client tests across 45 files, 1121 backend tests, and the production build. No visual verification was run — the client suite renders nothing |
| Coordination state | `.git/index` restored to `simpson:geist-dev` (UID 1000/GID 989), mode 0660, after the promotion workflow exposed and corrected its direct-gitdir ownership defect. |

## Deployed

| Environment | Live state at 2026-08-31T11:38Z |
|---|---|
| TEST | Release `20260831T105206Z-09cfd47e8477`; active and healthy; deep health and HTTPS 200; DB `ok`; pending migrations `0`; migration head `20260827205336_AddWeatherAlertProduct`; build `a66e80a+ · 2026-08-31 10:52Z`; bundle `index-D3pqF7Ee.js`; live bundle/service worker match artifact |
| Production / panel | Same exact release and artifact bytes as TEST; active and healthy; trusted HTTPS and deep health 200; DB `ok`; pending migrations `0`; bundle/service worker match artifact; MCP/TLS/loopback gates passed; gateway restarted and stable |
| Gap | TEST and production now run the same immutable bytes. This production use was Allan's one-release application-security exception; the ordinary gate remains in force for the next release. |

## Waiting to ship

Nothing deploys on push. Claude hands a verified code state to Geist; Geist snapshots and promotes it
through the process in `DEPLOYMENT.md`. `scripts/deploy.sh` is not the active route.

**`9eed27e` is the state being handed over**, and it is the first one that is a commit rather than a
dirty tree — eight pieces of work, listed under In flight below. The production gate still stands:
the five High source findings under Blocked have not been touched, so this is a TEST candidate.

TEST release `20260831T105206Z-09cfd47e8477` is also running in production under the recorded one-release exception; its original manifest remains TEST-only.

## In flight

- **The Kitchen's section bands are dividers, and the Pantry shows one shelf** (2026-08-31, committed `9eed27e`,
  not deployed). Built from `design_handoff_kitchen_lists/`, which Allan supplied as a zip and which
  says in its own README that it supersedes the divider and Pantry-list portions of
  `design_handoff_kitchen`. Everything else in that package still stands.
  **Three changes, and the second is the one with reach.**
  1. The full-bleed band is a hairline divider — 19px Marcellus, **sentence case**, rule to a mono
     count, gutter kept, no fill, no stub, no inset shade. `KitchenDivider`, 49 uses across 19
     screens. Amber is time pressure only.
  2. **Every nested per-group scroller is gone.** `CutGroup`, `CutFitProvider`, `cutFit` and
     `cutHeight` are deleted; `ScrollArea` is now the only scrolling region on a Kitchen screen. The
     reversal and the reasoning are in `DECISIONS.md` — this was a locked decision, not drift.
  3. The Pantry is a shelf switch — `SOON · FRIDGE · CUPBOARD · FREEZER`, one shelf full length, no
     dividers, no `All`. Search stays global across all four and every result says which shelf.
  Also: `SHOP · n THINGS` is pinned outside the scroller via a new `ScreenShell action` slot. It was
  inside it, under fourteen lines of shopping — the control for acting on the list was reachable
  only after scrolling past everything it acts on.
  **Two panels deliberately keep plain heading rows**: Kitchen home and Add-to-pantry ship
  byte-identical to the previous handoff and draw a brass label with a door opposite, no rule. The
  build had them on `.ml-band`, which neither handoff ever drew there.
  **Two open questions from the README answered, both stated rather than assumed.** The landing
  shelf is Soon when something is turning and Fridge otherwise — Soon is the one shelf that can be
  empty, and opening on an empty panel is the failure the alternative was guarding against;
  last-used needs somewhere to persist and is not built. And while a search term is typed the run is
  replaced by a `Found on the shelves` divider, because a switch claiming to show one shelf above
  results drawn from four is claiming to filter something it is not.
  Verified in a browser: 23 routes re-captured (`capture-kitchen.js`, 0 page errors, 0 cuts, no
  overflow) plus `probe-dividers.js` (new) reading **computed** colours, sizes and tracking back
  rather than token names — the two amber tokens are new and a property that resolves to nothing
  looks exactly like a rule that never applied. It caught three things: a dead `ml-cut` class still
  on three chip rows, and two assertions of my own that were wrong rather than the code.
  **The harness was serving an empty grocery list**, so `THE LIST` — the panel that owns the pinned
  action bar — had never been photographed with content. Fixtures added, same fault as the item
  sheet and run-a-check before it. Note also that `capture-summary.json` in that directory is a
  stale artefact from 2026-08-20; the harness writes `captures/results.json`, and reading the wrong
  one cost me a false "4 routes still have cuts".
- **The pump's START SESSION is verdigris, and that departs from the handoff** (2026-08-31, committed `9eed27e`,
  not deployed). Asked for by Allan against a screenshot of the design project — "increase visibility"
  — so this is a **deliberate change to a signed-off spec at his direction**, in the same class as
  the weather alert's §1 departure, not a correction of a build that had drifted.
  The build was exactly right before: `design_handoff_baby/README.md` draws 1px `#5c5342` on
  `#1c1a15`, 58px, a 14px `#e8e4dc` label, and that is what was there. **The problem is that the
  spec is right about the button and wrong about its neighbours** — every other control on the sheet
  is brass on near-black (both phase steppers, the typed route's steppers, the quick amounts, SAVE),
  so the one button most people open the panel to press was drawn in the register of the rows around
  it and read as another row.
  Now `--bg-live-soft` / `--live-dim` / `--live-text`, 68px, a 16px label, note in `--live-accent`.
  Verdigris is the app's LIVE/OK accent and *never decorative* (`tokens.css`), which this passes on
  the only reading that matters: pressing it is what makes a session live, and the running panel it
  opens is already verdigris. Size moved with the colour because this is read at arm's length on a
  wall panel, where the box is resolved before the hue is.
  **Two things came with it, and both were latent rather than new.** The button had *no* `:disabled`
  rule at all — survivable in brass, not survivable once it is loud, since it is disabled for the
  length of every write. And it had only a top margin, so a 68px block sat 11px off `OR LOG ONE YOU
  FINISHED` and read as that section's header; it has `1.25rem` both sides now, given on the button
  rather than on `.ml-caresheet__label`, which every panel in the app shares.
  **`.ml-caresheet__begin` is shared with the one-button stopwatch route**, so Sleep and Tummy time
  changed too. Left that way on purpose — same action, same words, and splitting it would make two
  registers for one control.
  Verified in a browser, 3 captures (`artifacts/homehub-browser-verification/capture-baby.js`, cases
  `12-pump`, `12-pump-disabled`, `13-sleep`, all new): computed colours read back rather than token
  names, since a token that resolves to nothing fails silently and looks exactly like a rule that
  never applied. Nothing overflows the 960px panel.
- **`client.test.ts` did not typecheck** (2026-08-31, committed `9eed27e`, not deployed). `readRecipePhoto` was
  called with `contentType` where `ReadKitchenPhotoRequest` declares `mediaType`, so `tsc -b` failed
  while `vitest` passed — the stubbed fetch never reads the field. One word. Worth noting only
  because it means the client build was red for as long as the deadline work above has been sitting
  here, and the test suite could not tell anyone.
- **A request that is never answered no longer disables the screen that sent it** (2026-08-31,
  committed `9eed27e`, not deployed). Reported by Allan against the pump: leave a session running, go away, come
  back, and SWITCH NOW, PAUSE, FINISH and CANCEL are all dimmed and dead. His screenshot has the
  OFFLINE banner up and `The care log is unreachable right now.` above the log, which is the
  situation rather than a coincidence.
  **`request()` in `api/client.ts` had no deadline of any kind** — a bare `fetch`, and the only
  watchdog in the file was the assist stream's, which was added for this exact failure and never
  generalised. A `fetch` to a host with no route does not fail promptly; it sits on an open socket
  until the OS gives up, and a page the OS freezes mid-request may never settle it at all. Every
  control on `CareRunning` is gated on `useCareLog`'s one `writing` flag, and `writing` is cleared
  in a `finally` that a promise which never settles never reaches. So the panel was not *slow*, it
  was **permanently** dead for the life of that mount.
  Reproduced and then re-verified in a browser (`artifacts/homehub-browser-verification/probe-pump-stuck.js`,
  ignored): a `pause` that is never answered leaves all four controls disabled indefinitely; with the
  deadline they come back by themselves and the panel says `That timer could not be changed.`
  **The only escape was the thing Allan happened not to do** — leaving the Baby tab unmounts
  `CareLogView` and resets the flag. Coming back to a *panel left open* (backgrounding the app, or
  locking the phone) keeps the mount and therefore keeps the flag.
  10s for ordinary calls, 90s (`SLOW_CALL_MS`, named at the call site) for the six that are slow
  because of what they do — the three photo readers, both recipe importers, and the litter cycle.
  Past the deadline a call raises the same `ApiError(0, …)` a refused connection already raised, so
  every caller's existing offline handling answers it unchanged — including `timer`'s fallback to a
  local session on `start`.
  **`executeDurably` in `writeQueue.ts` had the same hole**, and it feeds the same `writing` flag
  from `add`/`update`/`remove`. Its `AbortController` existed only to be aborted from outside, on a
  profile transition. It now has a 20s send deadline, longer because it carries a body rather than
  asking a question, and a deadline is reported as `offline` rather than `cancelled` — both retain
  the op, but only one of them is what happened.
  Pinned by `src/api/client.test.ts` (new) and a case in `writeQueue.test.ts`.
- **The pump's boundary buzz now fires from anywhere in the app** (2026-08-30, committed `9eed27e`, not deployed).
  Reported by Allan as not working *again*; unlike 2026-08-19 this was a real defect and not a
  stale deploy — see `INCIDENTS.md`. `PumpAlert` was mounted inside the Baby tab, so leaving the tab
  unmounted it and the switch passed in silence. It is mounted in `App` now, beside `MicLiveBanner`,
  fed by `BabyProvider`, which carries the running session alongside the Dashboard's figures.
  **Exactly one mount** — a second would replay the whole pattern.
  Patterns are untouched: `switch` is two short pulses, `done` three long ones, both pinned by
  `pumpPhases.test.ts`.
  **Not deployed, so the household will still feel nothing until this ships.** The panel is on
  `a66e80a+ · 2026-08-24`, which contains the bug.
- **The Baby row layout takes the time back into its own column** (2026-08-29, committed `9eed27e`, not deployed).
  From `design_handoff_baby/`, which Allan supplied as a zip and which the package itself says
  replaces `design_handoff_care_logging/`.
  **This reverses a decision recorded in the code, deliberately and with the reason changed.** The
  fixed time column was removed once because only ENTRIES had one, so swiping the pager moved the
  name and the figure to different edges. The design now puts the column on all three pages, which
  removes that objection — and the value column is fixed at 92px alongside it, without which the
  time column has the same width on every row and a different right edge on each.
  Also: the sixth bottle content, `BREAST / FORMULA`. It is HomeHub's own value — no upstream enum
  has it — which is fine because `CareEntry.Kind` is free text, so **no migration and no API
  change.** The empty-window `0` became the design's hollow ring and the unmeasured-pump `—` its
  rule, both in the same value column.
  **The time column is 16px in a 128px box, not the design's 12px in 88px** (2026-08-30, at Allan's
  request — a first step to 13px was too small to see). It now matches the entry name's size; the
  colour is what keeps them distinct.
  The width is not a preference: `LAST 11:00 AM`, which only the two window pages write, measures
  96px at the design's own 12px/0.1em, so an 88px box was clipping it silently from the moment the
  column was built. `nowrap` in a fixed box cuts rather than wraps, and the entries and since pages
  have no `LAST ` prefix, which is why it looked right. That prefix is most of the width — the
  entries page's longest value is 76px — so dropping `Last ` from `windowTotals` is where the width
  comes back from if this column ever needs it, rather than the size.
  Verified in a browser, 5 captures: `artifacts/homehub-browser-verification/capture-baby.js`.
  It caught three things tests did not: the value column sizing to content left six different right
  edges down one page, `BREAST / FORMULA` wrapped and broke the contents grid into one tall row and
  one short one, and the review line said "breast formula" without the slash.
  **The rest of that package is not done** — see the note under Blocked.
- **The weather alert banner now opens the NWS statement** (2026-08-28, committed `9eed27e`, not in
  any release). Built from `design_handoff_weather_alert/ALERT_SHEET.md`, which Allan supplied as a
  zip — it was not in the Claude Design project, and `DesignSync` cannot see handoffs that live in
  an ordinary claude.ai project, so the folder in the repo is the only copy.
  The banner said `SPECIAL WEATHER STATEMENT` and went nowhere; the cause was upstream of the UI,
  in `NwsWeatherProvider.BuildAlerts` collapsing the whole CAP product to one 280-char line. The
  product now travels whole (`ActiveAlert` + migration `20260827205336_AddWeatherAlertProduct`,
  additive nullable columns) and `WeatherAlertSheet` renders it.
  **One deliberate departure from the spec, at Allan's direction:** §1 has the Dashboard banner only
  route to Weather, leaving the sheet to a second tap there. It now routes *and* opens the sheet on
  arrival, via `?alert=open` consumed with `replace`.
  Two things the spec lists as out of scope are still out: the `1 OF 2` stepper for concurrent
  alerts, and CAP `messageType` Update/Cancel handling in the engine. The severity *sort* was done —
  `alerts.find` could hide a Tornado Warning behind a Special Weather Statement.
  Verified in a browser, 4 screens + a click-through journey:
  `artifacts/homehub-browser-verification/capture-weather-alert.js` (captures ignored). It caught
  two defects no test had: `IMPACT` swallowed the trailing "Locations impacted…" paragraph because
  tags ran to the next tag rather than to their own blank line, and the banner printed the event
  name twice once the title stopped being parsed out of the message.
- **The care log now works from a cold start with no server** (2026-08-25, present in current TEST
  release `20260825T100412Z-fddb49d37ebf` and also in `9eed27e`). Previously the offline story only held inside a tab that was already open: an
  offline boot locked, purged the care cache and left a keypad that could not be answered, because
  the PIN is checked by `SignIn` and the hash never leaves the server. Now the cache is sealed
  per profile (`screens/care/careVault.ts`) instead of purged, and the PIN is provable against the
  device (`app/offlineUnlock.ts`) — so a phone out of range opens to its log and accepts entries,
  which queue and replay on reconnect. The reasoning and the limits are in `DECISIONS.md`; the
  short version is that this is not a vault, and it is not claimed to be.
  Verified in a browser end to end, 18 checks: `artifacts/offline-care-verification/` (ignored;
  see its README). It caught a defect no test would have: the queue's replay effect fired when the
  connection returned but *before* the identity was confirmed, and never again — the offline
  entries were durable, correct and permanently unsent. `deviceOnly` is now one of its dependencies.
  **Not covered and pre-existing:** the care screen reads `Baby` rather than the child's name while
  offline, because the name lives in `/api/settings` and settings are not cached.
- **Kitchen visual fidelity.** 25 panels implemented against `design_handoff_kitchen/specs/`, swept
  once for the shared vocabulary (destination header, row supporting line). Two known
  gaps remain for missing data: the item sheet's `WHERE IT LIVES` section needs shelf-level location,
  and the recipe photo strip needs `Recipe.photos[]`, which is a data note in `RECIPES.md` §4 and was
  never built.
  **The band and the bisected cut in the sweeps below are history**, superseded by
  `design_handoff_kitchen_lists` on 2026-08-31. Findings in the geometry passes that measure either
  are stale until those passes are pointed at the new `.dc.html` files.
- **The item sheet (P2) was never actually verified, and was wrong.** The capture harness served
  `/api/pantry` an empty list, so `/kitchen/pantry/1` rendered its not-found fallback and every
  screenshot of it was a blank page — the screen passed 25-panel review without anyone seeing it.
  Rebuilt to the handoff on 2026-08-22: section order (history, then `USED BY`, then the footer),
  plain brass section labels in place of the shelves' full-bleed bands, natural-language history
  (`One used — Piccata`, not `6 → 4`), and the facts strip inset by margin rather than by the
  `padding-inline` allow-list, which had been drawing its border hard against the glass. `USED BY`
  now lists recipes with amounts off a new `GET /api/pantry/{id}/used-by`; it used to list only plan
  claims, so it was empty until the week was planned. Harness fixtures added, so the route is
  photographed with real content from now on.
  Two more found on 2026-08-22 by reproducing a real panel row (`Premium Sauce Caramel`, loose, 454 g,
  one event): `ONE IS` fell back to the item's unit and rendered **`ONE IS · g`** on anything measured
  by weight — `ADD_TO_PANTRY` §3 says a blank pack size means the row counts in whole units, so the
  cell now says `no pack size` in the same quiet register as `no date` beside it. And the count
  block's how-it-is-known clause rendered `ageLabel` lowercased, putting **`seen 2 wk`** mid-sentence;
  it is prose now (`seen two weeks ago · counted, not guessed`), the same fix as P3's belief line.
- **The item sheet's empty look on a sparse row is data, not layout.** Measured at 450 × 1000: the
  handoff's own item leaves a 122px void, a one-event row with no pack size, no expiry and no recipe
  using it leaves 454px. Nothing is mis-sized — that row genuinely has four facts to its name, and
  `WHERE IT LIVES` (still blocked) is roughly 90px of what is missing.
- **Run a check (P3) was wrong in the same way the item sheet was**, and for the same reason — the
  harness served an empty pantry, so the queue was empty and the panel was never seen with content.
  Rebuilt to the handoff on 2026-08-22. The one that mattered was the **answer weighting**: §3's
  table makes `THAT'S RIGHT` primary, `ALL GONE` secondary and `CAN'T FIND IT`/`SKIP` tertiary
  links, and the build had all four as equal bordered boxes — offering "I gave up" at the weight of
  "the shelf is empty", two answers that write opposite things. Also added: the lede, `2 OF 6`
  beside the progress bar, the card as an actual bordered card, `UNDO LAST` against the ledger's
  undo endpoint, the written-immediately line and the run tally. The queue was `the twelve stalest
  rows` and is now `stale rows, in shelf order` — the selection and the ordering answer different
  questions, and `isStale` is now shared with P1's badge so the two cannot disagree about the size
  of a run. `KITCHEN_SHELF_ORDER` moved from `KitchenPantryScreen` into `kitchenDomain` for the same
  reason. P3 also gets the quick row and nav, which the handoff draws and `nav={false}` was hiding.
- **The P4 add-choice sheet was unusable, not just off-design.** `.ml-kitchen__scrim` sits at
  `z-index:6` and `.ml-kitchen__choices` sat at `3`, so the scrim covered the sheet it was meant to
  sit behind: the panel came up dimmed, the rows read as disabled, and every tap on a row hit the
  scrim and closed the sheet. Playwright names it outright — *"ml-kitchen__scrim intercepts pointer
  events"*. Sheet is now `z-index:7`. Rebuilt to the handoff at the same time: `ADD TO THE PANTRY`
  brass label in place of the serif question, three ruled rows with a brass glyph and a chevron
  instead of three bordered cards, and the first row's brass fill dropped — `One thing` leads by
  being first, which is the whole of its precedence.
- **`1px solid var(--control-border)` is invalid CSS and appeared three times.** `--control-border`
  is a *width* (`max(1px, 0.0625rem)`), so putting it where the colour goes voids the whole
  declaration and the element renders borderless. It hit the P4 rows, `.ml-kitchen__card` and
  `.ml-kitchen__cardchoice` — the last of which carries a comment explaining that a borderless
  choice "reads as a caption rather than a choice beside it", which is exactly what it had become.
  All three now read `var(--control-border) solid var(--border-inactive)`. Worth a grep before
  adding any new bordered block.
- **There is now a mechanical handoff-vs-build sweep**, in `artifacts/handoff-sweep/` (ignored, see
  its README). It extracts every locked panel's text from the `.dc.html` files, renders each route
  against fixtures rich enough to draw every band, and reports which of the design's labels, button
  words and fixed sentences are absent. Built because four review passes over this section each
  missed things reading code cannot catch. First run: 24 panels, 82 candidate gaps after filtering
  fixture data, ~20 confirmed by hand. **Re-run it before calling this section done.**
  **It now has two passes**, and the second is the one that earns it: `geometry.js` measures sizes
  and spacing against the `.dc.html`'s declared px, on a *phone* viewport. That is what finally
  caught the item sheet's `−`/`+` — fixed 54px squares bordered on all four sides, where the handoff
  draws full-height columns of the count block, plus six values in the same block each one step
  small. Correctly worded, correctly placed, wrong shape: invisible to the text pass, to reading the
  code, and at the 540px design canvas where the block is short enough to hide it.
  Its own trap: fixtures must match the declared DTO shapes, not what the screen renders —
  `provenance` is `GroceryProvenanceDto[]`, `ReceiptLineDto.from/to` are numbers, `leftAlone` is
  `string[]`. Three false "crashes" came from getting those wrong.
- **Full geometry sweep of the Pantry handoff (2026-08-23), P1–P4: 42 mismatches, now 18.**
  `geometry-pantry.js` extracts all 243 styled text leaves from `HomeHub Kitchen Pantry.dc.html`
  with inherited properties resolved, matches each to the rendered element carrying the same words,
  and compares size, tracking, weight, colour and family in design-px. Found and fixed:
  the **destination title at 40px where all four section files draw 28px/0.05em** — the largest word
  on every Kitchen destination, 12px over, and nothing in a text sweep can see it; `ON THE SHELF`'s
  unit rendering in Marcellus because `var(--font-body, inherit)` names a token that does not exist
  and `inherit` inside the serif figure is serif; the shelves' **amber on the wrong cell** — the
  handoff colours `2 DAYS LEFT` and `OPEN 3 D` and leaves `1 bag` quiet, and the build had it
  reversed, which turns "this runs out Tuesday" into "this figure is wrong"; a low *count* marked at
  all, which the handoff never does; `›` at 19px against 13–14; the Kitchen's section labels at the
  ledger's 12px/0.26em rather than the section's 11px/0.3em; and the count-block figure, unit,
  padding, fact labels, provenance and date column each one step small.
  Of the 18 left: 8 are the shared shell avatar and ambiguous text matches, 4 are estimated rows
  where **`PANTRY_SHELVES` §1 and the drawing disagree** (§1 says name, state and quantity all go
  `#8f7a4f`; the drawing leaves the name bright) and the spec wins per the 2026-08-20 decision, and
  the rest are fixture data. Nothing there is a known defect.
- **`TAP TO SCAN A BARCODE` did nothing at all** — `onClick={() => { /* camera: M6 */ }}`, a stub
  nobody came back to. Built 2026-08-24. The camera logic already existed and worked, on the older
  phone screen `screens/pantry/ScanScreen`; it is now `app/useBarcodeScanner`, shared by both, so the
  debounce, the pause gate, the stream teardown and the three ways a camera can be unavailable exist
  once. Written twice they diverge silently and the second copy is the one nobody tests.
  New `GET /api/pantry/catalogue/{barcode}` — **identification only, writing nothing**. `POST /scan`
  is the phone's tally and moves stock, which is exactly wrong for a form: a camera decodes the same
  pack many times a second, so a lookup with a side effect would file a ledger row per frame
  (ADD_TO_PANTRY §2: "one scan names the thing and fills its size; it never increments a count").
  The form now fills from a scan, shows the teal/amber provenance banner of §4 with `UNDO`, and
  leaves already-typed fields alone.
  **Not a gap, though it looks like one:** a hand-added barcode teaches the catalogue a name but no
  pack size, so the viewfinder fills the name and leaves the size blank for such a code. Only the
  scan path teaches size, "because the phone asked while somebody was holding it" — my first test
  asserted otherwise and was wrong, not the code.
- **Geometry now sweeps the whole Kitchen handoff**, not just Pantry: `geometry-kitchen.js` over 23
  routes and 32 drawn panels. 156 mismatches → 78. It only reports text that is **unique on both
  sides** — matching by words alone made short strings worthless (a panel holds several `4`s and two
  `Butter`s, the lookup took the first, and the report filled with confident nonsense about the wrong
  element). Ambiguous strings are counted and named, never guessed at. Fixed from it: the account
  badge (48/19px brass → 44/17px `--text-secondary`, 14 findings, one rule); every primary button at
  12px against the drawn 11; the drill-in exit words, where the handoff sets `CANCEL`/`LATER`/
  `UNDO ALL` a step quieter than `BACK`/`PAUSE`/`STOP` and the build had them all alike; card and
  aisle values one step bright; the decision card's kind line; aisle names; and **recipe ingredient
  amounts rendering 15px Marcellus where every other amount column in the section is 13px mono** —
  a serif with proportional numerals in the one place figures are compared down a column.
  One change was reverted the same run: dropping `.ml-kitchen__errandalt` to 10px fixed four
  findings and broke thirteen. **Check the distribution before changing a shared value.**
- **Ruling: the Kitchen drill-in title is 22px.** The handoff draws it at 22 on nine panels and 24
  on three, with nothing distinguishing them. One component, one size; 22 is the majority and the
  one that fits `How long things last`. Recorded in the CSS so it is not re-measured every sweep.
- **Not blocked after all: `WHERE IT LIVES`, `CUPBOARD · MIDDLE SHELF` and `EDIT`.** This entry said
  for weeks that they could not be built from this machine, because they need a schema change
  (`PantryItem.Shelf`, `PantryEvent.Location`, a `Moved` kind) and `dotnet ef migrations add`
  supposedly could not run here — user-secrets empty, `/etc/homehub-test/homehub-test.env` root-only,
  no `sudo`, and `HomeHubDbContextFactory` refusing to guess a connection string.
  **That last step is where the reasoning went wrong.** `dotnet ef` builds the `DbContext` at design
  time and never connects, so *any* well-formed connection string satisfies it — which is exactly
  what `ENVIRONMENT.md` has documented since 2026-08-28, when `AddWeatherAlertProduct` was added by
  precisely that route. The two files have contradicted each other since, and this one was believed.
  Verified 2026-09-01: `dotnet ef migrations list --no-build` with a throwaway string enumerates all
  seven migrations. The work is unblocked and unstarted; nothing about it needs Hermes or a password.
- **Still open after the 2026-08-23 sweeps, in priority order.** Nothing below is unknown; each is
  a decision or a dependency rather than a miss.
  1. **A dead session now locks.** Closed: any 401 from a data call fires `SESSION_LOST_EVENT` from
     the request layer — the one place that sees every response — and `SessionProvider` locks to the
     picker. Sign-in and PIN 401s are excluded (a wrong PIN says nothing about the session), and it
     announces once per outage so a page-load storm is one event. Verified by expiring the cookie
     mid-session in the browser: the panel lands on the picker instead of rendering empty shelves.
  2. The text sweep's ~57 "present in source but not reached" candidates are still unverified by
     hand, and S3 cannot be rendered by either sweep at all — it only draws after a photo upload, so
     its strings are checked in source. This is the last unexamined corner.
  3. 41 geometry findings remain (was 156). Worked through one at a time on 2026-08-23. Fixed in
     that pass: the aisle-order panel end to end (position column 16px serif → 12px mono, the two
     hand-built rows, the blast-radius blurb, `this shop only` in verdigris); the decision card's
     alternatives at 12px against the drawn 10 and its kind line's tracking; the receipt's
     leftover captions, `had 4` column, `of 6` qualifier and destination buttons; the suggestions
     list's history cell in brass-meta; the shop's aisle footnote; `COOKING FOR` in brass.
     **Three of my own edits were wrong and caught by re-running**: `.ml-kitchen__cardname` was
     "corrected" to 16px on findings that had matched ingredient rows rather than card names (it is
     18px; only the serif was wrong), `.ml-kitchen__errandalt` was dropped to 10px on four findings
     and broke thirteen, and `.ml-kitchen__recipename` was set to the suggestion list's 16px while
     the folder wants 17 — both use `.ml-kitchen__recipe`, so the distinction had to be drawn with
     a `--dense` modifier rather than by context. **Re-run after every change; do not batch blind.**
     Also written and then deleted: three rules whose selectors matched nothing at all
     (`.ml-kitchen__method`, `.ml-kitchen__aislechange`, `.ml-kitchen__suggest`). Check the class
     exists before styling it.
  4. Of the 41 left: the estimated-row conflict (spec beats drawing), the 22/24 title and 11/12
     primary-button rulings, disabled-state artefacts, and repeated short strings the matcher
     declines to guess at. `A link` / `Typing it in` / `Pasting text` on R3 are a **content** gap —
     those rows do not exist — not a size one.
  5. Superseded — was: 78 geometry findings remain. The largest class is 4, and the two adjudicated groups are inside
     it: estimated rows, where `PANTRY_SHELVES` §1 and the drawing contradict each other and the
     spec wins, and the 22/24 title ruling above.
- **The drill-in header was wrong across the whole Kitchen section**, not just on the item sheet.
  Every drilled-in panel in the handoff is a `1fr auto 1fr` grid — worded exit box, centred title,
  status — and the build was using the ledger screens' left-aligned 32px Marcellus title behind a
  44px arrow. New `KitchenDrillInHeader`; all 16 Kitchen drill-ins moved to it. `DrillInHeader` is
  untouched and still serves Config, Assist and Sensor History, which draw it differently on purpose.
- **The panels now render.** 16 Kitchen routes photographed at 540 × 1169 against stubbed data
  (2026-08-21). The bisected cut is confirmed working — shelf groups bisect the fifth row through
  its text. Four faults found and fixed, all invisible to static checks: a primary button crushing
  its peer to a 40px sliver wherever `.ml-kitchen__shop` sat in a flex row; the grocery tick's
  target being the 24px box rather than the 44px its own comment promised; two 11px band doors;
  and shelves ordered Cupboard-first against `PANTRY_SHELVES` §1, which puts Fridge first.
- **Closed by ruling (2026-09-01):** the pantry writes `½ pot`. `trimNumber` carried an explicit
  contrary decision — a stock figure should not be dressed as a recipe amount — so this was held open
  for a ruling rather than reversed quietly. Allan ruled for the spec. Only exact fractions convert,
  judged at three decimal places, so `0.667` is `⅔` and `0.67` stays `0.67`; mixed numbers are set
  tight (`2½`), as the handoff draws. It reaches `usageAmount` too (`30 oz · 2½ cans`), kept on
  purpose. The superseded argument is preserved in `DECISIONS.md` rather than deleted.
- **Closed:** the pantry renders `4 cans` again. `pluralUnit` in `pantryDomain` agrees the unit with
  the number at display time — the registry is right to store one canonical singular, and agreement
  is a display question. Symbols never inflect (`200 gs` is not a thing), which is a closed set: a
  household can type a new *word* for a container but cannot invent a new abbreviation for a gram.
  Not a bare `+ 's'` — `box`, `bunch` and `loaf` are common enough on a shelf — and idempotent,
  because rows predating the canonical fold still hold `tins` and turned into `tinses` on the first
  pass. Was: `UnitRegistry` canonicalises to
  the singular and `MeasurementUnit.DisplayName` holds the plural, but no client code reads it, so
  every quantity in the section is short a plural. Section-wide in `amountLabel`, not local to one
  screen, which is why it was left alone rather than fixed on one screen only. It now shows in the
  captures rather than hiding: the harness fixtures were written in plurals, which no real row ever
  is, and are now canonical singulars — so `was 2 carton, now 1 carton` is visible on P3. The honest
  fix is a `unitPlural` on `PantryItemDto` off the registry, not client-side `+ 's'`, which gets
  `loaf` and `bunch` wrong.
- **The sweep's five findings are fixed (2026-08-23).**
  `cookedAgoLabel` now reads `LAST WEEK` / `3 WEEKS` / `NOT SINCE APRIL` — past two months it names
  the month, because `17 WKS` is arithmetic nobody does in their head. Three prose call sites were
  gluing a prefix onto that column value and produced "Last made not since May" on exactly the
  recipes worth mentioning; they use a new `lastCookedSentence` instead.
  `C2`'s partial confirm says `FOUR ATE`. `S2` gained the `ELSEWHERE` and `WHAT THIS CHANGES` bands
  and a `SAVE THE ORDER` footer — **and its order is now held until saved**, unlike the check flow,
  because an order is one arrangement and half a rearrangement saved by someone walking away is an
  order nobody chose. `G2`'s doubt cards now distinguish *never counted* (`LAST SEEN 5 WEEKS AGO`,
  `ADD A BOTTLE`) from *counted but not comparable* (`DON'T KNOW IF IT COUNTS`, `<unit> WILL DO`,
  `ADD STOCK`), and `DecisionCard` gained a `why` line — the columns show what disagrees, the
  sentence says what is being ruled on. `S3` names the substitution (`SUBSTITUTED BY THE SHOP`) and
  **groups the unreadable lines into one card**, which its own plural buttons (`SKIP THEM`) had been
  implying while the card described a single line.
  Still short one detail: the card reads `CUBE WILL DO`, not `CUBES` — the section-wide plural gap
  below, not a wording choice.
- **Open, not changed:** the item sheet's footer has two buttons where the handoff draws three.
  `EDIT` has nowhere to go — there is no edit surface for a pantry row, and `ADD_TO_PANTRY.md` is
  still the only screen that writes these fields by hand. `MOVE IT` is real: it reveals the three
  shelves inline and PATCHes the location.

## Blocked

- **Next production candidate** — release `20260822T151435Z-6d49a68ad72a` entered production under
  Allan's one-time exception with five known High source findings. They remain application remediation debt and block every
  later production candidate until fixed; the normal Critical/High gate remains in force.
- ~~Visual verification~~ — **cleared.** Shared Playwright at `/srv/dev/tools/playwright`; harness
  and usage in `ENVIRONMENT.md`.
- **Huckleberry is gone, client and API** (2026-08-30, committed `9eed27e`, not deployed). Allan: *"there is no
  Huckleberry anymore, it was slowly phased out in favour of the in-built systems which are now in
  place"* — so the handoff's "Huckleberry is removed" was describing reality, and the code was the
  last thing still claiming otherwise.
  **It was not merely dormant. Two live surfaces still read it**, both reproduced in a browser before
  and after (`artifacts/homehub-browser-verification/probe-huckleberry.js`, against
  `IntegrationMissing` — what the provider returned with HA up, as it is for climate and the litter
  robot, and no child entities present):
  1. **A permanent false alarm on the home screen.** `careSubjects` mapped `IntegrationMissing` to a
     fault and `needsYou` promoted it to a `tone: 'bad'` row: `CARE · Conrad — integration not found
     · GO AND LOOK`, about a service nobody was going to restore. Now `All well`.
  2. **The Dashboard's CARE stats were dead.** `CareBlock` read `lastBottleUtc` / `lastDiaperUtc` /
     `feedsToday` off `BabyState`, so all three showed `—` with a bottle 40 minutes old in the
     panel's own log. Now `40m · 1h 35m · 2 feeds`.
  **`BabyProvider` was repointed rather than deleted** — same 30s cadence and provider slot, reading
  `/api/care/{child}/entries` and deriving those three figures. It counts bottles in the same
  6 AM → 6 AM window the Baby tab's TODAY page uses, so the two cannot disagree. `useCareLog` was
  the obvious alternative and is wrong for this: it carries the write queue, the offline cache and a
  10-second poll, and the Dashboard is the screen that sits idle all day.
  Deleted: `Baby/*` (8 files), `BabyController`, `CareImportService`, `HuckleberryCalendarParser`,
  three test files, the `Huckleberry` config section, the client's `/baby/*` endpoints and DTOs, the
  `Pull in history` control, and the Config → Devices `Huckleberry` row (not renamed — the Care
  group's own `Baby settings` row already led to that screen).
  **Two things deliberately kept.** `CareEntrySource.HuckleberryImport` and the `hb:` external-key
  index: rows imported before today are the household's history, and rewriting them to say `Panel`
  would falsify the log to tidy a value nothing branches on. `CatStatusName` stopped aliasing
  `BabyStatusName` and declares its own five states.
  **One quiet loss:** `16 WEEKS` beside the child's name. It came off the integration's child record
  and nothing local holds a birthday — but it had already been blank for as long as that integration
  returned nothing, so the screen does not change. `careSubjects.ageLabel` was deleted with it. The
  design wants it back; that needs a household birthday setting, which does not exist.
- **The rest of `design_handoff_baby/` is unbuilt**, and Allan has not asked for it. Only the
  list-row layout and the sixth bottle content were in scope on 2026-08-29. Open: the tab renamed
  **Baby** everywhere (retiring `design_handoff_care_logging/`); the day header's `16 WEEKS` and
  `THU 27 AUG · 6:41 AM`; the vertical rhythm that keeps the tile grid off the nav bar; the ten-tile
  grid; the entries selection mode's `EDIT`/`DELETE` action row; and the panel geometry (760px,
  200px peek, drag-to-close).

## Recently cleared

- The earlier broad root-owned-file incident was repaired by Allan on 2026-08-21. A scoped inventory
  at 2026-08-21T21:06Z found no root-owned or unreadable source/test files outside generated trees.
- The promotion workflow no longer points an isolated snapshot directly at shared `.git`; it now uses
  isolated Git metadata so build-time provenance checks cannot replace the shared index as root.
