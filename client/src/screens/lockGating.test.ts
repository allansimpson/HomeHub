import { describe, expect, it } from 'vitest'
import {
  CLOSED, PIN_LENGTH, backspace, clearDigits, isComplete, openSheet, pressDigit, pinSubline,
  profileCount, rowAction, rowMeta,
} from './lockGating'

const profile = (id: number, hasPin: boolean) => ({ id, hasPin })

describe('row action', () => {
  it('opens the keypad for a profile that has a PIN', () => {
    expect(rowAction(profile(1, true))).toBe('enter-pin')
  })

  it('signs in a profile with no PIN rather than asking for one', () => {
    expect(rowAction(profile(2, false))).toBe('sign-in')
  })
})

describe('sheet state', () => {
  it('holds no digits while no profile is chosen', () => {
    expect(CLOSED).toEqual({ profileId: null, digits: '' })
    expect(pressDigit(CLOSED, '4')).toEqual(CLOSED)
    expect(backspace(CLOSED)).toEqual(CLOSED)
    expect(clearDigits(CLOSED)).toEqual(CLOSED)
  })

  it('opens empty, even onto a profile chosen a moment ago', () => {
    const typed = pressDigit(openSheet(1), '7')

    expect(openSheet(1)).toEqual({ profileId: 1, digits: '' })
    expect(typed.digits).toBe('7')
  })

  it('stops at the PIN length so a fifth press cannot overrun the entry', () => {
    let state = openSheet(1)
    for (const d of ['1', '2', '3', '4', '5']) state = pressDigit(state, d)

    expect(state.digits).toBe('1234')
    expect(state.digits).toHaveLength(PIN_LENGTH)
  })

  it('completes only on a full entry that has an owner', () => {
    expect(isComplete(openSheet(1))).toBe(false)
    expect(isComplete({ profileId: 1, digits: '1234' })).toBe(true)
    expect(isComplete({ profileId: null, digits: '1234' })).toBe(false)
  })

  it('backspaces and clears without losing the owner', () => {
    const state = { profileId: 1, digits: '123' }

    expect(backspace(state)).toEqual({ profileId: 1, digits: '12' })
    expect(clearDigits(state)).toEqual({ profileId: 1, digits: '' })
  })
})

describe('label row', () => {
  it('counts the profiles and never names one', () => {
    expect(profileCount(3)).toBe('3 PROFILES')
    expect(profileCount(1)).toBe('1 PROFILE')
  })
})

describe('row meta', () => {
  it('marks a locked profile as needing a PIN', () => {
    expect(rowMeta(profile(1, true), null)).toEqual({
      text: 'PIN REQUIRED', tone: 'locked', lock: true,
    })
  })

  it('says plainly that an unlocked profile just signs in', () => {
    expect(rowMeta(profile(2, false), null)).toEqual({
      text: 'SIGNS IN · NO PIN', tone: 'open', lock: false,
    })
  })

  it('switches the chosen row to the entering state', () => {
    expect(rowMeta(profile(1, true), 1).text).toBe('ENTERING PIN')
  })

  it('leaves an unlocked profile alone even when it is somehow the selection', () => {
    expect(rowMeta(profile(2, false), 2).text).toBe('SIGNS IN · NO PIN')
  })
})

describe('pin subline', () => {
  it('names the entry when nothing has gone wrong', () => {
    expect(pinSubline({ unreachable: false, lockedFor: null })).toBe('FOUR DIGITS')
  })

  it('counts down a cooldown', () => {
    expect(pinSubline({ unreachable: false, lockedFor: 30 })).toBe('LOCKED · 30s')
  })

  it('leads with an unchecked PIN, which is not the same as a wrong one', () => {
    expect(pinSubline({ unreachable: true, lockedFor: null }))
      .toBe('NO CONNECTION · PIN CANNOT BE CHECKED')
  })

  it('keeps the connection message ahead of a stale cooldown', () => {
    expect(pinSubline({ unreachable: true, lockedFor: 12 }))
      .toBe('NO CONNECTION · PIN CANNOT BE CHECKED')
  })
})
