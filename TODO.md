# TODO — active build order

Stages 0–9b are **shipped** (see PROJECT.md §12). Everything below is new work.

**Authoritative design docs — these own their workstreams; this file is only the order:**

| Workstream | Doc | Owns |
|---|---|---|
| Huckleberry + baby scale | `huckleberry-integration.md` (rev. 3.1) | Stages H1–H4, S1–S3 |
| Voice output (TTS) | `voice-tts.md` | Stages 8R, 8.5 |
| Meal planning + recipes | `meals-planning.md` (rev. 2) | Stages M1–M5 |
| Everything already built | `PROJECT.md` | Architecture, seams, conventions, §6 hybrid AI routing |

The Huckleberry and voice docs were reconciled against the codebase on 2026-07-25, the
meals doc on 2026-07-31; where they contradicted the repo, the repo won and the doc
carries a reconciliation note.

---

## Unified stage order

- [x] **8R — Voice seam evolution** — **DONE.** `ITextToSpeech` carries
      `SpeechRequest`/`Prosody`/`VoiceHealth`; `VoiceRouter` + deadline fallback;
      `PhraseCache` with startup hash invalidation; `ChatterboxTextToSpeech` implemented;
      both speech paths unified on `POST /api/voice/speak` (bridge keeps local Piper as
      its offline fallback). 8 router tests.
- [ ] **H1 — Huckleberry HA setup + verification** 🔒 **blocked-on-human-input (Gate H0)**
      HACS install, config flow, work Gate H0 items 1–4, record findings in the doc.
- [x] **H2 (reads) — provider + endpoints** — **DONE, ahead of H1.** Shared
      `HomeAssistantClient` extracted with climate refactored onto it;
      `IHuckleberryProvider` + HA-backed reads + not-connected fallback; `api/baby/*`;
      no write queueing; 10 provider tests against a stubbed HA. Entity/attribute names
      are centralised in `HuckleberryEntities` so Gate H0.2 is a one-file correction.
- [x] **H2 (writes) — DONE.** All 18 services behind `IHuckleberryProvider`, grouped into
      four methods (timer actions, diaper, bottle, growth). `device_id` resolved over REST
      via HA's template endpoint — no WebSocket needed. Weight crosses the API boundary as
      **pounds + ounces** and converts to decimal imperial pounds. Writes never queue and
      fail visibly (502). 22 tests asserting the exact JSON sent to HA.
- [ ] **H3 — Meridian Ledger UI** *(Baby dashboard section + `/baby` drill-in)*
      ⏳ **awaiting front-end design from Claude Design.** The read API it needs is live.
      Includes **manual growth entry** — ships regardless of the scale workstream and is
      its permanent fallback. No new nav item (nav stays at seven).
- [ ] **S1 — Scale capture to HA** 🔒 **blocked-on-human-input (Gate S0)**
      ESP32 per the Gate S0 outcome route. *Drops entirely if S0 hits its stop-rule.*
- [ ] **S2 — Auto-log engine in HomeHub.Api** 🔒 *blocked on S1*
      D3 rules 1–6; `ScaleAutoLogSettings` EF entity; decision-engine unit tests.
- [ ] **S3 — Panel surfaces for scale events**
      Confirm prompt, auto-log announce + Undo, Settings rows.
- [ ] **H4 — Real-time push** *(builds the push layer; nothing to wait for)*
      HA WebSocket → panel. **Evaluate SSE before committing to SignalR** — neither
      exists today (PROJECT.md §11). Largest stage here.
- [ ] **8.5 — Chatterbox TTS** ⏸ **code is in; unblocks on GPU install.**
      `ChatterboxTextToSpeech` is implemented and registered. Turning it on is: deploy
      Chatterbox-TTS-Server, set `Voice:Tts:Chatterbox:Endpoint`, set
      `Voice:Tts:Primary=chatterbox`. Then tune the per-prosody exaggeration/cfg values in
      config by ear, and verify VRAM co-residency with the local LLM under simultaneous load.
      Still needs a decision on streaming: sentence-chunking requires streaming assistant
      responses, which does not exist (`IAssistantProvider.CompleteAsync` returns a
      single result). Either scope a streaming prerequisite stage or accept whole-reply
      synthesis.

- [x] **M1 — Meals data model + CRUD API** — **DONE.** `Meals/` entities (`Recipe`,
      `RecipeIngredient`, `RecipeStep`, `RecipeTag`, `MealPlanEntry`), migration
      `20260731155717_AddMealsAndRecipes`, `RecipesController` + `MealsController`
      talking to the DbContext directly (no seam — doc D1), 9b conditional writes on
      both. 23 tests. Client types + `api.*` methods mirrored.
      Decisions worth carrying into M2: `MealPlanEntry` has a **unique (Date, Slot)**,
      so assignment is an upsert and the week read is a lookup; deleting a planned
      recipe **rewrites its plan entries to free text** holding the title rather than
      blanking the night; `Completeness`/`IncompleteReason`/`ImportMethod` columns ship
      now so **M2 needs no migration of its own**. `SourceUrl` is deliberately
      **not indexed** — nvarchar(1000) is 2000 bytes, over SQL Server's 1700-byte
      nonclustered key limit, so import-dedupe needs a hash column instead.
      Verified end-to-end against real SQL Server, not just the in-memory tests.
