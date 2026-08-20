import { useNavigate, useParams } from 'react-router'
import { BackButton, DoubleRule, EmptyState, ScreenShell, ScrollArea } from '../../components'
import { useClimate } from '../../app/ClimateProvider'
import { useNow } from '../../app/useNow'
import { clockLabel } from '../../app/dates'

/**
 * How far a nudge moves the target.
 *
 * The two hours it lasts are the loop's, not the panel's — `borrow` opens a loan and the server
 * decides when it lapses, which is why that figure is not repeated here as a constant nobody reads.
 */
const NUDGE_F = 2

/**
 * One air conditioner, and the room it reads.
 *
 * <b>The room is a property of its unit, not a section of its own.</b> That is the whole of what
 * the CARE split did to Climate: a temperature nobody can act on is a number, and the thing anybody
 * actually wants — move it, or find out why it will not move — lives on the machine. So this is
 * drawn in the same frame as the litter robot, and every device reads alike.
 *
 * <b>The setpoint is HomeHub's to move.</b> The loop writes it and will undo a change made on the
 * unit within ten minutes, which is a fact the screen states rather than leaves somebody to discover
 * by watching their adjustment vanish.
 */
export function AcDeviceScreen() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { zones, setTarget, borrow, staleMinutes } = useClimate()
  const now = useNow(30_000)

  const zone = zones.find((z) => String(z.id) === id)
  if (!zone) {
    return (
      <ScreenShell header={<header className="ml-header ml-header--drillin"><BackButton onClick={() => navigate('/devices')} /></header>}>
        <EmptyState label="No such device" hint="It may have been removed in Config → Devices." />
      </ScreenShell>
    )
  }

  const working = zone.state === 'correcting' || zone.state === 'backOn'
  const silent = zone.readingF == null || zone.probeSilentMinutes != null
  const target = zone.targetF ?? zone.standingTargetF
  const toGo = zone.deviationF == null ? null : Math.abs(zone.deviationF)

  /*
   * How far the room has come.
   *
   * The design labels the far end `STARTED AT 79.4°`, and nothing in the payload carries the
   * reading the pull began from — so the bar is drawn against the same nominal span the array uses
   * and that label is left off rather than invented. Right at both ends, which is what a bar is
   * asked from across a room.
   */
  const progress = toGo == null ? null : Math.max(0, Math.min(1, 1 - toGo / 5))

  return (
    <ScreenShell
      header={
        <header className="ml-header ml-header--drillin ml-acdev__head">
          <BackButton onClick={() => navigate('/devices')} />
          <span className="ml-acdev__names">
            <span className="ml-acdev__title serif">{zone.name}</span>
            <span className="ml-acdev__model">
              Sensibo mini-split{zone.probeRef ? ` · probe ${zone.probeRef}` : ''}
            </span>
          </span>
        </header>
      }
    >
      <DoubleRule />

      <div className="ml-devices__status">
        <span className={`ml-devices__state ml-devices__state--${silent ? 'stale' : working ? 'working' : 'ok'}`}>
          <span className="ml-devices__dot" aria-hidden="true" />
          {silent ? 'Probe quiet' : working ? 'Cooling' : 'Holding'}
          {staleMinutes == null ? ' · read just now' : ` · read ${staleMinutes} min ago`}
        </span>
        {/* Said plainly and always, because it is the answer to "why did my change disappear". */}
        <span className="ml-acdev__driving">HomeHub is driving</span>
      </div>

      <ScrollArea>
        <div className="ml-acdev__body">
          <div className="ml-acdev__hero">
            <span className="ml-acdev__now">
              <span className="ml-acdev__reading serif">
                {zone.readingF == null ? '—' : `${round1(zone.readingF)}°`}
              </span>
              <span className="ml-acdev__nowmeta">
                {silent ? 'Then' : 'Now'}{zone.humidity != null ? ` · ${Math.round(zone.humidity)}% RH` : ''}
              </span>
            </span>

            <span className="ml-acdev__set">
              <button
                type="button"
                className="ml-acdev__step"
                onClick={() => target != null && void setTarget(zone.id, target - 1)}
                disabled={target == null}
                aria-label="Target down"
              >
                −
              </button>
              <span className="ml-acdev__target">
                <span className="serif">{target == null ? '—' : `${Math.round(target)}°`}</span>
                <span className="ml-acdev__targetlabel">Target</span>
              </span>
              <button
                type="button"
                className="ml-acdev__step"
                onClick={() => target != null && void setTarget(zone.id, target + 1)}
                disabled={target == null}
                aria-label="Target up"
              >
                +
              </button>
            </span>
          </div>

          {working && (
            <>
              <Band label="Getting there" note={toGo == null ? undefined : `${round1(toGo)}° to go`} />
              <div className="ml-acdev__bar" aria-hidden="true">
                {progress != null && <span className="ml-acdev__fill" style={{ width: `${progress * 100}%` }} />}
              </div>
              {zone.etaLocal && <div className="ml-acdev__eta">About {etaWords(zone.etaLocal, now)} left</div>}
            </>
          )}

          <Band
            label="The unit"
            note={zone.lastWrite ? `Last write ${clock(zone.lastWrite.atUtc)}` : undefined}
          />
          <Row label="Setpoint on the unit" value={zone.unitSetPointF == null ? '—' : `${Math.round(zone.unitSetPointF)}°`} />
          <Row label="Mode" value={(zone.unitMode ?? 'Unknown').toString()} caps />
          {/* Compressor hours are drawn in the design and are not in the payload — the row is left
              out rather than filled with a figure the panel would be inventing. */}

          <p className="ml-acdev__note">
            The setpoint is HomeHub&rsquo;s to move. Change it on the unit and the loop will put it
            back within ten minutes.
          </p>

          <Band
            label="Nudge"
            note={target == null ? undefined : `Two hours, then back to ${Math.round(target)}°`}
          />
          <div className="ml-acdev__nudge">
            {[-NUDGE_F, NUDGE_F].map((delta) => (
              <button
                key={delta}
                type="button"
                className="ml-acdev__nudgebtn"
                // A loan, not a new standing target: it expires and the room goes back on its own,
                // which is the difference between a nudge and a decision.
                onClick={() => target != null && void borrow(zone.id, target + delta)}
                disabled={target == null}
              >
                {delta > 0 ? `+${delta}°` : `${delta}°`}
              </button>
            ))}
          </div>
        </div>
      </ScrollArea>

      <div className="ml-devices__foot">
        <span className="ml-devices__legend">Thresholds — Config · Devices</span>
        <button
          type="button"
          className="ml-devices__settings"
          onClick={() => navigate(zone.sensorZoneId ? `/sensor?zone=${zone.sensorZoneId}` : '/sensor')}
        >
          History ▸
        </button>
      </div>
    </ScreenShell>
  )
}

