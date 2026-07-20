# Hybrid local/cloud AI routing (Stage 7+)

The assistant is **hybrid**: routine requests are answered by a **local model on the home server** (free, private, on-LAN), and demanding requests go to a **cloud model (OpenAI)** — to extend paid cloud token usage. This document is the **authoritative design** for that feature; if the copy of `stage-7` / `00-architecture.md` inside the gitignored build package predates the hybrid decision, prefer this file.

Built in **Stage 7** (text/image) and reused by **Stage 8** (voice). Implemented behind the mandatory `IAssistantProvider` seam so nothing downstream (UI, transcript, voice) depends on a specific vendor.

## Components (suggested location: `src/HomeHub.Api/Ai/`)

- **`IAssistantProvider`** — provider-agnostic contract: text turn (with prior turns) → response; image (+ prompt) → analysis. The **response model carries the origin** (`Local` / `Cloud`) and, where available, a confidence signal.
- **`LocalAssistantProvider`** — calls the server-hosted model over a standard HTTP endpoint (e.g. an Ollama-compatible URL on the LAN). Config: `Ai:LocalEndpoint`, `Ai:LocalModel`.
- **`OpenAIAssistantProvider`** — cloud. Key stays server-side: `Ai:OpenAiApiKey`, `Ai:OpenAiModel`.
- **`AssistantRouter`** — sits in front of the two providers; every assistant request goes through it. Controllers/UI depend on the router (or the seam), never a vendor SDK.

## Routing logic

1. **Primary — route by task** (deterministic, legible; the map is tunable config, not hard-coded):
   - **→ Local:** control/action commands ("set living room to 70", "add milk to the list"), unit & measurement conversions, timers, quick household lookups (calendar/todo/climate state), short factual answers.
   - **→ Cloud:** recipe generation, open-ended explanations, broad world-knowledge, long-form / reasoning-heavy requests, and image analysis **unless** the local model is a capable VLM.
2. **Secondary — confidence fallback:** if the local answer is low-confidence or fails a sanity check, **escalate the same request to cloud** and return the cloud result. Accept that escalation costs a local attempt **plus** a cloud call.
3. **Optional override:** allow forcing `local` or `cloud` for a given request.

### On "confidence" (be pragmatic)
Small local models are poor at self-assessment, so "low confidence" should be a **blend**, tuned at build time to the chosen model:
- the model's own signal if usable (self-report, or token log-probabilities), **plus**
- cheap heuristics: empty/too-short answer, obvious hedging/refusal, or a failed format/JSON check (especially for command parsing).
Don't rely on a single clean confidence number; combine signals and make the threshold configurable (`Ai:Routing:*`).

## Frontend — LOCAL / CLOUD indicator (required)
Each assistant turn shows a small, tasteful tag of which backend answered — `LOCAL` vs `CLOUD` — in the ledger aesthetic (letterspaced caps, e.g. brass/verdigris or dim-brass; subtle). On an escalated turn, show the **final** origin (`CLOUD`); optionally hint that it escalated. This makes routing legible so the rules can be tuned and trusted. Consume existing tokens/`ml-` styles; no new visual language.

## Architecture placement
- **Local AI runs on the home server**, never on the kiosk Pi (the Pi stays thin glass). The server's capability sets how large/capable the local model can be and therefore **how aggressively to route local** — a build-time tuning decision pending server specs.
- If no capable local model is available, the router **degrades to cloud-only** with zero architecture change.
- **Voice (Stage 8):** prefer **local STT (e.g. Whisper on the server)** to keep voice input on the LAN; the transcribed text then flows through this same router, so voice inherits routing + the LOCAL/CLOUD indicator automatically.

## Privacy
Local-routed requests stay on the LAN; cloud-routed requests leave it. The router lets routine/private requests stay local by design. Camera-image → AI remains **out of scope** (separate future workstream); do not wire cameras into the assistant.

## Optional later enhancement
**Token-budget awareness:** the router can bias harder toward local as a monthly cloud budget is approached, capping cost. Not v1.

## Done criteria (from Stage 7)
- A task-routed **local** request (e.g. "how many teaspoons in a tablespoon", or a control command) is answered locally, stays on-LAN, indicator shows **LOCAL**.
- A task-routed **cloud** request (e.g. "recipe for coq au vin") is answered by cloud, indicator shows **CLOUD**.
- A **low-confidence local** answer **escalates to cloud** and returns the cloud result (indicator reflects CLOUD).
- All AI access goes through the seam/router; switching a provider or tuning rules requires **no UI change**.