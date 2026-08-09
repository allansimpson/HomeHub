import { Fragment } from 'react'
import { useNavigate } from 'react-router'
import { HoldButton, ScreenShell } from '../../components'
import type { RepeatOfferDto } from '../../api/types'
import { useClimate } from '../../app/ClimateProvider'
import { useNow } from '../../app/useNow'
import { AutomatedRow } from './AutomatedRow'
import { WatchedRow } from './WatchedRow'
import { loopLine, rowState } from './climateCopy'

/**
 * Climate — six rows, one loop, and one idea underneath all of it.
 *
 * **The probe is the truth; the set point is the machine's business.** A mini-split holds its own
 * return-air temperature, which is the air beside the unit rather than the temperature of the room,
 * so HomeHub reads the room's probe and moves the set point itself. That splits one number into two,
 * and the screen follows from keeping them apart: the *target* is on the row in brass because a
 * person owns it, and the *set point* appears only in the drill-in, as a fact.
 *
 * So no row here shows a set point, and no row offers to edit one. What a row offers is the band —
 * which is both the picture of how far off the room is and the control for doing something about it.
 */
export function ClimateScreen() {
  const navigate = useNavigate()
  const {
    zones, offer, housePaused, staleMinutes, gestureLive, promotedThisSession,
    borrow, keep, undo, answerOffer, pauseHouse, allUnitsOff,
  } = useClimate()
  // A minute: the shortest clause on the screen is a whole number of minutes, so anything faster is
  // re-rendering six rows to change nothing.
  const now = useNow(60_000)

  const line = loopLine(zones, housePaused, staleMinutes)

  return (
    <ScreenShell header={<ClimateHeader line={line} />}>
      <div className="ml-climate">
        <div className="ml-climate__rows">
          {zones.map((zone) => {
            const state = rowState(zone, promotedThisSession)
            const row = zone.class === 'Automated' ? (
              <AutomatedRow
                key={zone.id}
                zone={zone}
                state={state}
                now={now}
                gestureLive={gestureLive}
                onOpen={() => navigate(`/climate/room/${zone.id}`)}
                onBorrow={(targetF) => void borrow(zone.id, targetF)}
                onKeep={(targetF) => void keep(zone.id, targetF)}
                onUndo={() => void undo(zone.id)}
              />
            ) : (
              <WatchedRow
                key={zone.id}
                zone={zone}
                state={state}
                now={now}
                onOpen={() => navigate(zone.sensorZoneId ? `/sensor?zone=${zone.sensorZoneId}` : '/sensor')}
              />
            )

            // The offer sits directly under the row it is about — never a modal, never a
            // notification. It is a remark about one room, and it belongs next to that room.
            return offer?.zoneId === zone.id ? (
              <Fragment key={`${zone.id}-group`}>
                {row}
                <RepeatOffer offer={offer} onAnswer={(accept) => void answerOffer(offer, accept)} />
              </Fragment>
            ) : row
          })}
        </div>

        <div className="ml-climate__footer">
          <button
            type="button"
            className={'ml-climate__control' + (housePaused ? ' ml-climate__control--live' : '')}
            onClick={() => void pauseHouse(!housePaused)}
          >
            {housePaused ? 'RESUME THE LOOP' : 'PAUSE THE LOOP'}
          </button>
          {/*
            Pause is immediate and reversible; this is neither. Turning every unit off in a house
            that is asleep in it is the one action on this screen a stray touch must not fire, so it
            takes the same hold-to-confirm as Care's entry tiles.
          */}
          <HoldButton
            className="ml-climate__control ml-climate__control--hold"
            onHold={() => void allUnitsOff()}
            destructive
          >
            ALL UNITS OFF
          </HoldButton>
        </div>
      </div>
    </ScreenShell>
  )
}

/**
 * "You've cooled the Master Bedroom to about 69° three evenings running. Make it standing?"
 *
 * The section has no schedules — a schedule is a promise about a week the household has not had yet.
 * This is how one earns its way in instead: from evidence, with a real number, after the fact
 * (DECISIONS §3).
 */
function RepeatOffer({ offer, onAnswer }: { offer: RepeatOfferDto; onAnswer: (accept: boolean) => void }) {
  const target = Math.round(offer.targetF)
  return (
    <div className="ml-coffer">
      <p className="ml-coffer__text">
        You've cooled the {offer.zoneName} to about {target}° three evenings running. Make it standing?
      </p>
      <div className="ml-coffer__actions">
        <button type="button" className="ml-coffer__yes" onClick={() => onAnswer(true)}>
          MAKE IT {target}°
        </button>
        <button type="button" className="ml-coffer__no" onClick={() => onAnswer(false)}>
          NO, KEEP ASKING
        </button>
      </div>
    </div>
  )
}

/**
 * The title and, under it, the section's one-line state.
 *
 * Never a count of rooms that are fine: the right-hand clause states the one thing that is not
 * ordinary, or the instruction if everything is.
 */
function ClimateHeader({ line }: { line: ReturnType<typeof loopLine> }) {
  return (
    <header className="ml-header ml-climate__header">
      <span className="ml-climate__title serif">Climate</span>
      <span className="ml-climate__loopline">
        <span className={`ml-climate__loopstate ml-ctone--${line.leadTone}`}>{line.lead}</span>
        <span className={`ml-climate__loopclause ml-ctone--${line.clauseTone}`}>{line.clause}</span>
      </span>
    </header>
  )
}
