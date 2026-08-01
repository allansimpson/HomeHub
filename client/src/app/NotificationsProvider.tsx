import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api, ApiError } from '../api/client'
import type { NotificationDto } from '../api/types'

/**
 * Two levels, and the accent carries which. There is no third level and no "critical" — if something
 * is louder than *wants you*, it belongs in a fault display of its own, not in a notification.
 */
export type NotificationSeverity = 'wants-you' | 'worth-knowing'

/**
 * What may notify. **Six, not the seven the design drew.**
 *
 * `GROCERY` in the mockups is not a source — it is the name of a Microsoft To Do list, and could
 * equally read `HOUSEHOLD`. List notifications arrive as `tasks` carrying the list's own name as
 * their label. Making it a source would mean a switch for a list that might be renamed tomorrow.
 */
// eslint-disable-next-line react-refresh/only-export-components
export const ALL_SOURCES = ['litter', 'calendar', 'tasks', 'climate', 'baby', 'cameras'] as const
export type NotificationSource = (typeof ALL_SOURCES)[number]

// eslint-disable-next-line react-refresh/only-export-components
export const SOURCE_LABELS: Record<NotificationSource, string> = {
  litter: 'Litter Robot',
  calendar: 'Calendar',
  tasks: 'Tasks',
  climate: 'Climate',
  baby: 'Baby',
  cameras: 'Cameras',
}

export type AppNotification = NotificationDto

interface NotificationsState {
  /** Everything held, newest first — the last seven days. */
  all: AppNotification[]
  /** The at-most-three currently on screen as cards. */
  live: AppNotification[]
  unreadCount: number
  drawerOpen: boolean
  sources: Readonly<Record<string, boolean>>
  loading: boolean
  /** Send one card away. It stays in the drawer and inbox — dismissing is not clearing. */
  dismiss: (id: number) => void
  markRead: (id: number) => Promise<void>
  clearAll: (severity?: NotificationSeverity) => Promise<void>
  setSource: (source: string, on: boolean) => Promise<void>
  openDrawer: () => void
  closeDrawer: () => void
  refresh: () => Promise<void>
}

const NotificationsContext = createContext<NotificationsState | null>(null)

const POLL_MS = 20_000

/** How long a *worth knowing* card stays before retiring itself. A *wants you* card never does. */
const CARD_LIFETIME_MS = 12_000

/** Capacity of the visible stack. The badge carries the true count. */
const STACK = 3

