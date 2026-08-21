import { describe, expect, it } from 'vitest'
import {
  acknowledgeTimerReplacement, clearCareOfflineData, completedEntryInput, draftEntry, localElapsedMinutes, mergeEntries, mergeLastByType, nextLocalId,
  finishLocalTimer, pauseLocalTimer, resumeLocalTimer, startLocalTimer, switchLocalPhase,
  toTimerDto,
} from './careOffline'
import type { LocalTimer, PendingEntry } from './careOffline'
import type { CareEntryDto, CareEntryInput } from '../../api/types'

class MemoryStorage {
  readonly values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
}

describe('privacy boundary', () => {
  it('purges every persisted care record, pending entry and timer on lock', () => {
    const storage = new MemoryStorage()
    for (const key of [
      'homehub.care.cache.v1', 'homehub.care.cache.v1.summary',
      'homehub.care.pending.v1', 'homehub.care.timers.v1',
    ]) storage.setItem(key, 'private')
    storage.setItem('unrelated', 'keep')

    clearCareOfflineData(storage)

    expect([...storage.values.entries()]).toEqual([['unrelated', 'keep']])
  })
})

/**
 * The offline half of the care log.
 *
 * What these guard is the pair of mistakes that matter on a child's record: showing a feed twice
 * because the local copy and the server's were not recognised as one, and losing one because it was
 * merged away. Everything else here is arithmetic in service of that.
 */

const entry = (over: Partial<CareEntryDto> = {}): CareEntryDto => ({
  id: 1, childKey: 'conrad', type: 'Bottle', atUtc: '2026-08-15T02:00:00.000Z',
  amount: 3.5, unit: 'oz', durationMinutes: null, kind: 'breast_milk', side: null,
  peeAmount: null, pooAmount: null, color: null, consistency: null, diaperRash: null,
  pounds: null, ounces: null, heightInches: null, headInches: null, notes: null,
  source: 'Panel', edited: false, clientKey: null, version: 1, ...over,
})

const pendingOf = (over: Partial<CareEntryDto> & { clientKey: string }): PendingEntry => ({
  clientKey: over.clientKey,
  childKey: 'conrad',
  opId: `op-${over.clientKey}`,
  input: { type: over.type ?? 'Bottle' },
  entry: entry({ id: -1, pending: true, version: 0, ...over }),
})

describe('mergeEntries', () => {
  /*
   * The case the client key exists for. Between the queue replaying and the next read landing, the
   * same feed is in both lists under two different ids.
   */
  it('drops a pending entry once the server reports it back', () => {
    const server = [entry({ id: 7, clientKey: 'abc' })]
    const pending = [pendingOf({ clientKey: 'abc' })]

    const merged = mergeEntries(server, pending)

    expect(merged).toHaveLength(1)
    expect(merged[0].id).toBe(7)
    expect(merged[0].pending).toBeUndefined()
  })

  it('keeps a pending entry the server has not seen yet', () => {
    const merged = mergeEntries([entry({ id: 7, clientKey: 'abc' })], [pendingOf({ clientKey: 'xyz' })])

    expect(merged).toHaveLength(2)
    expect(merged.filter((e) => e.pending)).toHaveLength(1)
  })

  /*
   * Two genuinely separate 3 oz bottles at the same minute are two feeds. Matching on anything but
   * the key would fold them into one and quietly lose a feed — which is the failure that is worse
   * than a visible duplicate, because nobody can see it happen.
   */
  it('does not fold two identical feeds into one', () => {
    const merged = mergeEntries(
      [entry({ id: 7, clientKey: 'abc' })],
      [pendingOf({ clientKey: 'def', atUtc: '2026-08-15T02:00:00.000Z', amount: 3.5 })],
    )

    expect(merged).toHaveLength(2)
  })

  /* A server row with no key at all — an import, or anything written before this existed. */
  it('never matches on a null key', () => {
    const merged = mergeEntries(
      [entry({ id: 7, clientKey: null }), entry({ id: 8, clientKey: null })],
      [pendingOf({ clientKey: 'abc' })],
    )

    expect(merged).toHaveLength(3)
  })

  it('returns the whole log newest first', () => {
    const merged = mergeEntries(
      [entry({ id: 1, atUtc: '2026-08-15T01:00:00.000Z' }), entry({ id: 2, atUtc: '2026-08-15T05:00:00.000Z' })],
      [pendingOf({ clientKey: 'abc', atUtc: '2026-08-15T03:00:00.000Z' })],
    )

    expect(merged.map((e) => e.atUtc)).toEqual([
      '2026-08-15T05:00:00.000Z', '2026-08-15T03:00:00.000Z', '2026-08-15T01:00:00.000Z',
    ])
  })
})

