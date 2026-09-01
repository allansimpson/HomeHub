import { describe, expect, it } from 'vitest'
import { asConfigView, CONFIG_TITLES } from './configViews'

/**
 * Who Config opens which of its sections for.
 *
 * The roster is the one part of Config that is somebody else's business: it names every member of
 * the household and it is where an account is added, renamed or removed. The server has refused
 * those writes to a non-administrator since AUDIT A1.4, so nothing here is what keeps the data
 * safe — what it keeps is the panel honest about which doors will open, and a Member out of a
 * screen that is not theirs to read.
 */
describe('config view access', () => {
  it('opens the roster for an administrator', () => {
    expect(asConfigView('household', true)).toBe('household')
    expect(asConfigView('member', true)).toBe('member')
  })

  /* The whole point. A Member typing the address, or following a link left open on the panel from
     the last person to use it, lands on the index rather than the roster. */
  it('collapses the roster to the index for everybody else', () => {
    expect(asConfigView('household', false)).toBe('index')
    expect(asConfigView('member', false)).toBe('index')
  })

  /*
   * `isAdmin` is false on every cold start and again whenever the panel drops offline —
   * `sessionTrust` restores identity and deliberately not privilege. So "not an administrator"
   * and "not told yet" are the same input here, and both have to fail closed: the roster is
   * withheld until the server says otherwise, never shown while waiting to be told.
   */
  it('withholds the roster while privilege is still unknown', () => {
    expect(asConfigView('household', false)).not.toBe('household')
  })

  /* Everything else in Config is the household's in common, and none of it changes with the role. */
  it('leaves every other section alone for both', () => {
    for (const section of Object.keys(CONFIG_TITLES)) {
      if (section === 'household' || section === 'member' || section === 'index') continue
      expect(asConfigView(section, false)).toBe(section)
      expect(asConfigView(section, true)).toBe(section)
    }
  })

  /* Unchanged: a section nobody has, and the index naming itself, both mean the index. */
  it('still sends an unknown section to the index', () => {
    expect(asConfigView('nonsense', true)).toBe('index')
    expect(asConfigView(undefined, true)).toBe('index')
    expect(asConfigView('index', true)).toBe('index')
  })
})
