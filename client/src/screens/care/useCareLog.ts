import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError } from '../../api/client'
import { careWindowStart } from '../../app/care'
import { useNow } from '../../app/useNow'
import { useConnection } from '../../app/ConnectionProvider'
import { useWriteQueue } from '../../app/WriteQueueProvider'
import {
  cancelLocalTimer, completedEntryInput, draftEntry, finishLocalTimer, loadCachedEntries,
  loadCachedSummary, loadLocalTimers, loadPending, mergeEntries, mergeLastByType, nextLocalId,
  pauseLocalTimer, resumeLocalTimer, saveCachedEntries, saveCachedSummary, saveLocalTimers,
  savePending, startLocalTimer, switchLocalPhase, switchLocalSide, toTimerDto,
} from './careOffline'
import type { LocalTimer, PendingEntry } from './careOffline'
import { newId } from '../../app/writeQueue'
import type {
  CareEntryDto, CareEntryInput, CareEntryTypeName, CareTimerDto,
} from '../../api/types'

/**
 * HomeHub's own care log — the ten types, their running timers, and today's entries.
 *
 * <b>Distinct from `useBaby`, which fronts the Huckleberry integration.</b> That one reads live
 * sensors and drives the timers the household's own app can see; this is the log HomeHub keeps, and
 * the only thing the panel writes to now. Six of its types exist nowhere else — the integration has
 * no service to write them and no sensor to read them.
 *
 * <b>It works with no server, which is the one thing the rest of the app does not do.</b> Every
 * other screen degrades to last-known values and queued writes, and that is the right trade for a
 * forecast or a thermostat. Here it is not: the moment somebody most needs to log a feed is 3am in
 * a dark room, and a tab that cannot accept it then has failed at its only job — "write it down
 * later" is not a thing that happens. So entries are written to this device first and owed to the
 * server afterwards, reads fall back to what was last seen rather than to a blank page, and the
 * timers run here rather than on the far end of a connection that may not be there.
 *
 * What that costs is a merge, and the merge is the part to be careful with: see `careOffline.ts`,
 * where the rules about when two rows are one feed live and are tested on their own.
 */
