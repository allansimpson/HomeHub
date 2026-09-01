import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { DashboardHeader, ScreenShell } from '../components'
import { Icon } from '../icons/Icon'
import { useClock } from '../app/useClock'
import { useSession } from '../app/SessionProvider'
import { ApiError } from '../api/client'
import { isEnrolled, isOfflineUnlockAvailable, OfflineUnlockError } from '../app/offlineUnlock'
import { LockPinSheet } from './LockPinSheet'
import {
  CLOSED, backspace, clearDigits, isComplete, openSheet, pinSubline, pressDigit,
  profileCount, rowAction, rowMeta,
} from './lockGating'
import type { PinCheck } from './lockGating'

/**
 * Conditional per-profile Lock / PIN screen (`design_handoff_lock_pin`, superseding spec 06).
 *
 * <b>Choose a person, then enter a key</b> — an ordering the previous screen did not enforce. It
 * showed the profile tiles and a live keypad at once, so digits could be pressed with nobody
 * selected and nothing happened at all: no feedback, no error, no state. Now the screen is only a
 * chooser, and the keypad exists solely inside a sheet that cannot open without an owner.
 *
 * No bottom nav. Tapping a profile that has a PIN raises the sheet; tapping one without a PIN signs
 * straight in and never sees it.
 */
