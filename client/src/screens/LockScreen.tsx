import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { DashboardHeader, ScreenShell, PinPad } from '../components'
import { useClock } from '../app/useClock'
import { useSession } from '../app/SessionProvider'
import { ApiError } from '../api/client'

const PIN_LENGTH = 4

/**
 * Conditional per-profile Lock / PIN screen (spec 06). Profile tiles + 4-digit deco keypad,
 * wrong-PIN shake + clear. No bottom nav. Tapping a profile that has a PIN opens the keypad;
 * tapping one without a PIN signs straight in.
 */
export function LockScreen() {
  const navigate = useNavigate()
  const { time, ampm, date } = useClock()
  const { profiles, activeProfileId, completeUnlock } = useSession()

  // `hasPin` alone, not `requirePinWhenIdle && hasPin`. The server requires the PIN of any profile
  // that has one (SessionController.SignIn), so the two settings answer different questions:
  // `hasPin` decides whether signing in needs the keypad, `requirePinWhenIdle` decides whether the
  // panel re-locks after idling. Conflating them is what made Allan's PIN "not work" — his profile
  // had a PIN with requirePinWhenIdle off, so the tile signed in with no PIN at all and the server
  // refused it, without the keypad ever appearing.
  const lockable = profiles.filter((p) => p.hasPin)
  const initialId = lockable.some((p) => p.id === activeProfileId)
    ? activeProfileId
    : (lockable[0]?.id ?? null)

  const [selectedId, setSelectedId] = useState<number | null>(initialId)
  const [digits, setDigits] = useState('')
  const [shake, setShake] = useState(false)
  const [lockedFor, setLockedFor] = useState<number | null>(null)
  const verifyingRef = useRef(false)

  const selected = profiles.find((p) => p.id === selectedId) ?? null

  const selectProfile = useCallback(
    (id: number) => {
      const p = profiles.find((x) => x.id === id)
      if (!p) return
      if (!p.hasPin) {
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
        // Signs in rather than asking whether the PIN is right (AUDIT A1). The old `verifyPin`
        // returned a boolean this screen chose to honour — so the lock was only as real as the
        // client. Now the correct PIN is what mints the session cookie every other call needs, and
        // a client that skipped this screen would simply get 401s.
        await completeUnlock(selectedId, digits)
        navigate('/')
        return
      } catch (err) {
        // Offline / server error — clear and let the reconnecting state surface elsewhere.
        if (!(err instanceof ApiError)) throw err
        // 401 is a wrong PIN; the body carries the cooldown when the lockout has started.
        if (err.status === 401) {
          const failure = err.body as { retryAfterSeconds?: number | null } | undefined
          if (failure?.retryAfterSeconds) setLockedFor(failure.retryAfterSeconds)
          setShake(true)
          window.setTimeout(() => setShake(false), 400)
        }
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
    <ScreenShell header={<DashboardHeader clock={time} ampm={ampm} date={date} />} nav={false}>
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
        {/* No footer. It carried a "… STAY SIGNED IN" note and a SETTINGS link, and neither
            survives contact with the screen being a lock: the link goes somewhere the lock exists
            to prevent reaching, and announcing who can get in without a PIN is a hint offered to
            whoever is standing in front of a panel they could not open. */}
      </div>
    </ScreenShell>
  )
}
