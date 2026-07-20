import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { DashboardHeader, ScreenShell, PinPad } from '../components'
import { useClock } from '../app/useClock'
import { useSession } from '../app/SessionProvider'
import { api, ApiError } from '../api/client'

const PIN_LENGTH = 4

/**
 * Conditional per-profile Lock / PIN screen (spec 06). Profile tiles + 4-digit deco keypad,
 * wrong-PIN shake + clear, footer showing who stays signed in. No bottom nav. Only reached for
 * profiles that opted into a PIN; tapping a PIN-less profile signs straight in.
 */
export function LockScreen() {
  const navigate = useNavigate()
  const { time, date } = useClock()
  const { profiles, activeProfileId, completeUnlock } = useSession()

  // Profiles that can be selected here; those without a PIN sign in immediately on tap.
  const lockable = profiles.filter((p) => p.requirePinWhenIdle && p.hasPin)
  const initialId = lockable.some((p) => p.id === activeProfileId)
    ? activeProfileId
    : (lockable[0]?.id ?? null)

  const [selectedId, setSelectedId] = useState<number | null>(initialId)
  const [digits, setDigits] = useState('')
  const [shake, setShake] = useState(false)
  const [lockedFor, setLockedFor] = useState<number | null>(null)
  const verifyingRef = useRef(false)

  const selected = profiles.find((p) => p.id === selectedId) ?? null
  const stayNames = profiles.filter((p) => !p.requirePinWhenIdle || !p.hasPin).map((p) => p.name)

  const selectProfile = useCallback(
    (id: number) => {
      const p = profiles.find((x) => x.id === id)
      if (!p) return
      if (!p.requirePinWhenIdle || !p.hasPin) {
        // No lock on this profile — sign straight in.
        void completeUnlock(id).then(() => navigate('/'))
        return
      }
      setSelectedId(id)
      setDigits('')
      setLockedFor(null)
    },
    [profiles, completeUnlock, navigate],
  )

  const press = useCallback(
    (d: string) => {
      if (verifyingRef.current || lockedFor) return
      setDigits((cur) => (cur.length >= PIN_LENGTH ? cur : cur + d))
    },
    [lockedFor],
  )

  const backspace = useCallback(() => setDigits((cur) => cur.slice(0, -1)), [])
  const clear = useCallback(() => setDigits(''), [])

  // Verify once the 4th digit lands.
  useEffect(() => {
    if (digits.length !== PIN_LENGTH || selectedId == null) return
    verifyingRef.current = true
    ;(async () => {
      try {
        const result = await api.verifyPin(selectedId, digits)
        if (result.success) {
          await completeUnlock(selectedId)
          navigate('/')
          return
        }
        if (result.lockedForSeconds) setLockedFor(result.lockedForSeconds)
        setShake(true)
        window.setTimeout(() => setShake(false), 400)
      } catch (err) {
        // Offline / server error — clear and let the reconnecting state surface elsewhere.
        if (!(err instanceof ApiError)) throw err
      } finally {
        setDigits('')
        verifyingRef.current = false
      }
    })()
  }, [digits, selectedId, completeUnlock, navigate])

  // Count down a lockout so the keypad re-enables on its own.
  useEffect(() => {
    if (!lockedFor) return
    const id = window.setInterval(() => {
      setLockedFor((s) => (s && s > 1 ? s - 1 : null))
    }, 1000)
    return () => window.clearInterval(id)
  }, [lockedFor])

  const hint = lockedFor
    ? `LOCKED · ${lockedFor}s`
    : selected
      ? `${selected.name.toUpperCase()}'S PIN REQUIRED`
      : ''

  return (
    <ScreenShell header={<DashboardHeader clock={time} date={date} />} nav={false}>
      <div className={'ml-lock' + (shake ? ' ml-lock--shake' : '')}>
        <div className="ml-lock__top">
          <div className="ml-lock__labelrow">
            <span className="label ml-lock__who">Who is this?</span>
            {hint && <span className="ml-lock__hint">{hint}</span>}
          </div>

          <div className="ml-lock__tiles">
            {profiles.map((p) => (
              <button
                key={p.id}
                type="button"
                className={'ml-lock__tile' + (p.id === selectedId ? ' ml-lock__tile--selected' : '')}
                onClick={() => selectProfile(p.id)}
              >
                <span className="ml-lock__tile-initial serif">{p.initial}</span>
                <span className="ml-lock__tile-name">{p.name}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="ml-lock__entry">
          <PinPad
            digits={digits}
            length={PIN_LENGTH}
            onPress={press}
            onBackspace={backspace}
            onClear={clear}
          />
        </div>

        <div className="ml-lock__footer">
          <span className="ml-lock__footer-note">
            {stayNames.length ? `${stayNames.join(' & ').toUpperCase()} STAY SIGNED IN` : ''}
          </span>
          <button type="button" className="ml-lock__settings" onClick={() => navigate('/settings')}>
            SETTINGS ▸
          </button>
        </div>
      </div>
    </ScreenShell>
  )
}