export function useCareLog(childKey: string) {
  const { online } = useConnection()
  const { run, withdraw, amend } = useWriteQueue()

  /** What the server last said. Seeded from the cache so a cold offline open is not a blank page. */
  const [serverEntries, setServerEntries] = useState<CareEntryDto[]>(() => loadCachedEntries(childKey))
  const [summary, setSummary] = useState<CareEntryDto[]>(() => loadCachedSummary(childKey))
  const [serverTimers, setServerTimers] = useState<CareTimerDto[]>([])
  /** Written here, not yet acknowledged. Persisted, so closing the app does not lose a feed. */
  const [pending, setPending] = useState<PendingEntry[]>(() => loadPending())
  const [localTimers, setLocalTimers] = useState<LocalTimer[]>(() => loadLocalTimers())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [writing, setWriting] = useState(false)
  // A minute is close enough for a boundary that moves once a day; it is what rolls the window at
  // 6 AM without a refetch.
  const now = useNow(60_000)

  /*
   * Every write reads the queue's current state, and none of them should be re-created when it
   * changes — `add` re-identifying on each keystroke of pending state would restart the effects
   * below with it. The ref is read at call time, which is the only time it matters.
   */
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  const localTimersRef = useRef(localTimers)
  localTimersRef.current = localTimers
  const serverEntriesRef = useRef(serverEntries)
  serverEntriesRef.current = serverEntries

  /*
   * Always an updater, and the ref moves with it.
   *
   * Two entries logged in quick succession both go through an `await` before they append, so a
   * plain array would have the second computed from the queue as it stood before the first — and
   * the first feed would vanish, silently, which is the worst way for this to fail. Advancing the
   * ref here rather than waiting for a render is what makes back-to-back writes compose.
   */
  const putPending = useCallback((update: (cur: PendingEntry[]) => PendingEntry[]) => {
    const next = update(pendingRef.current)
    pendingRef.current = next
    savePending(next)
    setPending(next)
  }, [])

  /**
   * Change a cached server row and write the change through.
   *
   * <b>Through to storage, not just to state.</b> A correction or a deletion made offline is a
   * queued op plus an optimistic patch, and keeping the patch only in memory means a reload before
   * the connection returns shows the old value back — while the op that supersedes it is still
   * sitting in the queue. Reloading a phone in a dark room is not a rare event.
   */
  const patchServerEntries = useCallback(
    (update: (cur: CareEntryDto[]) => CareEntryDto[]) => {
      // Through the ref rather than a state updater: writing to storage inside one would be a side
      // effect in a function React is entitled to call twice.
      const next = update(serverEntriesRef.current)
      serverEntriesRef.current = next
      saveCachedEntries(childKey, next)
      setServerEntries(next)
    },
    [childKey],
  )

  const putLocalTimers = useCallback((next: LocalTimer[]) => {
    saveLocalTimers(next)
    setLocalTimers(next)
  }, [])

  const refresh = useCallback(async () => {
    try {
      /*
       * One read covering every window the day view needs.
       *
       * Three of them, and they do not nest tidily: the totals page counts a 6 AM–6 AM window,
       * Today's log lists a calendar day, and the ENTRIES page is simply the most recent entries
       * whenever they happened. Rather than three requests that can disagree with each other, this
       * fetches the widest range once and the screen slices it. It also means the 6 AM roll needs
       * no refetch — the entries either side of the boundary are already in hand when it turns.
       */
      const from = entriesFrom()
      const [nextSummary, nextEntries] = await Promise.all([
        api.getCareSummary(childKey),
        api.getCareEntries(childKey, from.toISOString(), tomorrow().toISOString()),
      ])
      setSummary(nextSummary.lastByType)
      setServerTimers(nextSummary.timers)
      // The ref moves with the state, so a correction made between this and the next render patches
      // what was just read rather than what it replaced.
      serverEntriesRef.current = nextEntries
      setServerEntries(nextEntries)
      // Written through on every good read, so the next cold open starts from the truth rather
      // than from whatever was on screen when the connection went.
      saveCachedSummary(childKey, nextSummary.lastByType)
      saveCachedEntries(childKey, nextEntries)

      /*
       * Anything the server now reports back is no longer owed. Dropping it here rather than
       * leaving `mergeEntries` to hide it keeps the queue and the store agreeing about what is
       * outstanding — a pending list that never empties would show a permanent "not sent yet" mark
       * on entries that were sent hours ago.
       */
      const acknowledged = new Set(nextEntries.map((e) => e.clientKey).filter(Boolean))
      if (pendingRef.current.some((p) => acknowledged.has(p.clientKey))) {
        putPending((cur) => cur.filter((p) => !acknowledged.has(p.clientKey)))
      }

      setError(null)
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
      /*
       * A failed read while offline is not an error, it is the expected case, and saying so would
       * put a red line above a screen that is working exactly as intended. The app-wide
       * RECONNECTING banner already tells the household what is going on. A failure while the
       * connection is up is a genuine fault and still says so.
       */
      setError(online ? 'The care log is unreachable right now.' : null)
    } finally {
      setLoading(false)
    }
  }, [childKey, online, putPending])

  useEffect(() => { void refresh() }, [refresh])

  /*
   * Swapping child swaps the cache under it.
   *
   * One baby today, but everything here is keyed for a second, and without this the new child would
   * be drawn with the previous one's entries for as long as the read takes — which offline is
   * forever. Pending entries are deliberately not touched: they are keyed by child themselves and
   * are owed regardless of who is being looked at.
   */
  useEffect(() => {
    const cached = loadCachedEntries(childKey)
    serverEntriesRef.current = cached
    setServerEntries(cached)
    setSummary(loadCachedSummary(childKey))
  }, [childKey])

  /*
   * A running timer needs a clock, and only while one is running.
   *
   * For a server session the elapsed figure comes from the server — a paused session is not "now
   * minus started", and two places doing that sum is two places to get a pause wrong — so this
   * re-reads rather than counting locally. Ten seconds is enough for a number displayed in minutes,
   * and nothing ticks at all when no session is open.
   */
  useEffect(() => {
    if (serverTimers.length === 0) return
    const id = window.setInterval(() => { void refresh() }, 10_000)
    return () => window.clearInterval(id)
  }, [serverTimers.length, refresh])

  /*
   * A local session has no server to re-read, so its clock is this.
   *
   * The same ten seconds, deliberately: `useRunningSeconds` interpolates between arrivals and
   * re-anchors on each one, so a local session and a server one tick through exactly the same
   * machinery at exactly the same cadence. A faster tick here would make the two visibly different.
   */
  const [localTick, setLocalTick] = useState(() => Date.now())
  useEffect(() => {
    if (localTimers.length === 0) return
    const id = window.setInterval(() => setLocalTick(Date.now()), 10_000)
    return () => window.clearInterval(id)
  }, [localTimers.length])

  /** Replayed writes land through the write queue's own sync event. */
  useEffect(() => {
    const onSync = () => void refresh()
    window.addEventListener('homehub:sync', onSync)
    return () => window.removeEventListener('homehub:sync', onSync)
  }, [refresh])

  // ---- what the screen reads ----

  /** What this child is owed. The queue is shared across children; a screen only shows one. */
  const owed = useMemo(() => pending.filter((p) => p.childKey === childKey), [pending, childKey])

  const entries = useMemo(() => mergeEntries(serverEntries, owed), [serverEntries, owed])

  const lastByType = useMemo(() => {
    const fromServer = new Map<CareEntryTypeName, CareEntryDto>(summary.map((e) => [e.type, e]))
    // The unsent entries only. The server's own rows are already in the summary, and feeding the
    // whole merged log back through would rebuild it from the fetched week — which reaches less far
    // back than the summary does, and would lose a quiet type entirely.
    return mergeLastByType(fromServer, owed.map((p) => p.entry))
  }, [summary, owed])

  /*
   * A locally-run session shadows a server one of the same type.
   *
   * There can only really be one — a local timer exists because the panel started it with no
   * connection, and the server has no session it does not know about. Preferring the local one is
   * what stops a reconnect mid-feed swapping the clock on screen for a different one.
   */
  const timers = useMemo(() => {
    const local = localTimers.map((t) => toTimerDto(t, localTick))
    const shadowed = new Set(local.map((t) => t.type))
    return [...local, ...serverTimers.filter((t) => !shadowed.has(t.type))]
  }, [localTimers, serverTimers, localTick])

  // ---- writes ----

  /**
   * Write an entry. Returns the local row, which is what the screen should draw either way.
   *
   * <b>It never fails for want of a connection.</b> The entry is written to this device and shown
   * at once; the server hears about it now if it can and on reconnect if it cannot. The client key
   * minted here is what makes that replay safe — the server keys on it, so the same entry arriving
   * twice is recorded once.
   */
  const add = useCallback(async (input: CareEntryInput): Promise<CareEntryDto | null> => {
    setWriting(true)
    try {
      const clientKey = newId()
      const entry = draftEntry(clientKey, childKey, input, nextLocalId(pendingRef.current))
      const body: CareEntryInput = { ...input, clientKey }

      const outcome = await run({
        domain: 'care',
        method: 'POST',
        path: `/care/${childKey}/entries`,
        body,
        label: `Log ${entry.type.toLowerCase()}`,
      })

      if (outcome.kind === 'queued') {
        putPending((cur) => [...cur, { clientKey, childKey, opId: outcome.opId, input: body, entry }])
        return entry
      }
      if (outcome.kind === 'ok') {
        await refresh()
        return (outcome.data as CareEntryDto) ?? entry
      }
      // A real refusal from a server we reached — a validation fault, not a lost connection. The
      // entry is not kept: it was never written, and showing it as pending would promise a sync
      // that is never going to come.
      setError('That entry could not be saved.')
      return null
    } finally {
      setWriting(false)
    }
  }, [childKey, run, refresh, putPending])

  /**
   * Correct an entry, whether or not the server has heard of it yet.
   *
   * Two different acts wearing one name. A row the server has is corrected with a conditional PUT,
   * so an edit that has been queued for hours cannot silently overwrite one made on the panel since.
   * A row still sitting in the queue has no server id to address and is amended in place instead —
   * one create, in its original order, now carrying the corrected values.
   */
  const update = useCallback(async (id: number, input: CareEntryInput) => {
    setWriting(true)
    try {
      const unsent = pendingRef.current.find((p) => p.entry.id === id)

      if (unsent) {
        const body: CareEntryInput = { ...input, clientKey: unsent.clientKey }
        if (amend(unsent.opId, body)) {
          const entry = draftEntry(unsent.clientKey, unsent.childKey, input, unsent.entry.id)
          putPending((cur) => cur.map((p) => (p.opId === unsent.opId ? { ...p, input: body, entry } : p)))
          return
        }
        /*
         * The create has left the queue between the sheet opening and SAVE — it is on the wire, or
         * already landed. There is no id to correct against yet, so the next read is what will
         * bring one. Refusing beats guessing: a PUT against the local negative id would 404, and
         * re-POSTing the corrected values under the same key would be answered with the *original*
         * row and the correction would vanish without a trace.
         */
        setError('That entry is syncing — try the correction again in a moment.')
        await refresh()
        return
      }

      const current = serverEntriesRef.current.find((e) => e.id === id)
      // Applied here first so an offline correction visibly takes, rather than appearing to do
      // nothing until the connection comes back.
      patchServerEntries((cur) =>
        cur.map((e) => (e.id === id ? { ...e, ...stripUnset(input), edited: true } : e)))

      const outcome = await run({
        domain: 'care',
        method: 'PUT',
        path: `/care/entries/${id}`,
        body: input,
        baseVersion: current?.version,
        label: `Correct ${(current?.type ?? input.type).toLowerCase()}`,
      })
      if (outcome.kind === 'ok') await refresh()
      else if (outcome.kind !== 'queued') {
        // conflict / gone / error — the queue surfaces a conflict for the household to settle; all
        // this has to do is stop showing an optimistic value the server never accepted.
        await refresh()
      }
    } finally {
      setWriting(false)
    }
  }, [run, refresh, amend, putPending, patchServerEntries])

  /** Remove an entry. One never sent is taken back out of the queue rather than deleted from it. */
  const remove = useCallback(async (id: number) => {
    setWriting(true)
    try {
      const unsent = pendingRef.current.find((p) => p.entry.id === id)

      if (unsent) {
        /*
         * Withdrawn, not deleted. An entry that has never reached the server has nothing to delete
         * on it — a DELETE would 404 against a row that does not exist, and the create would replay
         * on reconnect and put the feed back minutes after somebody took it away.
         */
        withdraw(unsent.opId)
        putPending((cur) => cur.filter((p) => p.opId !== unsent.opId))
        return
      }

      const current = serverEntriesRef.current.find((e) => e.id === id)
      patchServerEntries((cur) => cur.filter((e) => e.id !== id))

      const outcome = await run({
        domain: 'care',
        method: 'DELETE',
        path: `/care/entries/${id}`,
        baseVersion: current?.version,
        label: `Remove ${(current?.type ?? 'entry').toLowerCase()}`,
      })
      // ok / gone (already deleted) / queued → stay removed; conflict / error → reconcile.
      if (outcome.kind === 'conflict' || outcome.kind === 'error') await refresh()
    } finally {
      setWriting(false)
    }
  }, [run, refresh, withdraw, putPending, patchServerEntries])

  /**
   * Start, pause, resume or cancel a session.
   *
   * <b>A session started with no connection runs here and stays here.</b> It never becomes a server
   * timer: on COMPLETE it writes an ordinary entry carrying the duration it measured, and that
   * entry queues like any other. Which is what makes the reconnect uneventful — there is no
   * half-finished session to hand over, no start time to reconcile against a clock that has moved,
   * and nothing that can be counted twice.
   *
   * `opts` carries what the session needs to *begin* — the nursing side, and the pump's two phase
   * lengths, which are set on the panel before starting and which decide when it switches and when
   * it chimes.
   */
  const timer = useCallback(async (
    type: CareEntryTypeName,
    action: 'start' | 'pause' | 'resume' | 'cancel',
    opts?: { side?: string; phaseOne?: number; phaseTwo?: number },
  ) => {
    const heldTimers = localTimersRef.current
    const runsLocally = heldTimers.some((t) => t.type === type) || (!online && action === 'start')

    if (runsLocally) {
      switch (action) {
        case 'start': putLocalTimers(startLocalTimer(heldTimers, type, opts)); break
        case 'pause': putLocalTimers(pauseLocalTimer(heldTimers, type)); break
        case 'resume': putLocalTimers(resumeLocalTimer(heldTimers, type)); break
        // Cancel throws the session away and writes nothing — deliberately not the same act as
        // complete, offline exactly as on the server.
        case 'cancel': putLocalTimers(cancelLocalTimer(heldTimers, type)); break
      }
      return
    }

    setWriting(true)
    try {
      const params = new URLSearchParams()
      if (opts?.side) params.set('side', opts.side)
      if (opts?.phaseOne != null) params.set('phaseOne', String(opts.phaseOne))
      if (opts?.phaseTwo != null) params.set('phaseTwo', String(opts.phaseTwo))
      const query = params.toString()
      await api.careTimer(childKey, type, action, query ? `?${query}` : '')
      await refresh()
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
      /*
       * The connection went between the decision to use the server and the request. Rather than
       * report a failure for something the panel can simply do itself, the session starts here —
       * which is the whole point of the local timer existing.
       */
      if (action === 'start') putLocalTimers(startLocalTimer(localTimersRef.current, type, opts))
      else setError('That timer could not be changed.')
    } finally {
      setWriting(false)
    }
  }, [childKey, refresh, online, putLocalTimers])

  /** Move a nursing session to the other breast without ending it. */
  const switchSide = useCallback(async (type: CareEntryTypeName, side: string) => {
    const heldTimers = localTimersRef.current
    if (heldTimers.some((t) => t.type === type)) {
      putLocalTimers(switchLocalSide(heldTimers, type, side))
      return
    }
    setWriting(true)
    try {
      await api.careTimerSide(childKey, type, side)
      await refresh()
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
      setError('The side could not be changed.')
    } finally {
      setWriting(false)
    }
  }, [childKey, refresh, putLocalTimers])

  /**
   * Stop a session's clock and hold it for its amount. Writes nothing.
   *
   * <b>The pump's third stop, and the only one that is neither a write nor a discard.</b> How much
   * was expressed is knowable at exactly one moment — the end — so FINISH measures the session and
   * holds it, the panel asks once, and `complete` writes the session and its amount together. A
   * held session survives the panel closing and the app restarting, because it is a row rather than
   * something this hook remembers.
   */
  const finish = useCallback(async (type: CareEntryTypeName) => {
    const heldTimers = localTimersRef.current
    if (heldTimers.some((t) => t.type === type)) {
      putLocalTimers(finishLocalTimer(heldTimers, type))
      return
    }
    setWriting(true)
    try {
      await api.careTimer(childKey, type, 'finish')
      await refresh()
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
      /*
       * The measurement is the thing that must not be lost, and the server is the one place that
       * cannot be reached. Holding it locally would mean two records of one session — the server's
       * still running, this one finished — and the reconnect would have to reconcile them. Saying
       * so and leaving the session running keeps one truth: the clock is still going, and FINISH
       * can be pressed again when there is a connection.
       */
      setError('That session could not be finished.')
    } finally {
      setWriting(false)
    }
  }, [childKey, refresh, putLocalTimers])

  /** Advance a pump session to expression early, moving the switch and its chime with it. */
  const pumpPhase = useCallback(async () => {
    const heldTimers = localTimersRef.current
    if (heldTimers.some((t) => t.type === 'Pump')) {
      putLocalTimers(switchLocalPhase(heldTimers))
      return
    }
    setWriting(true)
    try {
      await api.carePumpPhase(childKey)
      await refresh()
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
      setError('The phase could not be changed.')
    } finally {
      setWriting(false)
    }
  }, [childKey, refresh, putLocalTimers])

  /**
   * End a session and write it.
   *
   * Deliberately its own call rather than a fifth timer action: <b>complete and cancel are different
   * acts</b> and the design is emphatic they must never be one ambiguous stop. `amount` is for pump,
   * where null means "not measured" and must never arrive as a zero.
   *
   * `atUtc` moves the session's start, and only the pump's finish step sends one — a timer left
   * running while the pump was packed away measured more than the session ran.
   */
  const complete = useCallback(async (
    type: CareEntryTypeName, amount?: number | null, unit?: string, atUtc?: string,
  ) => {
    const heldTimers = localTimersRef.current
    const local = heldTimers.find((t) => t.type === type)

    if (local) {
      /*
       * The one place a local session crosses over: it stops being a timer and becomes an entry,
       * which the queue already knows how to carry safely. The session is cleared first so a slow
       * or queued write cannot leave a finished clock still running on screen.
       */
      putLocalTimers(cancelLocalTimer(heldTimers, type))
      const input = completedEntryInput(local, amount, unit)
      await add(atUtc ? { ...input, atUtc } : input)
      return
    }

    setWriting(true)
    try {
      await api.careTimerComplete(childKey, type, amount, unit, atUtc)
      await refresh()
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
      setError('That session could not be saved.')
    } finally {
      setWriting(false)
    }
  }, [childKey, refresh, putLocalTimers, add])

  /*
   * No `importFromHuckleberry` here.
   *
   * The pull is a Config action now — see `BabySettingsScreen`, which calls `api.importCare`
   * directly. It has no business in this hook: everything else here is written on the device first
   * and owed to the server afterwards, and the import is the one call that is meaningless without
   * one. Its results still arrive, on this hook's next `refresh`.
   */

  const running = useCallback(
    (type: CareEntryTypeName) => timers.find((t) => t.type === type) ?? null,
    [timers],
  )

  /*
   * The two windows, cut from the one read.
   *
   * `today` is the calendar day, which is what Today's log lists. `inWindow` is 6 AM to 6 AM, which
   * is what the totals page counts — and the two deliberately disagree: the 1:25 AM and 4:00 AM
   * bottles belong to the window that opened at 6 AM *yesterday*, so they are counted there and
   * listed here. The handoff says in as many words not to reconcile them.
   *
   * Both derive from `now`, so the 6 AM roll happens on the clock tick with no refetch: at 6 AM the
   * window empties while the calendar list carries on.
   */
  const midnight = startOfToday().getTime()
  const windowOpened = careWindowStart(new Date(now)).getTime()
  const today = entries.filter((e) => Date.parse(e.atUtc) >= midnight)
  const inWindow = entries.filter((e) => Date.parse(e.atUtc) >= windowOpened)
  /*
   * Everything fetched, newest first — what the ENTRIES page lists.
   *
   * <b>Deliberately not scoped to today.</b> It was, and on any morning before the first feed the
   * page was empty, which on a screen whose neighbours show gaps of `3D` and `8D` reads as a page
   * that failed to load rather than as a day that has not started. It is also the only place an
   * entry can be corrected, and a correction is usually wanted for something logged last night.
   */
  const recent = entries

  return {
    lastByType, timers, today, inWindow, recent, loading, error, writing,
    /** How many entries this device still owes the server — what the log's unsent mark counts. */
    unsentCount: owed.length,
    refresh, add, update, remove, timer, switchSide, pumpPhase, finish, complete, running,
    clearError: () => setError(null),
  }
}

/**
 * The fields a correction actually set, for patching a row optimistically.
 *
 * An input carries every field the sheet knows about, most of them undefined. Spreading it whole
 * over a cached row would blank the columns the sheet did not ask about — which on a diaper is the
 * colour and consistency somebody recorded an hour ago.
 */
function stripUnset(input: CareEntryInput): Partial<CareEntryDto> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && key !== 'clientKey') out[key] = value
  }
  return out as Partial<CareEntryDto>
}

/**
 * How far back one read reaches: a week.
 *
 * Enough that the ENTRIES page has something on it for a household that logs a few times a day,
 * and enough that a correction to yesterday evening is reachable — while still being a handful of
 * rows rather than a history query. The totals and the calendar day are sliced out of the result.
 */
function entriesFrom(): Date {
  const d = startOfToday()
  d.setDate(d.getDate() - 7)
  return d
}

function startOfToday(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

function tomorrow(): Date {
  const d = startOfToday()
  d.setDate(d.getDate() + 1)
  return d
}
