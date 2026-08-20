import type { CareEntryDto, CareEntryInput, CareEntryTypeName, CareTimerDto } from '../../api/types'

/**
 * The care log's offline half: what the panel remembers, what it still owes the server, and the
 * timers it runs on its own.
 *
 * <b>Why this domain and not the others.</b> Every screen here degrades the same way when the
 * server goes — last known values, greyed, and writes queued. Care is the one where that is not
 * enough, because the thing somebody is doing when it happens is standing in a dark room at 3am
 * having just fed a baby, and the record of that feed is the entire point of the screen. A tab that
 * cannot accept it has failed at its one job, and "log it again later" is not something a person in
 * that state is going to do.
 *
 * Pure and apart from the hook, for the same reason `care.ts` is apart from the screens: the
 * functions below decide whether two rows are the same feed, and getting that wrong shows the
 * household a duplicate or hides an entry they wrote. That is worth testing directly rather than
 * through a component.
 *
 * Nothing here talks to the network. The hook owns the requests; this owns what is true while there
 * are none.
 */

/** Bump when a stored shape changes — an old payload is dropped rather than half-read. */
const CACHE_KEY = 'homehub.care.cache.v1'
const PENDING_KEY = 'homehub.care.pending.v1'
const TIMER_KEY = 'homehub.care.timers.v1'

interface CareStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

// Cold boot starts closed. SessionProvider opens this only after it has established the current
// identity and lock state; a locked render cannot recover care records by importing this module.
let storageUnlocked = false

export function setCareStorageUnlocked(unlocked: boolean): void {
  storageUnlocked = unlocked
}

/** Purge every care-specific persisted value when the privacy boundary closes. */
export function clearCareOfflineData(storage: CareStorage = localStorage): void {
  for (const key of [CACHE_KEY, `${CACHE_KEY}.summary`, PENDING_KEY, TIMER_KEY]) {
    try { storage.removeItem(key) } catch { /* best effort; reads remain blocked in memory */ }
  }
}

/**
 * An entry this device wrote that the server has not acknowledged.
 *
 * The entry as it will be shown, plus the two things needed to finish the job: the input to send,
 * and the queued op it is riding on so a correction can amend it in place.
 */
export interface PendingEntry {
  /** Stable across reloads, and the identity the server keys on. */
  clientKey: string
  childKey: string
  /** The write-queue op carrying it, so an edit can amend and a delete can withdraw. */
  opId: string
  /** What to send — kept so an amendment rewrites the op body rather than rebuilding it. */
  input: CareEntryInput
  /** The row as the log should draw it while it waits. */
  entry: CareEntryDto
}

// ---- the read cache ----

/**
 * The last entries the server gave us, per child.
 *
 * <b>So that opening the app offline shows the log rather than an empty page.</b> Every other
 * provider keeps its last read in memory and accepts that a reload starts blank, which is the right
 * trade when the screen is a weather forecast. Here a blank page at 4am is indistinguishable from
 * "nothing has been logged tonight", and somebody acting on that reading will feed a baby twice.
 */
export function loadCachedEntries(childKey: string): CareEntryDto[] {
  if (!storageUnlocked) return []
  return readJson<Record<string, CareEntryDto[]>>(CACHE_KEY)?.[childKey] ?? []
}

export function saveCachedEntries(childKey: string, entries: CareEntryDto[]): void {
  if (!storageUnlocked) return
  const all = readJson<Record<string, CareEntryDto[]>>(CACHE_KEY) ?? {}
  all[childKey] = entries
  writeJson(CACHE_KEY, all)
}

/**
 * The last-of-each-type the summary reported, cached alongside.
 *
 * The tile captions and every sheet's pre-fill come from it, and it reaches further back than the
 * week of entries does — so without it an offline panel opens every sheet on its bare defaults and
 * the SINCE rows for a quiet type read `NO RECORD` for something logged four days ago.
 */
export function loadCachedSummary(childKey: string): CareEntryDto[] {
  if (!storageUnlocked) return []
  return readJson<Record<string, CareEntryDto[]>>(`${CACHE_KEY}.summary`)?.[childKey] ?? []
}

export function saveCachedSummary(childKey: string, entries: CareEntryDto[]): void {
  if (!storageUnlocked) return
  const all = readJson<Record<string, CareEntryDto[]>>(`${CACHE_KEY}.summary`) ?? {}
  all[childKey] = entries
  writeJson(`${CACHE_KEY}.summary`, all)
}

