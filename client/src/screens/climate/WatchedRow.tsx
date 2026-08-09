import type { ClimateZoneDto, ZoneStateName } from '../../api/types'
import { reading, zoneStatus } from './climateCopy'

/**
 * A room with a probe and no unit, or an appliance — read, never commanded.
 *
 * **No band, no controls, and no control affordance of any kind.** There is nothing here to command,
 * and a disabled stepper would imply a capability the house does not have. Tapping opens history,
 * which is the only thing the household can actually do with a reading it cannot change
 * (CLIMATE_SCREEN §6).
 */
export function WatchedRow({
  zone, state, now, onOpen,
}: {
  zone: ClimateZoneDto
  state: ZoneStateName
  now: number
  onOpen: () => void
}) {
  const status = zoneStatus(zone, state, now)
  const alarming = state === 'outOfRange'

  return (
    <button
      type="button"
      className={'ml-cwatched' + (alarming ? ' ml-cwatched--alarm' : '')}
      onClick={onOpen}
    >
      <span className="ml-cwatched__main">
        <span className="ml-cwatched__name">{zone.name}</span>
        <span className={`ml-cwatched__meta ml-ctone--${status.tone}`}>
          {status.text}
          {/* A low battery is not a lost probe. It appends a clause and does nothing else. */}
          {zone.lowBattery && <span className="ml-ctone--alert"> · LOW BATTERY</span>}
        </span>
      </span>
      <span className="ml-cwatched__reading serif">{reading(zone.readingF, false)}</span>
      <span className="ml-cwatched__trail">
        {zone.class === 'ColdStorage' || zone.humidity == null ? '24H ▸' : `${Math.round(zone.humidity)}% RH`}
      </span>
    </button>
  )
}
