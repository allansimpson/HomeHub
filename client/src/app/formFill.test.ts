import { describe, expect, it } from 'vitest'
import { fillSummary, planFill } from './formFill'
import type { FormField } from './formFill'
import { toDraft } from './eventDrafts'
import type { DraftEventDto } from '../api/types'

/**
 * The merge rule behind the Calendar entry (screens 23–24).
 *
 * There is no confirmation sheet on that path — the form somebody already opened *is* the review —
 * so this rule is the only thing standing between a reading and somebody's typing. It gets a test
 * per clause.
 */

const dto = (over: Partial<DraftEventDto> = {}): DraftEventDto => ({
  id: '0',
  title: 'Summer Camp Open House',
  date: '2026-09-14',
  allDay: false,
  begins: '10:00:00',
  ends: '11:30:00',
  where: 'Beckett Field House',
  note: null,
  lowConfidence: [],
  assumed: [],
  ...over,
})

const touched = (...fields: FormField[]) => new Set<FormField>(fields)

describe('planFill', () => {
  it('fills every stated field of a form nobody has touched', () => {
    const plan = planFill(toDraft(dto()), touched())
    expect(plan.offers).toEqual([])
    expect(plan.fill).toEqual(['title', 'date', 'kind', 'begins', 'ends', 'where'])
  })

  /*
   * The distinction the whole rule turns on. The form opens with today's date and next-o'clock
   * already in its rows, so "has a value" would describe every time field on a form nobody has
   * typed into — and the reading would be reduced to offering back what it had just read.
   */
  it('treats a default as nobody’s answer, and an edit as somebody’s', () => {
    const plan = planFill(toDraft(dto()), touched('date'))
    expect(plan.offers).toEqual(['date'])
    expect(plan.fill).toContain('begins')
    expect(plan.fill).not.toContain('date')
  })

  /* Screen 23 exactly: a typed title and date held, the hour and place filled underneath them. */
  it('reproduces the drawn case', () => {
    const plan = planFill(toDraft(dto()), touched('title', 'date'))
    expect(plan.offers).toEqual(['title', 'date'])
    expect(plan.fill).toEqual(['kind', 'begins', 'ends', 'where'])
  })

  /*
   * An empty offer is worse than none: it invites somebody to press TAKE IT and watch a filled row
   * go blank.
   */
  it('says nothing about fields the photograph did not state', () => {
    const plan = planFill(toDraft(dto({ where: null, note: null })), touched('where'))
    expect(plan.offers).not.toContain('where')
    expect(plan.fill).not.toContain('where')
    expect(plan.fill).not.toContain('note')
  })

  it('offers no title when the photograph named nothing', () => {
    const plan = planFill(toDraft(dto({ title: '' })), touched('title'))
    expect(plan.offers).not.toContain('title')
  })

  /* A date and no hour is an all-day engagement — a value the reading produces like any other. */
  it('carries all-day as a field rather than a display rule', () => {
    const plan = planFill(toDraft(dto({ allDay: true, begins: null, ends: null })), touched())
    expect(plan.fill).toContain('kind')
    expect(plan.fill).not.toContain('begins')
    expect(plan.fill).not.toContain('ends')
  })

  it('holds the kind back when the household has already chosen one', () => {
    const plan = planFill(toDraft(dto({ allDay: true, begins: null, ends: null })), touched('kind'))
    expect(plan.offers).toEqual(['kind'])
  })
})

describe('fillSummary', () => {
  it('says both halves — what was filled, and that yours was left alone', () => {
    const plan = planFill(toDraft(dto()), touched('title', 'date'))
    expect(fillSummary(plan, true)).toBe('Four empty lines filled · two of yours left alone')
  })

  it('names retention when nothing of the household’s was in the way', () => {
    const plan = planFill(toDraft(dto()), touched())
    expect(fillSummary(plan, true)).toBe('Six empty lines filled · kept with the engagement')
  })

  /* Retention off in Config, or a format the panel will not store. The strip must stop claiming it. */
  it('drops the kept clause when no photo was kept', () => {
    const plan = planFill(toDraft(dto()), touched())
    expect(fillSummary(plan, false)).toBe('Six empty lines filled · not kept')
  })

  it('reads sensibly when a reading changed nothing at all', () => {
    const plan = planFill(toDraft(dto({ title: '', where: null, note: null })), touched('date', 'kind', 'begins', 'ends'))
    expect(fillSummary(plan, true)).toBe('Nothing filled · four of yours left alone')
  })
})
