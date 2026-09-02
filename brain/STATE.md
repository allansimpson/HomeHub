# State

What is true right now. **Overwrite this file** — it is a snapshot, not a log. Anything worth
keeping once it stops being current belongs in `DECISIONS.md` or `INCIDENTS.md`.

_Updated: 2026-09-02 by Claude, over Geist's post-second-review snapshot of the same day. Geist's live-verified deployment and production-probe facts below are theirs and unchanged; the remediation status is Claude's._

Current TEST remains healthy on the old exact `e11f74f` candidate. Production remains unchanged. The exact second remediation candidate `d94666a` (`a25eb83` application changes plus evidence) passed its full development gate but **failed independent production review with 0 Critical and 5 unique High findings**.

RR-01, RR-02, and RR-03 are closed. The immediate visible lock in RR-03 is accepted: network and queue admission close synchronously, old work becomes epoch-invalid, settlement drains, and stores close last. RR-05 remains partially open. RR-04 validates the initial cloud URL but automatic redirects escape the allowlist. A fresh exhaustive review also found unconstrained local-STT, Google/Microsoft provider, and Hermes gateway destinations.

The authoritative second re-review is `.hermes/2026-09-02-second-remediation-rereview-fail-closed.md`. Existing tests remain genuinely green under Node `v24.13.0` and .NET SDK `10.0.110`: typecheck and lint pass, 54/54 client files, 1,239/1,239 backend tests, and no npm/NuGet production vulnerabilities. Three disposable adversarial tests independently demonstrated the remaining RR-05 plaintext cases.

No candidate was built or promoted. Production prerequisite inspection remains deferred until source passes. Production currently reports no cloud STT availability; SQL's literal configured server/TLS policy still requires privileged read-only preflight later.

**All five are remediated in `3f164ae`**, each with a regression verified red-capable against the reverted fix. Claude's account is appended to the second re-review record. It is a claim awaiting review, not a clearance — three rounds in, that distinction is the only thing keeping this honest.

**Four of the five were one fault in four places.** Every outbound destination in the app was an unvalidated string and every client followed redirects: cloud STT, "local" STT, Google's and Microsoft's token/API/authorize endpoints, and each Hermes gateway. Fixing `Ai:OpenAiBaseUrl` on its own last round is exactly what left the other four standing — and left even that one escapable by a 307, which preserves the method and body. `Net/EgressGuard.cs` is now one rule per destination class, checked as a shape at startup and as *addresses* in a connect callback that dials what it screened. `INCIDENTS.md` carries the pattern: this is the second consecutive round where a fix landed at the instance and the class was left open.

## Source

| | |
|---|---|
| Branch | `main` |
| `HEAD` now | `55bb195` (second egress remediation), on top of `3f7dffc` |
| `HEAD` reviewed | `d94666a` (`a25eb83` remediation plus `d94666a` evidence), on top of `7e92322` |
| Working tree | Clean. Application bytes changed in `3f164ae`, so the candidate identifiers below describe the superseded `d94666a` and a fresh snapshot is owed. |
| Previously reviewed candidates | `e11f74f`: 0 Critical / 8 High. `d576927`: 0 Critical / at least 5 High. Both FAIL CLOSED; details remain in their dated `.hermes` reports. |
| Current candidate identity | Commit `d94666a086e4351bb5727fad2044f9e00a1764df`; Git tree `7d7e664addc13a0e3558e661e2288a67832667ba`; 858 tracked paths; deterministic source SHA-256 `31819e72f73d065242122e3e65404bec12f06b1a80b3835284c3f82dfb34b711`. |
| Independent verdict on `d94666a` | FAIL CLOSED: 0 Critical / 5 unique High. Details in `.hermes/2026-09-02-second-remediation-rereview-fail-closed.md`. |
| Reviewed in progress | `3f7dffc` — three blockers raised mid-review (RR-05 fail-open, account-link exchange unguarded, egress class incomplete). |
| Current candidate | `55bb195` — those three answered; full gate green (54 client files, 1,307 backend tests). Unreviewed, and the review of `3f7dffc` was still running across three workstreams, so the finding count is not final. |
| Coordination | Claude owns code remediation and development evidence. Geist owns immutable-candidate re-review and deployment. No production action is authorized. |

## Deployed

