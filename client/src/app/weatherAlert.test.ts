import { describe, expect, it } from 'vitest'
import {
  alertDetail,
  formatCounties,
  formatSeverityLine,
  formatWindow,
  hasProduct,
  mostSevere,
  readProduct,
  splitTags,
} from './weatherAlert'
import type { ActiveAlertDto } from '../api/types'

/**
 * These are pinned against the shape of real NWS products, because the parsing they exercise is a
 * bet on the *typographic conventions* of the forecast offices — the `HAZARD...` labels, the hard
 * line wraps, the semicolon county list — none of which the CAP schema actually guarantees. A test
 * suite is the only place that bet is written down.
 */

/** A Special Weather Statement, as `design_handoff_weather_alert/screens/weather-alert-statement.png`. */
function statement(over: Partial<ActiveAlertDto> = {}): ActiveAlertDto {
  return {
    id: 1,
    type: 'weather',
    severity: 'Warning',
    message: 'Special Weather Statement: strong storm near Edina',
    source: 'weather',
    startedAtUtc: '2026-08-27T19:14:00Z',
    expiresAtUtc: '2026-08-27T20:15:00Z',
    event: 'Special Weather Statement',
    description:
      'At 2:14 PM CDT, Doppler radar was tracking a strong thunderstorm\nnear Edina, moving east at 30 mph.\n\nWinds in excess of 40 mph and pea size hail will be possible with\nthis storm.',
    instruction: null,
    areaDesc: 'Hennepin; Ramsey; Anoka',
    senderName: 'NWS Minneapolis MN',
    sentUtc: '2026-08-27T19:14:00Z',
    onsetUtc: '2026-08-27T19:14:00Z',
    endsUtc: '2026-08-27T20:15:00Z',
    urgency: 'Expected',
    certainty: 'Likely',
    severityText: 'Minor',
    productId: 'NWS-IDP-PROD-4620381',
    ...over,
  }
}

describe('splitTags', () => {
  /** The whole reason THE WARNING section exists: NWS writes the labels into the prose itself. */
  it('pulls HAZARD / SOURCE / IMPACT out of a warning description', () => {
    const description = [
      'At 7:52 PM CDT, a severe thunderstorm was located over Minnetonka.',
      '',
      'HAZARD...60 mph wind gusts and quarter size hail.',
      '',
      'SOURCE...Radar indicated.',
      '',
      'IMPACT...Hail damage to vehicles is expected. Expect wind damage',
      'to roofs, siding and trees.',
      '',
      'Locations impacted include Minneapolis, Saint Paul and Edina.',
    ].join('\n')

    const { tags, rest } = splitTags(description)

    expect(tags).toEqual([
      { label: 'HAZARD', text: '60 mph wind gusts and quarter size hail.' },
      { label: 'SOURCE', text: 'Radar indicated.' },
      {
        label: 'IMPACT',
        text: 'Hail damage to vehicles is expected. Expect wind damage to roofs, siding and trees.',
      },
    ])
    // Prose either side of the tagged block survives, and only the tagged part is consumed. The
    // trailing paragraph is the one that matters: NWS writes it after the tags, and a tag that ran
    // to the next mark rather than to its own blank line would have eaten it into IMPACT.
    expect(rest).toContain('At 7:52 PM CDT, a severe thunderstorm was located over Minnetonka.')
    expect(rest).toContain('Locations impacted include Minneapolis, Saint Paul and Edina.')
    expect(rest).not.toContain('quarter size hail')
  })

  /** Statements and advisories carry no tags, and must not grow an empty section. */
  it('finds nothing to tag in a plain statement', () => {
    const { tags, rest } = splitTags('Winds in excess of 40 mph will be possible with this storm.')
    expect(tags).toEqual([])
    expect(rest).toBe('Winds in excess of 40 mph will be possible with this storm.')
  })

  /**
   * The reason the pattern is anchored to the start of a line. NWS uses these words in ordinary
   * sentences, and splitting on those would cut the sentence in half and label the second piece.
   */
  it('ignores the tag words used mid-sentence', () => {
    const { tags } = splitTags('The impact...on travel is uncertain, and the source of the gusts is unclear.')
    expect(tags).toEqual([])
  })
})

describe('readProduct', () => {
  /** NWS hard-wraps at ~70 columns; those newlines are teletype, not paragraphs. */
  it('reflows the hard line wraps but keeps the paragraph breaks', () => {
    expect(readProduct(statement()).paragraphs).toEqual([
      'At 2:14 PM CDT, Doppler radar was tracking a strong thunderstorm near Edina, moving east at 30 mph.',
      'Winds in excess of 40 mph and pea size hail will be possible with this storm.',
    ])
  })

  it('titles itself from the event, uppercased', () => {
    expect(readProduct(statement()).title).toBe('SPECIAL WEATHER STATEMENT')
  })

  it('names the office and the product for the provenance footer', () => {
    expect(readProduct(statement()).provenance).toBe('National Weather Service · NWS-IDP-PROD-4620381')
  })

  /** A description that is only tags leaves WHAT NWS SAYS with nothing, and the section is dropped. */
  it('leaves no paragraphs when the description was entirely tagged', () => {
    const product = readProduct(statement({ description: 'HAZARD...60 mph wind gusts.' }))
    expect(product.tags).toHaveLength(1)
    expect(product.paragraphs).toEqual([])
  })

  it('survives an alert carrying no product text at all', () => {
    const product = readProduct(
      statement({ description: null, areaDesc: null, productId: null, sentUtc: null, senderName: null }),
    )
    expect(product.paragraphs).toEqual([])
    expect(product.tags).toEqual([])
    expect(product.counties).toBeNull()
    expect(product.provenance).toBeNull()
    expect(product.issued).toBeNull()
  })
})

