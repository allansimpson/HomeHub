import type { ActiveAlertDto, ClimateZoneDto, LitterRobotDto, ZoneReadingDto } from '../../api/types'

/**
 * One block panel on Devices · Home, whatever kind of machine is behind it.
 *
 * <b>Every device reduces to the same four things</b> — a name, a model, one line saying what it is
 * doing, and one figure that matters with a bar under it. That is the whole point of the array: a
 * litter robot and an air conditioner have nothing in common mechanically, and a household glancing
 * at the wall is asking the same question of both.
 */
export interface DevicePanel {
  key: string
  name: string
  model: string
  /** What it is doing, in its own words. */
  status: string
  /** The figure that matters, and the word under it — `66` / `LITTER`, `71.8°` / `NOW`. */
  value: string
  unit: string
  /** 0–1, or null when there is nothing to fill. */
  fill: number | null
  tone: DeviceTone
  /** A hard fault: the two-letter code, the attempt count, and the one-line fix. */
  fault?: { code: string; attempts: number; fix: string }
  route: string
}

/**
 * The state colours, straight from `DESIGN.md`: holding or in range, working, broken, stale.
 *
 * Deliberately four rather than a spectrum. A wall panel is read from across a room, and the only
 * distinctions that survive that distance are "fine", "busy", "broken" and "I do not know".
 */
export type DeviceTone = 'ok' | 'working' | 'fault' | 'stale'

/**
 * The one-line fix, as the array says it.
 *
 * <b>Kept beside the litter view's numbered steps rather than derived from them.</b> They serve
 * different readers: the detail screen is addressed to a pair of hands mid-job and needs the
 * procedure, while this is addressed to somebody deciding whether to get up, and needs a sentence
 * and a duration. Condensing three numbered steps into one line automatically produces neither.
 */
const FIX_LINES: Record<string, string> = {
  dfs: 'Empty it, then reset the drawer — about 2 min',
  sdf: 'Empty it, then reset the drawer — about 2 min',
  br: 'Seat the bonnet until it clicks, then run a cycle — about 2 min',
  otf: 'Clear the globe by hand, then run a cycle — about 3 min',
  pd: 'Free the pinch sensor, then run a cycle — about 3 min',
}

const DEFAULT_FIX = 'Go and look — the ring is showing something a reset cannot clear'

/** The litter robot as a panel. Its bar is a **level**: how much litter is left. */
export function litterPanel(robot: LitterRobotDto): DevicePanel {
  const faulted = robot.faultClass === 'NeedsHuman'
  const stale = robot.stale && !faulted

  return {
    key: `litter-${robot.slug}`,
    /*
     * The machine, named as the machine.
     *
     * It read `Mika's box` here, which is the right words in Care — that surface is about a cat and
     * "the box" is what the household calls it. On Devices it is one appliance in a list of
     * appliances beside two air conditioners, and naming it after its user is like listing the
     * dishwasher under whoever loads it. The cat's name still leads the robot's own screen.
     */
    name: 'Litter Robot',
    model: robot.model ?? 'Litter-Robot',
    // pylitterbot's own words, so the panel and the Whisker app never disagree.
    status: robot.statusText,
    value: faulted
      ? `${Math.round(robot.wasteDrawerPercent ?? 100)}%`
      : `${Math.round(robot.litterPercent ?? 0)}%`,
    unit: faulted ? 'Drawer' : 'Litter',
    fill: faulted
      ? (robot.wasteDrawerPercent ?? 100) / 100
      : robot.litterPercent == null ? null : robot.litterPercent / 100,
    tone: faulted ? 'fault' : stale ? 'stale' : robot.usable ? 'ok' : 'working',
    fault: faulted
      ? {
        code: robot.statusCode.toUpperCase(),
        attempts: robot.recovery.attemptsThisEpisode,
        fix: FIX_LINES[robot.statusCode] ?? DEFAULT_FIX,
      }
      : undefined,
    route: '/devices/litter',
  }
}

/**
 * How far the room has come, not how warm it is.
 *
 * <b>An approximation, and worth saying so.</b> A true progress figure needs the reading the unit
 * started from, and nothing in the panel payload carries it — so this reads the remaining deviation
 * against a nominal five-degree pull. It is right at both ends, which is what a bar glanced at from
 * across a room is actually asked: full when the room is there, visibly short when it is not.
 */
const NOMINAL_PULL_F = 5

