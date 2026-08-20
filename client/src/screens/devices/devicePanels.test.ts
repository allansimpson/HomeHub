import { describe, expect, it } from 'vitest'
import {
  acPanel, claimedSensorIds, fleetLine, litterPanel, orderPanels, pushSensorPanel, sensorPanel,
} from './devicePanels'
import type { ClimateZoneDto, LitterRobotDto, ZoneReadingDto } from '../../api/types'

/**
 * What the Devices array claims about the machines.
 *
 * Every one of these is a sentence somebody reads from across a room to decide whether to get up,
 * so what they must never do is look calm while something is broken, or look broken while a probe
 * is merely quiet.
 */

const robot = (over: Partial<LitterRobotDto> = {}): LitterRobotDto => ({
  slug: 'lr4', name: "Mika's box", statusCode: 'rdy', statusText: 'Ready · drawer 17%',
  faultClass: 'Stable', model: 'Litter-Robot 4', usable: true,
  wasteDrawerPercent: 17, litterPercent: 66, petWeightLbs: 9.2, totalCycles: 4,
  lastSeenUtc: null, statusSinceUtc: null, fetchedUtc: new Date().toISOString(), stale: false,
  recovery: {
    enabled: true, activeFaultCode: null, faultSinceUtc: null, attemptsThisEpisode: 0,
    attemptsToday: 0, lastAttemptUtc: null, nextAttemptDueUtc: null, holdReason: null,
    maxAttemptsThisEpisode: 2, maxAttemptsToday: 4,
  } as LitterRobotDto['recovery'],
  controls: {} as LitterRobotDto['controls'],
  ...over,
})

const zone = (over: Partial<ClimateZoneDto> = {}): ClimateZoneDto => ({
  id: 1, name: 'Living Room AC', class: 'controlled', readingF: 71.8, humidity: 46,
  readingAtUtc: new Date().toISOString(), probeSilentMinutes: null, standingTargetF: 69,
  standingSetAtUtc: null, targetF: 69, toleranceF: 1, correction: 'cool', quietFrom: '22:00',
  quietTo: '07:00', isPaused: false, pausedAtUtc: null, override: null,
  previousStandingTargetF: null, state: 'correcting', steadySinceUtc: null, etaLocal: null,
  above: true, deviationF: 2.8, outsideMinutes: null, unreachableSinceUtc: null, degraded: false,
  overrideEndedAtUtc: null, lowBattery: false, rangeLowF: null, rangeHighF: null,
  outOfRangeMinutes: null, ratePerHour: null, unitSetPointF: 69, unitMode: 'Cool',
  probeRef: 'p1', unitRef: 'u1', sensorZoneId: null, lastWrite: null,
  ...over,
} as ClimateZoneDto)

describe('litterPanel', () => {
  /* The bar is a *level* on the robot — how much litter is left, not how full the drawer is. */
  it('reads the litter level while it is working', () => {
    expect(litterPanel(robot())).toMatchObject({ value: '66%', unit: 'Litter', fill: 0.66, tone: 'ok' })
  })

  /*
   * A fault swaps which number matters. Nobody standing in front of a stopped robot cares how much
   * litter is left; they care that the drawer is full, which is the thing they are about to empty.
   */
  it('swaps to the drawer, the code and the fix when it needs a human', () => {
    const panel = litterPanel(robot({
      faultClass: 'NeedsHuman', statusCode: 'dfs', wasteDrawerPercent: 100, usable: false,
      statusText: 'Drawer full · cycle paused 4:40 PM',
    }))
    expect(panel).toMatchObject({ value: '100%', unit: 'Drawer', tone: 'fault' })
    expect(panel.fault?.code).toBe('DFS')
    expect(panel.fault?.fix).toBe('Empty it, then reset the drawer — about 2 min')
  })
})

describe('acPanel', () => {
  it('says what it is doing and how far it has to go', () => {
    expect(acPanel(zone())).toMatchObject({
      status: 'Cooling to 69° · 2.8° to go', value: '71.8°', unit: 'Now', tone: 'working',
    })
  })

  it('reads as holding once it is there', () => {
    expect(acPanel(zone({ state: 'holding', deviationF: 0, readingF: 68.2, unitMode: 'Cool' })))
      .toMatchObject({ status: 'Holding 69° · cool', unit: 'Now', tone: 'ok' })
  })

  /*
   * A silent probe is not a broken one, and the figure on screen is the last one taken. `THEN`
   * rather than `NOW` is the whole of what says so — without it the panel shows a stale temperature
   * as though it were current.
   */
  it('greys and says THEN when the probe has gone quiet', () => {
    const panel = acPanel(zone({ probeSilentMinutes: 14, readingF: 68.2 }))
    expect(panel).toMatchObject({ unit: 'Then', tone: 'stale', fill: null })
    expect(panel.status).toBe('Stale · last read 14 min ago')
  })
})

