import { describe, expect, it } from 'vitest'
import { tabToRestore } from './lastTab'

/**
 * When a launch is redirected to the tab somebody was last on.
 *
 * Every clause here is a case where restoring would be *wrong*, and the cost of getting one of them
 * backwards is the app overriding somewhere a person deliberately asked to be. The happy path is
 * one line; the rest of this file is the refusals.
 */

const phone = { at: '/', remembered: '/care', handheld: true }

describe('tabToRestore', () => {
  it('returns to the tab the phone was left on', () => {
    expect(tabToRestore(phone)).toBe('/care')
  })

  /* The panel is always on, rarely relaunched, and the dashboard is what it exists to show across
     a room. A reboot overnight should not leave it on whatever tab was open at 3am. */
  it('leaves the wall panel on the dashboard', () => {
    expect(tabToRestore({ ...phone, handheld: false })).toBeNull()
  })

  /*
   * Anything that is not the start URL is a deliberate destination — a deep link, a bookmark, a
   * reload of the screen actually in view. Overriding it would replace an explicit request with a
   * remembered one.
   */
  it('never overrides a launch that was aimed somewhere', () => {
    expect(tabToRestore({ ...phone, at: '/meals' })).toBeNull()
    expect(tabToRestore({ ...phone, at: '/meals/recipe/5' })).toBeNull()
    expect(tabToRestore({ ...phone, at: '/lock' })).toBeNull()
  })

  it('does nothing on a first launch with nothing remembered', () => {
    expect(tabToRestore({ ...phone, remembered: null })).toBeNull()
  })

  /* The dashboard is a tab like any other, and being returned to it is indistinguishable from not
     being redirected — so there is nothing to do. */
  it('does nothing when the dashboard is what was remembered', () => {
    expect(tabToRestore({ ...phone, remembered: '/' })).toBeNull()
  })

  /*
   * A value written by an older build whose tab has since been renamed or dropped. Refusing beats
   * navigating to a path that no longer routes, which would open the app on a blank screen.
   */
  it('refuses a remembered path that is no longer a tab', () => {
    expect(tabToRestore({ ...phone, remembered: '/climate' })).toBeNull()
    expect(tabToRestore({ ...phone, remembered: '/nonsense' })).toBeNull()
  })

  /* A drill-in is never stored, but a stale one must not be honoured if it ever were: the tab is
     the unit here, not the screen. */
  it('refuses a remembered drill-in', () => {
    expect(tabToRestore({ ...phone, remembered: '/meals/recipe/5' })).toBeNull()
  })
})
