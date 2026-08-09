import { describe, it, expect } from 'vitest'
import { directionFor, arePeers } from './routeMotion'

const SEGMENTS = ['/meals', '/meals/recipes', '/meals/pantry']

describe('directionFor — MEALS segment switches', () => {
  /**
   * The bug this file exists for. WEEK · RECIPES · PANTRY live on three nested paths, so depth
   * inferred from the path called every segment tap a drill-in: the incoming screen animated in
   * from 1.25rem low (`ml-vt-up-in`) and settled upward, dropping the tab strip and bringing it
   * back on every tap. Every ordered pair must cross-fade instead.
   */
  it.each(SEGMENTS.flatMap((from) => SEGMENTS.filter((to) => to !== from).map((to) => [from, to])))(
    '%s -> %s cross-fades',
    (from, to) => {
      expect(directionFor(from, to)).toBe('fade')
    },
  )

  it('never rises or settles between segments, in either direction', () => {
    for (const from of SEGMENTS) {
      for (const to of SEGMENTS) {
        expect(directionFor(from, to)).not.toBe('slideup')
        expect(directionFor(from, to)).not.toBe('slidedown')
      }
    }
  })
})

describe('directionFor — the behaviour the fix must not break', () => {
  it('rises into a genuine drill-in', () => {
    expect(directionFor('/calendar', '/calendar/new')).toBe('slideup')
    expect(directionFor('/', '/sensor')).toBe('slideup')
  })

  it('settles back down out of a drill-in', () => {
    expect(directionFor('/calendar/new', '/calendar')).toBe('slidedown')
    expect(directionFor('/sensor', '/')).toBe('slidedown')
  })

  it('cross-fades between bottom-nav tabs', () => {
    expect(directionFor('/', '/calendar')).toBe('fade')
    expect(directionFor('/weather', '/todo')).toBe('fade')
  })

  /**
   * A recipe is a drill-in *from* a segment root, not a peer of it — only the exact roots are
   * peers. Getting this wrong would flatten the drill-in motion across the whole Meals section.
   */
  it('still treats screens under a segment root as drill-ins', () => {
    expect(directionFor('/meals/recipes', '/meals/recipes/42')).toBe('slideup')
    expect(directionFor('/meals/recipes/42', '/meals/recipes')).toBe('slideup')
    expect(directionFor('/meals/pantry', '/meals/pantry/grocery')).toBe('slideup')
    expect(directionFor('/meals', '/meals/week')).toBe('slideup')
  })

  it('settles down from a Meals drill-in back to the section root', () => {
    expect(directionFor('/meals/recipes/42', '/meals')).toBe('slidedown')
  })
})

describe('arePeers', () => {
  it('is symmetric and excludes unrelated paths', () => {
    expect(arePeers('/meals', '/meals/pantry')).toBe(true)
    expect(arePeers('/meals/pantry', '/meals')).toBe(true)
    expect(arePeers('/meals', '/calendar')).toBe(false)
    expect(arePeers('/meals', '/meals/recipes/42')).toBe(false)
  })

  it('does not report a path as its own peer group partner by accident', () => {
    // Same path in and out is not a transition anyone sees, but it must not throw or report
    // a drill-in either.
    expect(directionFor('/meals', '/meals')).toBe('fade')
  })
})