/**
 * One queue, three renderings.
 *
 * Live cards, the pull-down drawer and the inbox all read from here, and the store itself lives on
 * the server — a record that vanished when the panel reloaded would not be a record.
 *
 * Cards are decided *here* rather than server-side, because "has this been shown yet" is a property
 * of this screen session, not of the household. Anything already in the store when the panel starts
 * is loaded quietly: a card means *this just happened*, and walking up in the morning should not
 * throw a stack of things that have been true for hours.
 */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [all, setAll] = useState<AppNotification[]>([])
  const [sources, setSources] = useState<Record<string, boolean>>({})
  const [unreadCount, setUnreadCount] = useState(0)
  const [liveIds, setLiveIds] = useState<number[]>([])
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [loading, setLoading] = useState(true)

  /** Everything the panel has already had a chance to show — seeded on the first read. */
  const shown = useRef<Set<number>>(new Set())
  const seeded = useRef(false)

  const refresh = useCallback(async () => {
    try {
      const feed = await api.getNotifications()
      setAll(feed.items)
      setSources(feed.sources)
      setUnreadCount(feed.unread)

      if (!seeded.current) {
        // First read: everything is already-known, so nothing pops.
        feed.items.forEach((n) => shown.current.add(n.id))
        seeded.current = true
        return
      }

      const fresh = feed.items.filter((n) => !shown.current.has(n.id) && !n.read)
      if (fresh.length === 0) return
      fresh.forEach((n) => shown.current.add(n.id))
      // A fourth arrival pushes the oldest visible card out; it is not lost, just no longer on screen.
      setLiveIds((cur) => [...fresh.map((n) => n.id), ...cur].slice(0, STACK))
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
      // No notification store (no database) is not an error state — the panel simply has nothing to
      // show, and every other section keeps working.
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const tick = async () => { if (!cancelled) await refresh() }
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

  /**
   * One timer per card, owned across renders.
   *
   * The previous shape rebuilt every timer whenever `liveIds` or `all` changed — and both change for
   * reasons that have nothing to do with a given card. Swiping the front card away, or marking
   * anything read from the drawer, restarted the countdown on every *other* card: a card eleven
   * seconds into its twelve-second life would begin again and linger for twenty-three.
   */
  const retireTimers = useRef(new Map<number, number>())

  // Retire *worth knowing* cards on their own. A *wants you* card waits — that it does not go away
  // by itself is the whole point of the level.
  useEffect(() => {
    const timers = retireTimers.current

    // Start one for each newly live card; leave running timers strictly alone.
    for (const id of liveIds) {
      if (timers.has(id)) continue
      const n = all.find((x) => x.id === id)
      if (!n || n.severity === 'wants-you') continue
      timers.set(
        id,
        window.setTimeout(() => {
          timers.delete(id)
          setLiveIds((cur) => cur.filter((x) => x !== id))
        }, CARD_LIFETIME_MS),
      )
    }

    // And drop timers for cards that have gone by other means (dismissed, cleared).
    for (const [id, handle] of timers) {
      if (!liveIds.includes(id)) {
        window.clearTimeout(handle)
        timers.delete(id)
      }
    }
  }, [liveIds, all])

  // Timers outlive the effect that made them, so teardown is its own concern.
  useEffect(() => {
    const timers = retireTimers.current
    return () => {
      for (const handle of timers.values()) window.clearTimeout(handle)
      timers.clear()
    }
  }, [])

  const dismiss = useCallback((id: number) => {
    setLiveIds((cur) => cur.filter((x) => x !== id))
  }, [])

  const markRead = useCallback(async (id: number) => {
    setAll((cur) => cur.map((n) => (n.id === id ? { ...n, read: true } : n)))
    setUnreadCount((c) => Math.max(0, c - 1))
    try { await api.markNotificationRead(id) } catch (err) { if (!(err instanceof ApiError)) throw err }
  }, [])

  // Clearing is a reading gesture, never an action on the thing reported: clearing "globe stopped
  // partway through a cycle" does not cancel the retry, and clearing a Baby entry does not unlog it.
  const clearAll = useCallback(async (severity?: NotificationSeverity) => {
    setAll((cur) => (severity ? cur.filter((n) => n.severity !== severity) : []))
    setLiveIds([])
    try { await api.clearNotifications(severity) } catch (err) { if (!(err instanceof ApiError)) throw err }
    await refresh()
  }, [refresh])

  const setSource = useCallback(async (source: string, on: boolean) => {
    setSources((cur) => ({ ...cur, [source]: on }))
    try { await api.setNotificationSource(source, on) } catch (err) { if (!(err instanceof ApiError)) throw err }
  }, [])

  const live = useMemo(
    () => liveIds.map((id) => all.find((n) => n.id === id)).filter((n): n is AppNotification => !!n),
    [liveIds, all],
  )

  const value = useMemo<NotificationsState>(
    () => ({
      all, live, unreadCount, drawerOpen, sources, loading,
      dismiss, markRead, clearAll, setSource, refresh,
      openDrawer: () => setDrawerOpen(true),
      closeDrawer: () => setDrawerOpen(false),
    }),
    [all, live, unreadCount, drawerOpen, sources, loading, dismiss, markRead, clearAll, setSource, refresh],
  )

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useNotifications(): NotificationsState {
  const ctx = useContext(NotificationsContext)
  if (!ctx) throw new Error('useNotifications must be used within a NotificationsProvider')
  return ctx
}