describe('mergeLastByType', () => {
  /*
   * The summary is a server read, so offline it is frozen. A bottle given ten minutes ago must
   * still caption the tile and reset the SINCE row, or the screen reports hours since the last feed
   * on a night somebody has just fed the baby.
   */
  it('lets an unsent entry become the newest of its type', () => {
    const summary = new Map([['Bottle' as const, entry({ atUtc: '2026-08-15T01:00:00.000Z' })]])

    const merged = mergeLastByType(summary, [entry({ id: -1, atUtc: '2026-08-15T04:00:00.000Z', pending: true })])

    expect(merged.get('Bottle')?.atUtc).toBe('2026-08-15T04:00:00.000Z')
  })

  it('leaves the summary alone where it is already newer', () => {
    const summary = new Map([['Bottle' as const, entry({ id: 9, atUtc: '2026-08-15T06:00:00.000Z' })]])

    const merged = mergeLastByType(summary, [entry({ id: -1, atUtc: '2026-08-15T04:00:00.000Z' })])

    expect(merged.get('Bottle')?.id).toBe(9)
  })

  /* The summary reaches back further than the fetched week, so a quiet type only exists there. */
  it('keeps a type that only the summary knows about', () => {
    const summary = new Map([['Pump' as const, entry({ type: 'Pump', atUtc: '2026-08-01T00:00:00.000Z' })]])

    expect(mergeLastByType(summary, []).get('Pump')).toBeDefined()
  })
})

describe('draftEntry', () => {
  const input: CareEntryInput = { type: 'Bottle', amount: 3.5, unit: 'oz', kind: 'breast_milk' }

  it('marks the row as written here and not yet sent', () => {
    const draft = draftEntry('abc', 'conrad', input, -1)

    expect(draft).toMatchObject({ id: -1, clientKey: 'abc', pending: true, source: 'Panel', version: 0 })
  })

  it('stamps now when the sheet did not say when', () => {
    const now = new Date('2026-08-15T02:30:00.000Z')

    expect(draftEntry('abc', 'conrad', input, -1, now).atUtc).toBe('2026-08-15T02:30:00.000Z')
  })

  it('keeps the time the When picker chose', () => {
    const draft = draftEntry('abc', 'conrad', { ...input, atUtc: '2026-08-15T01:25:00.000Z' }, -1)

    expect(draft.atUtc).toBe('2026-08-15T01:25:00.000Z')
  })

  /*
   * The server erases a pump's zero on write. A local row that showed `0 oz` until it synced and
   * then became an em dash is a queued entry nobody would trust again.
   */
  it('erases a pump zero the way the server does', () => {
    const draft = draftEntry('abc', 'conrad', { type: 'Pump', amount: 0, unit: 'oz' }, -1)

    expect(draft.amount).toBeNull()
    expect(draft.unit).toBeNull()
  })

  /* Everywhere but pump, zero is a measurement somebody took. */
  it('keeps a zero that was actually measured', () => {
    expect(draftEntry('abc', 'conrad', { type: 'Temperature', amount: 0, unit: 'f' }, -1).amount).toBe(0)
  })

  it('drops a duration of zero', () => {
    expect(draftEntry('abc', 'conrad', { type: 'Sleep', durationMinutes: 0 }, -1).durationMinutes).toBeNull()
  })
})