| Environment | Last live-verified state |
|---|---|
| TEST | Release `20260902T041152Z-620d8f13f2ca`; artifact SHA-256 `e9e7b563c3cb3bc814bddd7c387609ca84f360c52cb885d12eb8d64057a18a6d`; active and healthy; deep health and HTTPS 200; DB `ok`; pending migrations `0`; migration head `20260901164422_AddProfileSecurityVersion`; build `e11f74f+ · 2026-09-02 04:12Z`; bundle `index-kcmVYEme.js`; live bundle and service worker exactly matched the artifact |
| Production / panel | Release `20260831T105206Z-09cfd47e8477`; unchanged and last verified healthy; build `a66e80a+ · 2026-08-31 10:52Z` |
| Gap | Production is blocked on the second re-review's 5 High findings, then a corrected exact candidate, fresh zero-Critical/High review, new TEST artifact, browser evidence, configuration/installer qualification, and Allan's explicit approval. |

## Waiting to ship

**`55bb195` is the state being handed back.** The three blockers raised during the review of `3f7dffc` are answered; `./scripts/check.sh all` is green at 54 client test files and 1,307 backend tests, neither baseline dropped. Both requested trade-offs were applied as decided: Hermes is loopback-only by default with exact `Hermes:AllowedGatewayOrigins`, and the household-LAN reach no longer admits CGNAT or `0.0.0.0/8`.

**One of those blockers contradicted a claim in Claude's own commit message** — that every outbound destination used one rule. Nine clients were still on default handlers, including the OAuth token exchange that posts a client secret and PKCE verifier. That is the third round of the same class-versus-instance failure, and `INCIDENTS.md` now carries the stronger guard: when a fix claims to close a class, write the test that asserts the class is closed. `EgressGuardTests.Every_outbound_client_registration_is_guarded` is that test, and it found the last two gaps while it was being written.

Geist's sequence is unchanged: rerun the full gate on the exact bytes, fresh independent source review, TEST promotion, and browser validations before resuming production prerequisite and installer qualification.

Read the remediation record appended to `.hermes/2026-09-02-second-remediation-rereview-fail-closed.md` first. **Five decisions are put up for review rather than assumed**, and two are worth Geist's opinion specifically: Hermes gateways and the local STT sidecar are constrained by *reach* (loopback or this house's network) rather than by exact origins, because a household's sidecar address is theirs to choose and a wrong guess bricks voice or the assistant with no obvious cause — if exact origins are wanted for Hermes, say so and it is a small change. And RR-05's fallback removes the entire legacy queue key when a rewrite will not take, which loses any ordinary unsent write sharing it, another profile's included.

**Two more configuration surfaces can now refuse startup**, joining HH-07, HH-08 and RR-04: Hermes gateway origins must be loopback or on the house network, and `Voice:Stt:LocalEndpoint`, if set, must be too. Both are expected to be no-ops in production — Hermes runs on the same host and the probe reported `localStt=false` — but expected is not verified, and both are cheaper to check before installing bytes than after. Google and Microsoft default to their own hosts, so an ordinary deployment needs no new value there.

**One correction worth carrying forward:** the first version of the RR-05 retirement test passed against the unfixed code — the legacy value happened to be emptied by a `removeItem` the stub had not intercepted, so it proved nothing. Caught by running it against the revert, which is now the routine and is the only reason it was caught.

Nothing deploys on push. Claude hands a verified code state to Geist; Geist snapshots and promotes it
through the process in `DEPLOYMENT.md`. `scripts/deploy.sh` is not the active route.

**Startup gates that will refuse to boot**, all intended, now eight rather than three: missing or
invalid `Server:RequiredSans` and `Server:CaPath`; `Mcp:ApiKey` still set; SQL certificate validation
disabled against a non-loopback host (HH-07); cloud STT permitted without acknowledgement (HH-08); a
cloud STT destination that is not absolute HTTPS on an allowed host (RR-04); a `Voice:Stt:LocalEndpoint`
that is not on this machine or this house's network; a Hermes gateway origin that is not either; and a
Google or Microsoft provider whose token, API or authorize endpoint is not on that provider's own hosts
or an explicitly named one. The earlier H2 change also signs the household out once — every cookie
predating it carries no security-version claim and is refused.

TEST release `20260831T105206Z-09cfd47e8477` is also running in production under the recorded
one-release exception; its original manifest remains TEST-only.

## In flight

