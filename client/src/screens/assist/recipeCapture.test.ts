import { describe, expect, it } from 'vitest'
import { asksToSaveARecipe, confirmationProse, offerProse, receiptLines, transcriptFor } from './recipeCapture'
import type { ConversationMessage, RecipeConversationReadingDto, RecipeDto } from '../../api/types'
import type { PendingTurn } from './useStreamedTurn'

const reading = (over: Partial<RecipeConversationReadingDto> = {}): RecipeConversationReadingDto => ({
  found: true,
  message: 1,
  confidence: 'Complete',
  title: 'Chicken Katsu Curry',
  servings: 4,
  ingredientCount: 8,
  stepCount: 6,
  sourceUrl: null,
  link: null,
  existing: null,
  reason: null,
  ...over,
})

const saved = (over: Partial<RecipeDto> = {}): RecipeDto => ({
  id: 12,
  title: 'Chicken Katsu Curry',
  description: null,
  sourceUrl: null,
  sourceName: null,
  servings: 4,
  yieldText: null,
  prepMinutes: null,
  cookMinutes: null,
  totalMinutes: null,
  hasImage: false,
  importMethod: 'Pasted',
  completeness: 'Complete',
  incompleteReason: null,
  isArchived: false,
  tags: [],
  ingredients: Array.from({ length: 8 }, (_, i) => ({
    id: i, position: i, rawText: `${i + 1} thing`, quantity: i + 1, unit: null, name: 'thing',
    note: null, sectionHeading: null,
  })),
  steps: [],
  leadMinutes: null,
  prepNote: null,
  modifiedByProfileId: null,
  modifiedByName: null,
  modifiedAtUtc: null,
  forkedFrom: null,
  forkedFromTitle: null,
  createdUtc: '2026-09-01T10:00:00Z',
  updatedUtc: '2026-09-01T10:00:00Z',
  version: 1,
  ...over,
})

describe('asksToSaveARecipe', () => {
  it('hears an instruction to file what was just discussed', () => {
    expect(asksToSaveARecipe('add this recipe')).toBe(true)
    expect(asksToSaveARecipe('save this recipe')).toBe(true)
    expect(asksToSaveARecipe('Save that one to the recipe folder')).toBe(true)
    expect(asksToSaveARecipe('keep this recipe please')).toBe(true)
    expect(asksToSaveARecipe('put it in the cookbook')).toBe(true)
  })

  /*
   * The asymmetry this rule is built around. A match is never sent to the agent, so a false positive
   * swallows a question — while a false negative costs one more message.
   */
  it('leaves a request with work in it for the agent', () => {
    expect(asksToSaveARecipe('save this recipe but double the garlic first')).toBe(false)
    expect(asksToSaveARecipe('can you save this recipe once you have halved it for two people')).toBe(false)
  })

  it('does not answer a question about whether to', () => {
    expect(asksToSaveARecipe('should I save this recipe?')).toBe(false)
    expect(asksToSaveARecipe('do you think this recipe is any good')).toBe(false)
  })

  it('needs a verb of writing and a word for where it goes, and two different words', () => {
    expect(asksToSaveARecipe('what temperature for the recipe')).toBe(false)
    expect(asksToSaveARecipe('save me some time')).toBe(false)
    expect(asksToSaveARecipe('')).toBe(false)
  })
})

describe('transcriptFor', () => {
  const stored = (id: number, text: string): ConversationMessage => ({
    id, role: id % 2 === 0 ? 'assistant' : 'user', text, atUtc: '2026-09-01T10:00:00Z',
    origin: null, escalated: false, action: null,
    attachmentName: null, attachmentKind: null, attachmentBytes: null,
  })

  const inFlight = (prompt: string, text: string): PendingTurn => ({
    prompt, text,
  } as PendingTurn)

  it('reads newest first, so an adaptation outranks what it was adapted from', () => {
    const said = transcriptFor([stored(1, 'the original'), stored(2, 'the adaptation')], [])
    expect(said).toEqual(['the adaptation', 'the original'])
  })

  /*
   * A reply that has just finished is still a pending turn for a beat — the stored transcript
   * reloads after it. Somebody who says "save this recipe" the moment it lands means *that* reply.
   */
  it('puts a turn still on screen ahead of the stored ledger, reply before prompt', () => {
    const said = transcriptFor([stored(1, 'older')], [inFlight('make it dairy-free', 'here it is')])
    expect(said).toEqual(['here it is', 'make it dairy-free', 'older'])
  })

  it('drops empty turns and stops at the bound the server holds', () => {
    const many = Array.from({ length: 20 }, (_, i) => stored(i + 1, `message ${i + 1}`))
    const said = transcriptFor([...many, stored(21, '   ')], [])
    expect(said).toHaveLength(12)
    expect(said[0]).toBe('message 20')
  })
})

describe('offerProse', () => {
  it('names the recipe and says how much of one was found', () => {
    expect(offerProse(reading()))
      .toBe("That's Chicken Katsu Curry — 8 ingredients and 6 steps. Shall I put it in the recipe folder?")
  })

  it('says what is thin about a partial reading rather than hiding it', () => {
    expect(offerProse(reading({ confidence: 'Partial', stepCount: 0 })))
      .toBe("That's Chicken Katsu Curry — 8 ingredients. Shall I put it in the recipe folder?")
  })

  /*
   * The whole point of the duplicate check: the question stops being whether to save and becomes
   * which of the two this is, which is the only question the household can answer.
   */
  it('asks which it is when the folder already holds that name', () => {
    expect(offerProse(reading({ existing: { id: 3, title: 'Chicken Katsu Curry' } })))
      .toContain('a variation of it, or as a recipe of its own?')
  })
})

describe('confirmationProse', () => {
  it('names what was written', () => {
    expect(confirmationProse(saved())).toBe('In the folder — Chicken Katsu Curry.')
  })

  it('says what it is a variation of, because that is what was decided', () => {
    expect(confirmationProse(saved({ forkedFrom: 3, forkedFromTitle: 'Katsu, the old one' })))
      .toBe('In the folder — Chicken Katsu Curry, a variation of Katsu, the old one.')
  })

  /* The common case, and it reads as the panel saying one thing twice. Only visible rendered. */
  it('does not name the same recipe twice when the variation kept its parent’s name', () => {
    expect(confirmationProse(saved({ forkedFrom: 3, forkedFromTitle: 'Chicken Katsu Curry' })))
      .toBe('In the folder — Chicken Katsu Curry, as a variation of the one you had.')
  })

  it('repeats what the server said is missing rather than claiming a clean save', () => {
    expect(confirmationProse(saved({
      completeness: 'Partial',
      incompleteReason: 'Pasted, but the panel could not find its method.',
    }))).toBe('In the folder — Chicken Katsu Curry. Pasted, but the panel could not find its method.')
  })
})

describe('receiptLines', () => {
  it('counts what actually landed', () => {
    expect(receiptLines(saved())).toEqual(['The recipe folder was written to · eight ingredients'])
  })

  it('adds the lineage row only when there is a link to report', () => {
    expect(receiptLines(saved({ forkedFrom: 3, forkedFromTitle: 'Katsu' })))
      .toEqual(['The recipe folder was written to · eight ingredients', 'Kept as a variation of Katsu'])
  })
})