describe('nextLocalId', () => {
  /* Negative, so a local row can never be mistaken for a server one — the screens key by id. */
  it('allocates below anything already held', () => {
    expect(nextLocalId([])).toBe(-1)
    expect(nextLocalId([pendingOf({ clientKey: 'a' })])).toBe(-2)
  })

  it('does not reuse an id after an earlier one is withdrawn', () => {
    const held = [{ ...pendingOf({ clientKey: 'b' }), entry: entry({ id: -5 }) }]

    expect(nextLocalId(held)).toBe(-6)
  })
})

describe('local timers', () => {
  const start = 1_000_000

  const running = (over: Partial<LocalTimer> = {}): LocalTimer => ({
    type: 'Nursing', side: 'left', startedAt: start, pausedAt: null, accumulatedMinutes: 0,
    openedAt: start, phaseOneMinutes: null, phaseTwoMinutes: null, phase: null, ...over,
  })

  it('keeps the only durable timer copy until its replacement entry is acknowledged', () => {
    const timers = startLocalTimer([], 'Bottle', {}, start)

    expect(acknowledgeTimerReplacement(timers, 'Bottle', false)).toEqual(timers)
    expect(acknowledgeTimerReplacement(timers, 'Bottle', true)).toEqual([])
  })

  it('will not start a second session of the same type', () => {
    const once = startLocalTimer([], 'Nursing', { side: 'left' }, start)

    expect(startLocalTimer(once, 'Nursing', { side: 'right' }, start)).toHaveLength(1)
  })

  it('opens a pump on the household pattern', () => {
    const [pump] = startLocalTimer([], 'Pump', {}, start)

    expect(pump).toMatchObject({ phaseOneMinutes: 3, phaseTwoMinutes: 17, phase: 1 })
  })

  it('counts minutes while it runs', () => {
    expect(localElapsedMinutes(running(), start + 7 * 60_000)).toBeCloseTo(7)
  })

  /* A pause is not a reset — the banked time has to survive it, twice over. */
  it('banks time across a pause and resume', () => {
    const paused = pauseLocalTimer([running()], 'Nursing', start + 5 * 60_000)
    expect(localElapsedMinutes(paused[0], start + 9 * 60_000)).toBeCloseTo(5)

    const resumed = resumeLocalTimer(paused, 'Nursing', start + 9 * 60_000)
    expect(localElapsedMinutes(resumed[0], start + 11 * 60_000)).toBeCloseTo(7)
  })

  it('holds a paused clock still', () => {
    const paused = pauseLocalTimer([running()], 'Nursing', start + 5 * 60_000)

    expect(toTimerDto(paused[0], start + 60 * 60_000)).toMatchObject({ paused: true, elapsedMinutes: 5 })
  })

  /*
   * Stimulation and expression are one session. Restarting the clock at the switch would report the
   * expression phase as the whole session, which is the figure somebody would write down.
   */
  it('moves a pump to expression without touching its clock', () => {
    const pump = startLocalTimer([], 'Pump', {}, start)
    const switched = switchLocalPhase(pump, start + 4 * 60_000)

    expect(switched[0].phase).toBe(2)
    expect(localElapsedMinutes(switched[0], start + 4 * 60_000)).toBeCloseTo(4)
  })

  /*
   * Where the switch fell, so expression gets its full seventeen minutes from it rather than
   * whatever was left of the plan. An offline session is the same session; it cannot keep a
   * different set of phases from a server one.
   */
  it('marks where a late switch happened', () => {
    const pump = startLocalTimer([], 'Pump', {}, start)
    const switched = switchLocalPhase(pump, start + 7 * 60_000)

    expect(switched[0].phaseTwoAtMinutes).toBeCloseTo(7)
    expect(toTimerDto(switched[0], start + 7 * 60_000).phaseTwoAtMinutes).toBeCloseTo(7)
  })

  /*
   * FINISH measures the session and holds it. It is neither of the other two stops.
   *
   * The amount is knowable only once the pump is done, so the length is banked here and the session
   * waits — offline exactly as on the server, because a session started with no connection is the
   * one most likely to be finished with none either.
   */
  it('holds a finished session at the length it measured', () => {
    const held = finishLocalTimer([running({ type: 'Pump' })], 'Pump', start + 25 * 60_000)[0]

    expect(held.endedAt).toBe(start + 25 * 60_000)
    // Held still: coming back ten minutes later reads the same measurement, not thirty-five minutes.
    expect(localElapsedMinutes(held, start + 35 * 60_000)).toBeCloseTo(25)
    expect(toTimerDto(held, start + 35 * 60_000).endedUtc)
      .toBe(new Date(start + 25 * 60_000).toISOString())
  })

  /* A second FINISH is the first one. The measurement was taken when the clock stopped. */
  it('does not restamp a session that is already held', () => {
    const once = finishLocalTimer([running({ type: 'Pump' })], 'Pump', start + 25 * 60_000)
    const twice = finishLocalTimer(once, 'Pump', start + 40 * 60_000)

    expect(twice[0].endedAt).toBe(start + 25 * 60_000)
    expect(localElapsedMinutes(twice[0], start + 40 * 60_000)).toBeCloseTo(25)
  })

  /* Nothing resumes a session that has stopped for good; it wants an amount, not a clock. */
  it('will not resume or pause a held session', () => {
    const held = finishLocalTimer([running({ type: 'Pump' })], 'Pump', start + 25 * 60_000)

    expect(pauseLocalTimer(held, 'Pump', start + 30 * 60_000)[0].pausedAt).toBeNull()
    expect(resumeLocalTimer(held, 'Pump', start + 30 * 60_000)[0].endedAt).toBe(start + 25 * 60_000)
    expect(localElapsedMinutes(resumeLocalTimer(held, 'Pump')[0], start + 60 * 60_000)).toBeCloseTo(25)
  })

  /* A second tap is the first switch. It must not restart expression somebody is already into. */
  it('leaves the mark alone when the switch is pressed twice', () => {
    const once = switchLocalPhase(startLocalTimer([], 'Pump', {}, start), start + 3 * 60_000)
    const twice = switchLocalPhase(once, start + 9 * 60_000)

    expect(twice[0].phaseTwoAtMinutes).toBeCloseTo(3)
  })

  /* The panel and the strip both read a `CareTimerDto`, so a local session has to be one. */
  it('reports the session start, not the last resume', () => {
    const resumed = resumeLocalTimer(pauseLocalTimer([running()], 'Nursing', start + 5 * 60_000), 'Nursing', start + 9 * 60_000)

    expect(toTimerDto(resumed[0]).startedUtc).toBe(new Date(start).toISOString())
  })
})

