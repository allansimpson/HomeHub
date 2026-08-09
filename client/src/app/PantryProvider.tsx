import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api, ApiError } from '../api/client'
import type {
  GroceryInput,
  GroceryListDto,
  PantryItemInput,
  PantryListDto,
  ScanInput,
} from '../api/types'
import { useSession } from './SessionProvider'
import { useWriteQueue, type WriteQueueState } from './WriteQueueProvider'
import { loadPantryPrefs, savePantryPrefs, type LocationFilter } from './pantryPrefs'

/**
 * The Pantry section's shared state: the shelves, the grocery list, and the location filter.
 *
 * One provider for both because they are two views of one idea and they write to each other —
 * ticking a grocery line puts stock back on a shelf, and a shortfall puts a shelf onto the list.
 * Fetching them separately would let the two screens disagree about whether the butter arrived.
 *
 * **Cached reads stay visible**, exactly as Meals does: a failed refresh sets `offline` and keeps
 * the last good data on screen. A stale shelf list is far more use on a wall panel than an empty
 * one, and the app-level reconnect bar already says the panel is offline.
 */
interface PantryState {
  pantry: PantryListDto | null
  grocery: GroceryListDto | null
  loading: boolean
  offline: boolean
  /** Which segment is selected. Persisted per profile (§1.4). */
  filter: LocationFilter
  setFilter: (filter: LocationFilter) => void
  refresh: () => Promise<void>
  /**
   * Add an item. Resolves to a refusal sentence the caller should show, or null when it landed.
   *
   * Refusals are rare and specific — a barcode another item already carries is the only one today —
   * but they have to reach the sheet that caused them. A queued write is *not* a refusal: offline is
   * a normal way to run this panel and the op replays on reconnect.
   */
  addItem: (input: PantryItemInput) => Promise<string | null>
  updateItem: (id: number, input: PantryItemInput, baseVersion?: number) => Promise<string | null>
  archiveItem: (id: number, baseVersion?: number) => Promise<void>
  undoEvent: (eventId: number) => Promise<void>
  scan: (input: Omit<ScanInput, 'profileId'>) => Promise<Awaited<ReturnType<typeof api.scanIntoPantry>>>
  addToGrocery: (input: GroceryInput) => Promise<void>
  addManyToGrocery: (lines: GroceryInput[]) => Promise<void>
  checkGrocery: (id: number, checkedOff: boolean) => Promise<void>
  removeGrocery: (id: number) => Promise<void>
  clearChecked: () => Promise<void>
}

const PantryContext = createContext<PantryState | null>(null)

/**
 * The sentence a write outcome should show, or null when there is nothing to say.
 *
 * `queued` and `conflict` are both silent here on purpose: the app-level queue bar already says a
 * change is pending, and a conflict raises its own keep-mine/use-server strip above the router.
 * Repeating either inside a sheet would be the same news twice in two places.
 */
function rejection(outcome: Awaited<ReturnType<WriteQueueState['run']>>): string | null {
  return outcome.kind === 'error' ? outcome.message : null
}

/**
 * Two minutes, matching Meals. Stock changes at human speed — somebody unpacking a bag — so this is
 * about catching a phone's scan, not about liveness.
 */
const POLL_MS = 2 * 60_000

