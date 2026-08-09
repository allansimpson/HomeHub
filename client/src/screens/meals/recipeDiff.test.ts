import { describe, expect, it } from 'vitest'
import { diffIngredients } from './recipeDiff'
import type { RecipeDto, RecipeIngredientDto } from '../../api/types'

/**
 * The fork diff (MEALS_FORK §5). Compared on the parsed ingredient `name`, not on position —
 * positional comparison reports every line after an inserted one as changed, which would make a
 * one-line edit look like a rewrite.
 */

let nextId = 1
const line = (
  name: string, quantity: number | null, unit: string | null, rawText = `${quantity} ${unit} ${name}`,
): RecipeIngredientDto => ({
  id: nextId++, position: 0, rawText, quantity, unit, name, note: null, sectionHeading: null,
})

const recipe = (ingredients: RecipeIngredientDto[]): RecipeDto => ({
  id: 1, title: 'R', description: null, sourceUrl: null, sourceName: null, servings: 4,
  yieldText: null, prepMinutes: null, cookMinutes: null, totalMinutes: null, hasImage: false,
  importMethod: 'Manual', completeness: 'Complete', incompleteReason: null, isArchived: false,
  tags: [], ingredients, steps: [], leadMinutes: null, prepNote: null,
  modifiedByProfileId: null, modifiedByName: null, modifiedAtUtc: null,
  forkedFrom: null, forkedFromTitle: null,
  createdUtc: '', updatedUtc: '', version: 1,
})

describe('diffIngredients', () => {
  it('reports only the lines whose amount actually changed', () => {
    const before = recipe([line('chicken cutlets', 4, 'ea'), line('capers', 0.25, 'cup'), line('butter', 2, 'tbsp')])
    const after = recipe([line('chicken cutlets', 8, 'ea'), line('capers', 0.5, 'cup'), line('butter', 2, 'tbsp')])

    const diffs = diffIngredients(before, after)

    expect(diffs.map((d) => d.name)).toEqual(['chicken cutlets', 'capers'])
    expect(diffs[0]).toMatchObject({ from: '4 ea', to: '8 ea' })
  })

  it('finds nothing when the two are identical', () => {
    const same = () => recipe([line('capers', 0.25, 'cup')])
    expect(diffIngredients(same(), same())).toEqual([])
  })

  /**
   * Matched on name, so inserting a line does not report every line after it as changed — the
   * failure mode a positional comparison would have.
   */
  it('is unaffected by a line being inserted above others', () => {
    const before = recipe([line('capers', 0.25, 'cup'), line('butter', 2, 'tbsp')])
    const after = recipe([line('garlic', 2, 'clove'), line('capers', 0.25, 'cup'), line('butter', 2, 'tbsp')])

    const diffs = diffIngredients(before, after)

    const added = diffs.find((d) => d.name === 'garlic')!
    expect(added.from).toBeNull()
    expect(diffs.map((d) => d.name)).toEqual(['garlic'])
  })

  /** A fork that *removed* an ingredient must not read as identical. */
  it('reports a dropped line as a difference', () => {
    const before = recipe([line('capers', 0.25, 'cup'), line('anchovy', 2, 'ea')])
    const after = recipe([line('capers', 0.25, 'cup')])

    const dropped = diffIngredients(before, after).find((d) => d.name === 'anchovy')!

    expect(dropped.from).toBe('2 ea')
    expect(dropped.to).toBeNull()
  })

  /** A line the parser never named still has to be comparable — it falls back to its raw text. */
  it('compares unparsed lines by their raw text', () => {
    const unparsed = (raw: string): RecipeIngredientDto => ({
      id: nextId++, position: 0, rawText: raw, quantity: null, unit: null,
      name: null, note: null, sectionHeading: null,
    })
    const before = recipe([unparsed('Salt and pepper to taste')])
    const after = recipe([unparsed('Salt and pepper to taste')])

    expect(diffIngredients(before, after)).toEqual([])
  })
})
