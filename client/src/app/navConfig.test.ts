import { describe, expect, it } from 'vitest'
import { NAV_SECTIONS, activeSectionPath } from './navConfig'

/**
 * The bottom bar, and which tab lights up for a given route.
 *
 * The cases worth pinning are all about the KITCHEN rename: the slot used to be MEALS, both of the
 * pre-Kitchen route trees are still routed, and a tab that goes dark on a screen you reached from
 * it reads as having navigated somewhere else.
 */
describe('NAV_SECTIONS', () => {
  it('holds eight tabs with the Kitchen in the third slot', () => {
    expect(NAV_SECTIONS).toHaveLength(8)
    expect(NAV_SECTIONS[2]).toEqual({ path: '/kitchen', label: 'Kitchen', icon: 'ico-meals' })
  })

  it('has no MEALS tab left', () => {
    expect(NAV_SECTIONS.some((s) => s.path === '/meals')).toBe(false)
  })
})

describe('activeSectionPath', () => {
  it('lights the Kitchen for the section and everything under it', () => {
    expect(activeSectionPath('/kitchen')).toBe('/kitchen')
    expect(activeSectionPath('/kitchen/plan')).toBe('/kitchen')
    expect(activeSectionPath('/kitchen/pantry/3')).toBe('/kitchen')
    expect(activeSectionPath('/kitchen/list/put-away')).toBe('/kitchen')
  })

  it('lights the Kitchen for the pre-Kitchen routes that are still reachable', () => {
    // The recipe editor is not drawn in the Kitchen handoff, so R2 links out to `/meals/...`.
    expect(activeSectionPath('/meals/recipes/5/edit')).toBe('/kitchen')
    expect(activeSectionPath('/meals')).toBe('/kitchen')
    expect(activeSectionPath('/pantry/anything')).toBe('/kitchen')
  })

  it('does not confuse a Kitchen sub-path with the legacy tree it is named after', () => {
    // `/kitchen/pantry` must not be re-homed by the `/pantry` legacy key — it already belongs.
    expect(activeSectionPath('/kitchen/pantry')).toBe('/kitchen')
  })

  it('still resolves the other tabs, and highlights nothing off the bar', () => {
    expect(activeSectionPath('/')).toBe('/')
    expect(activeSectionPath('/weather')).toBe('/weather')
    expect(activeSectionPath('/sensor/4')).toBe('/devices')
    expect(activeSectionPath('/settings')).toBe('')
  })
})
