/**
 * The steps of changing or removing a PIN — current, new, confirm — as a value rather than as four
 * `useState`s that have to keep agreeing with each other.
 *
 * <b>Why this exists at all.</b> A PIN could be set and it could be cleared, and there was nothing
 * in between: the only route to a different PIN was Household → Clear PIN followed by turning the
 * lock back on, which is two screens, and which any passer-by at an already-unlocked panel could do
 * without knowing the PIN they were replacing. The flow here asks for the PIN in force first, every
 * time, session or no session — that is the whole point of it, and the server refuses the change
 * without it regardless of what this module decides (`ProfilesController.RefuseWithoutCurrentPin`).
 *
 * Pure and apart from the screen for the same reason `lockGating` is: the interesting rules are not
 * visual. "The confirm is compared against the first entry, never against the current PIN" and "the
 * current PIN is asked for once and reused when the new one is finally submitted" are properties
 * worth asserting directly, and a component test would only reach them through three keypads.
 */

import { PIN_LENGTH } from './lockGating'

// Re-exported so a screen driving this flow needs one import, and so the length of a PIN keeps
// having exactly one definition.
export { PIN_LENGTH }

/** What the flow is for. Removing a PIN needs the current one and nothing else. */
export type PinTask = 'set' | 'clear'

export type PinStep = 'current' | 'enter' | 'confirm'

export interface PinChangeState {
  step: PinStep
  /** The PIN being replaced, once typed. Empty when this flow was never going to ask for one. */
  current: string
  /** The new PIN as first typed, held until the confirm either matches it or does not. */
  first: string
  /** What is on the keypad now. */
  digits: string
}

/**
 * A fresh flow.
 *
 * `askCurrent` is the caller's, not this module's, because it is an answer about *who is asking*:
 * a member changing their own PIN must prove it, an administrator resetting somebody else's cannot
 * (they do not know it) and the server lets them through. Mirroring that decision here keeps the
 * keypad from demanding four digits the server was never going to check.
 */
export function startPinChange(askCurrent: boolean): PinChangeState {
  return { step: askCurrent ? 'current' : 'enter', current: '', first: '', digits: '' }
}

export function pressDigit(state: PinChangeState, digit: string): PinChangeState {
  if (state.digits.length >= PIN_LENGTH) return state
  return { ...state, digits: state.digits + digit }
}

export function backspace(state: PinChangeState): PinChangeState {
  return { ...state, digits: state.digits.slice(0, -1) }
}

export function clearDigits(state: PinChangeState): PinChangeState {
  return { ...state, digits: '' }
}

export function isComplete(state: PinChangeState): boolean {
  return state.digits.length === PIN_LENGTH
}

/**
 * What the fourth digit of the current step means. There is no confirm key anywhere in this app's
 * PIN entry, so completing the row *is* the submission.
 */
export type PinAdvance =
  /** Nothing to send yet — carry on at the next step. */
  | { kind: 'next'; state: PinChangeState }
  /** The two entries of the new PIN disagreed. Start the new PIN again, keeping the current one. */
  | { kind: 'mismatch'; state: PinChangeState }
  /** Ready to save. `currentPin` is null only when nobody was ever going to be asked for it. */
  | { kind: 'set'; pin: string; currentPin: string | null }
  /** Ready to remove, with the proof the server will demand. */
  | { kind: 'clear'; currentPin: string }

export function advance(state: PinChangeState, task: PinTask): PinAdvance {
  const entered = state.digits

  if (state.step === 'current') {
    // Removing a PIN is one step long: the PIN in force is the only thing being asked for.
    if (task === 'clear') return { kind: 'clear', currentPin: entered }
    return { kind: 'next', state: { ...state, step: 'enter', current: entered, digits: '' } }
  }

  if (state.step === 'enter') {
    return { kind: 'next', state: { ...state, step: 'confirm', first: entered, digits: '' } }
  }

  // confirm
  if (entered !== state.first) {
    /*
     * Back to the new PIN, not back to the beginning.
     *
     * Mistyping the confirmation says nothing about the current PIN, which was accepted a moment
     * ago — making somebody re-type it because their thumb slipped on the seventh digit would be
     * the panel punishing them for its own strictness.
     */
    return { kind: 'mismatch', state: { ...state, step: 'enter', first: '', digits: '' } }
  }

  return { kind: 'set', pin: entered, currentPin: state.current || null }
}

/**
 * The line above the keypad. It names the step, because three identical keypads in a row is the
 * one way this flow can go wrong for somebody who knows all the PINs involved.
 */
export function stepPrompt(state: PinChangeState, task: PinTask, name: string): string {
  if (state.step === 'current') {
    return task === 'clear' ? `${name}’s PIN, to remove it` : `${name}’s current PIN`
  }
  return state.step === 'enter' ? `New PIN for ${name}` : 'Confirm new PIN'
}
