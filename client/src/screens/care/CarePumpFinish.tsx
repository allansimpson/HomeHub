import { useMemo, useState } from 'react'
import { clockLabel } from '../../app/care'
import { CarePanel } from './CarePanel'
import { SHAPES } from './CareSheet'
import { WhenPickerBody, WhenPickerFoot, useWhenDraft } from './WhenPicker'
import { mmss } from './runningClock'
import type { CareTimerDto } from '../../api/types'

/**
 * View 8b — the finished pump session, and the one screen in the design that asks for an amount.
 *
 * <b>A pump session is measured at one moment and written at another.</b> FINISH stops the clock
 * and holds the session; this panel states what was measured, asks how much was expressed, and
 * writes both together on SAVE. That ordering is the whole point of the redesign: the amount is
 * knowable at exactly one moment — the end — and the old panel asked before the session had run,
 * so it wrote whatever had been guessed and the only way out was to throw the session away.
 *
 * <b>Nothing here is a second chance to change the session.</b> The summary card is a statement of
 * fact in the plain frame, not the brass one: the length is a measurement already taken. The one
 * correctable thing is the start, because a timer left running while the pump was packed away is
 * the common case.
 *
 * The session survives this panel being closed. Dragging down leaves it held, the day view says so,
 * and opening PUMP comes back here rather than offering to start another.
 */
