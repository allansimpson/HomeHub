import type { ClimateZoneDto, ZoneStateName } from '../../api/types'

/**
 * Every sentence the Climate section speaks, and the colour it speaks it in.
 *
 * One module, deliberately. The row's status line is the loop talking, and each clause of it is
 * locked copy tied to a token — `HOLDING · STEADY 3H 20M` in verdigris is a different statement from
 * `CAN'T HOLD · 4° OVER FOR 40M` in amber, and the difference has to survive being edited. Kept here,
 * away from layout, the whole vocabulary can be read in one sitting and tested without a DOM.
 *
 * The rule behind the wording: **if a state cannot be seen, it is a bug.** Every branch the loop can
 * take has a sentence here, including the ones that mean it has stopped trying.
 */

/** Which token colours a line. Maps to the `--` custom properties, never to a raw hex. */
export type Tone = 'live' | 'brass' | 'bright' | 'alert' | 'danger' | 'muted' | 'disabled'

export interface ZoneStatus {
  text: string
  tone: Tone
  /** The way out of a promotion, appended as its own tappable clause. */
  undo?: boolean
}

/** `3H 20M` · `40M` · `2D`. Never "0M" — under a minute reads as "1M". */
export function duration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}M`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours < 24) return rest === 0 ? `${hours}H` : `${hours}H ${rest}M`
  return `${Math.round(hours / 24)}D`
}

/** `7:04` — the panel's clock, no leading zero, no meridiem where the sentence carries one. */
export function clock(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '')
}

/** `6:00 AM` — used where the sentence states a time of day rather than a moment today. */
export function clockAmPm(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  const suffix = h < 12 ? 'AM' : 'PM'
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour}:${String(m ?? 0).padStart(2, '0')} ${suffix}`
}

/** `71.8°` on a room, `37°` on an appliance — a tenth is meaningful in a room and noise in a freezer. */
export function reading(value: number | null, precise: boolean): string {
  if (value == null) return '—'
  return precise ? `${value.toFixed(1)}°` : `${Math.round(value)}°`
}

/** `34–40°` — an en dash, and a minus sign that is not a hyphen. */
export function range(low: number | null, high: number | null): string {
  if (low == null || high == null) return ''
  const fmt = (n: number) => (n < 0 ? `−${Math.abs(Math.round(n))}` : `${Math.round(n)}`)
  return `${fmt(low)}–${fmt(high)}°`
}

/**
 * The row's status line — the loop speaking, in the household's words.
 *
 * `now` is passed rather than read so the durations tick with the panel's own clock and so this can
 * be tested at a fixed instant.
 */
export function zoneStatus(zone: ClimateZoneDto, state: ZoneStateName, now: number): ZoneStatus {
  const since = (iso: string | null) => (iso ? duration(now - new Date(iso).getTime()) : '')

  switch (state) {
    case 'holding':
      return {
        tone: 'live',
        text: zone.steadySinceUtc
          ? `HOLDING · STEADY ${since(zone.steadySinceUtc)}`
          : 'HOLDING',
      }

    case 'correcting': {
      // "PULLING DOWN" is what the loop is doing to the room, not what the set point is doing —
      // the two move in opposite directions and only one of them is any of the household's business.
      const verb = zone.above ? 'PULLING DOWN' : 'PULLING UP'
      const target = zone.targetF == null ? '' : `${Math.round(zone.targetF)}°`
      // Omitted rather than guessed: an arrival time read off five minutes of data is worse than none.
      return { tone: 'brass', text: zone.etaLocal ? `${verb} · ${target} NEAR ${zone.etaLocal}` : verb }
    }

    case 'cantHold': {
      const way = zone.above ? 'OVER' : 'UNDER'
      const by = zone.deviationF == null ? '' : `${Math.round(zone.deviationF)}° ${way}`
      const forMins = zone.outsideMinutes == null ? '' : ` FOR ${duration(zone.outsideMinutes * 60_000)}`
      return { tone: 'alert', text: `CAN'T HOLD · ${by}${forMins}` }
    }

    case 'borrowed': {
      const borrowed = zone.override == null ? '' : `${Math.round(zone.override.targetF)}°`
      const back = zone.standingTargetF == null ? '' : `${Math.round(zone.standingTargetF)}°`
      const at = zone.override == null ? '' : clock(zone.override.expiresAtUtc)
      return { tone: 'brass', text: `BORROWED ${borrowed} · BACK TO ${back} AT ${at}` }
    }

    case 'backOn': {
      const standing = zone.standingTargetF == null ? '' : `${Math.round(zone.standingTargetF)}°`
      const at = zone.overrideEndedAtUtc ? clock(zone.overrideEndedAtUtc) : ''
      return { tone: 'live', text: `BACK ON ${standing} SINCE ${at}` }
    }

    /*
     * The one place the handoff contradicts itself, resolved toward safety.
     *
     * CLIMATE_SCREEN §5a gives 3a's outcome as `STANDING 69° · NO COUNTDOWN` — no way back — while
     * CLIMATE_BEHAVIOURS §6 states both paths land on `STANDING 69° SINCE 5:06 · UNDO` and that the
     * undo is present after *either*. One sentence is used for both, with the undo: a locked screen
     * that omits the exit from a permanent change is the reading that makes the section unsafe, and
     * "no countdown" is already visible in the countdown having gone.
     */
    case 'standing': {
      const standing = zone.standingTargetF == null ? '' : `${Math.round(zone.standingTargetF)}°`
      const at = zone.standingSetAtUtc ? ` SINCE ${clock(zone.standingSetAtUtc)}` : ''
      return { tone: 'live', text: `STANDING ${standing}${at}`, undo: true }
    }

    // How long it has been quiet is the useful half of this — but a probe that has never reported at
    // all has no "how long", and inventing one ("SILENT 1M") would misdescribe a room that has been
    // unread since the panel was installed. The clause is dropped rather than guessed.
    case 'probeLost':
      return {
        tone: 'danger',
        text: zone.probeSilentMinutes == null
          ? 'PROBE SILENT · UNIT ON ITS OWN SENSOR'
          : `PROBE SILENT ${duration(zone.probeSilentMinutes * 60_000)} · UNIT ON ITS OWN SENSOR`,
      }

    case 'paused': {
      const ago = zone.pausedAtUtc ? `${since(zone.pausedAtUtc)} AGO` : 'NOW'
      const left = zone.unitSetPointF == null ? '' : ` · UNIT LEFT AT ${Math.round(zone.unitSetPointF)}°`
      return { tone: 'muted', text: `PAUSED ${ago}${left}` }
    }

    case 'quiet':
      return { tone: 'muted', text: `QUIET · NO CHANGES UNTIL ${clockAmPm(zone.quietTo)}` }

    case 'unreachable':
      return {
        tone: 'danger',
        text: zone.unreachableSinceUtc
          ? `SENSIBO UNREACHABLE · RETRYING SINCE ${clock(zone.unreachableSinceUtc)}`
          : 'SENSIBO UNREACHABLE',
      }

    // Not "holding at 0" and not a blank row: a unit that is off is a fact, and pretending to hold
    // against it would be the loop claiming credit for a room nobody is conditioning.
    case 'unitOff':
      return { tone: 'muted', text: 'UNIT OFF · NOTHING TO HOLD' }

    case 'noProbe':
      return { tone: 'muted', text: 'NO PROBE · NOTHING TO READ' }

    case 'watched':
      return { tone: 'muted', text: 'WATCHED · NO UNIT IN THIS ROOM' }

    case 'inRange':
      return { tone: 'live', text: `IN RANGE · ${range(zone.rangeLowF, zone.rangeHighF)}` }

    case 'outOfRange': {
      const way = (zone.readingF ?? 0) > (zone.rangeHighF ?? 0) ? 'ABOVE' : 'BELOW';
      const forMins = duration((zone.outOfRangeMinutes ?? 0) * 60_000)
      // A freezer 2° warm and stable is a different problem from one 2° warm and climbing, and the
      // household should be able to tell them apart at a glance. Under 0.4°/h the server sends no
      // rate at all and the clause simply is not there.
      const trend = zone.ratePerHour == null
        ? ''
        : ` · ${zone.ratePerHour > 0 ? 'RISING' : 'FALLING'} ${Math.abs(zone.ratePerHour).toFixed(1)}°/H`
      return { tone: 'danger', text: `${way} RANGE ${forMins}${trend}` }
    }
  }
}

