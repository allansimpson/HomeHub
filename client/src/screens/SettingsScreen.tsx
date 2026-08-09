import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router'
import {
  DrillInHeader,
  ScreenShell,
  ScrollArea,
  SectionLabel,
  LedgerRow,
  Toggle,
  Stepper,
  PinPad,
  MarkPicker,
  MarkBox,
} from '../components'
import { Icon } from '../icons/Icon'
import type { IconId } from '../icons/Icon'
import { useSession } from '../app/SessionProvider'
import { useSensors } from '../app/SensorsProvider'
import { useTasks } from '../app/TasksProvider'
import { useCalendar } from '../app/CalendarProvider'
import { useNotifications } from '../app/NotificationsProvider'
import { getShowToday, getShowAll, setShowToday, setShowAll } from '../app/todoPrefs'
import { RETENTION_OPTIONS, DEFAULT_RETENTION_DAYS, NEVER, retentionLabel } from '../app/assistPrefs'
import { useAssist } from '../app/AssistProvider'
import { useShowThinking } from '../app/useShowThinking'
import { useBaby } from '../app/BabyProvider'
import { useCatName } from '../app/catName'
import { useNightMode } from '../app/useNightMode'
import { minutesOfDay, toClock } from '../app/nightMode'
import { api, ApiError } from '../api/client'
import type { ProfileDto, ProfileRole, ThresholdDto, DaylightBoostMode, SyncListDto, SyncCalendarDto, LinkStatusDto, AssignableAgent, WeatherLocationDto } from '../api/types'
import { markDefinition } from '../app/calendarMarks'
import type { MarkKey } from '../app/calendarMarks'


/** What the callback's `result` means, in the household's terms rather than OAuth's. */
const LINK_RESULTS: Record<string, string> = {
  ok: 'Account linked. Syncing resumes on the next refresh.',
  denied: 'Sign-in was cancelled — nothing changed.',
  expired: 'That took too long and the request expired. Try again.',
  norefresh: 'The provider signed you in but withheld a lasting token. Try again, and allow every permission it asks for.',
  notconfigured: 'This panel has no client id and secret for that provider yet.',
  nodb: 'No database is configured, so the link cannot be stored.',
  failed: 'Linking failed. The panel log has the provider’s own explanation.',
}


/**
 * The callback a provider has to have registered. Shown beside Connect because the failure mode is a
 * provider-side error page the panel never sees — "Error 400: redirect_uri_mismatch" is only
 * actionable if you know which string was sent.
 */
function CallbackHint({ uri }: { uri: string | null }) {
  if (!uri) return null
  return (
    <div className="ml-settings__callback">
      <span className="ml-settings__callback-label">Register this callback with the provider</span>
      <code className="ml-settings__callback-uri">{uri}</code>
    </div>
  )
}

const DAYLIGHT_MODES: DaylightBoostMode[] = ['auto', 'on', 'off']

/** Household-role and age-band choices offered per member (A1). Order matches the C# enums. */
const PROFILE_ROLES: ProfileRole[] = ['Member', 'Admin']

const PIN_LENGTH = 4

/**
 * CONFIG is an index of category rows that drill into detail views (spec 07).
 *
 * The index is grouped under six headings — Household · Devices · Lists · Thresholds · Privacy ·
 * Display — but the *views* are unchanged: the consolidation re-grouped what was there rather than
 * rebuilding it. `devices` is the one addition, and it is a route rather than a view here: it
 * renders `LitterSettingsScreen` unchanged, which is where `/litter/settings` now redirects.
 */
type ConfigView =
  | 'index' | 'lists' | 'calendars' | 'privacy' | 'thresholds' | 'display' | 'household' | 'member'
  | 'assist' | 'weather'
const CONFIG_TITLES: Record<ConfigView, string> = {
  index: 'Config',
  lists: 'To-Do Lists',
  calendars: 'Calendars',
  privacy: 'Privacy & Lock',
  thresholds: 'Alert Thresholds',
  display: 'Display',
  household: 'Household',
  member: 'Member',
  assist: 'Assist',
  weather: 'Weather',
}
function asConfigView(section: string | undefined): ConfigView {
  return section && section in CONFIG_TITLES && section !== 'index' ? (section as ConfigView) : 'index'
}

/** Display name of the active profile, or a prompt when none is chosen yet. */
function session_activeName(profiles: ProfileDto[], activeId: number | null): string {
  return profiles.find((p) => p.id === activeId)?.name ?? 'No profile selected'
}

/**
 * Settings (spec 07): PRIVACY & LOCK (per-user PIN + immutable mic indicator), ALERT
 * THRESHOLDS (stored now, consumed in Stage 2), idle dimming, and a HOUSEHOLD section for
 * add/rename/delete + clear-PIN. Persists through the API and refreshes the session so the
 * Lock screen and idle behaviour see the changes.
 */