/** An air conditioner as a panel. Its bar is **progress toward the setpoint**. */
export function acPanel(zone: ClimateZoneDto): DevicePanel {
  const silent = zone.readingF == null || zone.probeSilentMinutes != null
  const working = zone.state === 'correcting' || zone.state === 'backOn'
  const broken = zone.state === 'unreachable' || zone.state === 'cantHold' || zone.state === 'probeLost'

  const off = Math.abs(zone.deviationF ?? 0)
  const fill = silent ? null : Math.max(0, Math.min(1, 1 - off / NOMINAL_PULL_F))

  return {
    key: `zone-${zone.id}`,
    name: zone.name,
    model: 'Sensibo mini-split',
    status: acStatus(zone, silent),
    value: zone.readingF == null ? '—' : `${round1(zone.readingF)}°`,
    // `THEN`, not `NOW`, once the probe has gone quiet — the figure is the last one taken, and the
    // word is the whole of what says so.
    unit: silent ? 'Then' : 'Now',
    fill: broken ? 1 : fill,
    tone: broken ? 'fault' : silent ? 'stale' : working ? 'working' : 'ok',
    route: `/devices/ac/${zone.id}`,
  }
}

function acStatus(zone: ClimateZoneDto, silent: boolean): string {
  if (silent) {
    const mins = zone.probeSilentMinutes
    return mins == null ? 'Stale · no recent reading' : `Stale · last read ${mins} min ago`
  }
  if (zone.state === 'unreachable') return 'Not answering'
  if (zone.state === 'correcting' || zone.state === 'backOn') {
    const to = zone.targetF == null ? '' : ` to ${Math.round(zone.targetF)}°`
    const left = zone.deviationF == null ? '' : ` · ${round1(Math.abs(zone.deviationF))}° to go`
    return `${zone.unitMode === 'Heat' ? 'Warming' : 'Cooling'}${to}${left}`
  }
  const hold = zone.targetF == null ? 'Holding' : `Holding ${Math.round(zone.targetF)}°`
  return `${hold} · ${zone.unitMode && zone.unitMode !== 'Off' ? zone.unitMode.toLowerCase() : 'idle'}`
}

/**
 * A probe with no unit behind it — a room somebody watches but nothing drives.
 *
 * <b>These are devices too.</b> They were rows on the Climate screen, and when that tab went there
 * was a real risk they went with it: a freezer probe is exactly the thing you want to find out
 * about from across a room, and it has no air conditioner to hide inside. It has no bar, though —
 * the bar means a level or a pull toward a setpoint, and a watched room has neither, so it stays
 * empty rather than being given a meaning this one device would not share.
 */
export function sensorPanel(zone: ClimateZoneDto): DevicePanel {
  const silent = zone.readingF == null || zone.probeSilentMinutes != null
  const out = zone.state === 'outOfRange' || (zone.outOfRangeMinutes ?? 0) > 0

  return {
    key: `probe-${zone.id}`,
    name: zone.name,
    model: zone.class === 'ColdStorage' ? 'Cold storage probe' : 'Probe',
    status: silent
      ? (zone.probeSilentMinutes == null ? 'Stale · no recent reading' : `Stale · last read ${zone.probeSilentMinutes} min ago`)
      : out
        ? `Out of range${zone.outOfRangeMinutes ? ` for ${zone.outOfRangeMinutes} min` : ''}`
        : rangeWords(zone),
    value: zone.readingF == null ? '—' : `${round1(zone.readingF)}°`,
    unit: silent ? 'Then' : 'Now',
    fill: null,
    tone: out ? 'fault' : silent ? 'stale' : 'ok',
    route: `/sensor?zone=${zone.sensorZoneId ?? zone.id}`,
  }
}

/** `In range · 34–40°`, or just `In range` when nobody set a band. */
function rangeWords(zone: ClimateZoneDto): string {
  const { rangeLowF: low, rangeHighF: high } = zone
  if (low == null || high == null) return 'In range'
  return `In range · ${Math.round(low)}–${Math.round(high)}°`
}

/** A reading older than this has stopped being current and starts being a last-known figure. */
const SILENT_AFTER_MIN = 20

/**
 * A push sensor — the deep freezer, the ambient probes.
 *
 * <b>These come from a different provider than everything else on the screen.</b> `SensorsProvider`
 * reads `/sensors/zones`; the air conditioners come from the climate panel; the robot from the
 * litter one. Devices was built on the climate list alone and simply never looked here, so a
 * freezer — the single most alarm-worthy thing in the house — was absent from the screen whose job
 * is to say whether anything is wrong.
 *
 * A food-safety probe faults on its own alert rather than on a range, because the threshold that
 * matters is a server-side one somebody set deliberately.
 */