describe('completedEntryInput', () => {
  const start = 1_000_000
  const timer: LocalTimer = {
    type: 'Sleep', side: null, startedAt: start, pausedAt: null, accumulatedMinutes: 0,
    openedAt: start, phaseOneMinutes: null, phaseTwoMinutes: null, phase: null,
  }

  /* A 40 minute sleep that ends at 3am happened from 2:20 — stamping it at the end puts it in the
     wrong half of the night on every list that orders by time. */
  it('back-dates the entry to when the session opened', () => {
    const input = completedEntryInput(timer, undefined, undefined, start + 40 * 60_000)

    expect(input.atUtc).toBe(new Date(start).toISOString())
    expect(input.durationMinutes).toBeCloseTo(40)
  })

  /* Null means "not measured" and must never arrive as a zero — the pump case the log is careful
     about, and the reason complete and cancel are different acts. */
  it('sends no amount rather than a zero', () => {
    const pump = completedEntryInput({ ...timer, type: 'Pump' }, null, 'oz', start + 20 * 60_000)

    expect(pump.amount).toBeNull()
    expect(pump.unit).toBeNull()
  })

  it('carries an amount that was measured', () => {
    const pump = completedEntryInput({ ...timer, type: 'Pump' }, 2.5, 'oz', start + 20 * 60_000)

    expect(pump).toMatchObject({ amount: 2.5, unit: 'oz' })
  })
})
