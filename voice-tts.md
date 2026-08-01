# Voice output (TTS) — design & migration plan

> Authoritative design for speech synthesis in HomeHub. Companion to **PROJECT.md §6
> (Hybrid AI routing)**, which owns STT/assistant routing; this doc owns the voice
> *output* path. Lives at the repo root alongside `PROJECT.md`, `NOTES.md` and the other
> living docs — `docs/` was folded into the PROJECT.md knowledge base in `8b04237` and
> removed.
>
> **Reconciled against the codebase 2026-07-25.** This doc was drafted assuming Stage 8
> was unbuilt. It shipped at `d41f39c`, and Phases 1–3 on `feature/local-voice-stack`
> added local STT and the Pi voice bridge. The work below is therefore a **refactor of a
> live seam — Stage 8R**, not a greenfield build. See §Reconciliation notes.
>
> **Decision:** ship Stage 8R on **Piper** (current setup, CPU, no new hardware), then
> migrate the primary voice to **Chatterbox** once a GPU is installed in the server —
> as a configuration change, not a rewrite. Piper is retained permanently as the
> degraded-mode fallback.

## Why Chatterbox as the target

- MIT-licensed family from Resemble AI; markedly more natural than Piper and the only
  open model tier with **emotion control** (exaggeration/CFG) and paralinguistic tags
  (`[sigh]`, `[chuckle]` — Turbo variant).
- Variants: **Turbo (350M, ~75ms latency, ~6x real-time — the target for the panel)**,
  Original 0.5B (max English expressiveness), Multilingual (23 languages; not needed).
- Self-hosts behind an **OpenAI-compatible `/v1/audio/speech` API**
  (Chatterbox-TTS-Server project), which is the integration surface HomeHub.Api will
  use — plus a community streaming fork (~0.47s to first chunk on a 4090) if
  first-chunk latency needs tightening later.
- Realistic constraint: conversational latency **requires CUDA**. CPU inference is too
  slow for assistant replies — hence Piper-first until the GPU exists.

## The seam: evolve `ITextToSpeech` (not a new `IVoiceProvider`)

**Reconciled.** This doc originally proposed a new `IVoiceProvider`. The seam already
exists and is live: `src/HomeHub.Api/Ai/ITextToSpeech.cs`, implemented by
`PiperTextToSpeech`, consumed by `VoiceController` (`POST /api/voice/speak`) and the
client's `speech.ts`. Introducing a second interface with the same job would fork a
shipped seam for a rename. **Decision: extend `ITextToSpeech` in place.** The doc's real
requirement — prosody present at every call site from day one — is met either way.

Current signature: `Task<byte[]?> SynthesizeAsync(string text, CancellationToken ct)`.

```csharp
public interface ITextToSpeech
{
    bool IsAvailable { get; }

    // Retained; becomes a thin shim over the overload below (Neutral, cache allowed).
    Task<byte[]?> SynthesizeAsync(string text, CancellationToken ct);

    // Stage 8R: the prosody-aware contract every call site targets.
    Task<byte[]?> SynthesizeAsync(SpeechRequest request, CancellationToken ct);

    Task<VoiceHealth> GetHealthAsync(CancellationToken ct);
}

public record SpeechRequest(
    string Text,
    Prosody Prosody = Prosody.Neutral,   // neutral | urgent | warm | subdued
    bool AllowCache = true);
```

**`byte[]`, not `IAsyncEnumerable<AudioChunk>`, for now.** Streaming is deferred to
Stage 8.5 for two concrete reasons: `PiperTextToSpeech` shells out to a process that
writes a complete temp WAV (there is nothing to stream), and the assistant path can't
feed a stream anyway (see §Reconciliation notes, "streaming has a prerequisite"). Adding
chunked returns now would be a fictional abstraction over two non-streaming ends. It
lands with Chatterbox, where it is real.

**No call site may reference Piper or Chatterbox directly** — that rule stands unchanged.

**Emotion-aware from day one.** `Prosody` is part of the contract *now*, in Stage 8R,
even though Piper ignores it:

| Prosody | Piper | Chatterbox (later) |
|---|---|---|
| `Neutral` | default voice | exaggeration ≈ 0.5, cfg ≈ 0.5 |
| `Urgent` (severe weather, threshold alerts) | default | exaggeration ↑ (~0.7), cfg ↓ (~0.3), no tags |
| `Warm` (assistant chat, greetings) | default | exaggeration ≈ 0.55, tags permitted |
| `Subdued` (night hours — pairs with night-dim) | default | exaggeration ↓, slower pacing |

Every Stage 8R call site chooses a prosody at write time (alerts → `Urgent`, assistant →
`Warm`, etc.). When Chatterbox lands, the whole app becomes emotion-capable with zero
call-site changes. Exact parameter values are config, tuned by ear post-migration.