describe('sensorPanel', () => {
  /*
   * A watched room has no unit to live inside, and would have vanished with the Climate tab if the
   * array only took machines it could command. A freezer probe is exactly what you want to know
   * about from across a room.
   */
  it('reports a probe with no unit behind it', () => {
    const panel = sensorPanel(zone({
      unitRef: null, class: 'ColdStorage', state: 'inRange',
      readingF: 37.2, rangeLowF: 34, rangeHighF: 40, deviationF: null,
    }))
    expect(panel).toMatchObject({
      model: 'Cold storage probe', status: 'In range · 34–40°', value: '37.2°', tone: 'ok',
    })
    // No bar: it means a level or a pull toward a setpoint, and a watched room has neither.
    expect(panel.fill).toBeNull()
  })

  it('faults when it leaves its range', () => {
    expect(sensorPanel(zone({ unitRef: null, state: 'outOfRange', outOfRangeMinutes: 20 })))
      .toMatchObject({ status: 'Out of range for 20 min', tone: 'fault' })
  })
})

describe('pushSensorPanel', () => {
  const probe = (over: Partial<ZoneReadingDto> = {}): ZoneReadingDto => ({
    id: 7, name: 'Garage Deep Freezer', category: 'FoodSafety', source: 'freezer-1',
    displayOrder: 1, tempF: -2.4, humidity: null, timestampUtc: new Date().toISOString(),
    ...over,
  })

  /*
   * The freezer is the reason this exists. It arrives from `SensorsProvider`, not the climate panel
   * the rest of this screen was built on, so the most alarm-worthy thing in the house was missing
   * from the screen whose whole job is to say whether anything is wrong.
   */
  it('reports a push sensor the climate panel never sees', () => {
    expect(pushSensorPanel(probe(), [])).toMatchObject({
      name: 'Garage Deep Freezer', model: 'Food safety probe', value: '-2.4°', unit: 'Now', tone: 'ok',
    })
  })

  /* Its own alert decides the fault — the threshold that matters is one somebody set server-side. */
  it('faults on its own alert, and says what the alert says', () => {
    const alert = {
      id: 1, type: 'sensor', severity: 'Severe', message: 'Garage Deep Freezer is above -5°F',
      source: 'freezer-1', startedAtUtc: new Date().toISOString(),
    } as const
    expect(pushSensorPanel(probe(), [alert])).toMatchObject({
      status: 'Garage Deep Freezer is above -5°F', tone: 'fault',
    })
  })

  /* A probe that has stopped pushing is stale, not fine — and its figure is a last-known one. */
  it('goes stale when it stops reporting', () => {
    const old = new Date(Date.now() - 45 * 60_000).toISOString()
    expect(pushSensorPanel(probe({ timestampUtc: old }), [])).toMatchObject({
      unit: 'Then', tone: 'stale',
    })
  })
})

describe('claimedSensorIds', () => {
  const probe = (over: Partial<ZoneReadingDto> = {}): ZoneReadingDto => ({
    id: 7, name: 'Garage Deep Freezer', category: 'FoodSafety', source: 'freezer-1',
    displayOrder: 1, tempF: -2.4, humidity: null, timestampUtc: new Date().toISOString(),
    ...over,
  })

  /* The link the payload actually gives us: a climate zone names the sensor zone behind its probe. */
  it('claims a sensor a climate zone already draws', () => {
    const claimed = claimedSensorIds([zone({ sensorZoneId: 7 })], [probe()])
    expect(claimed.has(7)).toBe(true)
  })

  /* An AC's room probe is as much a duplicate as a bare one — the unit panel already shows it. */
  it('claims the probe behind an air conditioner too', () => {
    expect(claimedSensorIds([zone({ unitRef: 'u1', sensorZoneId: 7 })], [probe()]).has(7)).toBe(true)
  })

  /* The fallback, for a zone carrying no link. Exact, not fuzzy: two devices genuinely sharing a
     name is a problem the household can see, while a loose match hides one they installed. */
  it('falls back to an exact name match', () => {
    const claimed = claimedSensorIds([zone({ sensorZoneId: null, name: 'Garage Deep Freezer' })], [probe()])
    expect(claimed.has(7)).toBe(true)
    expect(claimedSensorIds([zone({ sensorZoneId: null, name: 'Garage' })], [probe()]).has(7)).toBe(false)
  })
})

describe('orderPanels', () => {
  /* The one thing needing a human goes to the top, and it is worth moving the others to do it. */
  it('puts faulted first, then stale, then the rest', () => {
    const ordered = orderPanels([
      acPanel(zone({ id: 1, name: 'A', state: 'holding', deviationF: 0 })),
      acPanel(zone({ id: 2, name: 'B', probeSilentMinutes: 20 })),
      litterPanel(robot({ faultClass: 'NeedsHuman', statusCode: 'dfs' })),
    ])
    expect(ordered.map((p) => p.tone)).toEqual(['fault', 'stale', 'ok'])
  })
})

describe('fleetLine', () => {
  /* Counts read as words on this panel, and the verb agrees with the count. */
  it('says how the house is, in words', () => {
    const ok = [acPanel(zone({ state: 'holding', deviationF: 0 })), litterPanel(robot())]
    expect(fleetLine(ok)).toEqual({ text: 'All two answering', tone: 'ok' })

    const broken = [litterPanel(robot({ faultClass: 'NeedsHuman', statusCode: 'dfs' })), ...ok]
    expect(fleetLine(broken)).toEqual({ text: 'One needs a human', tone: 'fault' })
  })
})
