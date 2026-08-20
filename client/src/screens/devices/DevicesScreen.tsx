import { useNavigate } from 'react-router'
import { ScreenShell, ScrollArea } from '../../components'
import { useLitter } from '../../app/LitterProvider'
import { useClimate } from '../../app/ClimateProvider'
import { useSensors } from '../../app/SensorsProvider'
import { useNow } from '../../app/useNow'
import { useClock } from '../../app/useClock'
import {
  acPanel, claimedSensorIds, count, fleetLine, litterPanel, orderPanels, pushSensorPanel, sensorPanel,
} from './devicePanels'
import type { DevicePanel } from './devicePanels'

/**
 * Devices — the machines in the house and what they report.
 *
 * <b>Read, occasionally command, never log by hand</b>, which is exactly what separates it from
 * Baby. The two shared a tab until the August split, on the reasoning that they have the same five
 * parts; what they do not share is the verb. This screen answers "is anything wrong" from across a
 * room, and nothing on it writes.
 *
 * One block panel per device, in one vocabulary: a name, its model, a line saying what it is doing,
 * and one figure with a bar. The bar means two different things — a **level** on the robot, and
 * **progress toward the setpoint** on an air conditioner — which is why the footer says which.
 */
export function DevicesScreen() {
  const navigate = useNavigate()
  const { robots } = useLitter()
  const { zones } = useClimate()
  const { zones: sensors, alerts } = useSensors()
  const now = useNow(30_000)
  const { stamp } = useClock()

  /*
   * Everything the house has: the robot, the units, and the bare probes.
   *
   * <b>The probes matter here.</b> Taking CLIMATE out of the bar moved the air conditioners in, and
   * it would have been easy to leave the watched rooms behind with the tab — a freezer probe has no
   * unit to live inside. They are devices in exactly the sense this screen means: a machine that
   * reports, that you read and never log by hand.
   */
  const claimed = claimedSensorIds(zones, sensors)

  const panels = orderPanels([
    ...robots.map(litterPanel),
    ...zones.filter((z) => z.unitRef != null).map(acPanel),
    ...zones.filter((z) => z.unitRef == null).map(sensorPanel),
    /*
     * The push sensors, less the ones already drawn as a climate zone.
     *
     * Three sources feed this screen and two of them overlap: a probe the household has given a
     * band to is a climate zone *and* a raw reading, and it drew twice. The zone wins — it carries
     * the range somebody configured, which is the more useful thing to read from across a room.
     */
    ...sensors.filter((s) => !claimed.has(s.id)).map((s) => pushSensorPanel(s, alerts)),
  ])

  const fleet = fleetLine(panels)
  // The freshest thing anything said, across all three sources — it read only the robot's, so on a
  // house with no litter box the line claimed nothing had ever been heard from.
  const read = [
    ...robots.map((r) => r.fetchedUtc),
    ...sensors.map((s) => s.timestampUtc).filter((t): t is string => t != null),
  ].sort().at(-1) ?? null
  const faulted = panels.some((p) => p.tone === 'fault')

  return (
    <ScreenShell
      header={
        <header className="ml-header ml-devices__head">
          <span className="ml-devices__title serif">Devices</span>
          {/* The one count on this screen that is a figure rather than a phrase: it is the number of
              things below it, and it is read against them. The fleet line under the header still
              spells its counts, because those are sentences about what is wrong. */}
          <span className="ml-devices__count">{panels.length} connected</span>
          <span className="ml-drillin-header__status">{stamp}</span>
        </header>
      }
    >
      {/*
        No rule under the header.

        The brass-and-hairline pair belongs to a screen whose header is a title with content
        starting beneath it — the AC detail still carries one. Here the header already ends in a
        count and is followed immediately by the fleet line, so the rule fell between two pieces of
        the same statement and read as a second, emptier header rather than as a division.
      */}
      <div className="ml-devices__status">
        <span className={`ml-devices__state ml-devices__state--${fleet.tone}`}>
          <span className="ml-devices__dot" aria-hidden="true" />
          {fleet.text}
        </span>
        <span className="ml-devices__read">{read ? `Read ${since(read, now)}` : 'Not read yet'}</span>
      </div>

      <ScrollArea>
        <div className="ml-devices__body">
          <div className="ml-devices__label">
            <span>In the house</span>
            {/* The note earns its place only when the order has actually been changed. */}
            <span className="ml-devices__note">{faulted ? 'Faulted first' : 'Tap for detail'}</span>
          </div>

          {panels.map((panel) => (
            <DeviceBlock key={panel.key} panel={panel} onOpen={() => navigate(panel.route)} />
          ))}

          {panels.length === 0 && (
            <p className="ml-carelog__empty">No devices are connected yet.</p>
          )}
        </div>
      </ScrollArea>

      {/*
        No footer at all now — the legend went first, and the settings link with it.

        The legend explained how to read the bar and, when something was faulted, the ordering.
        Neither is something the screen needs to say: the bar is read off the block it sits in, and
        a faulted device announces itself with its tone, its dot and the fix it carries. `Faulted
        first` still appears beside IN THE HOUSE, which is the one thing the household cannot see
        for itself — a statement about the *order* rather than about any one device.

        With the link gone the whole strip goes, rather than leaving an empty bordered band across
        the bottom of the screen. Device settings are reached where every other setting is, from the
        account avatar; a second door into one section's settings, on the section itself, was the
        kind of shortcut that has to be maintained in two places forever.

        The list now runs to the bottom of the screen, which is what it wanted — this is a screen
        for answering "is anything wrong" from across a room, and every row it can show is one more
        answer.
      */}
    </ScreenShell>
  )
}

/** One machine: name, model, what it is doing, the figure that matters, and the bar. */
function DeviceBlock({ panel, onOpen }: { panel: DevicePanel; onOpen: () => void }) {
  return (
    <button
      type="button"
      className={`ml-devblock ml-devblock--${panel.tone}`}
      onClick={onOpen}
    >
      <span className="ml-devblock__head">
        <span className="ml-devblock__name">{panel.name}</span>
        {/* The two-letter code sits beside the name on a fault — it is what the ring is showing and
            what anybody phoning support will be asked for. */}
        {panel.fault && <span className="ml-devblock__code serif">{panel.fault.code}</span>}
        <span className="ml-devblock__model">
          {panel.fault ? `${count(panel.fault.attempts)} attempts` : panel.model}
        </span>
      </span>

      <span className="ml-devblock__read">
        <span className="ml-devblock__status">{panel.status}</span>
        <span className="ml-devblock__value serif">
          {panel.value}<span className="ml-devblock__unit">{panel.unit}</span>
        </span>
      </span>

      <span className="ml-devblock__bar" aria-hidden="true">
        {panel.fill != null && <span className="ml-devblock__fill" style={{ width: `${panel.fill * 100}%` }} />}
      </span>

      {/* The fix, in one line: this reader is deciding whether to get up, not doing the job yet. */}
      {panel.fault && <span className="ml-devblock__fix">{panel.fault.fix}</span>}
    </button>
  )
}

/** `40 s ago`, `4 min ago` — how long since anything was heard from. */
function since(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (seconds < 60) return `${seconds} s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`
}