- [ ] **M2 — JSON-LD recipe import** ✅ **unblocked — Gate M0 retired in rev. 2.**
      `RecipeFetcher` with the SSRF guard **first** (doc D4), then `JsonLdRecipeImporter`
      (a class, not a seam), `IngredientParser` (deterministic — doc D3), D10
      completeness scoring, `SupportedRecipeSites` roster (doc D9 — known-good metadata,
      **not** a fetch allowlist), disk image cache. Adds the AngleSharp package.
      Fixture-based tests from real pages — no network.
- [ ] **M3 — Meals tab (Meridian Ledger UI)**
      ⏳ **awaiting front-end design from Claude Design** — brief handed over in
      `MEALS_SCREEN_BRIEF.md`; the read/write API it needs is live (M1 done).
      Deliverable back is `MEALS_SCREEN.md` in `TODO_SCREEN.md` form. Six open
      questions in the brief's §7, of which two are real forks: **nine nav items vs a
      dashboard row** (doc D8), and how the detail screen scales servings when only
      some ingredient lines parsed. Then: `ico-meals` sprite symbol, week screen (tab
      home), recipe folder, recipe detail, assign flow through `writeQueue`, dashboard
      "Tonight" line.
- ~~**M4 — LLM import fallback**~~ — **DROPPED (rev. 2).** Import is JSON-LD only;
      ingredient parsing moved into M2 as a deterministic parser. Later stages renumbered.
- [ ] **M4 — Cook mode** — steps as ledger rows, step timers reusing `AlertEngine` +
      the 8R speech path. Timers survive navigation.
- [x] ~~**M5 — Shopping list → Microsoft To Do**~~ — **SUPERSEDED by the Pantry section
      (P below).** The plan here was to derive a list from the week and push it into To
      Do. The Pantry handoff reversed the ownership: HomeHub owns `GroceryLine` and To
      Do is a *projection* of it (`DECISIONS.md` P8). That was the right call and not a
      detail — meals belong to the household while To Do lists belong to a signed-in
      profile, and owning the list locally is the only arrangement that survives the
      mismatch. It also buys two things a derived push cannot: provenance on each row,
      and the return trip, where ticking a line puts stock back on a shelf. There *is*
      now a separate list UI (9e), because the return trip needs somewhere to be shown.

- [x] **P — Pantry (stages 0–5)** — **DONE.** `Pantry/` entities (`PantryItem`,
      `PantryEvent`, `ProductCatalogueEntry`, `IngredientAlias`, `GroceryLine` +
      `GroceryLineSourceRef`, `GroceryMirrorSettings`, `OrderImport` +
      `OrderImportLine`, `StockCheckDismissal`), migration `20260801071114_AddPantry`,
      three controllers, six screens (9a–9f), tenth nav item + `ico-pantry`. 56 backend
      tests, 35 client tests.
      Decisions worth carrying forward: **`PantryItem` has no `LastSeenAt` column** —
      it is derived from the ledger, because Stage 0's acceptance is "read from the
      ledger, never written directly" and §3 requires it to revert to the *previous*
      event's timestamp after an undo rather than to now. Undo therefore writes a
      compensating event and **replays**, which is also why `PantryEvent.SetsAbsolute`
      exists: a replay of pure deltas cannot express "somebody counted the shelf and it
      was three", so undoing an earlier delivery would silently rewrite an observation.
      **Volume never converts to weight** (`UnitConversion`) — a density table is the
      confident wrongness P9 forbids — so a counted item with unconvertible units
      deducts *nothing* and says so in words on the receipt.
      The **product catalogue ships empty**: there is no bundled barcode database and no
      third-party lookup, and per PG4 that is the design rather than a gap — `NAME IT`
      writing a household entry is the whole learning mechanism.

**Ordering constraints honored:** H3's manual growth entry ships regardless of the scale
workstream; the S-chain hangs off H3 and never gates it — if Gate S0 fails, S1–S3 drop
and nothing else moves. The M-chain is independent of both and **has no human-input
gates at all** — M1–M5 can be built end to end while H1 and S1 wait on theirs.

---

## Verification gates — human action required, workable in parallel

