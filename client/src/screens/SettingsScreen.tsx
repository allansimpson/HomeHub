import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
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
import { api, ApiError } from '../api/client'
import type { ProfileDto, ThresholdDto, DaylightBoostMode, SyncListDto, SyncCalendarDto, LinkStatusDto } from '../api/types'
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

const PIN_LENGTH = 4

/** CONFIG is an index of category rows that drill into detail views (spec 07). */
type ConfigView = 'index' | 'lists' | 'calendars' | 'privacy' | 'thresholds' | 'display' | 'household' | 'member'
const CONFIG_TITLES: Record<ConfigView, string> = {
  index: 'Config',
  lists: 'To-Do Lists',
  calendars: 'Calendars',
  privacy: 'Privacy & Lock',
  thresholds: 'Alert Thresholds',
  display: 'Display',
  household: 'Household',
  member: 'Member',
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

  // Local editable copy of household settings, kept in sync when the session reloads.
  const [dimming, setDimming] = useState(true)
  const [timeoutMin, setTimeoutMin] = useState(5)
  const [daylight, setDaylight] = useState<DaylightBoostMode>('auto')

  useEffect(() => {
    if (!settings) return
    setDimming(settings.idleDimmingEnabled)
    setTimeoutMin(settings.idleTimeoutMinutes)
    setDaylight(settings.daylightBoost)
  }, [settings])

  // Debounced persist for the toggle/timeout/daylight settings (steppers repeat on long-press).
  useEffect(() => {
    if (!settings) return
    const unchanged =
      dimming === settings.idleDimmingEnabled &&
      timeoutMin === settings.idleTimeoutMinutes &&
      daylight === settings.daylightBoost
    if (unchanged) return
    const t = window.setTimeout(async () => {
      try {
        await api.updateSettings({ idleTimeoutMinutes: timeoutMin, idleDimmingEnabled: dimming, daylightBoost: daylight })
        await refresh()
      } catch (err) {
        if (!(err instanceof ApiError)) throw err
      }
    }, 400)
    return () => window.clearTimeout(t)
  }, [dimming, timeoutMin, daylight, settings, refresh])

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

            <div className="ml-config-index">
              {/* First row: the account avatar is the only way into Config, so this is one of the
                  two routes to notifications — the other being the drag-down drawer. */}
              <ConfigLink
                icon="ico-bell"
                label="Notifications"
                sub="The inbox, and what is allowed to notify"
                meta={unreadNotifications > 0 ? `${unreadNotifications} waiting` : 'Nothing waiting'}
                onClick={() => navigate('/notifications')}
              />
              <ConfigLink
                icon="ico-list"
                label="To-Do lists"
                sub="Which lists sync to the panel"
                meta={listsAvailable ? `${selectedLists} of ${taskLists.length}` : 'Not connected'}
                onClick={() => navigate('/settings/lists')}
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
              <ConfigLink
                icon="ico-lock"
                label="Privacy & Lock"
                sub="PIN, mic indicator"
                meta={pinRequiredHere ? 'PIN on' : 'PIN off'}
                onClick={() => navigate('/settings/privacy')}
              />
              <ConfigLink icon="ico-warning" label="Alert thresholds" sub="Freezer, humidity warnings" onClick={() => navigate('/settings/thresholds')} />
              <ConfigLink icon="ico-display" label="Display" sub="Idle dimming, daylight boost" onClick={() => navigate('/settings/display')} />
              <ConfigLink
                icon="ico-group"
                label="Household"
                sub="Members & profiles"
                meta={`${profiles.length} ${profiles.length === 1 ? 'member' : 'members'}`}
                onClick={() => navigate('/settings/household')}
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
              title="Idle dimming"
              sub="Dashboard dims to 40% after 10 PM"
              right={<Toggle on={dimming} onChange={setDimming} label="Idle dimming" />}
            />
            <LedgerRow
              title="Return to dashboard"
              sub="Idle timeout before returning home"
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

/** A CONFIG index row: leading icon + label + sub, optional right-meta, and a ▸ drill-in chevron. */
function ConfigLink({ icon, label, sub, meta, onClick }: { icon: IconId; label: string; sub: string; meta?: string; onClick: () => void }) {
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

/** Household role sub-label: the signed-in member is the owner; others adults (spec 07 household). */
function roleLabel(p: ProfileDto, activeId: number | null): string {
  const role = p.id === activeId ? 'Owner · Signed in' : 'Adult'
  return p.hasPin ? `${role} · PIN set` : `${role} · No PIN`
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