export function CarePumpFinish({
  timer, saving, rise = true, onSave, onDiscard, onClose,
}: {
  /** A held session: `endedUtc` set, its length already banked. */
  timer: CareTimerDto
  saving: boolean
  /** False when the running panel is handing over to this one. */
  rise?: boolean
  onSave: (amount: number | null, atUtc: string) => void
  onDiscard: () => void
  onClose: () => void
}) {
  const measure = SHAPES.Pump?.measure

  /*
   * Opens blank, and NONE is a tap rather than a default.
   *
   * The handoff is explicit that nothing is pre-selected here. A pre-filled figure on the one
   * screen that asks for a measurement is a guess wearing the clothes of a reading — and this log
   * stores "not measured" as a different fact from a zero precisely so that guess never has to be
   * made. Five of the last six real sessions had no amount at all.
   */
  const [amount, setAmount] = useState<number | null>(null)
  const [picking, setPicking] = useState(false)
  const when = useWhenDraft()

  const minutes = timer.elapsedMinutes
  const ended = useMemo(
    () => (timer.endedUtc ? new Date(timer.endedUtc) : new Date()),
    [timer.endedUtc],
  )
  /*
   * Where the session began: the end, less what it ran.
   *
   * Not `startedUtc` — the server moves that mark when a session is paused or held, so it is the
   * clock's own bookkeeping rather than the moment somebody sat down. The subtraction is what the
   * design draws (`6:08 → 6:33 AM` under a length of `25:00`), and it is the figure the household
   * would check against.
   */
  const [at, setAt] = useState<Date>(() => new Date(ended.getTime() - minutes * 60_000))
  const [timeSet, setTimeSet] = useState(false)

  const bump = (delta: number) => setAmount((cur) => {
    const next = Math.round(((cur ?? 0) + delta) * 100) / 100
    // Below the floor is "not measured", which is a different fact from zero.
    return next <= 0 ? null : next
  })

  const whole = Math.round(minutes)
  const unit = measure?.unit ?? 'oz'
  const review = `Writes a ${whole} minute session, ${amount == null ? 'no amount' : `${amount} ${unit}`}`
    + `, started ${clockLabel(at)}.`

  return (
    <CarePanel
      title="Pump"
      label={
        <span className="ml-carerunning__live ml-carerunning__live--held">
          <span className="ml-carerunning__dot" aria-hidden="true" />
          Finished
        </span>
      }
      /* Not `the timer keeps running` — it has stopped. What a drag leaves behind is the session
         itself, unwritten, which is the thing somebody needs to know before they do it. */
      handleNote="the session is held"
      rise={rise}
      onClose={onClose}
      footer={
        picking ? (
          <WhenPickerFoot
            note="Sets the time this session started. Nothing is written yet."
            draft={when}
            onBack={() => setPicking(false)}
            onSet={() => { setAt(when.at); setTimeSet(true); setPicking(false) }}
          />
        ) : (
          <>
            <p className="ml-carepanel__review">{review}</p>
            <button
              type="button"
              className="ml-carepanel__save"
              onClick={() => onSave(amount, at.toISOString())}
              disabled={saving}
            >
              Save
            </button>
            {/*
              Reachable, and not a peer of SAVE.

              By this point the session really happened, so throwing it away is a plain text row
              rather than the bordered card CANCEL gets on a running panel — no border, no fill, and
              it sits under SAVE rather than beside it. The destructive accent is the same one used
              everywhere else and nowhere but here on this panel.
            */}
            <button
              type="button"
              className="ml-carefinish__discard"
              onClick={onDiscard}
              disabled={saving}
            >
              Discard session
            </button>
          </>
        )
      }
    >
      {picking ? <WhenPickerBody draft={when} /> : (
        <>
          {/* The plain frame, not the brass one: this is what happened, not something to press. */}
          <div className="ml-carefinish__card">
            <span className="ml-carefinish__length">
              <span className="ml-carefinish__caption">Session length</span>
              <span className="serif ml-carefinish__clock">{mmss(minutes * 60)}</span>
            </span>
            <span className="ml-carefinish__facts">
              <span>{clockLabel(at)} → {clockLabel(ended)}</span>
              {timer.phaseOneMinutes != null && timer.phaseTwoMinutes != null && (
                <span>{timer.phaseOneMinutes} stimulation · {timer.phaseTwoMinutes} expression</span>
              )}
            </span>
          </div>

          <div className="ml-caresheet__label">
            Amount
            <span className="ml-caresheet__note">Optional</span>
          </div>
          <div className="ml-caresheet__stepper">
            <button
              type="button"
              className="ml-caresheet__step"
              onClick={() => bump(-(measure?.step ?? 0.5))}
              disabled={amount == null}
              aria-label="Less expressed"
            >
              −
            </button>
            <span className="ml-caresheet__value">
              {/* An em dash, not a zero: nothing was measured, and a zero is a measurement. */}
              <span className="serif">{amount ?? '—'}</span>
              <span className="ml-caresheet__unit">
                {amount == null ? 'Ounces · not measured' : (measure?.caption ?? 'Ounces')}
              </span>
            </span>
            <button
              type="button"
              className="ml-caresheet__step"
              onClick={() => bump(measure?.step ?? 0.5)}
              aria-label="More expressed"
            >
              +
            </button>
          </div>
          <div
            className="ml-caresheet__grid"
            style={{ '--cols': (measure?.quick.length ?? 4) + 1 } as React.CSSProperties}
          >
            <button
              type="button"
              className={'ml-carechip' + (amount === null ? ' ml-carechip--on' : '')}
              onClick={() => setAmount(null)}
            >
              None
            </button>
            {measure?.quick.map((q) => (
              <button
                key={q}
                type="button"
                className={'ml-carechip' + (amount === q ? ' ml-carechip--on' : '')}
                onClick={() => setAmount(q)}
              >
                {q}
              </button>
            ))}
          </div>

          {/* Correctable, because a timer left running while the pump was packed away is the
              common case and the length it measured is then longer than the session. */}
          <button
            type="button"
            className="ml-caresheet__when"
            onClick={() => { when.open(at); setPicking(true) }}
          >
            <span>
              Started
              <span className="ml-caresheet__note">
                {timeSet ? 'Set by hand' : 'From the timer — tap to change'}
              </span>
            </span>
            <span className="ml-caresheet__whenright">
              <span className="serif ml-caresheet__whenvalue">{clockLabel(at)}</span>
              <span className="ml-caresheet__chev" aria-hidden="true">▸</span>
            </span>
          </button>

          <p className="ml-carerunning__note">
            Saving without an amount records the session and no measurement, never a zero.
          </p>
        </>
      )}
    </CarePanel>
  )
}