describe('formatCounties', () => {
  it('rejoins the semicolon list with commas', () => {
    expect(formatCounties('Hennepin; Ramsey; Anoka')).toBe('Hennepin, Ramsey, Anoka')
  })

  /** Absent, not empty — the COUNTIES row is omitted rather than printed blank. */
  it('is null for nothing, so the row disappears', () => {
    expect(formatCounties(null)).toBeNull()
    expect(formatCounties('  ')).toBeNull()
  })
})

describe('formatSeverityLine', () => {
  it('capitalises only the first of the three', () => {
    expect(formatSeverityLine(statement())).toBe('Minor · expected · likely')
  })

  /** CAP's own word wins over the collapsed enum: Extreme and Severe share one banner treatment. */
  it('prefers the severity NWS wrote to the one the engine mapped', () => {
    expect(formatSeverityLine(statement({ severity: 'Severe', severityText: 'Extreme' })))
      .toBe('Extreme · expected · likely')
  })

  it('falls back to the mapped severity when CAP gave no word', () => {
    expect(formatSeverityLine(statement({ severityText: null, urgency: null, certainty: null })))
      .toBe('Warning')
  })
})

describe('formatWindow', () => {
  /**
   * `ends` beats `expires`. They differ in practice — a warning stops being in force before its CAP
   * record lapses — and the household cares which hour to be indoors for, not which record is live.
   */
  it('prefers ends over expires for the end of the window', () => {
    const window = formatWindow(
      statement({ endsUtc: '2026-08-27T20:15:00Z', expiresAtUtc: '2026-08-27T23:00:00Z' }),
    )
    expect(window).toContain('→')
    expect(window).not.toBeNull()
  })

  it('says Until when there is no start to state', () => {
    expect(formatWindow(statement({ onsetUtc: null, sentUtc: null, startedAtUtc: '' })))
      .toMatch(/^Until /)
  })

  it('is null when there is no window at all', () => {
    expect(
      formatWindow(
        statement({ onsetUtc: null, sentUtc: null, startedAtUtc: '', endsUtc: null, expiresAtUtc: null }),
      ),
    ).toBeNull()
  })
})

describe('alertDetail', () => {
  /** The title comes from `event` now, so leaving the prefix on prints the name twice. */
  it('drops the event prefix the banner title already says', () => {
    expect(alertDetail(statement())).toBe('strong storm near Edina')
  })

  it('leaves a message that does not start with the event alone', () => {
    expect(alertDetail(statement({ message: 'Until 3:15 PM · strong storm near Edina' })))
      .toBe('Until 3:15 PM · strong storm near Edina')
  })

  /** A sensor alert has no event, so there is no prefix to take off. */
  it('leaves a message alone when there is no event', () => {
    expect(alertDetail(statement({ event: null, message: 'Freezer above 0°F' }))).toBe('Freezer above 0°F')
  })

  /** Stripping down to nothing would leave a banner with a title and a blank line under it. */
  it('keeps the message when the event is the whole of it', () => {
    expect(alertDetail(statement({ message: 'Special Weather Statement:' })))
      .toBe('Special Weather Statement:')
  })
})

describe('hasProduct', () => {
  it('is true for an NWS alert, which has an event to title a sheet with', () => {
    expect(hasProduct(statement())).toBe(true)
  })

  /**
   * A sensor threshold has no product. Its banner must stay inert rather than opening a sheet with
   * a heading and nothing underneath it.
   */
  it('is false for a sensor alert, so its banner opens nothing', () => {
    expect(hasProduct(statement({ event: null }))).toBe(false)
    expect(hasProduct(undefined)).toBe(false)
  })
})

describe('mostSevere', () => {
  /**
   * The bug this exists to prevent: NWS returns a statement and a warning together, in no
   * particular order, and taking the head of the list can hide the tornado behind the statement.
   */
  it('picks the warning over a statement listed before it', () => {
    const picked = mostSevere([
      statement({ id: 1, severity: 'Info', event: 'Special Weather Statement' }),
      statement({ id: 2, severity: 'Severe', event: 'Tornado Warning' }),
    ])
    expect(picked?.event).toBe('Tornado Warning')
  })

  /** Ties keep source order, so a steady set of alerts produces a banner that does not flicker. */
  it('keeps the first of equals', () => {
    const picked = mostSevere([
      statement({ id: 1, severity: 'Severe', event: 'Tornado Warning' }),
      statement({ id: 2, severity: 'Severe', event: 'Severe Thunderstorm Warning' }),
    ])
    expect(picked?.id).toBe(1)
  })

  it('is undefined when nothing is active', () => {
    expect(mostSevere([])).toBeUndefined()
  })
})