// ---- pending entries ----

export function loadPending(): PendingEntry[] {
  if (!storageUnlocked) return []
  return readJson<PendingEntry[]>(PENDING_KEY) ?? []
}

export function savePending(pending: PendingEntry[]): void {
  if (!storageUnlocked) return
  writeJson(PENDING_KEY, pending)
}

/**
 * A local row for something just logged, to show until the server has it.
 *
 * <b>It mirrors the server's own normalisation deliberately.</b> `CareLogService.Normalise` erases a
 * pump's zero amount and drops a unit with nothing to measure, so a row drawn straight from the
 * input would show `0 oz` for ten minutes and then silently become an em dash when the real one
 * arrived. A queued entry that changes its reading on sync is a queued entry nobody trusts.
 */
export function draftEntry(
  clientKey: string,
  childKey: string,
  input: CareEntryInput,
  id: number,
  now: Date = new Date(),
): CareEntryDto {
  // Pump alone treats zero as "not measured" — see the service's own note. Everywhere else a zero
  // is a measurement somebody took and must survive.
  const amount = input.type === 'Pump' && input.amount === 0 ? null : input.amount ?? null
  const duration = input.durationMinutes != null && input.durationMinutes > 0
    ? input.durationMinutes
    : null

  return {
    id,
    childKey,
    type: input.type,
    atUtc: input.atUtc ?? now.toISOString(),
    amount,
    // A unit with nothing to measure is noise on the row, here as on the server.
    unit: amount == null ? null : input.unit ?? null,
    durationMinutes: duration,
    kind: input.kind ?? null,
    side: input.side ?? null,
    peeAmount: input.peeAmount ?? null,
    pooAmount: input.pooAmount ?? null,
    color: input.color ?? null,
    consistency: input.consistency ?? null,
    diaperRash: input.diaperRash ?? null,
    pounds: input.pounds ?? null,
    ounces: input.ounces ?? null,
    heightInches: input.heightInches ?? null,
    headInches: input.headInches ?? null,
    notes: input.notes ?? null,
    // Typed on the panel — which it was, whatever route it took to the database.
    source: 'Panel',
    edited: false,
    clientKey,
    // Nothing has corrected it yet, and it has no server row to be conditional against.
    version: 0,
    pending: true,
  }
}

/**
 * A negative id no other row is using.
 *
 * <b>Negative because the server's are positive</b>, so a local row can never be mistaken for one
 * that exists — and the screens key, select and delete by id. Allocated once and stored with the
 * pending entry rather than derived from the clock on each render, so a queued entry keeps the same
 * identity across a reload and the selection somebody made survives it.
 */
export function nextLocalId(pending: PendingEntry[]): number {
  const lowest = pending.reduce((min, p) => Math.min(min, p.entry.id), 0)
  return lowest - 1
}

/**
 * The server's entries and this device's unsent ones, as one log.
 *
 * <b>The dedupe is the whole point.</b> A queued entry is shown from the local store the moment it
 * is written, and it stays there until the queue has replayed it *and* a read has come back
 * carrying it. Between those two moments the same feed exists in both lists, and the client key is
 * the only thing that knows they are one feed — the ids differ, and matching on time and amount
 * would fold two genuinely separate 3 oz bottles into one.
 *
 * Newest first, which is the order every consumer wants and the order the server already returns.
 */
export function mergeEntries(server: CareEntryDto[], pending: PendingEntry[]): CareEntryDto[] {
  const acknowledged = new Set(server.map((e) => e.clientKey).filter((k): k is string => !!k))
  const unsent = pending
    .filter((p) => !acknowledged.has(p.clientKey))
    .map((p) => p.entry)

  return [...server, ...unsent].sort((a, b) => Date.parse(b.atUtc) - Date.parse(a.atUtc))
}

/**
 * The last of each type, counting what has not been sent yet.
 *
 * The summary is a server read, so offline it is frozen at whatever it last said — and a bottle
 * given ten minutes ago would leave the tile captioned with the one before it and SINCE reporting
 * hours since the last feed. Both are the wrong answer to the question the screen exists to answer.
 */