export function PantryProvider({ children }: { children: ReactNode }) {
  const { activeProfileId } = useSession()
  const { run } = useWriteQueue()
  const [pantry, setPantry] = useState<PantryListDto | null>(null)
  const [grocery, setGrocery] = useState<GroceryListDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [offline, setOffline] = useState(false)
  const [filter, setFilterState] = useState<LocationFilter>(() => loadPantryPrefs(activeProfileId).filter)

  // The filter is per profile, so switching who is signed in switches the shelf they were looking
  // at rather than inheriting somebody else's.
  useEffect(() => {
    setFilterState(loadPantryPrefs(activeProfileId).filter)
  }, [activeProfileId])

  const refresh = useCallback(async () => {
    try {
      // The filter is applied client-side from the full list: the tally counts the whole pantry
      // whatever the segment says, and re-fetching per tap would make tapping FRIDGE a network
      // round trip on a panel that is often offline.
      const [nextPantry, nextGrocery] = await Promise.all([api.getPantry(), api.getGrocery()])
      setPantry(nextPantry)
      setGrocery(nextGrocery)
      setOffline(false)
    } catch (err) {
      if (err instanceof ApiError) setOffline(true)
      else throw err
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      if (!cancelled) await refresh()
    }
    void tick()
    const id = window.setInterval(tick, POLL_MS)
    const onSync = () => void refresh()
    window.addEventListener('homehub:sync', onSync)
    return () => {
      cancelled = true
      window.clearInterval(id)
      window.removeEventListener('homehub:sync', onSync)
    }
  }, [refresh])

  const setFilter = useCallback((next: LocationFilter) => {
    setFilterState(next)
    savePantryPrefs(activeProfileId, { filter: next })
  }, [activeProfileId])

  const addItem = useCallback(async (input: PantryItemInput) => {
    const outcome = await run({
      domain: 'pantry',
      method: 'POST',
      path: '/pantry',
      // No profileId: the server attributes pantry events to the session (AUDIT A1.2).
      body: input,
      label: `Add ${input.name}`,
    })
    await refresh()
    return rejection(outcome)
  }, [run, refresh])

  const updateItem = useCallback(async (id: number, input: PantryItemInput, baseVersion?: number) => {
    const outcome = await run({
      domain: 'pantry',
      method: 'PATCH',
      path: `/pantry/${id}`,
      // No profileId: the server attributes pantry events to the session (AUDIT A1.2).
      body: input,
      baseVersion,
      label: input.name,
    })
    await refresh()
    return rejection(outcome)
  }, [run, refresh])

  const archiveItem = useCallback(async (id: number, baseVersion?: number) => {
    await run({
      domain: 'pantry',
      method: 'DELETE',
      path: `/pantry/${id}`,
      baseVersion,
      label: 'Remove from the pantry',
    })
    await refresh()
  }, [run, refresh])

  const undoEvent = useCallback(async (eventId: number) => {
    await api.undoPantryEvent(eventId)
    await refresh()
  }, [refresh])

  /**
   * A scan is not queued. It answers with whether the barcode matched, and the phone's next tap
   * depends on that answer — an optimistic "probably added" would put an unnamed pack on the run
   * list and leave the household unable to name it.
   */
  const scan = useCallback(async (input: Omit<ScanInput, 'profileId'>) => {
    const result = await api.scanIntoPantry(input)
    await refresh()
    return result
  }, [refresh])

  const addToGrocery = useCallback(async (input: GroceryInput) => {
    await run({
      domain: 'grocery',
      method: 'POST',
      path: '/grocery',
      // No profileId: the server attributes pantry events to the session (AUDIT A1.2).
      body: input,
      label: input.text,
    })
    await refresh()
  }, [run, refresh])

  const addManyToGrocery = useCallback(async (lines: GroceryInput[]) => {
    await run({
      domain: 'grocery',
      method: 'POST',
      path: '/grocery/batch',
      // No profileId: the server attributes pantry events to the session (AUDIT A1.2).
      body: { lines },
      label: `${lines.length} to the grocery list`,
    })
    await refresh()
  }, [run, refresh])

  const checkGrocery = useCallback(async (id: number, checkedOff: boolean) => {
    // Optimistic: ticking is the most-repeated gesture on this screen and it has to feel instant.
    // The return-trip sentence waits for the server, because it names a shelf the client is not
    // entitled to guess at.
    setGrocery((prev) => prev && {
      ...prev,
      lines: prev.lines.map((l) => (l.id === id
        ? { ...l, checkedAtUtc: checkedOff ? new Date().toISOString() : null }
        : l)),
      openCount: prev.openCount + (checkedOff ? -1 : 1),
    })
    await run({
      domain: 'grocery',
      method: 'POST',
      path: `/grocery/${id}/check?checkedOff=${checkedOff}`,
      label: checkedOff ? 'Got it' : 'Back on the list',
    })
    await refresh()
  }, [run, refresh])

  const removeGrocery = useCallback(async (id: number) => {
    await run({ domain: 'grocery', method: 'DELETE', path: `/grocery/${id}`, label: 'Off the list' })
    await refresh()
  }, [run, refresh])

  const clearChecked = useCallback(async () => {
    await run({ domain: 'grocery', method: 'POST', path: '/grocery/clear-checked', label: 'Clear the ticked' })
    await refresh()
  }, [run, refresh])

  const value = useMemo<PantryState>(() => ({
    pantry, grocery, loading, offline, filter, setFilter, refresh,
    addItem, updateItem, archiveItem, undoEvent, scan,
    addToGrocery, addManyToGrocery, checkGrocery, removeGrocery, clearChecked,
  }), [
    pantry, grocery, loading, offline, filter, setFilter, refresh,
    addItem, updateItem, archiveItem, undoEvent, scan,
    addToGrocery, addManyToGrocery, checkGrocery, removeGrocery, clearChecked,
  ])

  return <PantryContext.Provider value={value}>{children}</PantryContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePantry(): PantryState {
  const ctx = useContext(PantryContext)
  if (!ctx) throw new Error('usePantry must be used within a PantryProvider')
  return ctx
}