export function pushSensorPanel(zone: ZoneReadingDto, alerts: ActiveAlertDto[]): DevicePanel {
  const age = zone.timestampUtc == null ? null : (Date.now() - Date.parse(zone.timestampUtc)) / 60_000
  const silent = zone.tempF == null || age == null || age > SILENT_AFTER_MIN
  // Its own alert, matched by source — the server decides what "too warm" means for this probe.
  const alert = alerts.find((a) => a.source === zone.source || a.message.includes(zone.name))

  return {
    key: `sensor-${zone.id}`,
    name: zone.name,
    model: zone.category === 'FoodSafety' ? 'Food safety probe' : 'Ambient probe',
    status: alert
      ? alert.message
      : silent
        ? (age == null ? 'Stale · no reading yet' : `Stale · last read ${Math.round(age)} min ago`)
        : `Reporting${zone.humidity != null ? ` · ${Math.round(zone.humidity)}% RH` : ''}`,
    value: zone.tempF == null ? '—' : `${round1(zone.tempF)}°`,
    unit: silent ? 'Then' : 'Now',
    // No bar: a probe has neither a level nor a setpoint to travel toward.
    fill: null,
    tone: alert && alert.severity !== 'Info' ? 'fault' : silent ? 'stale' : 'ok',
    route: `/sensor?zone=${zone.id}`,
  }
}

/**
 * Which push sensors are already on the screen as something else.
 *
 * <b>The same physical probe reaches this screen down two pipes.</b> The climate panel carries it as
 * a zone — with the band somebody configured and a state derived from it — and `SensorsProvider`
 * carries it as a raw reading with its alerts. The Garage Deep Freezer is both, so it drew twice.
 *
 * Matched two ways, deliberately. `sensorZoneId` is the real link: a climate zone names the sensor
 * zone behind its probe, and an AC's room probe is just as much a duplicate as a bare one. The name
 * check is the fallback for a zone that has no such link, and it is exact rather than fuzzy — two
 * devices genuinely called the same thing is a naming problem the household can see and fix, while
 * a fuzzy match would silently hide a device somebody installed.
 */
export function claimedSensorIds(zones: ClimateZoneDto[], sensors: ZoneReadingDto[]): Set<number> {
  const byId = new Set(zones.map((z) => z.sensorZoneId).filter((id): id is number => id != null))
  const names = new Set(zones.map((z) => z.name.trim().toLowerCase()))
  const claimed = new Set(byId)
  for (const sensor of sensors) {
    if (names.has(sensor.name.trim().toLowerCase())) claimed.add(sensor.id)
  }
  return claimed
}

/**
 * Faulted, then stale, then the standing order.
 *
 * The one thing needing a human is the one thing worth putting at the top, and it is worth moving
 * the others down to do it — a device that has broken since the last glance is not where it was.
 */
export function orderPanels(panels: DevicePanel[]): DevicePanel[] {
  const rank = (p: DevicePanel) => (p.tone === 'fault' ? 0 : p.tone === 'stale' ? 1 : 2)
  return [...panels].sort((a, b) => rank(a) - rank(b))
}

/** `ALL THREE ANSWERING`, or what is actually wrong. */
export function fleetLine(panels: DevicePanel[]): { text: string; tone: DeviceTone } {
  const faulted = panels.filter((p) => p.tone === 'fault').length
  const stale = panels.filter((p) => p.tone === 'stale').length
  if (faulted > 0) {
    return { text: `${count(faulted)} ${faulted === 1 ? 'needs' : 'need'} a human`, tone: 'fault' }
  }
  if (stale > 0) return { text: `${count(stale)} not answering`, tone: 'stale' }
  return { text: `All ${count(panels.length).toLowerCase()} answering`, tone: 'ok' }
}

/**
 * Counts inside a sentence read as words — `TWO NOT ANSWERING`, `THREE ATTEMPTS`.
 *
 * The header's `N CONNECTED` is deliberately not one of them: it labels the list directly under it
 * and is read as a quantity, not as prose.
 */
export function count(n: number): string {
  const words = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten']
  return n < words.length ? words[n] : String(n)
}

function round1(value: number): string {
  return (Math.round(value * 10) / 10).toString()
}
