import { describe, expect, it } from 'vitest'
import { PLOT_PAD, labelAnchor, nearestReading, plotTemperatures } from './tempPlot'

const reading = (label: string, tempF: number | null) => ({ label, tempF })

/** A freezer window: sub-zero throughout, which is the case the bar chart drew wrongly. */
const freezer = [
  reading('6P', -6), reading('8P', -6), reading('10P', -5), reading('12A', -6),
  reading('2A', -7), reading('4A', -10),
]

describe('placing the readings', () => {
  it('puts each point over the centre of its own column, so the trace lines up with the times', () => {
    const { points } = plotTemperatures([reading('6P', -6), reading('8P', -5), reading('10P', -4), reading('12A', -3)])

    expect(points.map((p) => p.x)).toEqual([12.5, 37.5, 62.5, 87.5])
  })

  it('draws warmer readings higher up the plot', () => {
    const { points, high, low } = plotTemperatures(freezer)

    // y runs downwards, so the warmest reading has the smallest y.
    expect(high!.tempF).toBe(-5)
    expect(low!.tempF).toBe(-10)
    expect(high!.y).toBeLessThan(low!.y)
    expect(Math.min(...points.map((p) => p.y))).toBe(high!.y)
  })

  it('leaves air above and below the extremes, so their labels have somewhere to go', () => {
    const { high, low } = plotTemperatures(freezer)

    expect(high!.y).toBe(PLOT_PAD)
    expect(low!.y).toBe(100 - PLOT_PAD)
  })

  it('draws a window that never moved straight through the middle', () => {
    // The scale has no span here; dividing by it is the obvious way to get NaN across the chart.
    const { points } = plotTemperatures([reading('6P', 40), reading('8P', 40), reading('10P', 40)])

    expect(points.map((p) => p.y)).toEqual([50, 50, 50])
  })

  it('reports nothing plottable rather than a chart of nulls', () => {
    const empty = plotTemperatures([reading('6P', null), reading('8P', null)])

    expect(empty.points).toEqual([])
    expect(empty.lines).toEqual([])
    expect(empty.high).toBeNull()
  })
})

describe('gaps', () => {
  it('breaks the line rather than running a straight edge across an hour nobody recorded', () => {
    const { lines, points } = plotTemperatures([
      reading('6P', -6), reading('8P', -5), reading('10P', null), reading('12A', -4), reading('2A', -3),
    ])

    expect(points).toHaveLength(4)
    expect(lines).toHaveLength(2)
  })

  it('gives a lone reading between two gaps no line at all — the dot is all that is known', () => {
    const { lines, areas, points } = plotTemperatures([
      reading('6P', null), reading('8P', -5), reading('10P', null),
    ])

    expect(points).toHaveLength(1)
    expect(lines).toEqual([])
    expect(areas).toEqual([])
  })

  it('closes each area run to the floor so the wash sits under its own stretch of line', () => {
    const { areas } = plotTemperatures([reading('6P', -6), reading('8P', -5)])

    expect(areas).toHaveLength(1)
    expect(areas[0]).toMatch(/^M/)
    expect(areas[0]).toMatch(/ 100 L.* 100 Z$/)
  })
})

describe('the nearest reading to a touch', () => {
  it('picks the column the finger is over', () => {
    const { points } = plotTemperatures(freezer)

    expect(nearestReading(points, 0)!.label).toBe('6P')
    expect(nearestReading(points, 100)!.label).toBe('4A')
    expect(nearestReading(points, 60)!.label).toBe('12A')
  })

  it('settles a finger landing exactly between two columns on the earlier one', () => {
    // Six readings put their centres at 8.33 … 91.67, so 50 is equidistant from the third and the
    // fourth. Either would be defensible; what matters is that it is the *same* one every time,
    // rather than the trace flickering between two values under a still finger.
    const { points } = plotTemperatures(freezer)

    expect(nearestReading(points, 50)!.label).toBe('10P')
  })

  it('answers nothing when there is nothing plotted', () => {
    expect(nearestReading([], 50)).toBeNull()
  })
})

describe('label anchoring', () => {
  it('pins the end labels to the edges so they are not clipped', () => {
    expect(labelAnchor(4)).toBe('start')
    expect(labelAnchor(50)).toBe('middle')
    expect(labelAnchor(96)).toBe('end')
  })
})