## Implementations

### `PiperTextToSpeech` (exists — primary now, fallback forever)
- **Already built** (`src/HomeHub.Api/Ai/PiperTextToSpeech.cs`). Wiring, for the record
  (this doc's open question 1, now answered): it **shells out to the Piper binary** —
  `piper --model <voice> --output_file <temp.wav>`, text on stdin, WAV read back and
  deleted. Not Wyoming, not HTTP. Config is `Voice:Tts` (`PiperPath`, `VoiceModel`,
  `TimeoutSeconds`) in `VoiceOptions`.
- Stage 8R change is additive: accept `SpeechRequest`, ignore `Prosody`, consult the
  phrase cache. CPU, fully local. Health = binary + model present and a probe succeeds.

### `ChatterboxTextToSpeech` (Stage 8.5 — primary after GPU)
- HTTP client to Chatterbox-TTS-Server (`/v1/audio/speech`), running as a systemd
  service on the Ubuntu server (unit + env-file per `deploy/server-systemd.md`
  conventions; model + reference voice path in config, never secrets in git).
- Model: **Turbo**. Voice: **one neutral custom "house voice"** from a reference clip.
  Deliberate policy: **do not clone a family member's voice** — the panel announces
  emergencies and 3am alerts; a cloned household voice is a misfeature. (Chatterbox
  output carries Resemble's PerTh watermark; irrelevant for home use, noted for
  completeness.)
- Streaming: sentence-chunk assistant replies — synthesize per sentence as the
  `AssistantRouter` emits them; never wait for the full LLM reply before first audio.

### Selection & fallback (`VoiceRouter`, thin)
- Config `Voice:Primary` = `piper` | `chatterbox`; migration is flipping this value.
- Runtime fallback: if primary health-fails or first chunk exceeds a deadline
  (config, ~2.5s), fall back to Piper for that utterance and mark degraded. **Alert
  speech (`Urgent`) always uses whichever engine can speak *now*** — an alert must
  never wait on GPU warm-up, VRAM contention, or a down service.

## Pre-rendered phrase cache (engine-independent)
Fixed strings — alert preambles ("Severe weather alert"), timer chimes, "reconnecting",
mic on/off cues — are synthesized **once at deploy/config time** with the current
primary voice and stored as WAVs served from the API. Playback of time-critical fixed
phrases costs zero inference on any engine. Cache is regenerated when the primary
voice/engine changes (a `dotnet run --prerender-voice` style task or startup check on
voice-config hash). `AllowCache=false` bypasses for dynamic text.

## Staged plan

- **Stage 8R — BUILT.** `ITextToSpeech` carries `SpeechRequest`/`Prosody`/`VoiceHealth`;
  `VoiceRouter` selects the primary and falls back on the deadline; `PhraseCache` invalidates on a
  startup config-hash check; `ChatterboxTextToSpeech` is implemented and waiting on config; the Pi
  bridge now speaks through `POST /api/voice/speak` with a local-Piper fallback. What remains is
  the human verification below (kiosk autoplay, ALSA device string) and the GPU itself.
- *(original plan, for reference)* **Stage 8R:** extend `ITextToSpeech` with
  `SpeechRequest`/`Prosody`, add `VoiceRouter` + phrase cache, annotate every existing
  call site with a prosody, and **unify the two speech paths** (below — the prerequisite
  for everything else here). Panel audio playback path (kiosk Chromium autoplay policy:
  audio is permitted after any user gesture; verify the idle→alert case where no gesture
  preceded — may need the kiosk flag `--autoplay-policy=no-user-gesture-required`).
  Note this applies **only to the browser path**; bridge-spoken audio never touches
  Chromium.
- **Stage 8.5 (after GPU install):** deploy Chatterbox-TTS-Server (Turbo), select the
  house reference voice, implement `ChatterboxTextToSpeech`, tune prosody params,
  regenerate phrase cache, flip `Voice:Primary`. Verify VRAM co-residency with the
  local LLM under simultaneous load (assistant reply = LLM + TTS at once — this is the
  realistic worst case, test it explicitly).

## GPU purchase guidance (for the human, not Claude Code)
TTS is not the VRAM driver — the local LLM is. Chatterbox Turbo fits in a few GB; buy
for LLM + TTS **co-resident**. Practical tiers: used RTX 3090 24GB (recommended —
comfortable LLM + Turbo simultaneously, no model swapping); RTX 4060 Ti 16GB
(workable, constrains the LLM); ≤12GB (forces choosing between a decent local model
and resident TTS — undermines the hybrid routing design; avoid).

## Risks & tradeoffs
- **Two engines to keep working.** Accepted: Piper's job narrows to "always speaks,"
  which is cheap to maintain; the fallback path is exercised by the alert deadline
  logic, not left to rot.
- **Voice discontinuity during fallback** (Chatterbox voice → Piper voice mid-degrade).
  Accepted and honest — a different voice that speaks beats the right voice that
  doesn't. Panel may show the existing degraded/offline chip.
- **Chatterbox is young.** Pin versions; the OpenAI-compatible server is a community
  wrapper — treat its API surface as the contract and keep the provider thin so a
  wrapper swap is contained.
- **Latency tuning is empirical.** Sentence chunking + Turbo should feel conversational;
  if first-chunk latency disappoints, the streaming fork is the next lever before any
  architectural change.

## Open questions — resolved from the codebase

1. **Piper integration details — answered.** Subprocess on both paths; see
   `PiperTextToSpeech` above and §Reconciliation notes for the Pi bridge's separate
   invocation. Wrap as-is, don't re-plumb.
3. **Where audio plays from — mechanism answered, value outstanding.** The Pi bridge
   plays through **ALSA `aplay`**, device selected by the `APLAY_DEVICE` env var
   (`aplay -D`), defaulting to the system default — `voice-bridge/homehub_voice/config.py`.
   It is undocumented in `deploy/pi-kiosk.md`; document it once the actual device string
   is confirmed on the Pi (human, below).
4. **Phrase-cache invalidation — decided: startup hash check.** On boot, hash the voice
   config (engine + model + reference voice + prosody params); regenerate the cache on
   mismatch. Chosen over an explicit task because a deploy-time step that must be
   remembered will eventually be forgotten, and the failure mode is silent — the panel
   speaking alert preambles in a voice the rest of the app no longer uses.

## Open questions — need the human

2. **Kiosk autoplay** for alert audio with no prior gesture (verify on the Pi). Narrowed:
   this only affects panel-initiated speech via the browser path, not the voice bridge.
3. The **actual ALSA device string** on the Pi (see above).

## Reconciliation notes

### There are two speech paths, and this doc assumed one
The codebase speaks through two independent Piper invocations, split by initiator:

| Initiator | Path | Reaches `ITextToSpeech`? |
|---|---|---|
| Wake word ("Hey Barnaby" / "Oh Barnaby") | `voice-bridge` → `/api/voice/transcribe` → `/api/assistant/chat` → **local `PiperTTS` → `aplay` on the Pi** | **No** — bypasses the API's TTS entirely |
| Panel touch / on-screen | `speech.ts` → `POST /api/voice/speak` → `PiperTextToSpeech` → `new Audio().play()`, browser `speechSynthesis` as fallback | Yes |

The bridge (`voice-bridge/homehub_voice/bridge.py`, `tts.py`) runs its own
`piper --output-raw | aplay`. Consequence: **prosody, the phrase cache, the Piper
fallback deadline, and the eventual Chatterbox swap would all miss wake-word replies** —
the most-used voice path. Flipping `Voice:Primary` to `chatterbox` would leave the
bridge speaking in Piper indefinitely.

**Resolved in Stage 8R — the bridge now speaks through the server.** `tts.SpeechOutput` posts to
`POST /api/voice/speak` and plays the returned WAV through `aplay`; `PiperTTS` remains as the
local fallback when the API is unreachable, and `TTS_PREFER_SERVER=0` forces local-only. The table
above now describes only the pre-8R state.

*Original recommendation:* repoint the bridge's TTS at
`POST /api/voice/speak` and have it play the returned WAV through `aplay`. The bridge
already has an HTTP client to the API (`api.py`) calling two endpoints; this is a third.
Server-side stays the single voice authority, and the Pi keeps only playback — which is
the same "the Pi is glass, no app logic" principle the Huckleberry doc uses to justify
putting BLE capture on an ESP32 rather than the Pi. Piper-on-the-Pi is worth retaining
as a hard offline fallback for when the API is unreachable, since a bridge that can't
reach the server also can't say so.

### Streaming has an unscoped prerequisite
"Sentence-chunk assistant replies — synthesize per sentence as the `AssistantRouter`
emits them" cannot be built as written. `IAssistantProvider.CompleteAsync` returns
`Task<ProviderResult>` — one complete result, no token streaming, in either the OpenAI
or local provider. Delivering this needs streaming through the provider seam, the
router, `AssistantController`, and the client — a substantial change scoped in neither
doc. **Treat "streaming assistant responses" as an explicit prerequisite stage before
Stage 8.5's streaming claim**, or drop sentence-chunking from 8.5 and accept
whole-reply synthesis (Turbo at ~6× real-time makes this tolerable for short replies).
