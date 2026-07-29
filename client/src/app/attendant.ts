/**
 * The Attendant's identity — the assistant persona behind the Assist tab (THE_ATTENDANT.md).
 *
 * Distinct from the product name ("Central Home"): this is what the assistant is *called* in the
 * transcript, the mic-live banner, and the local wake word the Pi voice bridge listens for.
 */
export const ATTENDANT_NAME = 'Barnaby'

/** Local wake phrase spoken to open the mic (openWakeWord model on the Pi bridge). */
export const ATTENDANT_WAKE_PHRASE = `Hey ${ATTENDANT_NAME}`
