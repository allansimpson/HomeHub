import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
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
import { useSession } from '../app/SessionProvider'
import { useSensors } from '../app/SensorsProvider'
import { api, ApiError } from '../api/client'
import type { ProfileDto, ThresholdDto } from '../api/types'

const PIN_LENGTH = 4

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
  const { profiles, settings, refresh, offline } = useSession()

  const { refresh: refreshSensors } = useSensors()

  // Local editable copy of household settings, kept in sync when the session reloads.
  const [dimming, setDimming] = useState(true)
  const [timeoutMin, setTimeoutMin] = useState(5)

  useEffect(() => {
    if (!settings) return
    setDimming(settings.idleDimmingEnabled)
    setTimeoutMin(settings.idleTimeoutMinutes)
  }, [settings])

  // Debounced persist for the toggle/timeout settings (steppers repeat on long-press).
  useEffect(() => {
    if (!settings) return
    const unchanged = dimming === settings.idleDimmingEnabled && timeoutMin === settings.idleTimeoutMinutes
    if (unchanged) return
    const t = window.setTimeout(async () => {
      try {
        await api.updateSettings({ idleTimeoutMinutes: timeoutMin, idleDimmingEnabled: dimming })
        await refresh()
      } catch (err) {
        if (!(err instanceof ApiError)) throw err
      }
    }, 400)
    return () => window.clearTimeout(t)
  }, [dimming, timeoutMin, settings, refresh])

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

  return (
    <ScreenShell header={<DrillInHeader title="Settings" status="Household" onBack={() => navigate(-1)} />}>
      <ScrollArea>
        {offline && (
          <div className="ml-settings__offline label">Settings unavailable — reconnecting</div>
        )}

        {/* ---- Active profile / switcher ---- */}
        <SectionLabel label="Active Profile" />
        <LedgerRow
          title={session_activeName(profiles, settings?.activeProfileId ?? null)}
          sub="Switch the active household member"
          right={<span className="ml-linkbtn">Switch ▸</span>}
          onClick={() => navigate('/lock')}
        />

        {/* ---- Privacy & lock ---- */}
        <SectionLabel label="Privacy & Lock" />
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

        {/* ---- Alert thresholds (drive the engine) ---- */}
        <SectionLabel label="Alert Thresholds" />
        {thresholds.map((t) => {
          const unit = t.metric === 'Temperature' ? '°' : '%'
          const step = 1
          return (
            <LedgerRow
              key={t.id}
              title={`${t.zoneName} — ${t.metric.toLowerCase()} ${t.direction.toLowerCase()}`}
              sub={t.severity === 'Severe' ? 'Severe alert' : 'Warning alert'}
              right={
                <div className="ml-threshold">
                  <Stepper
                    direction="minus"
                    onStep={() => editThreshold(t.id, { value: t.value - step })}
                    label={`Lower ${t.zoneName} threshold`}
                  />
                  <span className="ml-threshold__value serif">{`${Math.round(t.value)}${unit}`}</span>
                  <Stepper
                    direction="plus"
                    onStep={() => editThreshold(t.id, { value: t.value + step })}
                    label={`Raise ${t.zoneName} threshold`}
                  />
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
                <Stepper
                  direction="minus"
                  onStep={() => setSharedDelay(sharedDelay - 1)}
                  label="Shorten alert delay"
                />
                <span className="ml-threshold__value serif">{`${sharedDelay}m`}</span>
                <Stepper direction="plus" onStep={() => setSharedDelay(sharedDelay + 1)} label="Lengthen alert delay" />
              </div>
            }
          />
        )}

        {/* ---- Idle dimming ---- */}
        <SectionLabel label="Display" />
        <LedgerRow
          title="Idle dimming"
          sub="Dashboard dims to 40% after 10 PM"
          right={<Toggle on={dimming} onChange={setDimming} label="Idle dimming" />}
        />

        {/* ---- Household management ---- */}
        <SectionLabel label="Household" status={`${profiles.length} ${profiles.length === 1 ? 'member' : 'members'}`} />
        {profiles.map((p) => (
          <LedgerRow
            key={p.id}
            title={
              renamingId === p.id ? (
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
                <button
                  type="button"
                  className="ml-linkname"
                  onClick={() => {
                    setRenamingId(p.id)
                    setNameDraft(p.name)
                  }}
                >
                  {p.name}
                </button>
              )
            }
            sub={p.hasPin ? 'PIN set' : 'No PIN'}
            right={
              <div className="ml-rowactions">
                {p.hasPin && (
                  <button type="button" className="ml-linkbtn" onClick={() => clearPin(p.id)}>
                    Clear PIN
                  </button>
                )}
                <button
                  type="button"
                  className="ml-linkbtn ml-linkbtn--danger"
                  onClick={() => removeProfile(p.id)}
                  aria-label={`Remove ${p.name}`}
                >
                  ×
                </button>
              </div>
            }
          />
        ))}
        <LedgerRow title={<span className="ml-linkadd">＋ Add profile</span>} onClick={addProfile} />
      </ScrollArea>
    </ScreenShell>
  )
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
