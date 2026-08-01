/**
 * The Attendant's identity — the assistant persona behind the Assist tab (THE_ATTENDANT.md).
 *
 * Distinct from the product name ("Central Home"): this is what the assistant is *called* in the
 * transcript, the mic-live banner, and the local wake word the Pi voice bridge listens for.
 */
export const ATTENDANT_NAME = 'Barnaby'

/**
 * Local wake phrases spoken to open the mic. Each one is a separately trained openWakeWord model on
 * the Pi bridge — the bridge matches sound, not text, so this list is a label for the UI and adding
 * to it here does not by itself teach the panel a new phrase (`voice-bridge/README.md`).
 */
export const ATTENDANT_WAKE_PHRASES = [`Hey ${ATTENDANT_NAME}`, `Oh ${ATTENDANT_NAME}`] as const

/** The primary phrase, for places with room for only one. */
export const ATTENDANT_WAKE_PHRASE = ATTENDANT_WAKE_PHRASES[0]
