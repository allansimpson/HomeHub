# Huckleberry + baby scale integration — design & build plan (rev. 3)

> Authoritative plan for adding Huckleberry (baby tracking) logging + display to HomeHub,
> including automatic weight capture from the Greater Goods (GG) Smart Baby Scale over
> BLE. Lives at the repo root alongside `PROJECT.md` and the other living docs — `docs/`
> was folded into the PROJECT.md knowledge base in `8b04237` and removed. Claude Code:
> read fully, work the verification gates before their stages, and raise objections in
> dialogue first.
> Revision history: rev. 1 proposed a custom sidecar; rev. 2 flipped to HA-first after
> the HA spike; rev. 3 adds the BLE scale workstream (Stages S1–S3); **rev. 3.1
> reconciled against the actual codebase (2026-07-25)** — see the reconciliation callouts
> in Part 4 and the resolved items in Part 6.

---

## Part 1 — Background

### The reverse-engineering landscape

Huckleberry has no official API. Projects analyzed:

| Project | What it is | Role in this plan |
|---|---|---|
| [Woyken/py-huckleberry-api](https://github.com/Woyken/py-huckleberry-api) | **The canonical client.** Python library talking to Huckleberry's Firebase Firestore backend via the official Google Cloud Firestore SDK (gRPC): email/password auth + token refresh, Pydantic schemas, real-time snapshot listeners. ~44 stars, 24 releases, live-credential CI, active (v0.4.3, May 2026). | Upstream source of truth; powers the HA integration below. |
| [Woyken/huckleberry-homeassistant](https://github.com/Woyken/huckleberry-homeassistant) | HA custom integration (HACS) wrapping the library. | **The chosen integration path** — see spike results. |
| [bckenstler/py-huckleberry-mcp](https://github.com/bckenstler/py-huckleberry-mcp) | FastMCP server wrapping the library (22 tools). | Reference for assistant tool shape (Stage 7+ workstream). |
| [KenLSM/node-huckleberry-mcp](https://github.com/KenLSM/node-huckleberry-mcp) | TypeScript port (Firebase JS SDK, 24 tools incl. `edit_*` + history). | Fallback client code if a sidecar is ever needed; assistant reference. |

**Critical constraint:** Huckleberry's Firebase Security Rules block non-SDK requests —
direct REST returns `403`. All access must go through an official Firebase SDK (gRPC),
so `HomeHub.Api` can never call Huckleberry with `HttpClient`, and a native C# port is
rejected (re-deriving every schema with no upstream). All access goes through Woyken's
library — via HA (chosen) or a direct sidecar (documented fallback, see rev. 1 in git
history).

### HA spike results (2026-07-25)

`huckleberry-homeassistant` covers ~90% of the wall-panel scope:

**Reads (per child, as an HA device):** `sensor.{child}_sleep` (sleeping/paused/none;
attributes incl. `is_paused`, `sleep_start`, `timer_start_time` → live elapsed timer on
the panel), `sensor.{child}_nursing`, `sensor.{child}_bottle` (last bottle: time,
amount, type), `sensor.{child}_diaper`, `sensor.{child}_growth` (latest measurements),
`sensor.{child}_profile`, and `calendar.{child}_events` (all history — sleep, nursing,
diaper, growth — fetched per date range via HA's calendar REST API). Real-time sync via
Firebase listeners inside HA: phone-initiated events reach HA entities without polling.

**Writes (HA services, device/child-targeted):** full sleep timer (`start/pause/resume/
cancel/complete_sleep`), full nursing timer (incl. `switch_nursing_side`), `log_bottle`
(amount, type, oz/ml), `log_diaper_pee|poo|both|dry`, **`log_growth`**.

**Known gaps:** (1) no retroactive/explicit-timestamp logging services — timers +
log-now only; backfill stays on the phone app; (2) diaper detail fields (color/
consistency/amount) unverified until `services.yaml` is inspected post-install; (3)
calendar events may be stringly-typed — verify fitness for the history drill-in; (4) no
pumping/solids/potty (out of v1 scope); (5) **requires Home Assistant 2026.3+.**

### GG Smart Baby Scale findings (2026-07-25)

- **No official API; no published reverse-engineered client** for GG Smart Baby (cloud
  or BLE) — unlike Huckleberry, we have no upstream here.
- The scale is **BLE-only**: it syncs to the phone app over Bluetooth when the app is
  open. There is no scale→cloud path, so the cloud backend (likely a sibling of the
  reverse-engineered `api.weightgurus.com`) only ever holds what a phone pushed.
  **BLE capture is the only *live* path.**

  > **Revised (2026-07-29):** rev. 3 concluded from this that "cloud RE is pointless for
  > automation." That overstates it. Cloud can't give live capture — correct — but it can still
  > eliminate the step that actually costs something today: **hand-retyping the weight from the GG
  > app into Huckleberry.** Compare
  > *manual* (weigh → read GG app → retype into Huckleberry) with a *cloud bridge* (weigh → open GG
  > app → HomeHub polls → auto-logs correctly). That removes the transcription error, which matters
  > disproportionately here because **no delete service exists** — a typo'd weight is permanent.
  > The risk profile also favours cloud: HTTPS + auth with a reverse-engineered sibling backend to
  > start from, versus an undecoded proprietary GATT protocol where we would be the upstream.
  > Cloud is therefore a **fallback tier before manual entry**, not a dead end. See the outcome
  > ladder in Part 3.
  >
  > *Objection that doesn't hold:* that a cloud dependency breaks the local-first design. Huckleberry
  > itself is Firebase-backed cloud and is already the system of record for this data, so a GG cloud
  > poll breaks no new ground.
- The scale is manufactured by Transtek; the BLE protocol is proprietary and undecoded.
  "Sync needs the app open" suggests it likely requires a **GATT connection** rather
  than broadcasting weight in advertisements — but this is unverified (see Gate S0).
- The app offers CSV export (manual escape hatch only).
- **Web Bluetooth in the kiosk Chromium is ruled out:** needs a user gesture, needs a
  secure context (kiosk is plain HTTP), and cannot background-scan. The capture point
  must be a native BLE listener, not the browser.

---

## Part 2 — Architecture decisions

### D1. Huckleberry access: HA-first behind `IHuckleberryProvider`

Integrate through Home Assistant (already the hardware abstraction layer for climate/
Govee), mirroring the "`ISensorProvider` — direct, with HA-backed option" pattern
inverted: **HA-backed first**, direct sidecar (FastAPI + `huckleberry-api`) as the
documented fallback behind the same seam if gaps bite. No UI/controller change to swap.

Why: ~90% of scope with zero new services, no second credential store (Huckleberry
creds live in HA's config flow), HomeHub already speaks HA REST/WebSocket, real-time
becomes an HA WebSocket `state_changed` subscription instead of custom Firestore→
SignalR plumbing, and upstream maintenance is Woyken's own most-used packaging.

### D2. Scale capture: ESP32 Bluetooth proxy → Home Assistant (not the Pi, not the browser)

The BLE listener is an **ESPHome ESP32 Bluetooth proxy** (or a dedicated ESPHome node
doing the GATT work itself — Gate S0 decides which) feeding HA. Rejected alternatives:

- *Browser (Web Bluetooth):* ruled out above.
- *Python `bleak` service on the Pi:* works, but violates "the Pi is glass — no app
  logic," ties capture range to the wall-panel location, and adds a deploy surface to
  the device that is supposed to be disposable.

The ESP32 (~$5) is placed **where the baby is actually weighed** (nursery), keeps the
Pi pure, and rides HA's first-class Bluetooth infrastructure — consistent with
everything else in this plan routing through HA. Weight then flows: scale → ESP32 → HA
(sensor or event) → HomeHub.Api → `huckleberry.log_growth` → Huckleberry (system of
record, visible to both phones with percentile charts).

### D3. Auto-logging policy: automatic, but guarded

Requirement: when the scale powers on and produces a settled reading, the weight logs
itself with no interaction. Naive auto-log is a data-quality hazard (tare weights,
towels, re-weighs, pets), so "automatic" means **auto-log when confident, confirm when
not**:

1. **Settled-only:** only capture the scale's final/hold reading (the protocol has a
   settling flag — identify it in Gate S0). Never log intermediate readings.
2. **Plausibility window per child:** auto-log only if the reading is within a
   configurable band around the child's last known Huckleberry weight (default: last
   weight −2% … +12%, covering normal gain between weigh-ins). Multi-child: the window
   also disambiguates which child; overlapping windows force a confirm.
3. **Debounce:** one auto-log per scale session; repeat settled readings within 10 min
   update nothing and instead surface a confirm ("Replace 8.42 kg with 8.45 kg?").
4. **Out-of-window readings are never dropped silently:** the panel shows a tappable
   prompt ("Weight detected: 6.1 kg — log for [child]?") via the alert/banner surface;
   unactioned prompts expire after 30 min.
5. **Every auto-log is announced:** a transient panel notice ("Logged 8.42 kg for
   [child]") with an Undo affordance — undo is possible because the HA integration's
   underlying library supports history reads; if no delete path exists via HA services,
   Undo instead deep-links the instruction "remove in the Huckleberry app" honestly.
   (Claude Code: verify whether a delete/edit service exists; the node MCP has
   `edit_growth`/delete upstream — HA may not expose it. Record the finding.)
6. **Kill switch:** Settings toggle "Auto-log scale weights" (default on once trusted;
   ship defaulted to *confirm-first* for the first two weeks of real use, then flip).

Auto-log decision logic lives in **HomeHub.Api** (it has child context, history, and
the panel), not in ESPHome/HA automations — HA just delivers raw settled readings.

---

## Part 3 — Verification gates (do before the dependent stage)

**Gate H0 (before H1):**
1. HA Core ≥ 2026.3 (upgrade deliberately first if not).
2. After HACS install + config flow: enumerate real entities/attributes for one child
   (Developer Tools → States) and diaper/growth service fields (`services.yaml`).
3. Pull a week of `calendar.{child}_events` via HA REST; judge whether payloads are
   structured enough for the history drill-in (else defer history or scope a read-only
   sidecar later).
4. Confirm HomeHub's HA long-lived token grants service-call permission.

### Gate H0 results (2026-07-29)

**H0.1 — HA version: DONE.** Was 2026.2.3; the integration's `hacs.json` declares
`"homeassistant": "2026.3.0"`, confirmed at source. Upgraded to **2026.7.4**.
*Non-obvious blocker:* HA ≥ 2026.3 requires **Python ≥ 3.14.2**, and the Ubuntu 24.04 venv install
was on 3.13 — so `pip install --upgrade homeassistant` reported "already satisfied" at 2026.2.3
rather than failing, because pip was correctly filtering releases it couldn't run. Resolved by
installing 3.14.2 via `uv` and rebuilding the venv. Install layout and procedure are recorded in
`deploy/home-assistant-core.md`.

**H0.2 — entities and attributes: DONE** (integration **v0.4.3**, one child, slug `conrad`).
Entities: `sensor.{child}_{sleep,nursing,bottle,diaper,growth,profile}`,
`calendar.{child}_events`, `switch.{child}_{sleep_timer,nursing_left,nursing_right}`, plus an
integration-level `sensor.huckleberry_children`.

Corrections this forced in `HuckleberryEntities` — the spike notes were wrong on most attribute names:

| Field | Spike note | Actual |
|---|---|---|
| Timer "running" state | `sleeping` | **`active`** (options: `active`/`paused`/`none`) |
| Paused | `is_paused` attribute | **a state value**, not an attribute |
| Timer start | `sleep_start`, `timer_start_time` | **neither exists** |
| Nursing side | `side` | **`previous_last_side`** (`"Right"`, capitalised) |
| Last nursing | `last_nursing` | **`previous_start`** |
| Bottle/diaper time | `last_bottle` / `last_diaper` | **`time`** (also the state value) |
| Bottle unit | `unit` | **`units`** |
| `amount`, `type`, `name` | — | correct as noted |

Better than planned: **`sensor.huckleberry_children`** publishes a `children` array with `uid`,
`name`, `birthday` — now the primary child-discovery source, with the entity-name heuristic as
fallback. **`sensor.{child}_profile`** exposes the child `uid` (what service calls need) plus
`night_start` / `morning_cutoff`, which are directly useful for the panel's night-dim and the
`Subdued` voice prosody. Timers are also plain **`switch`** entities, so the write half can use
`switch.turn_on`/`turn_off` rather than only custom services.

**Running-timer attributes: RESOLVED** (captured from a live timer). While `active` or `paused`, the
sensor adds **`current_start`**. This is load-bearing rather than cosmetic: on the observed sample
`current_start` and the entity's `last_changed` differed by **98 seconds**, because restarting a
timer updates `current_start` without changing the state value. An elapsed counter built on
`last_changed` would simply read wrong, so the provider prefers the attribute and keeps
`last_changed` only as a last-resort hedge. Both cases are covered by tests.

**Service targeting: `device_id`, not `entity_id`.** Calling
`huckleberry.cancel_sleep` with `entity_id` returns **400 Entity not found**, consistent with the
v0.4.0 note that `child_uid` was replaced with `device_id`. The write half must resolve a child's HA
*device* id — which the current read path does not capture, since `/api/states` doesn't expose device
ids. That needs the device or entity registry (WebSocket API), and is a design item for the write
half rather than a detail.

*Also learned:* the timer `switch` entities work as ordinary switches (`switch.turn_off` → 200), but
turning one off appears to **complete** a session rather than discard it — the cancel/complete
distinction H3's "cancel-timer confirms" affordance depends on lives in the custom services, not the
switches.

**Growth sensor: likely non-functional, pending one more observation.** A `log_growth` call returned
200 and the entry *did* reach Huckleberry (it was visible in the phone app to delete). The sensor's
`last_changed` moved — but 26 seconds later it still reported `unknown` **with no measurement
attributes at all**. That points to the growth sensor never surfacing measurements in v0.4.3, though
26s isn't conclusive against a backend sync delay. Confirm with one dump a few minutes after the next
*real* weigh-in.

**If confirmed, this breaks part of D3.** Rule D3's auto-log says the panel's growth display updates
*from Huckleberry itself, never from the raw scale value*, so that what you see is what was actually
recorded. With no measurements on the sensor, that verification loop has no data source and growth
reads must come from the **calendar** instead. Plan for that.

**Also learned from a full day of real calendar data:**

- **"Today" must be the local day, not the UTC day** — a real defect, now fixed. At UTC-05:00 a bottle
  logged 20:28 local lands in the *next* UTC day, so every evening between 19:00 and midnight the
  dashboard's counts silently absorbed the previous night's feeds. Verified against the live day:
  6 bottles + 1 nursing = 7 feeds, 4 diapers; the UTC window reported 8. Pinned by a regression test
  using a fixed-offset `TimeProvider`.
- **The calendar carries kinds the sensors don't expose** — e.g. `🩺 Health (Medication)`. Not in the
  spike notes, which listed only pumping/solids/potty as out of scope. Now classified as `health`
  rather than falling through to `other`. Treat the kind list as open-ended: the calendar is the
  richer history source, and the five sensors are only the "latest of each" view.
- Calendar events carry **`uid: null`** — there is no stable per-event identifier, so nothing can be
  referenced or deduped by id. Relevant if Undo ever needs to point at a specific entry.

**H0.3 — calendar payloads: DONE. Verdict: the history drill-in is viable.** Payloads are richer than
the "may be unusable" worry. Summaries are display-formatted (`🍼 Bottle (3.5 oz)`, `🍼 Feed (R:6m)`)
and descriptions carry parseable detail (`Bottle feeding: 3.5 oz\nType: Breast Milk`;
`Feeding - Total: 6 min 29 sec\nLeft: 1 sec\nRight: 6 min 28 sec`). Point-in-time logs arrive with
`end == start`; real sessions have a span. Times carry a local offset.

*This caught a genuine defect.* Nursing sessions are titled **"Feed", not "Nursing"**, and share the
bottle emoji — so the keyword classifier labelled **every nursing session as a bottle**. Invisible in
the daily counts (both are "feeds", so the total was right) but wrong in every history row. Fixed in
`BabyEventClassifier`: `bottle` is tested before any `feed` match, a bare "feed" means nursing, and
classification uses the summary only — a bottle's description says "Type: Breast Milk" and would
false-match otherwise. Emoji are stripped so the panel draws its own sprite icon from `Kind`.

**H0.4 — token service-call permission: DONE.** `POST /api/services/switch/turn_off` returned 200.

### Service surface (verified 2026-07-29, v0.4.3)

18 services, **every one requiring `device_id`** (device selector scoped to the integration):
sleep `start/pause/resume/cancel/complete`; nursing `start/pause/resume/switch_side/cancel/complete`
(`side`: left|right); `log_diaper_pee|poo|both|dry`; `log_growth`; `log_bottle`.

**Doc gap (2) closed — diaper detail exists and is rich:** `pee_amount`/`poo_amount`
(little|medium|big), `color` (yellow|brown|black|green|red|gray), `consistency`
(solid|loose|runny|mucousy|hard|pebbles|diarrhea), `diaper_rash` (bool), `notes` (text).

**`log_growth`:** `weight` (0–50, step .01), `height` (0–200, step .1), `head` (0–100, step .1), all
**optional**; `units` is a *system* (metric|imperial, default metric), not per-measurement.

**`log_bottle`:** `amount` **required** (0–2000, step .5), `bottle_type` **required**
(formula|breast_milk|tube_feeding|cow_milk|goat_milk|soy_milk|other), `units` (ml|oz, default ml).
Note the asymmetry: writes take the enum (`breast_milk`) while reads report the display form
(`"Breast Milk"`) — needs mapping both ways.

**Open question 4 / D3.5 — ANSWERED, unfavourably. There is no delete or edit service anywhere in
the domain.** So the auto-log **Undo cannot retract a logged weight**. The honest fallback ("remove
it in the Huckleberry app") is the only option and must be stated on-panel, not implied. This is a
hard constraint on S2's auto-log design, and strengthens the case for shipping confirm-first.

**Retroactive logging confirmed absent** — no log service accepts a timestamp. Backfill stays on the
phone, as the doc predicted.

**`cancel_*` vs `complete_*` is explicit:** cancel = "no interval saved", complete = "save interval
to history". `switch.turn_off` maps to *complete*, so H3's cancel-timer affordance must call
`cancel_sleep`, not toggle the switch.

**Resolving `device_id` needs no WebSocket.** REST doesn't expose the device registry, but HA's
template endpoint does: `POST /api/template` with `{{ device_id('sensor.{child}_sleep') }}` returns
it. The write half can resolve once per child per refresh and cache — no new infrastructure, and
WebSocket still arrives later with H4 for live push.

**Gate S0 (before S1) — the nRF Connect spike (~20 min + decode time):**
1. With nRF Connect (phone), power the scale: record advertisement payloads. Does
   weight appear in adverts (best case: passive sniffing, no pairing, no contention
   with the GG phone app)?
2. If not: connect, enumerate GATT services/characteristics, subscribe to notifications
   with weight on the tray. Identify the weight bytes, units, and the settled/hold
   flag. Check whether it uses the standard BLE Weight Scale Service (0x181D) — Transtek
   devices sometimes do, which would make decoding near-free.
3. Note connection behavior: does the scale accept a second central while the phone app
   is bonded? (Plan assumes the GG app is retired once this works; state that.)
4. Record everything (MACs redacted as needed) in `gg-scale-ble.md` (repo root).

**Gate S0 outcome ladder** (revised — rev. 3 had a binary BLE-or-manual fallback; the cloud tier
sits between them):

1. *Adverts carry weight* → ESP32 as plain Bluetooth proxy + HA passive BLE sensor. **Best case:**
   passive sniffing, no pairing, no contention with the GG phone app.
2. *GATT required, protocol decoded* → dedicated ESPHome node with `ble_client` + custom decode,
   publishing a settled-weight sensor/event to HA. Fully automatic.
3. *Protocol resists decoding after ~3 evenings* → **stop the BLE work** (the rev. 3 stop-rule
   stands; don't sink unbounded time) and try **Gate S0b — the cloud bridge** before conceding.
4. *Cloud also unavailable* → manual entry on the panel (Stage H3's growth entry), which ships
   regardless and is the permanent floor.

**Gate S0b — cloud spike (only if S0 fails):** confirm whether the GG Smart Baby app pushes readings
to a cloud endpoint at all, and whether it is the `api.weightgurus.com` family. Mostly a matter of
watching the app's traffic. Outcome: a poll-based bridge that auto-logs to Huckleberry once the app
has synced — **partial automation** (still needs the app opened) but it removes the retyping and the
transcription error. Same stop-rule discipline applies.

Note what tier 3–4 changes about the auto-log design: a cloud bridge delivers readings *late and in
batches*, not live, so D3's debounce and "settled reading only" rules become less relevant while the
plausibility window and confirm-prompt become more important.

---

## Part 4 — Staged build plan

### Stage H1 — Huckleberry HA setup + verification (mostly manual)
Install via HACS, complete config flow, work Gate H0, record findings here.
**Done when:** toggling `switch.{child}_sleep_timer` in HA appears in the Huckleberry
phone app, and a phone-started timer shows in HA within seconds.

### Stage H2 — HomeHub.Api provider + endpoints — **READ HALF BUILT**

> **Built:** shared `HomeAssistantClient` (`src/HomeHub.Api/HomeAssistant/`) with the Stage 6
> climate provider refactored onto it; `IHuckleberryProvider` +
> `HuckleberryHomeAssistantProvider` (reads) + `NotConnectedHuckleberryProvider`; in-memory
> `HuckleberrySnapshotCache` with an honest stale flag; `GET api/baby/{health,children,
> {child}/state,{child}/history}`; conditional registration; 10 provider tests against a stubbed
> HA. Entity/attribute names are centralised in `HuckleberryEntities` for a one-file correction
> after Gate H0.2.
>
> **Not built — deliberately:** the write services (timers, `log_bottle`, `log_diaper_*`,
> `log_growth`). Their field signatures are unverified (Gate H0.2), and writes built on guessed
> names fail against real family data rather than failing loudly. They land with Gate H0 and the
> front-end that drives them.

- `IHuckleberryProvider` + `HuckleberryHomeAssistantProvider`: HA REST for reads
  (`/api/states`, calendar) and service calls (`/api/services/huckleberry/...`).
- **Shared `HomeAssistantClient` — decided (this doc's open question 2): built here, in
  H2.** The "whichever lands first" sequencing is moot; Stage 6 climate already shipped
  (`62fffb3`) and did its plumbing inline — `HomeAssistantClimateProvider` sets
  `BaseAddress`/`Bearer` on its own `HttpClient` and hand-rolls `api/states` and
  `api/services/{service}` calls, configured by `HomeAssistantOptions`. H2 extracts that
  into a shared `HomeAssistantClient` (auth, base URL, resilience) and **refactors the
  climate provider onto it**, so there is one HA client rather than two. Budget for the
  climate refactor + its regression check inside H2.
- DTOs mapping HA states/attributes to domain types (child, timer state with elapsed
  basis, last-event summaries, history events).
- Thin controller `api/baby/*`; the SPA never talks to HA directly.
- Offline-first: cache last-known reads, serve stale with an honest flag on HA outage;
  **writes fail fast and visibly — no write queueing** (a silently delayed "fell
  asleep" timestamp is worse than a visible failure). *Confirmed compatible:* Stage 9b's
  `WriteQueueProvider` is opt-in per domain provider, so the baby provider simply doesn't
  enlist — no framework fighting. Document it as a deliberate deviation from the 9b
  convention so it doesn't read as an oversight later.
- Conditional registration like the DB: no config ⇒ boots, section shows "Not
  connected". No EF entities for Huckleberry data (it is the system of record).
- Tests: provider against a stubbed HA API.

### Stage H3 — Meridian Ledger UI
- Dashboard **Baby** section: child + live state ("ASLEEP · 1H 12M" in verdigris —
  live/OK only, per token rules), counts line ("4 feeds · 3 diapers today"). Tap →
  drill-in.
- Drill-in `/baby`: large ledger rows for timer actions; nursing L/R via `Chip`;
  one-tap diaper mode chips; **manual growth entry with `Stepper`** (this ships
  regardless of the scale workstream and is its fallback); recent history via
  `ScrollArea` (scope per Gate H0.3).
- **Nav stays at seven items** (corrected — `navConfig.ts` ships Home · Calendar ·
  Climate · Weather · Todo · Assist · Config; the doc's "five" predates the TODO tab).
  The rule is unchanged and still right: **Baby adds no nav item** — it is a dashboard
  section + drill-in. New `ico-baby` sprite symbol, 24×24 stroke-1.5 deco geometry.
- UI primitives all exist and need no new work: `Stepper`, `Chip`, `ScrollArea`,
  `LedgerRow`, `AlertBanner` are exported from `client/src/components/index.ts`.
- Freshness: poll `api/baby/.../state` every ~15s (upgraded in H4). Cancel-timer
  confirms; logs apply optimistically per conventions.

### Stage S1 — Scale capture to HA (depends on Gate S0)
- ESP32 flashed per the Gate S0 outcome route; mounted near the weigh spot.
- HA ends up with, per settled reading: weight value, unit, timestamp, and a
  session/reading id (for debounce). Exposed as a sensor + fired HA event.
- **Done when:** placing a known weight on the scale produces one settled reading in
  HA and nothing during settling.

### Stage S2 — Auto-log engine in HomeHub.Api
- Subscribe to the scale reading (HA WebSocket event preferred; poll fallback pre-H4).
- Implement D3 rules 1–6: plausibility windows (per-child config, stored in the
  HomeHub DB — this **is** a small EF entity: `ScaleAutoLogSettings`), debounce,
  confirm-prompt surface, announce+undo, kill switch in Settings.
- On accept (auto or confirmed): call `huckleberry.log_growth` via the provider; the
  panel's growth display then updates from Huckleberry itself — never from the raw
  scale value — so what you see is what was actually recorded.
- Tests: decision-engine unit tests (windows, debounce, multi-child ambiguity) with
  no BLE/HA dependency.

### Stage S3 — Panel surfaces for scale events
- Confirm prompt (amber alert-banner reuse — it is an actionable notice, which is what
  amber is for), auto-log announce (transient row/toast in the Baby section with
  Undo), Settings rows (auto-log toggle, per-child window steppers).

### Stage H4 — Real-time push (**this stage introduces push; nothing to wait for**)
- **Reconciled:** the doc's precondition "after SignalR exists anywhere in the app" is
  not satisfiable — there is no SignalR anywhere in the solution, and PROJECT.md §11
  lists both "HA WebSocket live push" and "SignalR backend→client push" as *deferred
  future workstreams*. H4 is therefore the stage that **builds** the push layer, not a
  consumer of an existing one. Size it accordingly — this is the largest stage here.
- **Recommend evaluating SSE before committing to SignalR.** The requirement is one-way
  server→client fan-out to a single kiosk panel. SSE rides the existing HTTP/controller
  stack with no new dependency, no hub lifecycle, and no client library; SignalR's
  duplex/RPC/transport-negotiation buys nothing the panel uses. Take SignalR only if a
  client→server push need appears that the existing REST endpoints can't serve.
- HA WebSocket `state_changed` subscription in HomeHub.Api relaying to the panel, shared
  across huckleberry entities, the scale, and ideally climate/Govee.
  Interim: tighten polls to ~3s. S2's event subscription folds into this.

---

## Part 5 — Risks & honest tradeoffs

- **Two unofficial integrations, different risk classes.** Huckleberry: active upstream
  (Woyken) absorbs breakage. The scale: **we are the upstream** — if Transtek firmware
  changes or the decode is wrong, it's ours to fix. Gate S0's stop-rule bounds the
  downside; manual entry is always the floor.
- **Auto-log data quality.** Mitigated by D3; the two-week confirm-first burn-in is
  deliberate — flip to auto only after the windows prove out.
- **Undo may be weak** if HA exposes no growth delete/edit service (Gate item, D3.5).
  Honest fallback is acceptable for a personal system but must be stated on-panel.
- **HA as a dependency** for baby data + scale capture — already true for climate;
  consistent posture. Provider health must distinguish "HA down" vs "integration
  auth-failed" vs "scale silent" so the panel is truthful.
- **Upstream breaking changes:** huckleberry-homeassistant renamed services/entities at
  v0.4.0 — pin the HACS version, read MIGRATION.md before upgrades.
- **ToS/account risk** of reverse-engineered clients on personal accounts. Accepted.
- **BLE contention:** until Gate S0.3 is answered, assume the GG phone app and the
  ESP32 may fight over the scale. Plan of record: retire the GG app once capture works.

## Part 6 — Open questions

### Resolved against the codebase
2. **Shared `HomeAssistantClient` sequencing — decided: built in Stage H2**, extracting
   from the already-shipped `HomeAssistantClimateProvider` and refactoring climate onto
   it. See Stage H2.
5. **ESPHome config location — proposed: `deploy/esphome/`**, matching the existing
   `deploy/` convention (`pi-kiosk.md`, `server-systemd.md`, `voice-bridge.service`).
   Secrets follow the established rule the rest of the repo already uses — user-secrets
   in dev, env vars in prod, nothing committed; the ESPHome HA key goes in a
   `!secret`-referenced file that is gitignored, never in the checked-in YAML.

### Need the human
1. Gate H0 + Gate S0 outcomes (update this doc and `gg-scale-ble.md`).
3. History drill-in scope — pending Gate H0.3 calendar-payload verification.
4. Growth delete/edit availability via HA → strength of Undo (Gate H0.2 / D3.5).