export function LockScreen() {
  const navigate = useNavigate()
  const { time, ampm, date } = useClock()
  const { profiles, completeUnlock, offline } = useSession()

  const [sheet, setSheet] = useState(CLOSED)
  const [shake, setShake] = useState(false)
  const [lockedFor, setLockedFor] = useState<number | null>(null)
  /** The PIN could not be checked at all — a different fact from its being wrong. */
  const [unreachable, setUnreachable] = useState(false)
  /** This device was asked and had nothing stored to check against. */
  const [notEnrolled, setNotEnrolled] = useState(false)
  const verifyingRef = useRef(false)

  const selected = profiles.find((p) => p.id === sheet.profileId) ?? null

  /*
   * Who will check these digits, decided before any are pressed.
   *
   * Read from what this device actually holds rather than assumed from being offline: a profile
   * enrolled here is admitted by it, and one that has never signed in here cannot be, and those are
   * different sentences for the person about to type. Only ever a display decision — the check
   * itself is `completeUnlock`'s, and it re-decides from the same facts.
   */
  const reachable = !offline && !unreachable
  const check: PinCheck = reachable
    ? 'server'
    : sheet.profileId != null && isOfflineUnlockAvailable() && isEnrolled(sheet.profileId)
      ? 'device'
      : 'unavailable'

  const close = useCallback(() => {
    setSheet(CLOSED)
    setLockedFor(null)
    setUnreachable(false)
    setNotEnrolled(false)
  }, [])

  const choose = useCallback(
    (id: number) => {
      const p = profiles.find((x) => x.id === id)
      if (!p) return
      if (rowAction(p) === 'sign-in') {
        // No lock on this profile — sign straight in, with no pass through the sheet.
        void completeUnlock(id).then(() => navigate('/'))
        return
      }
      setSheet(openSheet(id))
      setLockedFor(null)
      setUnreachable(false)
      setNotEnrolled(false)
    },
    [profiles, completeUnlock, navigate],
  )

  const press = useCallback(
    (d: string) => {
      if (verifyingRef.current || lockedFor) return
      setSheet((s) => pressDigit(s, d))
    },
    [lockedFor],
  )

  const onBackspace = useCallback(() => setSheet(backspace), [])
  const onClear = useCallback(() => setSheet(clearDigits), [])

  // Verify once the fourth digit lands. There is no confirm key: the fourth digit is the submission.
  useEffect(() => {
    const { profileId, digits } = sheet
    if (profileId == null || !isComplete(sheet)) return
    verifyingRef.current = true
    ;(async () => {
      try {
        // Signs in rather than asking whether the PIN is right (AUDIT A1). The old `verifyPin`
        // returned a boolean this screen chose to honour — so the lock was only as real as the
        // client. Now the correct PIN is what mints the session cookie every other call needs, and
        // a client that skipped this screen would simply get 401s.
        await completeUnlock(profileId, digits)
        navigate('/')
        return
      } catch (err) {
        const wrong = () => {
          setShake(true)
          window.setTimeout(() => setShake(false), 400)
        }

        /*
         * The device checked it and refused, which the server never saw.
         *
         * Three different refusals wearing one shape, and the screen has to tell them apart: wrong
         * digits are worth another go, a wait is a wait, and a profile that has never signed in on
         * this device cannot be admitted by it at all — that last one is the only state where
         * trying again is pointless, so it is the only one that says so.
         */
        if (err instanceof OfflineUnlockError) {
          setUnreachable(false)
          if (err.failure.kind === 'not-enrolled') {
            setNotEnrolled(true)
          } else if (err.failure.kind === 'locked-out') {
            setLockedFor(err.failure.retryAfterSeconds)
            wrong()
          } else {
            wrong()
          }
          return
        }

        if (!(err instanceof ApiError)) throw err
        // 401 is a wrong PIN; the body carries the cooldown when the lockout has started.
        if (err.status === 401) {
          const failure = err.body as { retryAfterSeconds?: number | null } | undefined
          if (failure?.retryAfterSeconds) setLockedFor(failure.retryAfterSeconds)
          wrong()
          setUnreachable(false)
        } else {
          /*
           * The PIN could not be checked, which is not the same as being wrong.
           *
           * This used to clear the digits and say nothing, on the reasoning that the reconnecting
           * banner would explain it. It does not: the Lock screen has no banner above it, so a
           * correct PIN simply vanished four digits at a time with no feedback at all — which reads
           * exactly like being told you are wrong, repeatedly, by a panel that will not say so.
           * The sheet's subline now says which of the two happened, and there is no shake, because
           * nothing was rejected.
           *
           * Reached far less often now: the unreachable server hands the PIN to the device, and
           * only a profile with nothing stored here — or a browser with no WebCrypto — gets this
           * far without an answer.
           */
          setUnreachable(true)
        }
      } finally {
        // Empty the squares and stay on this profile: a wrong PIN is a reason to try again, not a
        // reason to make somebody choose their own name a second time.
        setSheet(clearDigits)
        verifyingRef.current = false
      }
    })()
  }, [sheet, completeUnlock, navigate])

  // Count down a lockout so the keypad re-enables on its own.
  useEffect(() => {
    if (!lockedFor) return
    const id = window.setInterval(() => {
      setLockedFor((s) => (s && s > 1 ? s - 1 : null))
    }, 1000)
    return () => window.clearInterval(id)
  }, [lockedFor])

  return (
    <ScreenShell header={<DashboardHeader clock={time} ampm={ampm} date={date} />} nav={false}>
      <div className={'ml-lock' + (shake ? ' ml-lock--shake' : '')}>
        <div className="ml-lock__labelrow">
          <span className="label ml-lock__who">Who is this?</span>
          <span className="ml-lock__count">{profileCount(profiles.length)}</span>
        </div>
        {/* Sentence case, not a label: this one is an instruction to a person, not a heading. */}
        <p className="ml-lock__instruction">Tap a name to continue.</p>

        <div className="ml-lock__rows">
          {profiles.map((p) => {
            const meta = rowMeta(p, sheet.profileId)
            const chosen = p.id === sheet.profileId
            return (
              <button
                key={p.id}
                type="button"
                className={'ml-lockrow' + (chosen ? ' ml-lockrow--chosen' : '')}
                onClick={() => choose(p.id)}
              >
                <span
                  className={'ml-lockrow__avatar serif' + (p.hasPin ? ' ml-lockrow__avatar--pin' : '')}
                  aria-hidden="true"
                >
                  {p.initial}
                </span>
                <span className="ml-lockrow__text">
                  <span className="ml-lockrow__name serif">{p.name}</span>
                  <span className={`ml-lockrow__meta ml-lockrow__meta--${meta.tone}`}>
                    {meta.lock && <Icon id="ico-lock" size="0.8125rem" />}
                    {meta.text}
                  </span>
                </span>
                {/* The chosen row loses its chevron — it has already been followed. */}
                {!chosen && <span className="ml-lockrow__chevron" aria-hidden="true">▸</span>}
              </button>
            )
          })}
        </div>
        {/* No footer. It carried a "… STAY SIGNED IN" note and a SETTINGS link, and neither
            survives contact with the screen being a lock: the link goes somewhere the lock exists
            to prevent reaching, and announcing who can get in without a PIN is a hint offered to
            whoever is standing in front of a panel they could not open. */}
      </div>

      {selected && (
        <LockPinSheet
          name={selected.name}
          initial={selected.initial}
          digits={sheet.digits}
          subline={pinSubline({ check, lockedFor, notEnrolled })}
          onPress={press}
          onBackspace={onBackspace}
          onClear={onClear}
          onCancel={close}
        />
      )}
    </ScreenShell>
  )
}