- **Every outbound destination is now an authorised one** (2026-09-02, `3f164ae`, committed, not
  deployed, **not independently reviewed**). The second review closed RR-01, RR-02 and RR-03 and
  found five more.
  **Four of the five were the same fault in four places.** Every outbound destination in the app was
  an unvalidated string and every client followed redirects — cloud STT, "local" STT, Google's and
  Microsoft's token/API/authorize endpoints, and each Hermes gateway. All of them took whatever
  configuration said and posted household audio, calendar and task content, refresh tokens, client
  secrets and agent bearers to it. `Net/EgressGuard.cs` is one rule per destination class now,
  checked twice: a shape check at startup and where a request is built, and an address screen in a
  connect callback that resolves once and dials what it screened. Redirects off everywhere — a 307
  preserves the method and the body, which is how the validated cloud URL was escaped. The
  connect-callback reasoning is `RecipeFetcher`'s, which already had it for the inward direction.
  **"Local" STT was a name rather than a constraint.** Cloud fallback off, `Prefer=local`, no
  acknowledgement — and every recording could still go to a public cleartext host while the operator,
  the validator and the panel's own boundary indicator all called it local. The privacy claim was
  resting on the field's name.
  **RR-05's residuals were three ways of reporting a sweep that had not happened**: it asked only
  about the profile being opened, so another member's care record waited for a session that on a
  locked panel never comes; it ran only when a profile store was opened at all, so a locked boot swept
  nothing; and it rewrote through a helper that swallows failure. It is owner-blind now, runs at boot
  before anyone is asked for a PIN, and reads back what it wrote — if the record survives, the whole
  key goes.
  Gate green at 54 client test files (1,024 tests) and 1,299 backend tests (was 1,239).

