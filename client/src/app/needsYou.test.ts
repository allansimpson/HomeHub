import { describe, expect, it } from 'vitest'
import { alertHeadline, alertTarget } from './needsYou'

/**
 * The dashboard and Weather banner the same weather alert, so they have to name it the same way.
 * These pin the headline, because "the two screens agree" is the whole reason this is one function
 * and not two `split(':')` calls in two files.
 */
describe('alertHeadline', () => {
  it('takes the name NWS puts before the colon', () => {
    expect(alertHeadline({ message: 'Winter Storm Warning: heavy snow expected', severity: 'Warning', source: 'weather' }))
      .toBe('Winter Storm Warning')
  })

  /** Otherwise the title and the detail underneath it are the same sentence, printed twice. */
  it('does not repeat a message that has no colon in it', () => {
    expect(alertHeadline({ message: 'Heavy snow expected tonight', severity: 'Warning', source: 'weather' }))
      .toBe('Weather Alert')
  })

  it('falls back by severity first, so a severe alert says so', () => {
    expect(alertHeadline({ message: 'Basement is below freezing', severity: 'Severe', source: 'sensor:3' }))
      .toBe('Severe Alert')
  })

  it('has a fallback for sources that are neither', () => {
    expect(alertHeadline({ message: 'Litter tray is full', severity: 'Warning', source: 'cat:litter_robot_4' }))
      .toBe('Alert')
  })
})

describe('alertTarget', () => {
  it('sends a weather alert to the screen that explains it', () => {
    expect(alertTarget('weather')).toBe('/weather')
  })

  it('sends a sensor alert to its own zone', () => {
    expect(alertTarget('sensor:3')).toBe('/sensor?zone=3')
    expect(alertTarget('sensor')).toBe('/sensor')
  })
})
