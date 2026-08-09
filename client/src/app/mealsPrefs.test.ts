import { describe, expect, it } from 'vitest'
import {
  ALL_SLOTS, DEFAULT_MEALS_SETTINGS, cuisineLabel, cuisineOf, cuisineTag, plainTags,
} from './mealsPrefs'

/**
 * Cuisine is a reserved tag namespace rather than a column (MEALS_DATA_CONTRACT §2). These tests
 * pin the normalisation, because the whole point of it is that the folder groups by cuisine instead
 * of by typing habit — and that only holds if every spelling lands on one tag.
 */
describe('cuisineTag', () => {
  it('collapses every spelling of a cuisine onto one tag', () => {
    expect(cuisineTag('Italian')).toBe('cuisine:italian')
    expect(cuisineTag('ITALIAN')).toBe('cuisine:italian')
    expect(cuisineTag('  italian  ')).toBe('cuisine:italian')
  })

  it('hyphenates multi-word names so they cannot split', () => {
    expect(cuisineTag('Middle Eastern')).toBe('cuisine:middle-eastern')
    expect(cuisineTag('middle   eastern')).toBe('cuisine:middle-eastern')
  })
})

describe('cuisineOf', () => {
  it('finds the cuisine tag and ignores plain ones', () => {
    expect(cuisineOf({ tags: ['quick', 'cuisine:thai', 'weeknight'] })).toBe('cuisine:thai')
  })

  /** No cuisine is the UNCATEGORISED case, not an error. */
  it('returns null when a recipe has none', () => {
    expect(cuisineOf({ tags: ['quick'] })).toBeNull()
  })
})

describe('cuisineLabel', () => {
  /** The household's own spelling wins, so an import reads as the settings screen writes it. */
  it('prefers the household’s canonical spelling', () => {
    expect(cuisineLabel('cuisine:middle-eastern', ['Middle Eastern'])).toBe('Middle Eastern')
  })

  it('title-cases a cuisine the household has not named', () => {
    expect(cuisineLabel('cuisine:middle-eastern', [])).toBe('Middle Eastern')
    expect(cuisineLabel('cuisine:thai', [])).toBe('Thai')
  })

  it('passes null through rather than inventing a name', () => {
    expect(cuisineLabel(null, ['Italian'])).toBeNull()
  })
})

describe('plainTags', () => {
  it('excludes the reserved namespace, so the TAG axis is not cuisines again', () => {
    expect(plainTags({ tags: ['cuisine:thai', 'quick', 'CUISINE:italian', 'slow'] }))
      .toEqual(['quick', 'slow'])
  })
})

describe('default settings', () => {
  /**
   * Dinner is always visible. A meal planner that can be configured to plan no meals is a bug
   * wearing a preference's clothes, and every screen below the home tab assumes it exists.
   */
  it('always shows dinner', () => {
    expect(DEFAULT_MEALS_SETTINGS.visibleSlots).toContain('Dinner')
  })

  it('hides breakfast and shows lunch by default', () => {
    expect(DEFAULT_MEALS_SETTINGS.visibleSlots).not.toContain('Breakfast')
    expect(DEFAULT_MEALS_SETTINGS.visibleSlots).toContain('Lunch')
  })

  it('lists the slots this UI writes, in the order of a day', () => {
    expect(ALL_SLOTS).toEqual(['Breakfast', 'Lunch', 'Dinner'])
  })
})
