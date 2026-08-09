import { describe, expect, it } from 'vitest'
import { foldUnit, resolveUnit, suggestUnits } from './units'
import type { MeasurementUnitDto } from '../api/types'

/**
 * The unit field's local resolution.
 *
 * The server normalises again on save and is the authority, so nothing here can corrupt data — what
 * it can do is show the wrong thing while somebody types, which on a box that rewrites what it is
 * given is exactly the moment trust is won or lost.
 */

const unit = (
  canonical: string,
  displayName: string | null,
  aliases: string[],
  isSeeded = true,
): MeasurementUnitDto => ({ canonical, displayName, aliases, isSeeded })

/** A slice of the seeded list, in the server's own order. */
const UNITS: MeasurementUnitDto[] = [
  unit('ea', 'each', ['ea', 'each', 'ct', 'cnt', 'count', 'pc', 'pcs', 'piece', 'pieces']),
  unit('tsp', 'teaspoons', ['tsp', 'tsps', 'teaspoon', 'teaspoons']),
  unit('cup', 'cups', ['cup', 'cups']),
  unit('mL', 'millilitres', ['ml', 'mls', 'milliliter', 'milliliters', 'millilitre', 'millilitres', 'cc']),
  unit('oz', 'ounces', ['oz', 'ozs', 'ounce', 'ounces']),
  unit('lb', 'pounds', ['lb', 'lbs', 'pound', 'pounds']),
  unit('bunch', 'bunches', ['bunch', 'bunches']),
  unit('sleeve', null, ['sleeve'], false),
]

describe('foldUnit', () => {
  it('matches the server fold: trimmed, lowercased, periods dropped, spaces collapsed', () => {
    expect(foldUnit('  OZ. ')).toBe('oz')
    expect(foldUnit('Fl.  Oz.')).toBe('fl oz')
    expect(foldUnit('   ')).toBe('')
  })
})

describe('resolveUnit', () => {
  it('lands every spelling of a unit on the one that gets stored', () => {
    for (const typed of ['oz', 'OZ', 'Oz.', 'ounce', 'Ounces', ' ounces ']) {
      expect(resolveUnit(typed, UNITS)).toBe('oz')
    }
  })

  it('keeps the canonical casing the server chose', () => {
    // `mL` earns its capital: a lowercase l beside a quantity is a 1 at arm's length, which is the
    // distance a wall panel is read from.
    expect(resolveUnit('milliliters', UNITS)).toBe('mL')
    expect(resolveUnit('ML', UNITS)).toBe('mL')
  })

  it('passes free text through folded rather than refusing it', () => {
    // A unit nobody predefined is a normal answer — it becomes one of its own on save. Refusing it
    // is the strictness that makes people write the unit into the item's name instead.
    expect(resolveUnit('Rashers', UNITS)).toBe('rashers')
  })

  it('leaves an empty box empty', () => {
    expect(resolveUnit('   ', UNITS)).toBe('')
  })
})

describe('suggestUnits', () => {
  it('opens on the units a kitchen reaches for first', () => {
    expect(suggestUnits('', UNITS, 3).map((u) => u.canonical)).toEqual(['ea', 'tsp', 'cup'])
  })

  it('puts the unit being typed first, not the alphabetical accident', () => {
    // "ou" is on its way to ounces. `cup` also contains it — behind, not in front.
    expect(suggestUnits('ou', UNITS, 3)[0].canonical).toBe('oz')
  })

  it('ranks an exact spelling above a longer one that starts the same way', () => {
    expect(suggestUnits('lb', UNITS)[0].canonical).toBe('lb')
  })

  it('finds a unit by its own name as well as its abbreviation', () => {
    expect(suggestUnits('teasp', UNITS)[0].canonical).toBe('tsp')
  })

  it('offers a unit the household added just like a predefined one', () => {
    expect(suggestUnits('slee', UNITS)[0].canonical).toBe('sleeve')
  })

  it('offers nothing rather than everything when nothing matches', () => {
    expect(suggestUnits('zzz', UNITS)).toEqual([])
  })
})