/**
 * The section's one-line state, under the title.
 *
 * **Never a count of rooms that are fine.** The right-hand clause states the one thing that is not
 * ordinary, or the instruction if everything is (CLIMATE_SCREEN §2).
 */
export function loopLine(
  zones: ClimateZoneDto[], housePaused: boolean, staleMinutes: number | null,
): { lead: string; leadTone: Tone; clause: string; clauseTone: Tone } {
  const automated = zones.filter((z) => z.class === 'Automated')
  const handedBack = automated.filter((z) => z.state === 'probeLost' || z.state === 'unreachable').length
  const quiet = automated.filter((z) => z.state === 'quiet')

  const stale = staleMinutes == null ? null : `· LAST HEARD ${staleMinutes} MIN AGO`

  if (housePaused) {
    return {
      lead: 'LOOP PAUSED', leadTone: 'alert',
      clause: stale ?? '· NO ROOM IS BEING HELD', clauseTone: stale ? 'alert' : 'disabled',
    }
  }
  if (stale) return { lead: 'LOOP RUNNING', leadTone: 'live', clause: stale, clauseTone: 'alert' }
  if (handedBack > 0) {
    return {
      lead: 'LOOP RUNNING', leadTone: 'live',
      clause: `· ${handedBack} ROOM${handedBack === 1 ? '' : 'S'} ON ${handedBack === 1 ? 'ITS' : 'THEIR'} OWN SENSOR`,
      clauseTone: 'disabled',
    }
  }
  // Quiet is a whole-section state only when every room that can be held is in it — one bedroom on a
  // different schedule is a row's business, not the section's.
  if (quiet.length > 0 && quiet.length === automated.length) {
    return {
      lead: 'LOOP QUIET', leadTone: 'muted',
      clause: `· NO CHANGES UNTIL ${clockAmPm(quiet[0].quietTo)}`, clauseTone: 'disabled',
    }
  }
  return { lead: 'LOOP RUNNING', leadTone: 'live', clause: '· PRESS A ROOM TO BORROW IT', clauseTone: 'disabled' }
}

/**
 * The state the row actually renders, which is not always the one the server sent.
 *
 * The server reports what is true of the house. `standing` is true of *this panel* — it means "you
 * changed this a moment ago and can still take it back" — so it is raised here, from what the session
 * has seen itself do, and only while there is a previous target to restore.
 */
export function rowState(zone: ClimateZoneDto, promotedThisSession: ReadonlySet<number>): ZoneStateName {
  if (
    zone.class === 'Automated'
    && promotedThisSession.has(zone.id)
    && zone.previousStandingTargetF != null
    && (zone.state === 'holding' || zone.state === 'correcting' || zone.state === 'quiet' || zone.state === 'backOn')
  ) return 'standing'
  return zone.state
}
