import type { ActiveAlertDto } from '../api/types'
import { clockLabel } from './dates'

/**
 * Reading an NWS product into the shape the statement sheet renders
 * (`design_handoff_weather_alert/ALERT_SHEET.md` §2).
 *
 * All of it is pure and lives outside the component because NWS text is the part most likely to
 * surprise us — the tag conventions below are typographic habits of the forecast offices, not
 * guarantees of the CAP schema, and the only way to be confident about a habit is to test it
 * against real products.
 */

/** One `HAZARD…` / `SOURCE…` / `IMPACT…` row of a warning. */
export interface AlertTag {
  label: string
  text: string
}

/** A parsed alert product, with every section already decided to be present or absent. */
export interface AlertProduct {
  /** The sheet's title — CAP `event`, uppercased. */
  title: string
  /** `Issued 2:14 PM CDT by NWS Minneapolis MN`, or null when neither half is known. */
  issued: string | null
  /** `2:14 PM → 3:15 PM`, or null when there is no window to state. */
  inEffect: string | null
  /** `Minor · expected · likely`, or null when CAP said none of the three. */
  severityLine: string | null
  /** Counties, re-joined with commas. Null for anything that is not geographic. */
  counties: string | null
  /** THE WARNING rows. Empty for statements and advisories, which carry no tags. */
  tags: AlertTag[]
  /** WHAT NWS SAYS, as paragraphs, with anything already consumed by `tags` removed. */
  paragraphs: string[]
  /** PRECAUTIONS. Null when CAP carried no instruction — the section is omitted, not emptied. */
  precautions: string | null
  /** `National Weather Service · NWS-IDP-PROD-4620381`, or null without a product id. */
  provenance: string | null
}

/**
 * The tags NWS writes into warning descriptions, as literal uppercase labels followed by an
 * ellipsis. Ordered as the offices write them, which is also the order the sheet shows.
 */
const TAGS = ['HAZARD', 'SOURCE', 'IMPACT', 'RECOMMENDED ACTION'] as const

/**
 * NWS hard-wraps description text at ~70 columns. Those newlines are a teletype artifact, not
 * meaning: a single newline joins, a blank line is a real paragraph break.
 */
function reflow(text: string): string[] {
  return text
    .split(/\n[ \t]*\n+/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean)
}

/**
 * Split a description into its tagged rows and whatever prose is left over.
 *
 * Only tags at the start of a line count. A description that merely uses the word "impact" in a
 * sentence is prose, and treating it as a label would cut the sentence in half.
 */
export function splitTags(description: string): { tags: AlertTag[]; rest: string } {
  const pattern = new RegExp(String.raw`^(${TAGS.join('|')})\.\.\.`, 'gim')
  const marks: { label: string; from: number; to: number }[] = []
  for (const m of description.matchAll(pattern)) {
    const at = m.index ?? 0
    marks.push({ label: m[1].toUpperCase(), from: at, to: at + m[0].length })
  }
  if (marks.length === 0) return { tags: [], rest: description }

  const tags: AlertTag[] = []
  // Everything the tags did not claim, in order, to be rejoined as WHAT NWS SAYS.
  const leftover: string[] = [description.slice(0, marks[0].from)]

  marks.forEach((mark, i) => {
    const limit = i + 1 < marks.length ? marks[i + 1].from : description.length
    /*
     * A tag ends at its own paragraph break, not at the next tag.
     *
     * NWS puts the "Locations impacted include..." paragraph after the tagged block, and running
     * each tag to the next mark swallows it into IMPACT — which is where it was going, since IMPACT
     * is usually last. The design puts that paragraph under WHAT NWS SAYS, so the blank line has to
     * be the boundary.
     */
    const para = description.slice(mark.to, limit).search(/\n[ \t]*\n/)
    const end = para === -1 ? limit : mark.to + para

    const text = description.slice(mark.to, end).replace(/\s*\n\s*/g, ' ').trim()
    if (text) tags.push({ label: mark.label, text })
    leftover.push(description.slice(end, limit))
  })

  return { tags, rest: leftover.join('\n\n') }
}

/** `Hennepin; Ramsey; Anoka` → `Hennepin, Ramsey, Anoka`. */
export function formatCounties(areaDesc: string | null | undefined): string | null {
  if (!areaDesc) return null
  const parts = areaDesc.split(';').map((s) => s.trim()).filter(Boolean)
  return parts.length ? parts.join(', ') : null
}

/**
 * `Minor · expected · likely` — CAP's severity, urgency and certainty, with only the first
 * capitalised. The lowercasing is the design's: it reads as one phrase rather than three labels.
 */
