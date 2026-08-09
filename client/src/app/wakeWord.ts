/**
 * The local wake word — the phrases the Pi bridge listens for, and the agent they reach.
 *
 * Replaces `attendant.ts`, which exported `ATTENDANT_NAME` as *the* assistant's name. There is no
 * single assistant any more: Assist names whichever agent's list you are looking at, and that comes
 * from the roster the server sends (`Agent.name`). Nothing in the UI should hard-code a name.
 *
 * What survives is genuinely fixed. Each phrase is a **separately trained openWakeWord model** on the
 * Pi bridge, which matches sound rather than text (`voice-bridge/README.md`). Adding a string here
 * does not teach the panel a new phrase, and — the part that matters for the roster — a second agent
 * does **not** get a wake word for free. Until the bridge carries a second model, the wake word
 * reaches this agent and no other.
 */
export const WAKE_AGENT_NAME = 'Barnaby'

/** Every trained phrase. A label for the UI, not a configuration the bridge reads. */
export const WAKE_PHRASES = [`Hey ${WAKE_AGENT_NAME}`, `Oh ${WAKE_AGENT_NAME}`] as const

/** The primary phrase, for places with room for only one. */
export const WAKE_PHRASE = WAKE_PHRASES[0]

/**
 * The event a wake word raises to open Assist from any screen.
 *
 * **Still not emitted.** The Pi voice bridge runs its own sequential loop — wake, capture,
 * transcribe, ask, speak — entirely off the browser, so a wake phrase today holds a conversation the
 * panel never shows. This remains the single documented seam for closing that gap: whatever the
 * bridge eventually uses to reach the client (SSE, websocket, a poll) raises this one event.
 *
 * What changed is what happens next. It used to raise an overlay over the current screen; it now
 * navigates to `/assist`, because Assist is a place.
 */
export const WAKE_EVENT = 'homehub:wake'