export function SettingsScreen() {
  const navigate = useNavigate()
  const { section } = useParams()
  const { search } = useLocation()
  const view = asConfigView(section)
  const { profiles, settings, refresh, offline, signOut } = useSession()

  const { refresh: refreshSensors } = useSensors()
  const { refresh: refreshTasks } = useTasks()
  const { refresh: refreshCalendar } = useCalendar()
  const { unreadCount: unreadNotifications } = useNotifications()
  // Only for the Devices group's Huckleberry row — Config states what is connected, it does not
  // configure it. The connection itself is made in Home Assistant.
  const { health: babyHealth } = useBaby()
  // For the Devices group's Litter row — Config says what the cat is called without making anyone
  // drill in to find out. Straight from the setting; nothing infers it.
  const cat = useCatName()
  // The signed-in member's own agents, for the Assist view. Straight from the provider that already
  // polls them for the Assist tab, so this page cannot disagree with the switcher about what somebody
  // has.
  const { agents } = useAssist()
  const { showThinking, setShowThinking } = useShowThinking()

  // Local editable copy of household settings, kept in sync when the session reloads.
  const [dimming, setDimming] = useState(true)
  const [timeoutMin, setTimeoutMin] = useState(5)
  const [daylight, setDaylight] = useState<DaylightBoostMode>('auto')
  const [nightStart, setNightStart] = useState('22:00')
  const [nightEnd, setNightEnd] = useState('06:00')
  /** The panel's own darkness, for the override row. Not a setting — see `useNightMode`. */
  const night = useNightMode()

  useEffect(() => {
    if (!settings) return
    setDimming(settings.idleDimmingEnabled)
    setTimeoutMin(settings.idleTimeoutMinutes)
    setDaylight(settings.daylightBoost)
    setNightStart(settings.nightDimStart)
    setNightEnd(settings.nightDimEnd)
  }, [settings])

  // Debounced persist for the toggle/timeout/daylight/window settings (steppers repeat on
  // long-press, and a time field fires on every digit).
  useEffect(() => {
    if (!settings) return
    const unchanged =
      dimming === settings.idleDimmingEnabled &&
      timeoutMin === settings.idleTimeoutMinutes &&
      daylight === settings.daylightBoost &&
      nightStart === settings.nightDimStart &&
      nightEnd === settings.nightDimEnd
    if (unchanged) return
    const t = window.setTimeout(async () => {
      try {
        await api.updateSettings({
          idleTimeoutMinutes: timeoutMin,
          idleDimmingEnabled: dimming,
          daylightBoost: daylight,
          // Only when readable. A time input reports "" mid-edit — while somebody is retyping the
          // hour — and sending that would clear the field they are still typing into.
          ...(minutesOfDay(nightStart) !== null ? { nightDimStart: nightStart } : {}),
          ...(minutesOfDay(nightEnd) !== null ? { nightDimEnd: nightEnd } : {}),
        })
        await refresh()
      } catch (err) {
        if (!(err instanceof ApiError)) throw err
      }
    }, 400)
    return () => window.clearTimeout(t)
  }, [dimming, timeoutMin, daylight, nightStart, nightEnd, settings, refresh])

  // ---- Alert thresholds (drive the engine; edited here) ----
  const [thresholds, setThresholds] = useState<ThresholdDto[]>([])
  const [dirtyThresholds, setDirtyThresholds] = useState<Set<number>>(new Set())

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const t = await api.getThresholds()
        if (!cancelled) setThresholds(t)
      } catch (err) {
        if (!(err instanceof ApiError)) throw err
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const editThreshold = useCallback((id: number, patch: Partial<ThresholdDto>) => {
    setThresholds((cur) => cur.map((t) => (t.id === id ? { ...t, ...patch } : t)))
    setDirtyThresholds((cur) => new Set(cur).add(id))
  }, [])

  // Debounced persist of edited thresholds; re-evaluates the engine server-side.
  useEffect(() => {
    if (dirtyThresholds.size === 0) return
    const t = window.setTimeout(async () => {
      const toSave = thresholds.filter((x) => dirtyThresholds.has(x.id))
      setDirtyThresholds(new Set())
      try {
        await Promise.all(
          toSave.map((x) =>
            api.updateThreshold(x.id, { value: x.value, durationMinutes: x.durationMinutes, enabled: x.enabled }),
          ),
        )
        await refreshSensors()
      } catch (err) {
        if (!(err instanceof ApiError)) throw err
      }
    }, 500)
    return () => window.clearTimeout(t)
  }, [dirtyThresholds, thresholds, refreshSensors])

  // A single shared breach-delay applied to every threshold (common case).
  const sharedDelay = thresholds.length > 0 ? thresholds[0].durationMinutes : 10
  const setSharedDelay = useCallback(
    (next: number) => {
      const clamped = Math.max(0, next)
      setThresholds((cur) => cur.map((t) => ({ ...t, durationMinutes: clamped })))
      setDirtyThresholds(new Set(thresholds.map((t) => t.id)))
    },
    [thresholds],
  )

  // ---- Assist's conversation policy (household settings — see the Privacy view) ----
  //
  // Read from the server rather than from localStorage: the transcripts moved to the database when
  // Assist became a chat system a phone can also read, and a window held on the panel would now
  // govern nothing (ASSIST.md · Config).
  const retentionDays = settings?.conversationRetentionDays ?? DEFAULT_RETENTION_DAYS
  const storeConversations = settings?.storeConversations ?? true
  const saveConversationPolicy = useCallback(
    async (store: boolean, days: number) => {
      try {
        await api.setConversationPolicy(store, days)
        await refresh()
      } catch (err) {
        if (!(err instanceof ApiError)) throw err
      }
    },
    [refresh],
  )

  // ---- Where the weather is for ----
  //
  // Its own read rather than a field on the settings object, because the interesting part of the
  // answer is not household state: the coordinates in force fall back to the deployment's
  // configuration, and the town name comes from the last forecast NWS returned.
  const [weatherLocation, setWeatherLocation] = useState<WeatherLocationDto | null>(null)
  const [latField, setLatField] = useState('')
  const [lonField, setLonField] = useState('')
  const [weatherError, setWeatherError] = useState<string | null>(null)
  const [weatherSaving, setWeatherSaving] = useState(false)

  const loadWeatherLocation = useCallback(async () => {
    try {
      const loc = await api.getWeatherLocation()
      setWeatherLocation(loc)
      // The fields start at what is actually in force, including the configured fallback. Starting
      // them empty would make "save" ambiguous with "clear", and starting them at the household's
      // own value only would show blanks on the panel that most needs them filled in.
      setLatField(String(loc.latitude))
      setLonField(String(loc.longitude))
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
    }
  }, [])

  // Only for the two views that show it — the index row's meta, and the page itself. Re-read on
  // entering rather than polled: it changes when somebody changes it, and once more when the next
  // forecast names the new place.
  useEffect(() => {
    if (view !== 'weather' && view !== 'index') return
    void loadWeatherLocation()
  }, [view, loadWeatherLocation])

  /** The index row's meta line — the town, when there is one. */
  const weatherPlace = weatherLocation?.place ?? null

  const saveWeatherLocation = useCallback(async () => {
    // Parsed here as well as validated on the server, because the useful message is different at
    // each end: the server can only say the number was out of range, and this can say the field was
    // not a number at all — which is what a stray keystroke in a text field actually produces.
    const lat = Number(latField.trim())
    const lon = Number(lonField.trim())
    if (!latField.trim() || !lonField.trim() || Number.isNaN(lat) || Number.isNaN(lon)) {
      setWeatherError('Both need to be numbers — a latitude and a longitude.')
      return
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      setWeatherError('Latitude runs −90 to 90, longitude −180 to 180.')
      return
    }

    setWeatherSaving(true)
    setWeatherError(null)
    try {
      const loc = await api.setWeatherLocation(lat, lon)
      setWeatherLocation(loc)
      setLatField(String(loc.latitude))
      setLonField(String(loc.longitude))
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
      setWeatherError('That could not be saved. The panel may be offline.')
    } finally {
      setWeatherSaving(false)
    }
  }, [latField, lonField])

  /** Hand the question back to the deployment's configured location. */
  const clearWeatherLocation = useCallback(async () => {
    setWeatherSaving(true)
    setWeatherError(null)
    try {
      const loc = await api.setWeatherLocation(null, null)
      setWeatherLocation(loc)
      setLatField(String(loc.latitude))
      setLonField(String(loc.longitude))
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
      setWeatherError('That could not be saved. The panel may be offline.')
    } finally {
      setWeatherSaving(false)
    }
  }, [])

  // ---- To-Do lists: special Today/All view toggles + which Microsoft lists sync ----
  const activeId = settings?.activeProfileId ?? null
  const [showToday, setShowTodayState] = useState(getShowToday())
  const [showAll, setShowAllState] = useState(getShowAll())
  const [taskLists, setTaskLists] = useState<SyncListDto[]>([])
  const [listsAvailable, setListsAvailable] = useState(false)
  const [listSearch, setListSearch] = useState('')

  const toggleToday = useCallback((v: boolean) => { setShowToday(v); setShowTodayState(v) }, [])
  const toggleAll = useCallback((v: boolean) => { setShowAll(v); setShowAllState(v) }, [])

  useEffect(() => {
    if (activeId == null) return
    let cancelled = false
    ;(async () => {
      try {
        const data = await api.getTaskLists(activeId)
        if (!cancelled) {
          setTaskLists(data)
          setListsAvailable(true)
        }
      } catch (err) {
        if (!cancelled) setListsAvailable(false)
        if (!(err instanceof ApiError)) throw err
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeId])

  const toggleList = useCallback(
    async (graphListId: string) => {
      if (activeId == null) return
      const next = taskLists.map((l) => (l.graphListId === graphListId ? { ...l, selected: !l.selected } : l))
      setTaskLists(next)
      try {
        await api.setTaskLists(activeId, next.filter((l) => l.selected).map((l) => l.graphListId))
        await refreshTasks() // re-sync so the TODO view reflects the change without a page reload
      } catch (err) {
        if (!(err instanceof ApiError)) throw err
      }
    },
    [activeId, taskLists, refreshTasks],
  )

  // ---- Google calendars: which of the active profile's calendars display (mirrors To-Do lists) ----
  const [calendars, setCalendars] = useState<SyncCalendarDto[]>([])
  const [calendarsAvailable, setCalendarsAvailable] = useState(false)
  /**
   * The account is linked but Google refused the token — a sign-in, not an absence.
   *
   * Distinct from `calendarsAvailable` because the three states need three different sentences:
   * no link at all, a link that needs renewing, and a working link with nothing on it. Collapsing
   * the middle one into either of the others sends someone looking for a problem that isn't there.
   */
  const [calendarsNeedReauth, setCalendarsNeedReauth] = useState(false)

  /**
   * Outcome of a linking round trip, read from the query the callback redirects back with.
   *
   * The consent happens on the provider's own pages, so the panel learns how it went only by being
   * returned to — there is no promise to await. Read once and cleared from the URL, so a refresh
   * does not re-announce a link made ten minutes ago.
   */
  const [linkResult, setLinkResult] = useState<string | null>(null)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const result = params.get('result')
    if (!result) return
    setLinkResult(result)
    // Clear only the link outcome. `profile` identifies which member this page is about, so
    // stripping the whole query string here would drop the member view back to nobody the moment a
    // link finished — exactly when it needs to report the result against that person.
    params.delete('result')
    params.delete('link')
    const rest = params.toString()
    window.history.replaceState({}, '', window.location.pathname + (rest ? `?${rest}` : ''))
  }, [])

  /**
   * Which member the `member` view is about, from `?profile=`. Distinct from the active profile:
   * this whole view exists so the household can link an account for someone who is not signed in.
   */
  // Derived from the router's own location, not `window.location`: the latter is not reactive, so a
  // navigation that changes only the query string would leave this stale on the previous member.
  const memberId = useMemo(() => {
    const raw = new URLSearchParams(search).get('profile')
    const id = raw ? Number(raw) : NaN
    return Number.isFinite(id) && id > 0 ? id : null
  }, [search])
  const member = profiles.find((p) => p.id === memberId) ?? null

  /** Link status for the member being configured, kept apart from the active profile's. */
  const [memberLinks, setMemberLinks] = useState<LinkStatusDto[]>([])
  const [memberLinksLoaded, setMemberLinksLoaded] = useState(false)
  const loadMemberLinks = useCallback(async (id: number) => {
    try {
      setMemberLinks(await api.getLinkStatus(id))
    } catch {
      setMemberLinks([])
    } finally {
      setMemberLinksLoaded(true)
    }
  }, [])
  useEffect(() => {
    if (view !== 'member' || memberId == null) { setMemberLinks([]); setMemberLinksLoaded(false); return }
    void loadMemberLinks(memberId)
  }, [view, memberId, loadMemberLinks, linkResult])

  /**
   * Which agents this member may talk to (ASSIST.md · Agents).
   *
   * Here rather than in Assist, deliberately: Assist is where you *use* an agent, and giving someone
   * access to one is a decision about a person that another person makes. Kept beside account
   * linking for the same reason — both are "what this member's panel can reach".
   */
  const [agentAssignments, setAgentAssignments] = useState<AssignableAgent[]>([])
  const [agentsLoaded, setAgentsLoaded] = useState(false)
  const loadAgentAssignments = useCallback(async (id: number) => {
    try {
      setAgentAssignments((await api.getAgentAssignments(id)).agents)
    } catch {
      setAgentAssignments([])
    } finally {
      setAgentsLoaded(true)
    }
  }, [])
  useEffect(() => {
    if (view !== 'member' || memberId == null) { setAgentAssignments([]); setAgentsLoaded(false); return }
    void loadAgentAssignments(memberId)
  }, [view, memberId, loadAgentAssignments])

  const toggleAgent = useCallback(
    async (id: number, agentKey: string, assigned: boolean) => {
      // Whole-list PUT, so the request always states the complete set rather than a delta that could
      // be applied to a set somebody else has since changed.
      const next = agentAssignments
        .filter((a) => (a.key === agentKey ? assigned : a.assigned))
        .filter((a) => !a.isHouseholdAgent)
        .map((a) => a.key)
      const withToggled = assigned && !next.includes(agentKey) ? [...next, agentKey] : next
      setAgentAssignments((prev) =>
        prev.map((a) => (a.key === agentKey ? { ...a, assigned } : a)))
      try {
        setAgentAssignments((await api.setAgentAssignments(id, withToggled)).agents)
      } catch (err) {
        if (!(err instanceof ApiError)) throw err
        await loadAgentAssignments(id) // put the truth back
      }
    },
    [agentAssignments, loadAgentAssignments],
  )

  /**
   * Which of this member's agents Assist opens on.
   *
   * Not optimistic, unlike the toggles beside it. The server refuses a default naming an agent the
   * member does not have — a real outcome here, because revoking one is a tap away in the same
   * section — and a chip that moved and then moved back would read as the panel changing its mind.
   * The response *is* the whole assignment list, so one round trip settles both halves of the section.
   */
  const setDefaultAgent = useCallback(
    async (id: number, agentKey: string) => {
      try {
        setAgentAssignments((await api.setDefaultAgent(id, agentKey)).agents)
      } catch (err) {
        if (!(err instanceof ApiError)) throw err
        await loadAgentAssignments(id)
      }
    },
    [loadAgentAssignments],
  )

  /** Consent for a specific member, returning to that member's page rather than the default screen. */
  const startMemberLink = useCallback(async (provider: string, id: number) => {
    try {
      const { url } = await api.startLink(provider, id, `/settings/member?profile=${id}`)
      window.location.assign(url)
    } catch (err) {
      if (err instanceof ApiError) setLinkResult(err.status === 501 ? 'notconfigured' : 'failed')
      else throw err
    }
  }, [])

  const unlinkMember = useCallback(async (provider: string, id: number) => {
    try {
      await api.unlink(provider, id)
    } finally {
      await loadMemberLinks(id)
      await refreshCalendar()
      await refreshTasks()
    }
  }, [loadMemberLinks, refreshCalendar, refreshTasks])

  /**
   * The callback each provider must have registered. A mismatch fails on the provider's own error
   * page, which never returns here — so the string is shown up front rather than after the fact.
   */
  const [linkStatus, setLinkStatus] = useState<LinkStatusDto[]>([])
  useEffect(() => {
    if (activeId == null) { setLinkStatus([]); return }
    let cancelled = false
    api.getLinkStatus(activeId)
      .then((s) => { if (!cancelled) setLinkStatus(s) })
      .catch(() => { if (!cancelled) setLinkStatus([]) })
    return () => { cancelled = true }
  }, [activeId])

  const callbackFor = useCallback(
    (provider: string) => linkStatus.find((s) => s.provider === provider)?.redirectUri ?? null,
    [linkStatus],
  )

  /** Hand the panel to the provider's consent page. The kiosk has one window, so it travels there. */
  const startLink = useCallback(async (provider: string) => {
    if (activeId == null) return
    try {
      const { url } = await api.startLink(provider, activeId)
      window.location.assign(url)
    } catch (err) {
      if (err instanceof ApiError) setLinkResult(err.status === 501 ? 'notconfigured' : 'failed')
      else throw err
    }
  }, [activeId])
  const [calendarSearch, setCalendarSearch] = useState('')

  useEffect(() => {
    if (activeId == null) return
    let cancelled = false
    ;(async () => {
      try {
        const data = await api.getCalendars(activeId)
        if (!cancelled) {
          setCalendars(data)
          setCalendarsAvailable(true)
          setCalendarsNeedReauth(false)
        }
      } catch (err) {
        if (!cancelled) {
          setCalendarsAvailable(false)
          // 409 is the server saying the link exists and Google refused it.
          setCalendarsNeedReauth(err instanceof ApiError && err.status === 409)
        }
        if (!(err instanceof ApiError)) throw err
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeId])

  const toggleCalendar = useCallback(
    async (calendarId: string) => {
      if (activeId == null) return
      const next = calendars.map((c) => (c.calendarId === calendarId ? { ...c, selected: !c.selected } : c))
      setCalendars(next)
      try {
        await api.setCalendars(activeId, next.filter((c) => c.selected).map((c) => c.calendarId))
        await refreshCalendar() // reflect on the dashboard/calendar without a reload
      } catch (err) {
        if (!(err instanceof ApiError)) throw err
      }
    },
    [activeId, calendars, refreshCalendar],
  )

  /**
   * The calendar whose mark is being chosen (spec 14). Held here rather than routed because the
   * calendar id is a Google address — `#`, `@` and all — and has no business in a URL.
   */
  const [markFor, setMarkFor] = useState<SyncCalendarDto | null>(null)

  /** Why a mark could not be saved, when the server refused it. Cleared on the next attempt. */
  const [markError, setMarkError] = useState<string | null>(null)

  const saveMark = useCallback(
    async (calendarId: string, mark: MarkKey) => {
      if (activeId == null) return
      // 'none' is a choice, not an absence: it clears the stored icon.
      const icon = mark === 'none' ? null : mark
      const previous = calendars.find((c) => c.calendarId === calendarId)?.icon ?? null
      setCalendars((cs) => cs.map((c) => (c.calendarId === calendarId ? { ...c, icon } : c)))
      setMarkFor(null)
      setMarkError(null)
      try {
        await api.setCalendarIcon(activeId, calendarId, icon)
        await refreshCalendar() // re-resolves every event on that calendar, without re-fetching them
      } catch (err) {
        if (!(err instanceof ApiError)) throw err
        // Put the row back. Leaving the optimistic mark on screen is exactly what made a failed save
        // look like a successful one — it only came undone on the next visit, far from the cause.
        setCalendars((cs) => cs.map((c) => (c.calendarId === calendarId ? { ...c, icon: previous } : c)))
        setMarkError(
          err.status === 409
            ? 'That calendar is hidden. Turn it on before giving it a mark.'
            : 'The mark could not be saved. The panel log has the reason.',
        )
      }
    },
    [activeId, calendars, refreshCalendar],
  )

  // ---- Per-user lock toggle ----
  const setRequirePin = useCallback(
    async (profile: ProfileDto, next: boolean) => {
      if (next && !profile.hasPin) {
        // Can't require a PIN that doesn't exist yet — collect one first.
        setPinFor(profile)
        return
      }
      try {
        await api.updateProfile(profile.id, {
          name: profile.name,
          initial: profile.initial,
          requirePinWhenIdle: next,
          stayLoggedIn: !next,
          displayOrder: profile.displayOrder,
        })
        await refresh()
      } catch (err) {
        if (!(err instanceof ApiError)) throw err
      }
    },
    [refresh],
  )

  // ---- Household management ----
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [nameDraft, setNameDraft] = useState('')

  const commitRename = useCallback(
    async (profile: ProfileDto) => {
      const name = nameDraft.trim()
      setRenamingId(null)
      if (!name || name === profile.name) return
      try {
        await api.updateProfile(profile.id, {
          name,
          initial: name[0].toUpperCase(),
          requirePinWhenIdle: profile.requirePinWhenIdle,
          stayLoggedIn: profile.stayLoggedIn,
          displayOrder: profile.displayOrder,
        })
        await refresh()
      } catch (err) {
        if (!(err instanceof ApiError)) throw err
      }
    },
    [nameDraft, refresh],
  )

  /**
   * Set a member's household role. Sent as a partial so an omitted grant is never revoked by a
   * stale copy of the row — see `api.updateProfile`.
   */
  const setProfileFacet = useCallback(
    async (profile: ProfileDto, facet: { role?: ProfileRole }) => {
      try {
        await api.updateProfile(profile.id, {
          name: profile.name,
          initial: profile.initial,
          requirePinWhenIdle: profile.requirePinWhenIdle,
          stayLoggedIn: profile.stayLoggedIn,
          displayOrder: profile.displayOrder,
          ...facet,
        })
        await refresh()
      } catch (err) {
        if (!(err instanceof ApiError)) throw err
      }
    },
    [refresh],
  )

  const addProfile = useCallback(async () => {
    try {
      const created = await api.createProfile('New Member', 'N')
      await refresh()
      setRenamingId(created.id)
      setNameDraft(created.name)
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
    }
  }, [refresh])

  const removeProfile = useCallback(
    async (id: number) => {
      try {
        await api.deleteProfile(id)
        await refresh()
      } catch (err) {
        if (!(err instanceof ApiError)) throw err
      }
    },
    [refresh],
  )

  const clearPin = useCallback(
    async (id: number) => {
      try {
        await api.clearPin(id)
        await refresh()
      } catch (err) {
        if (!(err instanceof ApiError)) throw err
      }
    },
    [refresh],
  )

  // ---- Set-PIN flow (two-step enter → confirm) ----
  const [pinFor, setPinFor] = useState<ProfileDto | null>(null)

  if (markFor) {
    return (
      <MarkPicker
        subject={markFor.name}
        value={markFor.icon}
        onCancel={() => setMarkFor(null)}
        onSave={(mark) => void saveMark(markFor.calendarId, mark)}
      />
    )
  }

  if (pinFor) {
    return (
      <SetPinFlow
        profile={pinFor}
        onCancel={() => setPinFor(null)}
        onDone={async () => {
          setPinFor(null)
          await refresh()
        }}
      />
    )
  }

  const activeName = session_activeName(profiles, activeId)
  const activeInitial = profiles.find((p) => p.id === activeId)?.initial ?? '?'
  const pinRequiredHere = profiles.find((p) => p.id === activeId)?.requirePinWhenIdle ?? false
  const selectedLists = taskLists.filter((l) => l.selected).length
  const selectedCalendars = calendars.filter((c) => c.selected).length

  // Detail views drill in one level and carry a back ◂ to the index. The index itself is a main
  // tab destination (CONFIG), so it has no back button.
  // Member is the one two-deep view (Config → Household → a member), so it is the one that must not
  // unwind straight to the index — you came from a list you were working through.
  const goBack = () => navigate(view === 'member' ? '/settings/household' : '/settings')

  return (
    <ScreenShell
      // The index carries the identity row, so it shows no global avatar (CONFIG_SCREEN.md §1);
      // detail screens keep the standard avatar + 88px header right-padding.
      avatar={view !== 'index'}
      // …and no badge on any of them: the Notifications row states the count in words, one tap away.
      avatarBadge={false}
      header={
        <DrillInHeader
          // The member view is about someone who is usually *not* the signed-in profile, so it
          // titles itself with that person — otherwise two members' pages look identical once
          // you are on them.
          title={view === 'member' ? (member?.name ?? CONFIG_TITLES.member) : CONFIG_TITLES[view]}
          status={view === 'index' ? undefined : activeName}
          onBack={view === 'index' ? undefined : goBack}
        />
      }
    >
      <ScrollArea>
        {offline && <div className="ml-settings__offline label">Settings unavailable — reconnecting</div>}

        {view === 'index' && (
          <>
            <div className="ml-identity">
              <span className="ml-identity__avatar serif" aria-hidden="true">{activeInitial}</span>
              <div className="ml-identity__body">
                <div className="ml-identity__name serif">{activeName}</div>
                <div className="ml-identity__status">
                  <span className="ml-identity__statusdot" aria-hidden="true" />
                  {offline ? 'Signed in · Offline' : 'Signed in · Synced'}
                </div>
              </div>
              <button
                type="button"
                className="ml-identity__signout"
                onClick={async () => {
                  await signOut()
                  navigate('/lock') // signed-out landing: choose who this is / switch profile
                }}
              >
                <Icon id="ico-signout" size="1.125rem" />
                <span>Sign out</span>
              </button>
            </div>

            {/*
              One screen, six groups — not a popover and not a two-tier menu (CONFIG.md).
              Household · Devices · Lists · Thresholds · Privacy · Display. Nothing here was
              rebuilt; the rows that already existed were re-grouped under headings, and the
              sections whose tabs the consolidation removed brought their settings with them.
            */}
            <SectionLabel label="Household" />
            <div className="ml-config-index">
              <ConfigLink
                icon="ico-group"
                label="Members"
                sub="Who uses this panel"
                meta={`${profiles.length} ${profiles.length === 1 ? 'member' : 'members'}`}
                onClick={() => navigate('/settings/household')}
              />
              {/* The account avatar is the only way into Config, so this is one of the two routes
                  to notifications — the other being the drag-down drawer. */}
              <ConfigLink
                icon="ico-alert"
                label="This panel"
                sub="The notification inbox, and what is allowed to notify"
                meta={unreadNotifications > 0 ? `${unreadNotifications} waiting` : 'Nothing waiting'}
                onClick={() => navigate('/notifications')}
              />
              <ConfigLink
                icon="ico-calendar"
                label="Calendars"
                sub="Which Google calendars display"
                meta={
                  calendarsAvailable
                    ? `${selectedCalendars} of ${calendars.length}`
                    : calendarsNeedReauth
                      ? 'Needs reconnecting'
                      : 'Not connected'
                }
                onClick={() => navigate('/settings/calendars')}
              />
            </div>

            <SectionLabel label="Devices" />
            <div className="ml-config-index">
              <ConfigLink
                icon="ico-climate"
                label="Sensors"
                sub="Room readings and their history"
                onClick={() => navigate('/sensor')}
              />
              {/* Its tab no longer exists — Care has one settings surface and it is this one. The
                  meta names the cat, because that is the setting people come here to change. */}
              <ConfigLink
                icon="ico-care"
                label="Litter settings"
                sub="The cat's name, the litter, the robot's own switches"
                meta={cat.name ?? 'No name set'}
                onClick={() => navigate('/settings/devices')}
              />
              {/* Under Devices because that is where the household's *inputs* are configured, and
                  the location is what the forecast provider is asked about. The meta names the town
                  rather than the coordinates: it is the only form of the setting anybody can check
                  from the index. */}
              <ConfigLink
                icon="ico-weather"
                label="Weather location"
                sub="Which town the forecast is for"
                meta={weatherPlace ?? 'Not resolved yet'}
                onClick={() => navigate('/settings/weather')}
              />
              <ConfigLink
                icon="ico-bottle"
                label="Huckleberry"
                sub="Baby tracking, through Home Assistant"
                meta={babyHealth?.configured === false ? 'Not connected' : babyHealth?.status ?? '—'}
                onClick={() => navigate('/care?subject=conrad')}
              />
            </div>

            <SectionLabel label="Lists" />
            <div className="ml-config-index">
              <ConfigLink
                icon="ico-list"
                label="To-Do lists"
                sub="Which lists sync to the panel"
                meta={listsAvailable ? `${selectedLists} of ${taskLists.length}` : 'Not connected'}
                onClick={() => navigate('/settings/lists')}
              />
              {/* The list itself moved under Pantry, which moved under Meals. The row says where. */}
              <ConfigLink
                icon="ico-meals"
                label="Grocery list"
                sub="What the pantry is out of is what the list is for"
                meta="Under Pantry"
                onClick={() => navigate('/meals/pantry/grocery')}
              />
            </div>

            <SectionLabel label="Thresholds" />
            <div className="ml-config-index">
              <ConfigLink
                icon="ico-warning"
                label="Alert thresholds"
                sub="Freezer, humidity warnings"
                onClick={() => navigate('/settings/thresholds')}
              />
            </div>

            {/* Assist's own section, and the first thing here that is about the signed-in member
                rather than the household: which agents *they* have, and how they want to read them.
                Distinct from the per-member agent toggles under Household → a member, which are an
                admin granting access; this is the person on the panel setting up their own reading. */}
            <SectionLabel label="Assist" />
            <div className="ml-config-index">
              <ConfigLink
                icon="ico-assist"
                label="Assistant"
                sub="Your agents, and whether you see them think"
                meta={showThinking ? 'Thinking shown' : 'Answers only'}
                onClick={() => navigate('/settings/assist')}
              />
            </div>

            <SectionLabel label="Privacy" />
            <div className="ml-config-index">
              <ConfigLink
                icon="ico-lock"
                label="Privacy & Lock"
                sub="PIN, mic indicator, chat retention"
                meta={pinRequiredHere ? 'PIN on' : 'PIN off'}
                onClick={() => navigate('/settings/privacy')}
              />
              {/* The *policy* only. The records stay in the conversation, where reviewing what the
                  panel heard is a chat concern rather than a settings dig (ASSIST.md). */}
              <ConfigLink
                icon="ico-assist"
                label="Chat retention"
                sub="How long Assist keeps what it heard"
                // Three states, not two: not kept at all, kept for a window, kept indefinitely. The
                // last one used to be unreachable and now has to be sayable — "0 days" would read as
                // the first.
                meta={storeConversations ? retentionLabel(retentionDays) : 'Not kept'}
                onClick={() => navigate('/settings/privacy')}
              />
            </div>

            <SectionLabel label="Display" />
            <div className="ml-config-index">
              <ConfigLink
                icon="ico-display"
                label="Display"
                sub="Night mode, brightness, idle dimming, daylight boost"
                onClick={() => navigate('/settings/display')}
              />
            </div>
          </>
        )}

        {view === 'lists' && (
          <>
            <p className="ml-settings__intro">Choose which views and Microsoft To Do lists appear on the panel.</p>

            {/* SMART VIEWS — app-level views, not real Microsoft lists (verdigris group). */}
            <SectionLabel label="Smart Views" live />
            <div className="ml-listrows">
              <LedgerRow
                title="Today"
                sub={<span className="ml-listrow__state ml-listrow__state--caps">Due-dated items across lists</span>}
                right={<Toggle on={showToday} onChange={toggleToday} variant="live" label="Show Today tab" />}
              />
              <LedgerRow
                title="All"
                sub={<span className="ml-listrow__state ml-listrow__state--caps">Every synced list together</span>}
                right={<Toggle on={showAll} onChange={toggleAll} variant="live" label="Show All tab" />}
              />
            </div>

            {/* YOUR LISTS — the account's real Microsoft To Do lists (brass group). */}
            <SectionLabel label="Your Lists" />
            {linkResult && (
              <LedgerRow
                title={
                  <span style={{ color: linkResult === 'ok' ? 'var(--live-text)' : 'var(--danger)' }}>
                    {LINK_RESULTS[linkResult] ?? 'Linking finished with an unexpected result.'}
                  </span>
                }
              />
            )}
            {!listsAvailable && (
              <LedgerRow
                title={<span style={{ color: 'var(--text-muted)' }}>No Microsoft account linked to this profile</span>}
                sub="Sign in on the panel to sync this member's To Do lists."
                right={
                  <button type="button" className="ml-chip ml-chip--active" onClick={() => void startLink('microsoft')}>
                    Connect
                  </button>
                }
              />
            )}
            {!listsAvailable && <CallbackHint uri={callbackFor('microsoft')} />}
            {listsAvailable &&
              (taskLists.length === 0 ? (
                <LedgerRow title={<span style={{ color: 'var(--text-muted)' }}>No To Do lists on this account</span>} />
              ) : (
                <>
                  <div className="ml-settings__searchbox">
                    <Icon id="ico-search" size="1.125rem" />
                    <input
                      className="ml-settings__searchfield"
                      value={listSearch}
                      placeholder={`Search ${taskLists.length} lists`}
                      onChange={(e) => setListSearch(e.target.value)}
                    />
                  </div>
                  <div className="ml-listrows">
                    {taskLists
                      .filter((l) => l.name.toLowerCase().includes(listSearch.trim().toLowerCase()))
                      .map((l) => (
                        <LedgerRow
                          key={l.graphListId}
                          title={l.name}
                          sub={<span className="ml-listrow__state">{l.selected ? 'Syncing to the panel' : 'Not synced'}</span>}
                          right={<Toggle on={l.selected} onChange={() => toggleList(l.graphListId)} label={l.name} />}
                        />
                      ))}
                  </div>
                  <div className="ml-settings__footcount">{`${selectedLists} of ${taskLists.length} lists syncing`}</div>
                </>
              ))}
          </>
        )}

        {view === 'calendars' && (
          <>
            <p className="ml-settings__intro">
              Choose which of your Google calendars appear on the panel. Tap a mark to change it — events inherit their
              calendar’s mark unless the provider states a kind of its own.
            </p>
            {linkResult && (
              <LedgerRow
                title={
                  <span style={{ color: linkResult === 'ok' ? 'var(--live-text)' : 'var(--danger)' }}>
                    {LINK_RESULTS[linkResult] ?? 'Linking finished with an unexpected result.'}
                  </span>
                }
              />
            )}
            {markError && (
              <LedgerRow title={<span style={{ color: 'var(--danger)' }}>{markError}</span>} />
            )}
            {calendarsNeedReauth ? (
              <LedgerRow
                title={<span style={{ color: 'var(--danger)' }}>Google needs reconnecting</span>}
                sub="The account is still linked, but Google has stopped accepting it — sign in again to resume syncing. Events already on the panel are the last ones that synced."
                right={
                  <button type="button" className="ml-chip ml-chip--active" onClick={() => void startLink('google')}>
                    Reconnect
                  </button>
                }
              />
            ) : !calendarsAvailable ? (
              <LedgerRow
                title={<span style={{ color: 'var(--text-muted)' }}>No Google account linked to this profile</span>}
                sub="Sign in on the panel to sync this member's calendars."
                right={
                  <button type="button" className="ml-chip ml-chip--active" onClick={() => void startLink('google')}>
                    Connect
                  </button>
                }
              />
            ) : calendars.length === 0 ? (
              <LedgerRow title={<span style={{ color: 'var(--text-muted)' }}>No calendars on this account</span>} />
            ) : null}
            {(calendarsNeedReauth || !calendarsAvailable) && <CallbackHint uri={callbackFor('google')} />}
            {calendarsAvailable && !calendarsNeedReauth && calendars.length > 0 && (
              <>
                <div className="ml-settings__searchbox">
                  <Icon id="ico-search" size="1.125rem" />
                  <input
                    className="ml-settings__searchfield"
                    value={calendarSearch}
                    placeholder={`Search ${calendars.length} calendars`}
                    onChange={(e) => setCalendarSearch(e.target.value)}
                  />
                </div>
                <div className="ml-listrows">
                  {calendars
                    .filter((c) => c.name.toLowerCase().includes(calendarSearch.trim().toLowerCase()))
                    .map((c) => (
                      <CalendarMarkRow
                        key={c.calendarId}
                        calendar={c}
                        onPickMark={() => setMarkFor(c)}
                        onToggle={() => toggleCalendar(c.calendarId)}
                      />
                    ))}
                </div>
                <div className="ml-settings__footcount">{`${selectedCalendars} of ${calendars.length} calendars showing`}</div>
                {/* Said here because the absence is otherwise unexplainable: the household adds a
                    birthday to Google Contacts, and the panel never sees it. */}
                <div className="ml-settings__footnote">
                  Google’s contact birthdays are not served to the panel. Only birthdays saved as real events appear.
                </div>
              </>
            )}
          </>
        )}

        {view === 'privacy' && (
          <>
            {profiles.map((p) => (
              <LedgerRow
                key={p.id}
                title={`${p.name} — require PIN when idle`}
                sub={p.hasPin ? `Locks after ${timeoutMin} minutes` : 'Set a PIN to enable'}
                right={
                  <Toggle
                    on={p.requirePinWhenIdle && p.hasPin}
                    onChange={(next) => setRequirePin(p, next)}
                    label={`${p.name} require PIN when idle`}
                  />
                }
              />
            ))}
            <LedgerRow
              title="Microphone indicator"
              sub="Always shown when mic is live — cannot be disabled"
              right={<span className="ml-alwayson">Always On</span>}
            />

            {/*
              Assist's conversation *policy*, beside account privacy — and only the policy. The
              records themselves stay in the chat, where reviewing what the panel heard is a chat
              concern rather than a settings dig. That split is deliberate and unchanged (ASSIST.md).

              What changed is where the values live. They were panel-local because the transcripts
              were; both are household settings now, so the panel and a phone agree about how long
              the household keeps its own conversations.
            */}
            <SectionLabel label="Assist" />
            <LedgerRow
              title="Store chats"
              sub={storeConversations
                ? 'Chats are kept and listed in Assist'
                : 'Only the chat in front of you is kept'}
              right={
                <Toggle
                  on={storeConversations}
                  onChange={(next) => void saveConversationPolicy(next, retentionDays)}
                  label="Store chats"
                />
              }
            />
            {/*
              "Delete them after", not "Keep them for" — the row had to be renamed for NEVER to be
              readable on it. "Keep them for · never" says the opposite of what the chip does, and it
              collides with the switch directly above, which is the one that really does keep nothing.
              Read as a deletion schedule, NEVER is unambiguous and is plainly the end of the scale.
            */}
            <LedgerRow
              title="Delete them after"
              sub={retentionDays <= NEVER
                ? 'Nothing is ever dropped — chats stay until somebody deletes them'
                : 'Anything older is dropped the next time Assist reads the list'}
              right={
                <div className="ml-retention">
                  {RETENTION_OPTIONS.map((days) => (
                    <button
                      key={days}
                      type="button"
                      className={'ml-chip' + (retentionDays === days ? ' ml-chip--active' : '')}
                      disabled={!storeConversations}
                      onClick={() => void saveConversationPolicy(storeConversations, days)}
                    >
                      {retentionLabel(days)}
                    </button>
                  ))}
                </div>
              }
            />
          </>
        )}

        {/*
          ASSIST — the signed-in member's own view of their assistants.

          Deliberately not the same screen as the per-member agent toggles under Household → a member.
          Those are an admin deciding who may talk to what, and they are about somebody else; this is
          the person standing at the panel, looking at the agents they have and setting how they want
          to read them. Putting a member's own reading preference behind "edit this household member"
          would make it something you administer rather than something you choose.

          The roster is read-only here for exactly that reason. Access is granted elsewhere, and a
          member cannot hand themselves an agent from their own preferences page.
        */}
        {view === 'assist' && (
          <>
            <p className="ml-settings__intro">
              The assistants you can talk to, and how much of their work you want to see.
            </p>

            <SectionLabel label="Your agents" />
            {agents.length === 0 ? (
              <LedgerRow
                title={<span style={{ color: 'var(--text-muted)' }}>No agents yet</span>}
                sub="An admin grants these under Household — each member has at least the household agent."
              />
            ) : (
              agents.map((a) => (
                <LedgerRow
                  key={a.key}
                  title={a.name}
                  sub={a.tagline ?? 'Its own chats, memory and skills.'}
                  right={a.isDefault ? <span className="ml-configlink__meta">Opens on</span> : undefined}
                />
              ))
            )}

            <SectionLabel label="Reading" />
            <LedgerRow
              title="Show thinking"
              sub={
                showThinking
                  ? 'The working appears above each reply while it is being written'
                  : 'Only the answer is shown'
              }
              right={
                <Toggle
                  on={showThinking}
                  onChange={setShowThinking}
                  label="Show the agent's thinking"
                />
              }
            />
            {/*
              Three limitations, said rather than discovered. Each of them is something a household
              would otherwise conclude was a bug: nothing appeared, it disappeared, or it appeared on
              one device and not another.
            */}
            <div className="ml-settings__footnote">
              Thinking is the model's working — what it considers on the way to an answer, including
              things it decides against. It is shown while a reply is being written and is never kept:
              the transcript holds what the agent said, not what it thought. Not every agent produces
              any, so some will show none at all. This is a preference for this device, so the panel
              and a phone can be set differently.
            </div>
          </>
        )}

        {/*
          WEATHER — where the forecast is for.

          This used to be `Weather:Latitude` / `Weather:Longitude` in the environment and nowhere
          else, which made the most local fact in the whole product — which town the household lives
          in — the one thing they could not change without editing a file on the server and restarting
          it. A panel that moves house had no way to say so.

          Two number fields is an honest interface here rather than a lazy one. There is no key-free
          geocoder to type a town into, and adding one would put a third-party lookup between the
          household and their own address; NWS takes coordinates and nothing else. What makes the
          fields usable is the line under them: the panel reports the town *the forecast provider*
          resolved, so a mistyped digit shows up as the wrong town rather than as a forecast that is
          quietly for somewhere else.
        */}
        {view === 'weather' && (
          <>
            <p className="ml-settings__intro">
              The forecast, the week ahead and any severe-weather alerts are all for this point.
            </p>

            <SectionLabel label="Now showing" />
            <LedgerRow
              title={weatherLocation?.place ?? 'Not resolved yet'}
              sub={
                !weatherLocation
                  ? 'Reading…'
                  : weatherLocation.place
                    ? weatherLocation.fromHousehold
                      ? 'The location this household set'
                      : 'From this panel’s configuration — nobody has set one here'
                    : 'The next refresh will name it. Weather updates every few minutes.'
              }
              right={
                weatherLocation && (
                  <span className="ml-configlink__meta">
                    {`${weatherLocation.latitude.toFixed(4)}, ${weatherLocation.longitude.toFixed(4)}`}
                  </span>
                )
              }
            />

            <SectionLabel label="Move it" />
            <LedgerRow
              title="Latitude"
              sub="Between −90 and 90"
              right={
                <input
                  className="ml-settings__coord"
                  type="text"
                  inputMode="decimal"
                  value={latField}
                  placeholder="44.98"
                  onChange={(e) => { setLatField(e.target.value); setWeatherError(null) }}
                  aria-label="Latitude"
                />
              }
            />
            <LedgerRow
              title="Longitude"
              sub="Between −180 and 180"
              right={
                <input
                  className="ml-settings__coord"
                  type="text"
                  inputMode="decimal"
                  value={lonField}
                  placeholder="-93.27"
                  onChange={(e) => { setLonField(e.target.value); setWeatherError(null) }}
                  aria-label="Longitude"
                />
              }
            />
            {weatherError && <div className="ml-settings__offline label">{weatherError}</div>}
            <LedgerRow
              right={
                <div className="ml-rowactions">
                  <button
                    type="button"
                    className="ml-chip ml-chip--active"
                    onClick={() => void saveWeatherLocation()}
                    disabled={weatherSaving}
                  >
                    {weatherSaving ? 'Saving…' : 'Save'}
                  </button>
                  {/* Only when there is a household answer to give back. Offering to clear a setting
                      nobody made is a control whose every outcome is the state you are already in. */}
                  {weatherLocation?.fromHousehold && (
                    <button
                      type="button"
                      className="ml-linkbtn"
                      onClick={() => void clearWeatherLocation()}
                      disabled={weatherSaving}
                    >
                      Use the configured location
                    </button>
                  )}
                </div>
              }
            />
            <div className="ml-settings__footnote">
              Saving clears the cached forecast, so the panel shows “Loading weather…” until the next
              refresh — a few minutes at most. That is deliberate: the old town’s conditions under the
              new town’s name would be worse than a gap. Coordinates come from any map — long-press a
              spot and read them off. The National Weather Service covers the United States only.
            </div>
          </>
        )}

        {view === 'thresholds' && (
          <>
            {thresholds.map((t) => {
              const unit = t.metric === 'Temperature' ? '°' : '%'
              return (
                <LedgerRow
                  key={t.id}
                  title={`${t.zoneName} — ${t.metric.toLowerCase()} ${t.direction.toLowerCase()}`}
                  sub={t.severity === 'Severe' ? 'Severe alert' : 'Warning alert'}
                  right={
                    <div className="ml-threshold">
                      <Stepper direction="minus" onStep={() => editThreshold(t.id, { value: t.value - 1 })} label={`Lower ${t.zoneName} threshold`} />
                      <span className="ml-threshold__value serif">{`${Math.round(t.value)}${unit}`}</span>
                      <Stepper direction="plus" onStep={() => editThreshold(t.id, { value: t.value + 1 })} label={`Raise ${t.zoneName} threshold`} />
                    </div>
                  }
                />
              )
            })}
            {thresholds.length > 0 && (
              <LedgerRow
                title="Alert delay"
                sub="Breach must persist this long before alerting"
                right={
                  <div className="ml-threshold">
                    <Stepper direction="minus" onStep={() => setSharedDelay(sharedDelay - 1)} label="Shorten alert delay" />
                    <span className="ml-threshold__value serif">{`${sharedDelay}m`}</span>
                    <Stepper direction="plus" onStep={() => setSharedDelay(sharedDelay + 1)} label="Lengthen alert delay" />
                  </div>
                }
              />
            )}
          </>
        )}

        {view === 'display' && (
          <>
            <LedgerRow
              title="Night dimming"
              sub={dimming ? `Panel dims from ${nightStart} to ${nightEnd}` : 'Panel never dims by itself'}
              right={<Toggle on={dimming} onChange={setDimming} label="Night dimming" />}
            />
            {/* The window itself, shown only when it governs anything. Two plain time fields: this
                is a pair of wall-clock times and every device this panel runs on already has a
                control for that, one that respects 12/24-hour locale without us reimplementing it. */}
            {dimming && (
              <LedgerRow
                title="Dims between"
                sub={
                  nightStart === nightEnd
                    ? 'Same start and end — nothing dims. Set them apart.'
                    : 'Crossing midnight is normal — 21:00 to 07:00'
                }
                right={
                  <div className="ml-nightwindow">
                    <input
                      type="time"
                      className="ml-nightwindow__time"
                      aria-label="Dimming starts"
                      value={nightStart}
                      onChange={(e) => setNightStart(e.target.value)}
                    />
                    <span className="ml-nightwindow__sep" aria-hidden="true">–</span>
                    <input
                      type="time"
                      className="ml-nightwindow__time"
                      aria-label="Dimming ends"
                      value={nightEnd}
                      onChange={(e) => setNightEnd(e.target.value)}
                    />
                  </div>
                }
              />
            )}
            {/*
              The override, and why it is not simply the toggle above.

              Turning the schedule off to read something at eleven at night is a decision that
              outlives the reading: the panel then never dims again and nobody remembers why. This
              argues with tonight only — it lapses when the window next opens or closes, and the
              row says when that is rather than leaving it to be discovered.
            */}
            <LedgerRow
              title={night.dimmed ? 'Brighten it now' : 'Dim it now'}
              sub={
                night.overridden
                  ? night.overrideUntil
                    ? `Just for now — the schedule takes over at ${toClock(night.overrideUntil)}`
                    : 'Holding until you change it — no schedule to hand back to'
                  : 'Just for now. The schedule keeps running.'
              }
              right={
                <div className="ml-daylight">
                  <button
                    type="button"
                    className="ml-chip"
                    onClick={() => night.setOverride(!night.dimmed)}
                  >
                    {night.dimmed ? 'brighten' : 'dim'}
                  </button>
                  {night.overridden && (
                    <button type="button" className="ml-chip" onClick={night.clearOverride}>
                      release
                    </button>
                  )}
                </div>
              }
            />
            {/* This used to read RETURN TO DASHBOARD, and the panel used to do that. It no longer
                does — going quiet is not a request to go somewhere else (`useIdleReset`) — so the
                only thing the timeout still governs is the PIN lock, and the row says so. The `sub`
                names the condition rather than hiding the row when nobody has a PIN: a stepper that
                appears and disappears with a setting on another screen is harder to find than one
                that explains itself. */}
            <LedgerRow
              title="Lock when idle"
              sub="How long the panel waits before locking, for members who set a PIN"
              right={
                <div className="ml-threshold">
                  <Stepper direction="minus" onStep={() => setTimeoutMin(Math.max(1, timeoutMin - 1))} label="Shorter idle timeout" />
                  <span className="ml-threshold__value serif">{`${timeoutMin}m`}</span>
                  <Stepper direction="plus" onStep={() => setTimeoutMin(timeoutMin + 1)} label="Longer idle timeout" />
                </div>
              }
            />
            <LedgerRow
              title="Daylight boost"
              sub="Brightens text under daytime glare"
              right={
                <div className="ml-daylight">
                  {DAYLIGHT_MODES.map((m) => (
                    <button key={m} type="button" className={'ml-chip' + (daylight === m ? ' ml-chip--active' : '')} onClick={() => setDaylight(m)}>
                      {m}
                    </button>
                  ))}
                </div>
              }
            />
          </>
        )}

        {view === 'household' && (
          <>
            {profiles.map((p) => (
              <LedgerRow key={p.id}>
                <span className={'ml-memberavatar' + (p.id === activeId ? ' ml-memberavatar--owner' : '')} aria-hidden="true">
                  {p.initial}
                </span>
                <div className="ml-row__main">
                  {renamingId === p.id ? (
                    <input
                      className="ml-input"
                      value={nameDraft}
                      autoFocus
                      onChange={(e) => setNameDraft(e.target.value)}
                      onBlur={() => commitRename(p)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename(p)
                        if (e.key === 'Escape') setRenamingId(null)
                      }}
                    />
                  ) : (
                    <button type="button" className="ml-linkname" onClick={() => { setRenamingId(p.id); setNameDraft(p.name) }}>
                      {p.name}
                    </button>
                  )}
                  <div className="ml-row__sub">{roleLabel(p, activeId)}</div>
                  {/* Role and age band (A1). Age band is not a privilege — it is who the
                      assistant thinks it is talking to, which is why it is set here beside the
                      person rather than buried in the assistant's own settings. */}
                  <div className="ml-memberfacets">
                    <div className="ml-memberfacets__group" role="group" aria-label={`${p.name}'s household role`}>
                      {PROFILE_ROLES.map((r) => (
                        <button
                          key={r}
                          type="button"
                          className={'ml-chip' + (p.role === r ? ' ml-chip--active' : '')}
                          aria-pressed={p.role === r}
                          onClick={() => setProfileFacet(p, { role: r })}
                        >
                          {r}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="ml-row__right">
                  <div className="ml-rowactions">
                    {p.hasPin && (
                      <button type="button" className="ml-linkbtn" onClick={() => clearPin(p.id)}>
                        Clear PIN
                      </button>
                    )}
                    {/* Accounts drill-in. Its own control rather than making the whole row tappable:
                        the row's name is already a rename button, so a row-level tap would have to
                        fight it. */}
                    <button
                      type="button"
                      className="ml-linkbtn"
                      onClick={() => navigate(`/settings/member?profile=${p.id}`)}
                      aria-label={`${p.name}'s accounts`}
                    >
                      Accounts ▸
                    </button>
                    <button type="button" className="ml-linkbtn ml-linkbtn--danger" onClick={() => removeProfile(p.id)} aria-label={`Remove ${p.name}`}>
                      ×
                    </button>
                  </div>
                </div>
              </LedgerRow>
            ))}
            <LedgerRow title={<span className="ml-linkadd">＋ Add member</span>} onClick={addProfile} />
          </>
        )}

        {view === 'member' && (
          <>
            {member == null ? (
              <LedgerRow title={<span style={{ color: 'var(--text-muted)' }}>No member selected</span>} />
            ) : (
              <>
                <p className="ml-settings__intro">
                  {member.name}’s connected accounts. Consent happens on the provider’s own sign-in page, so{' '}
                  {member.name} signs in themselves — hand them the panel, or open this page from their phone at
                  the panel’s address.
                </p>
                {linkResult && (
                  <LedgerRow
                    title={
                      <span style={{ color: linkResult === 'ok' ? 'var(--live-text)' : 'var(--danger)' }}>
                        {LINK_RESULTS[linkResult] ?? 'Linking finished with an unexpected result.'}
                      </span>
                    }
                  />
                )}
                {!memberLinksLoaded ? (
                  <LedgerRow title={<span style={{ color: 'var(--text-muted)' }}>Checking…</span>} />
                ) : memberLinks.length === 0 ? (
                  <LedgerRow
                    title={<span style={{ color: 'var(--text-muted)' }}>Account linking is unavailable</span>}
                    sub="The panel has no database configured, so links cannot be stored."
                  />
                ) : (
                  memberLinks.map((s) => (
                    <LedgerRow
                      key={s.provider}
                      title={s.provider === 'google' ? 'Google' : 'Microsoft'}
                      sub={
                        !s.configured
                          ? 'Not configured on this panel — its client id and secret are missing.'
                          : s.linked
                            ? s.provider === 'google'
                              ? 'Linked — calendars sync for this member.'
                              : 'Linked — To Do lists sync for this member.'
                            : 'Not linked.'
                      }
                      right={
                        s.configured ? (
                          <div className="ml-rowactions">
                            <button
                              type="button"
                              className="ml-chip ml-chip--active"
                              onClick={() => void startMemberLink(s.provider, member.id)}
                            >
                              {s.linked ? 'Reconnect' : 'Connect'}
                            </button>
                            {s.linked && (
                              <button
                                type="button"
                                className="ml-linkbtn ml-linkbtn--danger"
                                onClick={() => void unlinkMember(s.provider, member.id)}
                              >
                                Unlink
                              </button>
                            )}
                          </div>
                        ) : undefined
                      }
                    />
                  ))
                )}
                {memberLinks.some((s) => s.configured && !s.linked) && (
                  <CallbackHint uri={memberLinks.find((s) => s.configured && !s.linked)?.redirectUri ?? null} />
                )}
                {/*
                  Which agents this member may talk to. A toggle each, and the household agent is
                  fixed on: a member with no agent would have an Assist tab that cannot do anything,
                  and there is no useful screen to draw for that.

                  Absence is not access — an agent added to `Ai:Agents` reaches nobody until somebody
                  turns it on here.
                */}
                <SectionLabel label="Assist agents" />
                {!agentsLoaded ? (
                  <LedgerRow title={<span style={{ color: 'var(--text-muted)' }}>Checking…</span>} />
                ) : agentAssignments.length === 0 ? (
                  <LedgerRow
                    title={<span style={{ color: 'var(--text-muted)' }}>No agents are configured</span>}
                    sub="Add one under Ai:Agents in the panel's configuration."
                  />
                ) : (
                  <>
                    {agentAssignments.map((a) => (
                      <LedgerRow
                        key={a.key}
                        title={a.name}
                        sub={
                          a.isHouseholdAgent
                            ? `${a.tagline ?? 'Household agent'} — everyone has this one`
                            : !a.configured
                              ? 'Not configured on this panel — it has no endpoint or key yet.'
                              : (a.tagline ?? 'Its own chats, memory and skills.')
                        }
                        right={
                          a.isHouseholdAgent ? (
                            <span className="ml-alwayson">Always On</span>
                          ) : (
                            <Toggle
                              on={a.assigned}
                              onChange={(next) => void toggleAgent(member.id, a.key, next)}
                              label={`${a.name} for ${member.name}`}
                            />
                          )
                        }
                      />
                    ))}

                    {/*
                      Which one Assist opens on, for a member who has more than one.

                      Absent below two, and that is not tidiness — with one agent there is nothing to
                      choose between, so a picker there would be a control whose every option is the
                      state you are already in. It appears the moment a second agent is switched on
                      above, which is also the moment the question first exists.

                      Separate from the toggles rather than a third state on them: having an agent and
                      preferring it are different decisions, and a tri-state toggle would make turning
                      one *off* and making it *first* the same control.
                    */}
                    {agentAssignments.filter((a) => a.assigned).length > 1 && (
                      <LedgerRow
                        title="Opens on"
                        sub={`Which agent Assist starts on for ${member.name}. The others stay one tap away in the switcher.`}
                        right={
                          <div className="ml-retention">
                            {agentAssignments.filter((a) => a.assigned).map((a) => (
                              <button
                                key={a.key}
                                type="button"
                                className={'ml-chip' + (a.isMemberDefault ? ' ml-chip--active' : '')}
                                onClick={() => void setDefaultAgent(member.id, a.key)}
                              >
                                {a.name}
                              </button>
                            ))}
                          </div>
                        }
                      />
                    )}
                  </>
                )}
                <div className="ml-settings__footnote">
                  Each agent keeps its own chats, memory and skills, so switching agents in Assist
                  switches the whole list. Turning one off here leaves {member.name}’s chats with
                  it in place — it removes access, not history.
                  {/* Said only when there is nothing to assign. A household looking at a single
                      ALWAYS ON row has no way to tell whether that is all there is or whether they
                      are missing a step — and the answer is a config file, which is not a place this
                      screen can send them to without saying so. */}
                  {agentsLoaded && agentAssignments.length === 1 && (
                    <>
                      {' '}This panel has one agent configured. More are added under <code>Ai:Agents</code> in the
                      panel’s configuration — each needs its own Hermes endpoint and key — and they appear here as
                      toggles once the panel restarts.
                    </>
                  )}
                </div>

                {/* Said plainly because it is the next thing anyone tries: linking is per-member here,
                    but choosing *which* of their calendars or lists display is still done from the
                    signed-in profile's own Calendars / To-Do Lists pages. */}
                <div className="ml-settings__footnote">
                  Linking is done here for any member. Choosing which of their calendars and lists appear on the
                  panel is still done from Calendars and To-Do Lists while signed in as {member.name}.
                </div>
              </>
            )}
          </>
        )}
      </ScrollArea>
    </ScreenShell>
  )
}

/**
 * A CONFIG index row: leading icon + label + sub, optional right-meta, and a ▸ drill-in chevron.
 *
 * **There is no MOVED marker.** It carried a `moved` flag through the consolidation, which put a
 * small brass `MOVED` chip beside four labels — the settings whose own tabs had gone. That was always
 * a one-release notice, on the reasoning written down with it: a household that has been opening the
 * same settings for a year needs telling once that they are somewhere else now, and a marker that
 * never goes away stops being a notice and becomes decoration. The release has been; it has been
 * removed rather than left to age into furniture. **Do not add it back for the next move** — a
 * permanent "this is new" vocabulary is how a settings index ends up covered in badges nobody reads.
 */
function ConfigLink({
  icon, label, sub, meta, onClick,
}: {
  icon: IconId
  label: string
  sub: string
  meta?: string
  onClick: () => void
}) {
  return (
    <LedgerRow onClick={onClick}>
      <span className="ml-configlink__icon" aria-hidden="true"><Icon id={icon} size="1.375rem" /></span>
      <div className="ml-row__main">
        <div className="ml-configlink__title">{label}</div>
        <div className="ml-listrow__state">{sub}</div>
      </div>
      <span className="ml-configlink__right">
        {meta && <span className="ml-configlink__meta">{meta}</span>}
        <span className="ml-configlink__chevron" aria-hidden="true">▸</span>
      </span>
    </LedgerRow>
  )
}

/**
 * A calendar in CONFIG: mark box on the left, sync toggle on the right (spec 14 amends 07). The
 * meta line names the mark, and says when the event kind will override it anyway.
 */
function CalendarMarkRow({
  calendar,
  onPickMark,
  onToggle,
}: {
  calendar: SyncCalendarDto
  onPickMark: () => void
  onToggle: () => void
}) {
  const mark = markDefinition(calendar.icon)
  const meta = [
    mark ? `Mark · ${mark.label}` : 'No mark · Events show a plain rule',
    calendar.selected ? null : 'Hidden',
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <LedgerRow>
      <MarkBox mark={mark} onClick={onPickMark} label={calendar.name} />
      <div className="ml-row__main">
        <div className="ml-row__title">{calendar.name}</div>
        <div className="ml-listrow__state ml-listrow__state--caps">{meta}</div>
      </div>
      <div className="ml-row__right">
        <Toggle on={calendar.selected} onChange={onToggle} label={calendar.name} />
      </div>
    </LedgerRow>
  )
}

/**
 * Household sub-label. Reads the real `role` column rather than inferring it: this used to say
 * "Owner" for whoever was signed in and "Adult" for everyone else, both of which were guesses the
 * panel had no way to be right about.
 */
function roleLabel(p: ProfileDto, activeId: number | null): string {
  const parts: string[] = [p.role]
  if (p.id === activeId) parts.push('Signed in')
  parts.push(p.hasPin ? 'PIN set' : 'No PIN')
  return parts.join(' · ')
}

/** Two-step PIN capture reusing the shared deco keypad. */
function SetPinFlow({
  profile,
  onCancel,
  onDone,
}: {
  profile: ProfileDto
  onCancel: () => void
  onDone: () => void
}) {
  const [step, setStep] = useState<'enter' | 'confirm'>('enter')
  const [first, setFirst] = useState('')
  const [digits, setDigits] = useState('')
  const [shake, setShake] = useState(false)
  const [error, setError] = useState('')

  const press = useCallback((d: string) => setDigits((c) => (c.length >= PIN_LENGTH ? c : c + d)), [])
  const backspace = useCallback(() => setDigits((c) => c.slice(0, -1)), [])
  const clear = useCallback(() => setDigits(''), [])

  useEffect(() => {
    if (digits.length !== PIN_LENGTH) return
    if (step === 'enter') {
      setFirst(digits)
      setDigits('')
      setError('')
      setStep('confirm')
      return
    }
    // confirm
    if (digits === first) {
      ;(async () => {
        try {
          await api.setPin(profile.id, digits)
          onDone()
        } catch (err) {
          if (err instanceof ApiError) {
            setError('Could not save PIN')
            setStep('enter')
            setFirst('')
          } else throw err
        }
      })()
    } else {
      setShake(true)
      setError('PINs did not match')
      window.setTimeout(() => setShake(false), 400)
      setStep('enter')
      setFirst('')
    }
    setDigits('')
  }, [digits, step, first, profile.id, onDone])

  return (
    <ScreenShell
      header={<DrillInHeader title="Set PIN" status={profile.name} onBack={onCancel} />}
      nav={false}
    >
      <div className={'ml-lock' + (shake ? ' ml-lock--shake' : '')}>
        <div className="ml-lock__labelrow">
          <span className="label ml-lock__who">
            {step === 'enter' ? `New PIN for ${profile.name}` : 'Confirm PIN'}
          </span>
          {error && <span className="ml-lock__hint">{error.toUpperCase()}</span>}
        </div>
        <div className="ml-lock__entry">
          <PinPad digits={digits} length={PIN_LENGTH} onPress={press} onBackspace={backspace} onClear={clear} />
        </div>
        <div className="ml-lock__footer">
          <span className="ml-lock__footer-note" />
          <button type="button" className="ml-lock__settings" onClick={onCancel}>
            CANCEL
          </button>
        </div>
      </div>
    </ScreenShell>
  )
}