- **The five previous re-review findings were remediated** (2026-09-02, `a25eb83`, committed, not
  deployed; RR-01, RR-02 and RR-03 subsequently **closed** by Geist's second review).
  **RR-01 — the Care vault could be overwritten by the wrong key.** A failed decrypt started an empty
  vault while keeping the wrong key and a writable store, so the first change — a server refill, a
  pending entry, a pump timer ticking — sealed that empty log over the rightful owner's blob. The
  session now goes memory-only, which is what `queueStore` already did; see the note above and
  `INCIDENTS.md` for why it was fixed in one store and not the other.
  **RR-02 — the migration deleted its source before the replacement was durable.** `adoptLegacy`
  removed plaintext entries as it read them and the sealed replacement went out behind an unawaited
  persist, so a quota failure during upgrade destroyed unsent operations *and* the only notices for
  the quarantined ones. It is planned purely now, sealed, awaited, and only then allowed to retire the
  source; a failure leaves the legacy keys byte-identical and rolls the in-memory queue back.
  Adoption is also idempotent by id, which closes what the ordering cannot — a silent failure to
  retire the source would otherwise adopt the same care write twice, and a duplicate care write is a
  second feed on the log.
  **RR-03 — a lock did not end authority until React committed.** `lockNow` and the session-loss
  handler closed the stores and left the request layer to the effect watching `locked`, so a body or
  stream already running kept full admission in between. `sessionAuthority.ts` shuts admission and
  aborts synchronously, awaits the settlement, and closes the stores *last* — an unwinding operation
  belongs to the old owner and has a durability decision left to make. Extracted from the provider
  because the order is the security property, and an order living inside a component is one no test
  can hold.
  **RR-04 — cloud STT would post audio and a bearer anywhere.** `Ai:OpenAiBaseUrl` was an arbitrary
  string; acknowledging that audio may leave the LAN is consent to a provider, not to an arbitrary
  recipient over an arbitrary scheme. `CloudSpeechEndpoint` requires absolute HTTPS, no userinfo, no
  query or fragment, and an exact host allowlist defaulting to the provider's own — checked at
  startup, in availability, and again at the request, which is the only place audio meets the wire.
  **RR-05 — private plaintext could outlive the upgrade indefinitely.** A session with no key left the
  legacy queue untouched, so a previous build's care bodies stayed readable across lock, restart and
  profile change whenever no key-bearing session opened. Waiting is not a plan when the wait has no
  bound: private and unowned entries are swept immediately even with no key, leaving a notice that
  names no record, and ordinary writes still wait for a session that can seal them.
  Each group was verified red-capable against the reverted fix before being accepted. Gate green at
  54 client test files (was 53) and 1,239 backend tests (was 1,210).
  Existing tests passed; adversarial tests proved two of the remaining defects.
  **One key model, settled first, because three findings depended on it.** A profile with no PIN had
  its Care vault opened `{ kind: 'plaintext' }` on the reasoning that there was no secret to seal
  under — the premise was wrong, not the conclusion. `deviceKey.ts` mints a per-profile AES-GCM key
  with `extractable: false` and keeps the `CryptoKey` in IndexedDB, so storage inspection yields a
  handle the browser will use and will not hand over. Allan chose this over memory-only, which would
  have cost the kiosk profile its offline log on every restart. The `plaintext` seal is gone from the
  type; a blob a previous build wrote in the clear is erased on open, and a *sealed* blob that will
  not open is left alone, because the right key may arrive later.
  **The write queue was the open window beside the sealed door.** It carried Care bodies, paths and
  labels into `localStorage` as JSON — the same rows the vault was protecting, on their way to the
  server. `queueStore.ts` seals it under the same key, per profile. Its migration is asymmetric on
  purpose: an allowlisted write is adopted, a private one is quarantined as `legacy-plaintext` and
  the household told, and nothing plaintext is ever replayed as a private write.
  **A wrong key must read nothing *and* destroy nothing**, which is two claims. The first version
  satisfied only the first: it started empty, so the next write sealed an empty queue over the
  rightful owner's unsent work. The acceptance test caught it. An unreadable blob now makes the
  session memory-only and leaves the blob where it is.
  **`lockNow` returned without locking whenever the panel was offline.** Sound when written — the
  PIN was the server's to check, so an offline lock stranded people — and overtaken by
  `offlineUnlock`, which teaches the device to check the PIN itself. What it had become was a way to
  suspend the household's own privacy setting from outside: pull the router, wait, and a shared panel
  sits on a decrypted care log. Deleted, and restated as `locksWhenIdle(profile, online)` which takes
  the connection reading and ignores it — an absence is not something a test can hold on to.
  **The transport let go at the response headers.** `authorizedFetch` removed a request from
  `inFlight` and settled its drain when headers arrived, so a transition's drain reported quiet while
  JSON bodies, Assist streams and queue settlements were still running under the identity it had just
  revoked. The unit is the whole operation now (`authorizedOperation`), the epoch is rechecked before
  a value reaches a caller, and `authorizedFetch` no longer exists — so the fifth transport, the
  write queue, could not stay outside it. That also closed the queue's silent 401: an expired cookie
  found by a replay used to break the loop and tell nobody.
  **A 401 is not one fact.** The client guessed by path and method that any 401 from
  `PUT|DELETE /profiles/{id}/pin` was a wrong PIN — true of one of the two ways those routes refuse,
  false of the other, and a member changing their PIN on an expired session is the ordinary way to
  hit the false one. The server marks credential refusals with `HomeHub-Auth: credential-rejected`
  and everything unmarked closes the boundary. Fail-closed by absence.
  **Two production defaults.** `SqlConnectionPolicy` refuses a deployment that disables SQL
  certificate validation against anything but loopback, and the bootstrap template no longer ships
  `TrustServerCertificate=True` next to a `Server=` you are told to point elsewhere. Cloud STT
  fallback defaults off in both the options class and `appsettings.json`; a deployment that wants it
  must acknowledge audio egress explicitly or startup fails, and the active boundary is logged at boot
  and reported on `/voice/capabilities` rather than only as a label after each response.
  `./scripts/check.sh all` green: 53 client test files (was 50), 1,210 backend tests (was 1,157).
  **The browser evidence is missing and is the honest gap.** Every manual validation the handoff asks
  for needs a sign-in, which needs a database; there is no `ConnectionStrings:HomeHub` in this
  checkout's user-secrets and no dev credentials available. A SQL Server listens on `127.0.0.1:1433`
  and was not guessed at. Given a development connection string this runs through the shared
  Playwright runtime and lands under `artifacts/homehub-browser-verification/`.

- **The last tab survives a close and reopen, on every device** (2026-09-01, committed, not
  deployed). Asked for by Allan. The mechanism already existed and already persisted — `lastTab.ts`
  writes to `localStorage` and rewrites the URL before the router mounts — but `tabToRestore`
  refused above 820px, so only a phone came back to its tab. Measured before the change: phone
  restored, tablet and panel both opened on the dashboard.
  **Recency replaced the screen-size rule**, at Allan's choice from three options. The exclusion was
  protecting something real — a panel rebooted overnight should show the house, not whatever tab was
  open at 3am — but that is a claim about *time*, and equally true of a phone picked up the next
  morning. So every device restores, and only within four hours of the app last being used; the
  stamp is rewritten on every tab change, so the window measures the gap and not the session.
  Stored shape went from a bare path to `{path, atMs}` under the same key. A value from the older
  build cannot be dated, so it is ignored and overwritten on the next tab change: the household
  loses one restore, once. Verified in a browser at 430/900/2160px — restores after 20 minutes,
  opens on the dashboard after nine hours, and the legacy value self-heals.

- **The bottom nav is at the bottom again** (2026-09-01, committed, not deployed). Reported by Allan
  off a screenshot; measured, and real on every screen whose content is short.
  `PrivateSession` keys the whole app on the active profile so a switch discards the tree
  (`edf476c`, H3), which puts a plain `div.ml-private` between `#root` and `.app-root` — and that
  div had **no CSS rule at all**. `.app-root`'s `height: 100%` resolved against a content-height
  parent, so the app stopped being full-height: at 540×1169 the Assist inbox was 443px tall and the
  nav floated 726px up the screen with the background below it. It is invisible wherever the content
  reaches the bottom on its own, which is why a full Kitchen list looked right and this survived a
  browser pass. One rule, `.ml-private { height: 100% }`, restores the chain.
  `render-chat-recipe.mjs` now audits it — nav bottom against viewport bottom, on every shot — and
  the audit reports the fault when the rule is removed. Same commit batch as the identity boundary
  below, and also live in TEST.

- **The client-side identity boundary is opened on every path that establishes identity** (2026-09-01,
  committed, not deployed). Found in a browser while verifying the chat capture below; fixed at
  Allan's instruction, which lifted the candidate freeze for it.
  **What was wrong.** `privateNetworkConfirmed` in `api/client.ts` refuses every private call before
  the fetch until the server has said who is asking. Exactly one thing opened it —
  `SessionProvider.refresh()` — and neither of the two paths that actually establish identity went
  through it: a cold boot with a valid cookie, and a sign-in at the picker. Its only other caller was
  the device-only recovery effect, which is dead on both paths because `deviceOnly` starts `false`.
  So the panel refused its own data and, because that refusal is deliberately shaped as
  `ApiError(0)`, drew offline states over a server that was answering. The boot batch had the same
  ordering mistake `refresh` documents and had been fixed for: `/settings` was fetched *in* the
  confirming batch, so it was refused on every boot.
  **The fix.** One `confirmIdentity(isLocked, profileId)` that all four paths route through — boot,
  refresh, sign-in, and the lock that closes it — with both arguments passed rather than read from a
  closure, since a stale `locked` is the other way this goes wrong and it goes wrong open. Boot now
  confirms first and reads settings second. The offline `deviceOnly` branch deliberately does not
  open it: that path admits somebody against the device, and nothing has confirmed them to the house.
  **Instrument.** `artifacts/probe-session-boundary.mjs` (new) drives three cases in a browser —
  cookie boot, signed-out boot, sign-in at the picker — and asserts private calls flow in the first
  and third and not the second. It **fails 2 of 3 on `dc7d026`** and passes on this. Nothing in
  either suite can see this class of defect, which is why it is a browser instrument and not a test.
  **TEST is still running the broken build** (`20260901T211217Z-e8c282873295`, carrying `379d9ed`).
  Worth confirming there against a real session before the next promotion.

- **A recipe can be saved out of a Barnaby chat** (2026-09-01, **uncommitted**, in the working tree
  only — this is the change Geist's Source row calls "five concurrent recipe-import paths"). Asked
  for by Allan: chats are used to create or adapt recipes from outside sources, and the transcript
  was the one place a recipe could be and not be saveable.
  **The panel answers it, not the agent.** "Save this recipe" is intercepted client-side
  (`asksToSaveARecipe`) and never sent — Barnaby holds no recipe tool, so a turn would cost ~7,200
  tokens to produce a sentence about a recipe he cannot file. Same trade the photo-only path makes.
  **No model reads the conversation.** `ConversationRecipeReader` flattens each message out of
  markdown (`MarkdownToText`, new, the `HtmlToText` job one format along) and hands it to
  `PastedRecipeImporter` — the same parser as the paste box, so a chat recipe scales and matches the
  pantry like every other one. `POST /recipes/read-conversation` reads and writes nothing; a yes
  posts the same message to `POST /recipes/import/text`, so the offer and the write are two parses
  of one block.
  **A name the folder already holds becomes a question, not a duplicate**: the offer asks whether
  this is a variation, and `RecipePasteInput.ForkOf` links it while keeping its own method — a chat
  changes the method as readily as the amounts, which is why `/fork` was not reused.
  `import/text` now flattens markdown **unconditionally**, which is the one change with reach
  outside this feature: a pasted `## Ingredients` used to read as an unsectioned list with no
  method.
  Design and decisions: `homehub-docs/docs/chat-recipe-capture.md` (new), sibling to
  `event-capture.md`.
  **Verified.** `./scripts/check.sh all` green — typecheck, lint, 48 client test files, 1156 backend
  tests (11 new, `ChatRecipeTests`, booting the real app). **And in a browser**, at 540×1169:
  `artifacts/render-chat-recipe.mjs` (new, gitignored like the rest of `artifacts/`) drives the whole
  errand against a stubbed API — types the instruction, takes the offer, saves the variation — and
  reports what actually left the panel. It was two requests, `read-conversation` and `import/text`:
  **no assist turn was sent**, which is the claim the whole design rests on. Shots in
  `artifacts/chat-recipe-shots/`.
  That pass found one thing the suites could not: a variation keeps its parent's name, so the receipt
  read "Chicken Katsu Curry, a variation of Chicken Katsu Curry" — the panel saying one thing twice
  in the exact case the offer exists for. Fixed, with a test.
  It also found the identity-boundary defect above, which is what the harness first ran into: before
  that fix the panel could not get past sign-in at all.
  **Held off `main` deliberately**: the candidate is frozen, so nothing here is committed.

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
- **Two more `var(--control-border)`-as-a-colour borders found on 2026-09-01**, making five in all.
  `.ml-kitchen__photoadd` and the strip beside it both read `1px dashed var(--control-border)`, so
  both rendered with no border whatever — the recipe photo `＋` was an invitation drawn as nothing.
  The 2026-08-22 sweep below found three and stopped; these two are dashed rather than solid, which
  is why grepping for the solid form missed them. **Grep for `var(--control-border)` in any position
  other than the width, not for a particular shorthand.**
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
- **`WHERE IT LIVES` is built (2026-09-01), to Claude Design's answers.** The item sheet's P4 section:
  `Cupboard · middle shelf`, `since 3 Aug`, and `Usually kept here · 4 of the last 4`.
  **It was almost dropped, and the near-miss is the useful part.** The entry here said it was blocked
  on a migration nobody could run; that was wrong (`dotnet ef` never connects at design time). It then
  looked like the sub-shelf was *refused* by `DECISIONS.md` 2026-08-20 — locked specs outrank
  drawings — because `PANTRY_DATA_CONTRACT` §1 enumerates the item's fields and has no shelf. Allan
  called it outdated on that basis. Design's answer: it is current, the sub-shelf is real, and §1 is
  being amended. **The rule held; the spec was simply behind the design.** Design's field spec is
  still to come and should be reviewed against what was built.
  **Shape, all eight points as answered.** Free text, not an enum — the first real kitchen produces
  "behind the pasta" and "the bit above the microwave". Scoped per location, so a freezer offers
  freezer places (`GET /api/pantry/shelves?location=`). 24 characters. Unset renders the bare
  location, no placeholder and no hanging separator. `since` dates the last move and falls back to
  when the item arrived. The habit line counts **sightings, not moves** — a jar that never moves is
  the one you are surest of — and is omitted below two, because `1 of the last 1` claims total
  confidence from a single look. `EDIT` stays undrawn until an edit surface exists; that is now the
  next Pantry screen for Design.
  **Three things worth knowing about the build.**
  1. `PantryEventKind.Moved = 12` plus nullable `ResultingLocation` / `ResultingShelf` — additive,
     reversible, no data touched.
  2. **One request is one sighting.** A PATCH that moves something writes both a correction and a
     move, and both land after the location changed, so the habit line counted a single tap as two
     agreements. The correction now gives up its place and the move carries it. Caught by a test that
     expected `1 of the last 4` and got `2`.
  3. **The rows needed the gutter the handoff does not draw.** Its `padding:12px 0` assumes the
     panel's own 34px inset; taken literally the rows went full-bleed and `since 3 Aug` lost its last
     glyph off the right edge of a 412px phone. Invisible to every test — the string was present and
     correct and simply not on screen. Found by rendering it.
  Verified in a browser at 412×915: all five strings present, no page errors, metas landing on the
  same right edge as the facts strip.
- **Still open after the 2026-08-23 sweeps, in priority order.** Nothing below is unknown; each is
  a decision or a dependency rather than a miss.
  1. **A dead session now locks.** Closed: any 401 from a data call fires `SESSION_LOST_EVENT` from
     the request layer — the one place that sees every response — and `SessionProvider` locks to the
     picker. Sign-in and PIN 401s are excluded (a wrong PIN says nothing about the session), and it
     announces once per outage so a page-load storm is one event. Verified by expiring the cookie
     mid-session in the browser: the panel lands on the picker instead of rendering empty shelves.
  2. **The text sweep is triaged (2026-09-01), and it was never 57 defects.** Re-measured against the
     corrected design it is 154 candidates, and `triage.py` — now part of the harness — sorts them by
     the three causes the README names, mechanically, by asking whether the wording exists in the
     client source at all:
     **20 absent · 78 in source but never driven into that state · 56 composed at runtime.**
     Of the 20 absent, **15 are S3's invented grocery names** on the panel neither sweep can render,
     and 4 are counts off the design's own fixtures (`4 OF 11`, `SPANISH 2`, `LEBANESE 1`).
     **That leaves exactly one real candidate: `IN 14 MTH`**, the design's form for a long-dated
     pantry row, appearing on P1 and P4. The build has no `MTH` anywhere. Not fixed, and deliberately
     not fixed blind — how the section writes dates is a shared value, and this needs the same kind of
     ruling `½ pot` got rather than a guess. (Its neighbour in the extract, `IN 2 D AGO`, is not a
     phrase anybody wrote: it is the extractor merging two adjacent cells, and is not a target.)
     **Two traps found while building the triage**, both of which produced confident wrong answers:
     a design leaf like `YES · NO` is one string that the build renders as button/separator/button, so
     grepping the source for the whole phrase calls a correct panel a content gap; and testing "is
     every long word present" skips that phrase entirely, because nothing in it reaches four letters.
     Split on the leaf's own separators first, and keep the word threshold at three.
  3. **Geometry, re-measured 2026-09-01: 41 → 32 → 23 → 20**, and only the last number means
     anything. Design is left of the arrow, build is right.
     **41 → 32**: the passes were measuring against bands and cut groups the design deleted on
     2026-08-31. Fixed by overlaying the two bundles (`ENVIRONMENT.md`).
     **32 → 23**: nine of those were the matcher comparing a *data* string to whatever element shared
     its words — the design's 28px serif `Chicken Piccata` card heading against a 16px waiting row on
     the same screen, while `.ml-kitchen__dish` (34px serif, the actual counterpart) went unchecked.
     This pass now identifies data per panel from the API responses it served and skips it, counted
     and named rather than dropped quietly. **The obvious implementation of that filter is wrong**:
     regexing `sweep-fixtures.js` for quoted literals desynchronises on the first apostrophe in a
     comment, and it silently caught `Plain flour` while silently missing `Chicken Piccata`.
     **23 → 15**: eight real defects fixed — R3's three source chips, the Kitchen home week strip's
     day column and empty night, the plan pager's label and arrows, and the recipe photo `＋`.
     **All 15 that remain are explained, and none is a defect.** Worked through one at a time on
     2026-09-01, re-running after each change; the diff never showed a new finding.
     - **Six are adjudicated rulings**, all of the same shape — the design draws one component at
       several sizes and the build picks one. Three `24 → 22` destination titles (the recorded 22px
       ruling); `NEXT STEP` and `ADD IT · NEXT ONE` at `12 → 11` and `PUT THEM BACK` at `10 → 11`
       (the 11/12 ruling, which **survives re-measurement**: the current design draws 19 primary
       buttons at 11px, 15 at 12px and 10 at 10px, so 11 is still the plurality).
     - **`›` at `13 → 14` is the same ruling**, newly established: the design draws it at 11, 12, 13,
       14 and 15px across fifteen instances. 13 is the plurality at six. One component, one size.
     - **Three are disabled-state artefacts.** `ADD IT · NEXT ONE`, `SAVE IT ROUGH` and
       `SAVE THE ORDER` all resolve to `rgb(95, 88, 75)`, which is `--text-disabled`: the fixtures
       never put those screens in a state that enables the button.
     - **`What it needs` in amber is a deliberate departure**, already reasoned in a comment at
       `KitchenRecipeScreen.tsx:160` — the handoff reserves amber for time pressure, and a recipe you
       cannot cook tonight was judged to be exactly that.
     - **`Baby` is a false match**: the design's 17px aisle name was compared against the *bottom
       nav's* `Baby` tab label at 9px. Different element, different screen furniture.
     - **Four are bare digits** (`1`, `2`, `2`, `6`) — counts and step numbers the matcher cannot
       place safely.
     So the honest figure is **zero unexplained geometry findings**, which is not the same as zero
     mismatches and should not be written down as if it were.
  4. 41 geometry findings remained as of 2026-08-23 (was 156). Worked through one at a time. Fixed in
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
     declines to guess at.
     **`A link` / `Typing it in` / `Pasting text` on R3 were recorded here as a content gap — "those
     rows do not exist". They did exist**, as `A LINK` / `TYPING IT IN` / `PASTING TEXT`, which is why
     the matcher found them and reported a size: it compares case-insensitively, so a row shouted in
     caps looks present to it and absent to a grep for the drawn words. Fixed 2026-09-01. The handoff
     draws them 16px weight 300 in sentence case — a row of choices, read as words — and the build
     was borrowing `errandalt`, the section's 11px/0.14em quiet secondary action, which made three
     phrases read as three tiny buttons at the point where somebody is choosing how to enter a
     recipe. Done as a `--source` modifier, not a change to `errandalt`: it has 28 uses across 15
     screens, and the last attempt to retune it globally fixed four findings and broke thirteen.
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

- **The five High source findings: written down, and all five remediated on the application side**
  (2026-09-01) — [`.hermes/2026-09-01-five-high-source-findings.md`](../.hermes/2026-09-01-five-high-source-findings.md),
  which carries each one's evidence, severity rationale, definition of done and current status.
  Hermes recovered the original review artifact and rechecked it; Claude spot-checked four of the
  five in current source before acting, and disagreed with part of one (see H1).
  H1 the reader · H2 cookie revocation · H3 the lock as an execution boundary · H4 TLS identity ·
  H5 the deprecated MCP key. Commits `e8ab192`, `f262205`, `a051fde`, `edf476c`, `379d9ed`, `a3f4af9`.
  **Not cleared, and the remaining half is not Claude's.** The gate (`DEPLOYMENT.md:46`) stands until:
  1. **Hermes rotates `Mcp:ApiKey` out of TEST and production.** The application refuses it now; it
     cannot remove it from a server's environment.
  2. **Three startup gates are exercised deliberately in TEST.** The panel will refuse to boot without
     valid `Server:RequiredSans` and `Server:CaPath`, or with `Mcp:ApiKey` set. Intended, and better
     met on purpose than at eight in the morning.
  3. **A fresh full-source review of the changed candidate.** Hermes's own condition, and the diff is
     substantial — three startup gates, a per-request auth change, and a restructured composition
     root. Worth a second pair of eyes on `UNCONFIRMED_PATHS` in `api/client.ts`: four entries that
     constitute the entire client-side identity boundary, and the kind of list that grows quietly.
     `/profiles` is on it because the picker draws before sign-in, and it does return member names to
     an unconfirmed caller.
  **H2 signs the household out once** on first deploy — every cookie predating it carries no version
  claim and is refused. Confirmed by Hermes as intended and preferable to honouring legacy cookies.
  **Two things that look like they should have closed findings and did not**: the Huckleberry
  deletion closed none of them, and `ImageIngress` plus the `ce9ebcd` startup hardening close neither
  H1 nor H4.
  **A correction that came out of H1 and outlives it.** `DECISIONS.md:93-97` claimed the tool-less
  reader was the default; it was describing the isolated `ImageExtractor` path while naming the
  `EventCapture` one, and `EventCaptureOptions` ships `Provider = "hermes"`, `Agent = "barnaby"`. The
  decision record was asserting a safety property the build did not have. Production could never have
  used that path — `Program.cs` refuses to start without the isolated reader — but nothing proved it,
  which is why the finding read as open. Corrected in a dated entry rather than by rewriting history.
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