function Band({ label, note }: { label: string; note?: string }) {
  return (
    <div className="ml-acdev__band">
      <span>{label}</span>
      {note && <span className="ml-acdev__bandnote">{note}</span>}
    </div>
  )
}

function Row({ label, value, caps }: { label: string; value: string; caps?: boolean }) {
  return (
    <div className="ml-acdev__row">
      <span className="ml-acdev__rowlabel">{label}</span>
      <span className={'ml-acdev__rowvalue' + (caps ? ' ml-acdev__rowvalue--caps' : ' serif')}>{value}</span>
    </div>
  )
}

/** `25 min` — the wait, from the local time the loop expects to arrive. */
function etaWords(etaLocal: string, now: number): string {
  const parsed = Date.parse(`${new Date(now).toDateString()} ${etaLocal}`)
  if (Number.isNaN(parsed)) return etaLocal
  const minutes = Math.round((parsed - now) / 60_000)
  if (minutes <= 0) return 'a moment'
  return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`
}

// The panel's own way of saying a time, not the device's: `toLocaleTimeString` follows the
// browser locale, so the same reading rendered `18:32` on a phone set to en-GB and `6:32 PM`
// on the wall panel beside it. Nothing here is 24-hour (`dates.clockLabel`).
const clock = (iso: string): string => clockLabel(new Date(iso))

function round1(value: number): string {
  return (Math.round(value * 10) / 10).toString()
}