export function mergeLastByType(
  summary: Map<CareEntryTypeName, CareEntryDto>,
  entries: CareEntryDto[],
): Map<CareEntryTypeName, CareEntryDto> {
  const merged = new Map(summary)
  for (const entry of entries) {
    const held = merged.get(entry.type)
    if (!held || Date.parse(entry.atUtc) > Date.parse(held.atUtc)) merged.set(entry.type, entry)
  }
  return merged
}

// ---- timers run on this device ----

/**
 * A session this panel is timing itself.
 *
 * <b>A local timer never becomes a server timer.</b> It runs here, and on COMPLETE it writes an
 * ordinary entry with the duration it measured — which the queue already knows how to carry. That
 * is what keeps the reconnect honest: there is no half-finished session to hand over, no start time
 * to reconcile against a clock that has moved, and nothing that can be counted twice. The only
 * thing that ever crosses the wire is the record of a session that finished, and that record is
 * keyed like every other queued entry.
 */
export interface LocalTimer {
  type: CareEntryTypeName
  side: string | null
  /** Epoch ms of the current run. Reset on resume — banked time lives in `accumulatedMinutes`. */
  startedAt: number
  /** Epoch ms the pause began, or null while running. */
  pausedAt: number | null
  /** Minutes banked by earlier run/pause cycles, so a pause is not a reset. */
  accumulatedMinutes: number
  /** When the session actually began, which a pause and resume must not move. */
  openedAt: number
  phaseOneMinutes: number | null
  phaseTwoMinutes: number | null
  phase: number | null
  /** Elapsed minutes at the switch to expression. Null until it happens. */
  phaseTwoAtMinutes?: number | null
  /**
   * Epoch ms the session was finished and held for its amount. Null while it runs.
   *
   * Pump only, and the offline half of the same hold the server keeps: the length is measured at
   * FINISH and the session is written once, at SAVE, with whatever amount is in hand. Held here it
   * survives a reload, because these timers are read back out of local storage.
   */
  endedAt?: number | null
}

export function loadLocalTimers(): LocalTimer[] {
  if (!storageUnlocked) return []
  return readJson<LocalTimer[]>(TIMER_KEY) ?? []
}

export function saveLocalTimers(timers: LocalTimer[]): void {
  if (!storageUnlocked) return
  writeJson(TIMER_KEY, timers)
}

/** Begin a session here. Returns the existing one rather than starting a second, as the server does. */
export function startLocalTimer(
  timers: LocalTimer[],
  type: CareEntryTypeName,
  opts: { side?: string; phaseOne?: number; phaseTwo?: number } = {},
  now: number = Date.now(),
): LocalTimer[] {
  if (timers.some((t) => t.type === type)) return timers
  return [
    ...timers,
    {
      type,
      side: opts.side ?? null,
      startedAt: now,
      pausedAt: null,
      accumulatedMinutes: 0,
      openedAt: now,
      // The same 3 and 17 the server falls back to, so a session started offline and one started on
      // the panel do not run to different lengths.
      phaseOneMinutes: type === 'Pump' ? opts.phaseOne ?? 3 : null,
      phaseTwoMinutes: type === 'Pump' ? opts.phaseTwo ?? 17 : null,
      phase: type === 'Pump' ? 1 : null,
    },
  ]
}

/**
 * How long a local session has run, banked time included and a pause held still.
 *
 * A finished session holds still more firmly than a paused one: its length is a measurement already
 * taken, and it has to read the same when somebody comes back to it ten minutes later.
 */
export function localElapsedMinutes(timer: LocalTimer, now: number = Date.now()): number {
  if (timer.endedAt != null || timer.pausedAt !== null) return timer.accumulatedMinutes
  return timer.accumulatedMinutes + Math.max(0, (now - timer.startedAt) / 60_000)
}

export function pauseLocalTimer(
  timers: LocalTimer[], type: CareEntryTypeName, now: number = Date.now(),
): LocalTimer[] {
  return timers.map((t) =>
    t.type === type && t.pausedAt === null && t.endedAt == null
      // Bank what has run before stopping the clock, or resuming would start again from zero.
      ? { ...t, accumulatedMinutes: localElapsedMinutes(t, now), pausedAt: now }
      : t)
}

