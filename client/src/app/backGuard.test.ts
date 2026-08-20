import { describe, expect, it } from 'vitest'
import { guardsBackFrom } from './backGuard'
import { NAV_SECTIONS } from './navConfig'

/**
 * Which screens refuse a back navigation.
 *
 * The line this draws is the whole of the guard's judgement, and it is drawn on the route rather
 * than on a flag callers have to set — so the ten-odd `navigate(-1)` back buttons in the app need
 * to know nothing about it. Getting it wrong in one direction lets an accidental edge swipe leave
 * the tab somebody was working in; in the other, it strands them on a drill-in whose back button
 * has quietly stopped working.
 */

describe('guardsBackFrom', () => {
  /* There is no back affordance on a tab root — the bar is how you change tabs — so every back
     arriving at one is the system gesture or the hardware button, by accident. */
  it('refuses a back from every tab root', () => {
    for (const section of NAV_SECTIONS) {
      expect(guardsBackFrom(section.path), section.path).toBe(true)
    }
  })

  it('refuses a back from the dashboard', () => {
    expect(guardsBackFrom('/')).toBe(true)
  })

  /*
   * Backing out of a recipe is a journey somebody took. These screens carry their own back buttons
   * calling `navigate(-1)`, and absorbing the pop would break every one of them.
   */
  it('allows a back from a drill-in', () => {
    expect(guardsBackFrom('/meals/recipe/5')).toBe(false)
    expect(guardsBackFrom('/care/history')).toBe(false)
    expect(guardsBackFrom('/devices/litter')).toBe(false)
  })

  /* Screens that render outside the nav entirely — the editor, the lock screen, settings. */
  it('allows a back from a screen with no tab', () => {
    expect(guardsBackFrom('/settings')).toBe(false)
    expect(guardsBackFrom('/lock')).toBe(false)
    expect(guardsBackFrom('/event/new')).toBe(false)
  })

  /* Exact match only. A prefix test would catch `/carehistory` and, worse, would make every
     drill-in under a tab look like the tab itself. */
  it('matches the root exactly rather than by prefix', () => {
    expect(guardsBackFrom('/care/')).toBe(false)
    expect(guardsBackFrom('/carehistory')).toBe(false)
  })
})
