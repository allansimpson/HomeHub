import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearUnlock, locksWhenIdle, mayAccessPrivateCache, shouldAskForPin, TRUST_WINDOW_MS,
  withinTrustWindow,
} from './sessionTrust'
import type { UnlockNote } from './sessionTrust'
import type { ProfileDto } from '../api/types'

afterEach(() => {
  clearUnlock()
  vi.unstubAllGlobals()
})

/**
 * When the panel asks for a PIN again.
 *
 * Two ways to get this wrong and both are felt immediately: too strict and somebody is typing four
 * digits one-handed at 3am for a screen they unlocked an hour ago; too loose and the gate between
 * two household members has quietly stopped existing. These pin down the edges.
 *
 * `shouldAskForPin` reads `localStorage` for the note, which the node test environment has no
 * opinion about — so the rule is exercised through `withinTrustWindow`, which takes the note as an
 * argument. That is the whole of the decision; the wrapper only fetches it and checks the profile's
 * two flags.
 */

const note = (over: Partial<UnlockNote> = {}): UnlockNote => ({ profileId: 1, atMs: 1_000_000, ...over })

describe('withinTrustWindow', () => {
  it('lets a recent unlock straight back in', () => {
    expect(withinTrustWindow(1, note(), 1_000_000 + 60_000)).toBe(true)
  })

  it('asks again once the window has passed', () => {
    expect(withinTrustWindow(1, note(), 1_000_000 + TRUST_WINDOW_MS + 1)).toBe(false)
  })

  /* Twelve hours is chosen against a night, so the boundary itself is worth stating. */
  it('holds right up to the boundary and not past it', () => {
    expect(withinTrustWindow(1, note(), 1_000_000 + TRUST_WINDOW_MS - 1)).toBe(true)
    expect(withinTrustWindow(1, note(), 1_000_000 + TRUST_WINDOW_MS)).toBe(false)
  })

  /*
   * The one that matters for privacy: an unlock is a statement about one person. Honouring it for
   * another profile would let a PIN typed by one member open a different member's.
   */
  it('never admits a different profile', () => {
    expect(withinTrustWindow(2, note({ profileId: 1 }), 1_000_000 + 60_000)).toBe(false)
  })

  it('never admits nobody', () => {
    expect(withinTrustWindow(null, note(), 1_000_000 + 60_000)).toBe(false)
    expect(withinTrustWindow(undefined, note(), 1_000_000 + 60_000)).toBe(false)
  })

  /* Signing out clears the note; with none there is nothing to trust. */
  it('asks when there is no note at all', () => {
    expect(withinTrustWindow(1, null, 1_000_000)).toBe(false)
  })

  /*
   * A note stamped in the future means the clock moved — a device carried across a time zone, or
   * one whose clock was wrong until NTP corrected it. Refused rather than treated as infinitely
   * fresh, because the alternative fails towards a window that never closes.
   */
  it('refuses a note from the future', () => {
    expect(withinTrustWindow(1, note({ atMs: 2_000_000 }), 1_000_000)).toBe(false)
  })
})

describe('private offline cache boundary', () => {
  it('requires a proved identity and an unlocked screen', () => {
    expect(mayAccessPrivateCache('none', false)).toBe(false)
    expect(mayAccessPrivateCache('server-session', true)).toBe(false)
    expect(mayAccessPrivateCache('server-session', false)).toBe(true)
  })

  /*
   * The offline half. A PIN proved against this device's own sealed enrolment opens the cache
   * without a server — which is safe only because the cache is sealed under the key that proof
   * produces, and is the difference between a usable offline log and an empty one.
   */
  it('admits a PIN proved on the device, and still not while locked', () => {
    expect(mayAccessPrivateCache('device-pin', false)).toBe(true)
    expect(mayAccessPrivateCache('device-pin', true)).toBe(false)
  })

  it('does not let a forged persisted unlock note bypass the PIN boundary', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => JSON.stringify({ profileId: 1, atMs: Date.now() }),
      setItem: () => undefined,
      removeItem: () => undefined,
    })
    const profile = {
      id: 1,
      hasPin: true,
      requirePinWhenIdle: true,
    } as ProfileDto

    expect(shouldAskForPin(profile)).toBe(true)
  })
})

/**
 * The idle lock, and the condition that is deliberately not in it — HH-06.
 *
 * <b>`lockNow` used to begin `if (!onlineRef.current) return`.</b> The reasoning was sound when it was
 * written: unlocking was a round trip to `signIn`, so an idle timeout with no connection would strand
 * somebody behind a keypad that rejects every correct PIN. What it also was, once `requirePinWhenIdle`
 * is read as the privacy control it is, is a way to switch the household's own setting off from
 * outside — pull the router, wait, and a shared wall panel sits indefinitely on a decrypted care log.
 *
 * These take the connection reading as an argument precisely so that a future edit which starts
 * consulting it fails here rather than passing quietly. An absence is not something a test can hold.
 */
describe('locksWhenIdle', () => {
  const locking = { id: 1, hasPin: true, requirePinWhenIdle: true } as ProfileDto

  it('locks a profile that asked for it whether or not the house is reachable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null, setItem: () => undefined, removeItem: () => undefined,
    })

    expect(locksWhenIdle(locking, true)).toBe(true)
    expect(locksWhenIdle(locking, false)).toBe(true)
  })

  it('reaches the same answer as the boot path, connected or not', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null, setItem: () => undefined, removeItem: () => undefined,
    })

    for (const online of [true, false]) {
      // Two copies of this rule would be two places for them to drift apart, and the symptom would be
      // a panel that locks in one situation and not the other for no reason anybody could see.
      expect(locksWhenIdle(locking, online)).toBe(shouldAskForPin(locking))
    }
  })

  it('still never asks a profile that did not opt in, offline included', () => {
    const open = { id: 2, hasPin: false, requirePinWhenIdle: false } as ProfileDto

    expect(locksWhenIdle(open, false)).toBe(false)
    expect(locksWhenIdle(null, false)).toBe(false)
  })

  /*
   * The trusted window is the remaining condition and is unchanged by any of this — it is asserted
   * against `withinTrustWindow` above, which is where the decision actually lives. What matters here
   * is only that `locksWhenIdle` defers to it rather than adding a term of its own.
   */
  it('adds no condition of its own beyond the one the boot path uses', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null, setItem: () => undefined, removeItem: () => undefined,
    })
    const at = 1_000_000 + TRUST_WINDOW_MS + 1

    expect(locksWhenIdle(locking, false, at)).toBe(shouldAskForPin(locking, at))
    expect(locksWhenIdle(locking, true, at)).toBe(shouldAskForPin(locking, at))
  })
})
