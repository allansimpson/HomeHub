import { describe, expect, it } from 'vitest'
import { parseRemembered, tabToRestore } from './lastTab'

/**
 * When a launch is redirected to the tab somebody was last on.
 *
 * Every clause here is a case where restoring would be *wrong*, and the cost of getting one of them
 * backwards is the app overriding somewhere a person deliberately asked to be. The happy path is
 * one line; the rest of this file is the refusals.
 */

const NOW = Date.parse('2026-09-01T14:00:00Z')
const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** Left on the Care tab twenty minutes ago, and relaunched at the start URL. */
const launch = { at: '/', remembered: { path: '/care', atMs: NOW - 20 * MINUTE }, now: NOW }

describe('tabToRestore', () => {
  it('returns to the tab the app was left on', () => {
    expect(tabToRestore(launch)).toBe('/care')
  })

  /*
   * The rule that replaced "phones only".
   *
   * The panel is always on and the dashboard is what it exists to show across a room, so a reboot
   * overnight must not leave it on whatever tab was open at 3am. That is a claim about *time* — it
   * is equally true of a phone picked up the next morning — so the gap is what is measured, on
   * every device.
   */
  it('restores a tab that is still recent, whatever the screen', () => {
    expect(tabToRestore({ ...launch, remembered: { path: '/care', atMs: NOW - 3 * HOUR } })).toBe('/care')
  })

  it('opens on the dashboard once the gap is a night rather than a break', () => {
    expect(tabToRestore({ ...launch, remembered: { path: '/care', atMs: NOW - 9 * HOUR } })).toBeNull()
  })

  /*
   * A stamp in the future means the clock moved backwards under us — a panel that lost power and
   * came back before NTP caught up does exactly this. "How long ago" then has no answer, and the
   * dashboard is the safe thing to be wrong with.
   */
  it('refuses a stamp from the future rather than treating it as fresh', () => {
    expect(tabToRestore({ ...launch, remembered: { path: '/care', atMs: NOW + HOUR } })).toBeNull()
  })

  /*
   * Anything that is not the start URL is a deliberate destination — a deep link, a bookmark, a
   * reload of the screen actually in view. Overriding it would replace an explicit request with a
   * remembered one.
   */
  it('never overrides a launch that was aimed somewhere', () => {
    expect(tabToRestore({ ...launch, at: '/meals' })).toBeNull()
    expect(tabToRestore({ ...launch, at: '/meals/recipe/5' })).toBeNull()
    expect(tabToRestore({ ...launch, at: '/lock' })).toBeNull()
  })

  it('does nothing on a first launch with nothing remembered', () => {
    expect(tabToRestore({ ...launch, remembered: null })).toBeNull()
  })

  /* The dashboard is a tab like any other, and being returned to it is indistinguishable from not
     being redirected — so there is nothing to do. */
  it('does nothing when the dashboard is what was remembered', () => {
    expect(tabToRestore({ ...launch, remembered: { path: '/', atMs: NOW } })).toBeNull()
  })

  /*
   * A value written by an older build whose tab has since been renamed or dropped. Refusing beats
   * navigating to a path that no longer routes, which would open the app on a blank screen.
   */
  it('refuses a remembered path that is no longer a tab', () => {
    expect(tabToRestore({ ...launch, remembered: { path: '/climate', atMs: NOW } })).toBeNull()
    expect(tabToRestore({ ...launch, remembered: { path: '/nonsense', atMs: NOW } })).toBeNull()
  })

  /* A drill-in is never stored, but a stale one must not be honoured if it ever were: the tab is
     the unit here, not the screen. */
  it('refuses a remembered drill-in', () => {
    expect(tabToRestore({ ...launch, remembered: { path: '/meals/recipe/5', atMs: NOW } })).toBeNull()
  })
})

describe('parseRemembered', () => {
  it('reads back what was stored', () => {
    expect(parseRemembered(JSON.stringify({ path: '/kitchen', atMs: NOW })))
      .toEqual({ path: '/kitchen', atMs: NOW })
  })

  /*
   * The build before this one stored a bare path with no stamp. It cannot be aged, so it is not
   * honoured — the household loses one restore, once, and the next tab change writes the new shape.
   */
  it('ignores the older format rather than restoring something it cannot date', () => {
    expect(parseRemembered('/kitchen')).toBeNull()
  })

  it('ignores nothing, junk, and a half-written record', () => {
    expect(parseRemembered(null)).toBeNull()
    expect(parseRemembered('{"path":')).toBeNull()
    expect(parseRemembered(JSON.stringify({ path: '/kitchen' }))).toBeNull()
    expect(parseRemembered(JSON.stringify({ atMs: NOW }))).toBeNull()
    expect(parseRemembered(JSON.stringify({ path: '/kitchen', atMs: 'soon' }))).toBeNull()
  })
})
