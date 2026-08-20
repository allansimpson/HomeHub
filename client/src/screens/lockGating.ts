/**
 * Gating rules for the Lock screen — choose a person, *then* enter a key.
 *
 * Pure and separate from the view because the rule that matters here is not a visual one: the
 * keypad must be unreachable until a profile owns it. The old screen showed the tiles and a live
 * keypad together, so digits could be pressed with nobody selected — they went nowhere, silently,
 * and the meta slot meanwhile read `ELEANOR'S PIN REQUIRED` before Eleanor had been chosen. Both of
 * those are states this module makes unrepresentable rather than merely unlikely.
 */

/** Digits in a PIN. Four, with no confirm key — the fourth digit is the submission. */
export const PIN_LENGTH = 4

/** Just enough of a profile to decide what tapping its row does. */
export interface GatedProfile {
  id: number
  hasPin: boolean
}

export type RowAction = 'enter-pin' | 'sign-in'

/**
 * What a tap on this row does.
 *
 * `hasPin` alone, not `requirePinWhenIdle && hasPin`. The server requires the PIN of any profile
 * that has one (SessionController.SignIn), so the two settings answer different questions: `hasPin`
 * decides whether signing in needs the keypad, `requirePinWhenIdle` decides whether the panel
 * re-locks after idling. Conflating them is what made Allan's PIN "not work" — his profile had a
 * PIN with requirePinWhenIdle off, so the tile signed in with no PIN at all and the server refused
 * it, without the keypad ever appearing.
 */
export function rowAction(profile: GatedProfile): RowAction {
  return profile.hasPin ? 'enter-pin' : 'sign-in'
}

/**
 * The sheet, as one value.
 *
 * Digits and owner live in the same state deliberately: the invariant "there are no digits without
 * a profile" is then a property of the type rather than a rule two `useState`s have to keep
 * agreeing about.
 */
export interface SheetState {
  profileId: number | null
  digits: string
}

export const CLOSED: SheetState = { profileId: null, digits: '' }

export function openSheet(profileId: number): SheetState {
  return { profileId, digits: '' }
}

export function pressDigit(state: SheetState, digit: string): SheetState {
  if (state.profileId == null || state.digits.length >= PIN_LENGTH) return state
  return { ...state, digits: state.digits + digit }
}

export function backspace(state: SheetState): SheetState {
  if (state.profileId == null) return state
  return { ...state, digits: state.digits.slice(0, -1) }
}

/** Empty the squares but keep the sheet open — the CLEAR key, and what a wrong PIN leaves behind. */
export function clearDigits(state: SheetState): SheetState {
  if (state.profileId == null) return state
  return { ...state, digits: '' }
}

/** Four digits are in: there is nothing left to press, so this is the moment to verify. */
export function isComplete(state: SheetState): boolean {
  return state.profileId != null && state.digits.length === PIN_LENGTH
}

/**
 * The right-hand count on the label row.
 *
 * It counts, and never names. Naming a profile before anyone has chosen one both leaks who lives
 * here to whoever is standing in front of a panel they cannot open, and answers a question that has
 * not been asked yet.
 */
export function profileCount(total: number): string {
  return total === 1 ? '1 PROFILE' : `${total} PROFILES`
}

export type RowTone = 'locked' | 'open' | 'entering'

export interface RowMeta {
  text: string
  tone: RowTone
  /** Whether the lock glyph leads the line. */
  lock: boolean
}

/** The line under a name: what this row will do, in the row's own words. */
export function rowMeta(profile: GatedProfile, selectedId: number | null): RowMeta {
  if (!profile.hasPin) return { text: 'SIGNS IN · NO PIN', tone: 'open', lock: false }
  if (profile.id === selectedId) return { text: 'ENTERING PIN', tone: 'entering', lock: true }
  return { text: 'PIN REQUIRED', tone: 'locked', lock: true }
}

export interface PinSublineInput {
  /** The PIN could not be checked at all — a different fact from its being wrong. */
  unreachable: boolean
  /** Seconds left on a server-imposed cooldown, or null. */
  lockedFor: number | null
}

/**
 * The line under "Eleanor's PIN" in the sheet header — and the only surface that can explain why
 * the keys have stopped answering.
 *
 * The unreachable case leads, because it is the only one that changes what to do about it. A
 * cooldown is a reason to wait; "the server cannot be reached" means no PIN will work at all until
 * something else changes, and somebody standing there needs that before they try a fourth time.
 * Saying nothing — which is what this screen used to do on a non-401 — is indistinguishable from
 * being told you are wrong, repeatedly, by a panel that will not say so.
 */
export function pinSubline({ unreachable, lockedFor }: PinSublineInput): string {
  if (unreachable) return 'NO CONNECTION · PIN CANNOT BE CHECKED'
  if (lockedFor) return `LOCKED · ${lockedFor}s`
  return 'FOUR DIGITS'
}
