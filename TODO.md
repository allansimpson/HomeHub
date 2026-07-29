# TODO — active build order

Stages 0–9b are **shipped** (see PROJECT.md §12). Everything below is new work.

**Authoritative design docs — these own their workstreams; this file is only the order:**

| Workstream | Doc | Owns |
|---|---|---|
| Huckleberry + baby scale | `huckleberry-integration.md` (rev. 3.1) | Stages H1–H4, S1–S3 |
| Voice output (TTS) | `voice-tts.md` | Stages 8R, 8.5 |
| Everything already built | `PROJECT.md` | Architecture, seams, conventions, §6 hybrid AI routing |

Both docs were reconciled against the codebase on 2026-07-25; where they contradicted
the repo, the repo won and the doc carries a reconciliation note.

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

**Ordering constraints honored:** H3's manual growth entry ships regardless of the scale
workstream; the S-chain hangs off H3 and never gates it — if Gate S0 fails, S1–S3 drop
and nothing else moves.

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
- [ ] **Huckleberry Q3** — history drill-in scope (depends on Gate H0.3).
- [ ] **Huckleberry Q4** — growth delete/edit availability via HA → how strong Undo can be.
- [ ] **voice-tts Q2** — kiosk autoplay for alert audio with no prior gesture. Narrowed:
      affects the browser path only, not the voice bridge.
- [ ] **voice-tts Q3** — the actual ALSA device string on the Pi (mechanism already
      identified: `APLAY_DEVICE` → `aplay -D`).

**Resolved without you** and recorded in the docs: Piper wiring (subprocess, both paths),
audio-device mechanism, phrase-cache invalidation (startup hash check),
`HomeAssistantClient` sequencing (H2), ESPHome config location (`deploy/esphome/`).
