import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  DrillInHeader,
  ScreenShell,
  ScrollArea,
  SectionLabel,
  LedgerRow,
  Toggle,
  Stepper,
  PinPad,
} from '../components'
import { Icon } from '../icons/Icon'
import type { IconId } from '../icons/Icon'
import { useSession } from '../app/SessionProvider'
import { useSensors } from '../app/SensorsProvider'
import { useTasks } from '../app/TasksProvider'
import { useCalendar } from '../app/CalendarProvider'
import { getShowToday, getShowAll, setShowToday, setShowAll } from '../app/todoPrefs'
import { api, ApiError } from '../api/client'
import type { ProfileDto, ThresholdDto, DaylightBoostMode, SyncListDto, SyncCalendarDto } from '../api/types'

const DAYLIGHT_MODES: DaylightBoostMode[] = ['auto', 'on', 'off']

const PIN_LENGTH = 4

/** CONFIG is an index of category rows that drill into detail views (spec 07). */
type ConfigView = 'index' | 'lists' | 'calendars' | 'privacy' | 'thresholds' | 'display' | 'household'
const CONFIG_TITLES: Record<ConfigView, string> = {
  index: 'Config',
  lists: 'To-Do Lists',
  calendars: 'Calendars',
  privacy: 'Privacy & Lock',
  thresholds: 'Alert Thresholds',
  display: 'Display',
  household: 'Household',
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
  const view = asConfigView(section)
  const { profiles, settings, refresh, offline, signOut } = useSession()

  const { refresh: refreshSensors } = useSensors()
  const { refresh: refreshTasks } = useTasks()
  const { refresh: refreshCalendar } = useCalendar()

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
        }
      } catch (err) {
        if (!cancelled) setCalendarsAvailable(false)
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
  const goBack = () => navigate('/settings')

  return (
    <ScreenShell
      // The index carries the identity row, so it shows no global avatar (CONFIG_SCREEN.md §1);
      // detail screens keep the standard avatar + 88px header right-padding.
      avatar={view !== 'index'}
      header={
        <DrillInHeader
          title={CONFIG_TITLES[view]}
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
                meta={calendarsAvailable ? `${selectedCalendars} of ${calendars.length}` : 'Not connected'}
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
            <p className="ml-settings__intro">Choose which of your Google calendars appear on the panel.</p>
            {!calendarsAvailable ? (
              <LedgerRow title={<span style={{ color: 'var(--text-muted)' }}>No Google account linked to this profile</span>} />
            ) : calendars.length === 0 ? (
              <LedgerRow title={<span style={{ color: 'var(--text-muted)' }}>No calendars on this account</span>} />
            ) : (
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
                      <LedgerRow
                        key={c.calendarId}
                        title={c.name}
                        sub={<span className="ml-listrow__state">{c.selected ? 'Showing on the panel' : 'Hidden'}</span>}
                        right={<Toggle on={c.selected} onChange={() => toggleCalendar(c.calendarId)} label={c.name} />}
                      />
                    ))}
                </div>
                <div className="ml-settings__footcount">{`${selectedCalendars} of ${calendars.length} calendars showing`}</div>
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