- [ ] **Gate H0** *(before H1)* — 1. HA Core ≥ 2026.3 · 2. post-HACS entity/attribute
      enumeration for one child + diaper/growth `services.yaml` fields · 3. pull a week
      of `calendar.{child}_events`, judge payload fitness for the history drill-in ·
      4. confirm the HomeHub long-lived token grants service-call permission.
- [ ] **Gate S0** *(before S1)* — nRF Connect BLE spike on the GG scale: adverts, GATT
      enumeration/notifications, weight bytes + units + settled flag, check for standard
      Weight Scale Service `0x181D`, second-central behavior vs the GG app.
      **Stop-rule: ~3 evenings, then fall back to H3 manual entry.** Record in
      `gg-scale-ble.md`.
- [x] ~~**Gate M0**~~ — **RETIRED (rev. 2).** The spike existed to choose between
      JSON-LD-only, JSON-LD-plus-LLM, and abandoning import; that choice was made by
      decision instead. Seeding the site roster survives as a build task inside M2, and
      the paywall risk it would have caught is now handled at runtime by the doc's D10
      completeness check. **No human input needed before M2.**
- [ ] **Meals Q1** — nav metrics at nine items (doc D8): does `CALENDAR` clip at 4K
      portrait, and is the `.ml-nav__label` tracking reduction needed? Measured, not
      estimated.
- [ ] **Meals Q2** — import endpoint auth posture (doc D6): confirm plan-of-record
      LAN-trust, or elect the shared-secret header.
- [ ] **Pantry Q1** — nav at **ten** items on the real 4K portrait panel
      (`PANTRY_NAV.md`). Measured in a 540×960 browser: ten labels, no clipping, no
      overlap, widest label `WEATHER` at 45px in a 52px cell, tightest gap 14px
      (`CLIMATE`→`WEATHER`), centre pitch ratio 1.19×. **Needs a photograph** — the
      handoff is explicit that a browser measurement is not the acceptance.
- [ ] **Pantry Q2** — who owns the Graph token for the grocery mirror, and what happens
      when they leave the household (`BUILD_ORDER.md` open #2). Built as
      `GroceryMirrorSettings.OwnerProfileId` with a `SignInExpired` strip state that
      asks for a new owner; nobody has chosen an owner yet, so the mirror is `Off`.
- [ ] **Pantry Q3** — whether the grocery list should also appear as a first-class list
      inside the Todo tab, or only as a link from there (`BUILD_ORDER.md` open #3).
      **Not built either way** — it is reached from the Pantry tab's header for now.
- [x] ~~**Pantry Q5a** — a non-`BarcodeDetector` decoder for iOS~~ — **NOT NEEDED.** Confirmed
      2026-08-01: every device that will scan in this household is Android, and Chrome on Android
      has shipped `BarcodeDetector` since Chrome 83. `zxing-wasm` would have been a dependency
      bought for a platform nobody here uses. The scan screen's `no-decoder` state stays — desktop
      browsers still hit it, and it is what stops the panel pretending it can scan.

- [ ] **Pantry Q5b — the deployed panel has no TLS, and that is now the only thing between the
      household and working barcode scanning.** Dev is sorted (`deploy/dev-https.md`) and verified:
      `isSecureContext` and `getUserMedia` both true, Android will scan against a dev machine
      today. But the real panel is served `ASPNETCORE_URLS=http://0.0.0.0:5000`
      (`deploy/server-systemd.md`), and a phone pointed at *that* gets no camera — `getUserMedia`
      is not blocked there, it is absent. So scanning currently works only against a laptop, which
      is not where anyone unpacks shopping.
      The fix is small and already half-built: re-run `scripts/make-dev-certs.sh` with the panel
      host's address so the existing CA signs a certificate for it, give the panel's Kestrel the
      same presence-detected HTTPS binding Development already has, and the household's phones —
      which trust the CA once — need nothing further. Decide before the pantry is relied on.
- [ ] **Pantry Q4** — receipt-photo imports. The route is accepted (`OrderImportSource.Photo`)
      and lands on the same review screen, but nothing here does OCR, so a photo arrives
      with whatever text the caller supplies. Needs a decision on an OCR service before
      it is more than a placeholder.
- [ ] **Huckleberry Q3** — history drill-in scope (depends on Gate H0.3).
- [ ] **Huckleberry Q4** — growth delete/edit availability via HA → how strong Undo can be.
- [ ] **voice-tts Q2** — kiosk autoplay for alert audio with no prior gesture. Narrowed:
      affects the browser path only, not the voice bridge.
- [ ] **voice-tts Q3** — the actual ALSA device string on the Pi (mechanism already
      identified: `APLAY_DEVICE` → `aplay -D`).

**Resolved without you** and recorded in the docs: Piper wiring (subprocess, both paths),
audio-device mechanism, phrase-cache invalidation (startup hash check),
`HomeAssistantClient` sequencing (H2), ESPHome config location (`deploy/esphome/`).
