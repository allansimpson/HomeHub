/**
 * When the panel is dark, and why.
 *
 * Three inputs decide it and they are deliberately independent:
 *
 *  - the **window** (`21:00–07:00`), a household setting, in local wall time;
 *  - the **schedule switch**, which says whether the window is consulted at all;
 *  - the **override**, a panel-local "not right now" that expires on its own.
 *
 * The separation is the whole design. Turning the schedule off to read a recipe at eleven at night
 * is a decision that outlives the recipe — the panel then never dims again, and nobody remembers
 * why. So the override is a different gesture with a different lifetime: it lasts until the window
 * next opens or closes, and then the schedule simply resumes.
 *
 * Pure functions, no clock of its own — every entry point takes `now`. That is what makes a window
 * that crosses midnight testable at all, and midnight is the normal case here rather than the edge.
 */

/** Minutes since local midnight for an `HH:mm` string, or null if it is not one. */
export function minutesOfDay(hhmm: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

/**
 * `HH:mm` for a local time, the form the settings and an `<input type="time">` both use.
 *
 * <b>The storage form, and no longer a display one.</b> Config used to print the override's expiry
 * through this — "the schedule takes over at 22:00" — and now says it with `dates.clockLabel`, like
 * every other time the panel says out loud. What is left here is the inverse of `minutesOfDay`,
 * which is how the window tests state a boundary as a clock rather than as a `Date`.
 */
export function toClock(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/**
 * Is `now` inside the window?
 *
 * A start later than the end is the **ordinary** case — a night window crosses midnight — so the
 * comparison flips rather than treating it as two windows.
 *
 * A start equal to the end is an empty window, not a full day. Both readings are defensible and only
 * one of them can strand somebody with a permanently dark panel and no obvious way back; saying
 * "never" is what the schedule switch is for, and this input can only ever have been a slip.
 */
export function isWithinWindow(now: Date, start: string, end: string): boolean {
  const from = minutesOfDay(start)
  const to = minutesOfDay(end)
  // An unreadable window dims nothing. The panel showing its normal brightness is the state that
  // needs no explanation; a dark screen from a malformed setting is a fault report waiting to happen.
  if (from === null || to === null || from === to) return false

  const at = now.getHours() * 60 + now.getMinutes()
  return from < to ? at >= from && at < to : at >= from || at < to
}

/**
 * The next moment the window opens or closes, which is when a manual override stops applying.
 *
 * Returned as a real `Date` rather than a delay so a panel left running across a clock change lands
 * on the right wall-clock minute rather than on "eight hours from when you tapped it".
 */
export function nextBoundary(now: Date, start: string, end: string): Date | null {
  const from = minutesOfDay(start)
  const to = minutesOfDay(end)
  if (from === null || to === null || from === to) return null

  const at = now.getHours() * 60 + now.getMinutes()
  // Strictly after now, so a boundary landing on this very minute does not expire an override the
  // instant it is set.
  const next = [from, to]
    .map((minute) => (minute > at ? minute : minute + 1440))
    .reduce((a, b) => Math.min(a, b))

  const when = new Date(now)
  when.setHours(0, 0, 0, 0)
  when.setMinutes(next)
  return when
}

/** A panel-local "not right now", and the moment it stops applying. */
export interface NightOverride {
  /** What the household asked for, against whatever the schedule says. */
  dim: boolean
  /** Epoch ms. Past this the schedule resumes with nothing to undo. */
  untilMs: number
}

/**
 * Whether the panel should be dark, given everything.
 *
 * The override wins while it lasts and is ignored the moment it does not — no separate expiry timer,
 * because a value that expires by being read cannot be left behind by a missed tick.
 */
export function shouldDim(
  now: Date,
  { enabled, start, end }: { enabled: boolean; start: string; end: string },
  override: NightOverride | null,
): boolean {
  if (override && now.getTime() < override.untilMs) return override.dim
  return enabled && isWithinWindow(now, start, end)
}