export function formatSeverityLine(alert: ActiveAlertDto): string | null {
  const severity = alert.severityText ?? alert.severity
  const parts = [severity, alert.urgency, alert.certainty].filter((s): s is string => !!s)
  if (parts.length === 0) return null
  return parts.map((p, i) => (i === 0 ? p : p.toLowerCase())).join(' · ')
}

function at(iso: string | null | undefined): Date | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * The IN EFFECT window. `ends` is preferred over `expires` because they differ: a warning can be in
 * force until 9:00 while its CAP record lingers past that, and the household cares about the former.
 */
export function formatWindow(alert: ActiveAlertDto): string | null {
  const start = at(alert.onsetUtc) ?? at(alert.sentUtc) ?? at(alert.startedAtUtc)
  const end = at(alert.endsUtc) ?? at(alert.expiresAtUtc)
  if (!start && !end) return null
  if (!end) return `From ${clockLabel(start!)}`
  if (!start) return `Until ${clockLabel(end)}`
  return `${clockLabel(start)} → ${clockLabel(end)}`
}

/**
 * The panel's timezone abbreviation — `CDT`.
 *
 * The only place in the app that prints one. It earns it here: this line and the provenance footer
 * exist so somebody can check the panel against weather.gov, and an issue time without a zone is
 * not checkable. Returns null if the runtime has no short name to give, rather than inventing one.
 */
export function zoneAbbrev(d: Date): string | null {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
      .formatToParts(d)
      .find((p) => p.type === 'timeZoneName')?.value
    // Intl falls back to offsets like "GMT+2" where it has no abbreviation; those say less than
    // nothing on a wall panel, so drop them.
    return part && !/GMT|UTC[+-]/.test(part) ? part : null
  } catch {
    return null
  }
}

/** `Issued 2:14 PM CDT by NWS Minneapolis MN` — either half alone still says something useful. */
function formatIssued(alert: ActiveAlertDto): string | null {
  const sent = at(alert.sentUtc)
  const by = alert.senderName ? `by ${alert.senderName}` : null
  if (!sent && !by) return null
  if (!sent) return by
  const zone = zoneAbbrev(sent)
  const when = `Issued ${clockLabel(sent)}${zone ? ` ${zone}` : ''}`
  return by ? `${when} ${by}` : when
}

/**
 * Whether this alert has a product worth opening a sheet for.
 *
 * `event` is the test because it is the sheet's title. A sensor-threshold alert has none, so its
 * banner stays inert rather than opening a sheet with a heading and nothing under it.
 */
export function hasProduct(alert: ActiveAlertDto | undefined): alert is ActiveAlertDto {
  return !!alert?.event
}

/**
 * The banner's detail line, with the event name taken off the front.
 *
 * The stored message is `"{event}: {headline}"`, which is how `alertHeadline` reads a title out of
 * alerts that have no `event` of their own. Once the title comes from `event` directly that prefix
 * is the title printed twice, and on a 540px banner it costs a whole second line — see
 * `design_handoff_weather_alert/screens/weather-alert-statement.png`, where the detail is the part
 * after the colon alone.
 */
export function alertDetail(alert: ActiveAlertDto): string {
  const message = alert.message.trim()
  if (!alert.event) return message
  const prefix = `${alert.event}:`
  return message.toLowerCase().startsWith(prefix.toLowerCase())
    ? message.slice(prefix.length).trim() || message
    : message
}

/** Read an alert into the sheet's sections. */
export function readProduct(alert: ActiveAlertDto): AlertProduct {
  const description = alert.description?.trim() ?? ''
  const { tags, rest } = splitTags(description)

  return {
    title: (alert.event ?? 'Weather Alert').toUpperCase(),
    issued: formatIssued(alert),
    inEffect: formatWindow(alert),
    severityLine: formatSeverityLine(alert),
    counties: formatCounties(alert.areaDesc),
    tags,
    paragraphs: reflow(rest),
    precautions: alert.instruction?.trim() || null,
    provenance: alert.productId ? `National Weather Service · ${alert.productId}` : null,
  }
}

/**
 * The alert the banner should name when several are live at once.
 *
 * NWS commonly has a statement and a warning active together, and the order it returns them in is
 * not severity order. Picking the first — which is what this replaced — could leave a Tornado
 * Warning hidden behind a Special Weather Statement on the one screen meant to catch it. Ties keep
 * source order, so a steady set of alerts produces a steady banner.
 */
export function mostSevere(alerts: readonly ActiveAlertDto[]): ActiveAlertDto | undefined {
  const rank = { Severe: 3, Warning: 2, Info: 1 } as const
  let best: ActiveAlertDto | undefined
  for (const a of alerts) {
    if (!best || (rank[a.severity] ?? 0) > (rank[best.severity] ?? 0)) best = a
  }
  return best
}
