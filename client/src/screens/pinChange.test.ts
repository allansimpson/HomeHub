import { describe, expect, it } from 'vitest'
import {
  PIN_LENGTH, advance, backspace, clearDigits, isComplete, pressDigit, startPinChange, stepPrompt,
} from './pinChange'
import type { PinChangeState, PinTask } from './pinChange'

/** Type a whole PIN, advancing at the fourth digit the way the screen does. */
function type(state: PinChangeState, pin: string, task: PinTask = 'set') {
  let s = state
  for (const d of pin) s = pressDigit(s, d)
  expect(isComplete(s)).toBe(true)
  return advance(s, task)
}

describe('asking for the PIN in force', () => {
  it('starts on the current PIN when the caller has one to prove', () => {
    expect(startPinChange(true).step).toBe('current')
  })

  it('skips straight to the new PIN when nobody is going to be asked', () => {
    // A profile with no PIN yet, or an administrator resetting somebody else's — the server does
    // not ask for a current PIN in either case, so neither does the keypad.
    expect(startPinChange(false).step).toBe('enter')
  })

  it('carries the current PIN through to the save, not just past the first screen', () => {
    const afterCurrent = type(startPinChange(true), '1111')
    expect(afterCurrent.kind).toBe('next')
    if (afterCurrent.kind !== 'next') return

    const afterNew = type(afterCurrent.state, '2222')
    expect(afterNew.kind).toBe('next')
    if (afterNew.kind !== 'next') return

    const saved = type(afterNew.state, '2222')
    expect(saved).toEqual({ kind: 'set', pin: '2222', currentPin: '1111' })
  })

  it('sends no current PIN when it was never asked for', () => {
    const afterNew = type(startPinChange(false), '4321')
    if (afterNew.kind !== 'next') throw new Error('expected the confirm step')

    expect(type(afterNew.state, '4321')).toEqual({ kind: 'set', pin: '4321', currentPin: null })
  })
})

describe('removing a PIN', () => {
  it('is one step: the PIN in force, and nothing after it', () => {
    expect(type(startPinChange(true), '9876', 'clear')).toEqual({ kind: 'clear', currentPin: '9876' })
  })
})

describe('the confirm', () => {
  it('compares against the new PIN, never against the current one', () => {
    const afterCurrent = type(startPinChange(true), '1111')
    if (afterCurrent.kind !== 'next') throw new Error('expected the new-PIN step')
    const afterNew = type(afterCurrent.state, '2222')
    if (afterNew.kind !== 'next') throw new Error('expected the confirm step')

    // Typing the *old* PIN at the confirm is a mismatch, not a save. Accepting it would make the
    // flow silently keep the PIN it was called to replace.
    expect(type(afterNew.state, '1111').kind).toBe('mismatch')
  })

  it('sends a mismatch back to the new PIN, keeping the current one already proved', () => {
    const afterCurrent = type(startPinChange(true), '1111')
    if (afterCurrent.kind !== 'next') throw new Error('expected the new-PIN step')
    const afterNew = type(afterCurrent.state, '2222')
    if (afterNew.kind !== 'next') throw new Error('expected the confirm step')

    const mismatched = type(afterNew.state, '3333')
    expect(mismatched.kind).toBe('mismatch')
    if (mismatched.kind !== 'mismatch') return

    expect(mismatched.state.step).toBe('enter')
    expect(mismatched.state.current).toBe('1111')
    expect(mismatched.state.first).toBe('')
    expect(mismatched.state.digits).toBe('')
  })
})

describe('the keypad', () => {
  it('stops at the PIN length so a fifth press cannot overrun the entry', () => {
    let state = startPinChange(true)
    for (const d of ['1', '2', '3', '4', '5']) state = pressDigit(state, d)

    expect(state.digits).toBe('1234')
    expect(state.digits).toHaveLength(PIN_LENGTH)
  })

  it('backspaces and clears without leaving the step', () => {
    const typed = pressDigit(pressDigit(startPinChange(true), '1'), '2')

    expect(backspace(typed).digits).toBe('1')
    expect(clearDigits(typed).digits).toBe('')
    expect(clearDigits(typed).step).toBe('current')
  })
})

describe('the prompt', () => {
  it('names the step, so three identical keypads are not the same screen', () => {
    const current = startPinChange(true)
    expect(stepPrompt(current, 'set', 'Astrid')).toBe('Astrid’s current PIN')
    expect(stepPrompt(current, 'clear', 'Astrid')).toBe('Astrid’s PIN, to remove it')

    const next = advance(pressDigit(pressDigit(pressDigit(pressDigit(current, '1'), '1'), '1'), '1'), 'set')
    if (next.kind !== 'next') throw new Error('expected the new-PIN step')
    expect(stepPrompt(next.state, 'set', 'Astrid')).toBe('New PIN for Astrid')
  })
})