export function resumeLocalTimer(
  timers: LocalTimer[], type: CareEntryTypeName, now: number = Date.now(),
): LocalTimer[] {
  return timers.map((t) =>
    // A held session has stopped for good; there is nothing to resume, only an amount to give.
    t.type === type && t.pausedAt !== null && t.endedAt == null
      ? { ...t, startedAt: now, pausedAt: null }
      : t)
}

/**
 * Stop a session's clock and hold it for its amount. Writes nothing.
 *
 * The offline half of `FinishTimerAsync`, and the same three rules: bank the measurement, hold the
 * row, and let a second FINISH be the first one — a session held for ten minutes must not be
 * restamped with a length that has kept running.
 */
export function finishLocalTimer(
  timers: LocalTimer[], type: CareEntryTypeName, now: number = Date.now(),
): LocalTimer[] {
  return timers.map((t) =>
    t.type === type && t.endedAt == null
      ? { ...t, accumulatedMinutes: localElapsedMinutes(t, now), endedAt: now }
      : t)
}

export function switchLocalSide(
  timers: LocalTimer[], type: CareEntryTypeName, side: string,
): LocalTimer[] {
  return timers.map((t) => (t.type === type ? { ...t, side } : t))
}

/**
 * Advance a local pump session to expression, early or on time.
 *
 * <b>The elapsed clock is left alone; the switch is marked on it.</b> Stimulation and expression
 * are two parts of one session rather than two sessions — what it writes is a single pump with a
 * single duration — so restarting the clock here would have the panel report the expression phase's
 * length as the whole session, which is the number somebody would then write down. Marking where
 * the switch fell gives the second phase its full length without touching what the session has run:
 * `SwitchPhaseAsync` on the server does exactly this, and for the same reason.
 *
 * Switching twice is the first switch, so a stale panel cannot restart seventeen minutes somebody
 * is already eight minutes into.
 */
export function switchLocalPhase(timers: LocalTimer[], now: number = Date.now()): LocalTimer[] {
  return timers.map((t) => (t.type === 'Pump' && t.phase !== 2
    ? { ...t, phase: 2, phaseTwoAtMinutes: localElapsedMinutes(t, now) }
    : t))
}

export function cancelLocalTimer(timers: LocalTimer[], type: CareEntryTypeName): LocalTimer[] {
  return timers.filter((t) => t.type !== type)
}

/**
 * A local session in the shape the running panel and the strip already read.
 *
 * Deliberately the server's own DTO rather than a second timer type. The panel, the strip and
 * `useRunningSeconds` all take a `CareTimerDto`, and giving them a near-copy to branch on is how
 * one of the three ends up drawing a local session differently from a server one.
 */
export function toTimerDto(timer: LocalTimer, now: number = Date.now()): CareTimerDto {
  return {
    type: timer.type,
    side: timer.side,
    startedUtc: new Date(timer.openedAt).toISOString(),
    paused: timer.pausedAt !== null,
    elapsedMinutes: Math.round(localElapsedMinutes(timer, now) * 100) / 100,
    phaseOneMinutes: timer.phaseOneMinutes,
    phaseTwoMinutes: timer.phaseTwoMinutes,
    phase: timer.phase,
    phaseTwoAtMinutes: timer.phaseTwoAtMinutes ?? null,
    endedUtc: timer.endedAt == null ? null : new Date(timer.endedAt).toISOString(),
  }
}

/**
 * The entry a finished local session writes.
 *
 * Back-dated to when the session opened, which is what the server's own complete does — a 40 minute
 * sleep that ends at 3am happened from 2:20, and stamping it at the end would put it in the wrong
 * half of the night on every list that orders by time.
 */
export function completedEntryInput(
  timer: LocalTimer,
  amount?: number | null,
  unit?: string,
  now: number = Date.now(),
): CareEntryInput {
  return {
    type: timer.type,
    atUtc: new Date(timer.openedAt).toISOString(),
    durationMinutes: localElapsedMinutes(timer, now),
    side: timer.side,
    // Null means "not measured" and must never arrive as a zero — the pump case the whole log is
    // careful about. Left undefined where the caller said nothing at all.
    amount: amount ?? null,
    unit: amount == null ? null : unit ?? 'oz',
  }
}

// ---- storage plumbing ----

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    // A full, disabled or corrupt store costs the panel its offline memory and nothing else. It
    // must not cost it the screen.
    return null
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* best effort — see above */
  }
}
