/**
 * The 24-hour temperature trace, as geometry — where each reading sits in the plot, and the path
 * through them.
 *
 * <b>Why this is a line and was a bar chart.</b> Bars grow from a baseline and are read as
 * magnitude: the length of the bar *is* the quantity. Temperature has no meaningful zero on this
 * screen — the freezer sits between −5° and −10° — so the bars grew from a floor the data never
 * touches, and the reader compared lengths that meant nothing. A −5° column drawn three times the
 * height of a −7° one is not a rounding artefact; it is the chart saying something false about the
 * freezer, on the screen whose whole job is "is it holding". A line answers the question actually
 * being asked, which is change over time, and it may legitimately sit on a truncated range.
 *
 * Pure and apart from the screen because the interesting parts are arithmetic: a gap in the
 * readings has to become a gap in the line rather than a straight run through it, a flat window
 * must not divide by zero, and the points have to land on the same centres as the time labels
 * underneath them.
 *
 * Coordinates are percentages of the plot box — x across, y *down*, so a warmer reading has the
 * smaller y. Percentages rather than pixels so nothing here needs to know how wide the panel is.
 */

/** One reading, as the API sends it. Null is a window with nothing recorded in it. */
export interface TempReading {
  label: string
  tempF: number | null
}

export interface PlotPoint {
  /** Position in the original series, which is what the screen holds when one is selected. */
  index: number
  label: string
  tempF: number
  x: number
  y: number
}

export interface TempPlot {
  points: PlotPoint[]
  /** One `d` per unbroken run — see `PLOT_PAD` and the gap note above. */
  lines: string[]
  /** The same runs closed to the floor, for the wash under the line. */
  areas: string[]
  /** The warmest and coldest readings in the window: the only two the chart names. */
  high: PlotPoint | null
  low: PlotPoint | null
  min: number
  max: number
}

/**
 * How much of the plot height is left as air above the warmest reading and below the coldest.
 *
 * Not decoration: the extremes carry a printed value each, and a trace that touched the ceiling
 * would put that text outside the box. It is also what stops a flat-looking day from being drawn
 * edge to edge as though it had swung wildly.
 */
export const PLOT_PAD = 14

/** Two decimals is under a tenth of a pixel at any panel size, and keeps the `d` readable. */
const round = (n: number): number => Math.round(n * 100) / 100

export function plotTemperatures(readings: TempReading[]): TempPlot {
  const values = readings.map((r) => r.tempF).filter((v): v is number => v != null)
  if (values.length === 0) {
    return { points: [], lines: [], areas: [], high: null, low: null, min: 0, max: 0 }
  }

  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min

  const points: PlotPoint[] = []
  readings.forEach((r, index) => {
    if (r.tempF == null) return
    // The centre of this reading's share of the width, so the trace lands over the time label
    // beneath it rather than between two of them.
    const x = ((index + 0.5) / readings.length) * 100
    // A window that never moved has no range to scale against; it is drawn straight through the
    // middle, which is the truth about it. Dividing by the span would be a division by zero.
    const y = span === 0 ? 50 : 100 - PLOT_PAD - ((r.tempF - min) / span) * (100 - PLOT_PAD * 2)
    points.push({ index, label: r.label, tempF: r.tempF, x: round(x), y: round(y) })
  })

  // Runs of consecutive readings. A missing hour breaks the line rather than being interpolated
  // across: the panel would otherwise draw a confident straight edge over the part of the night it
  // has no idea about.
  const runs: PlotPoint[][] = []
  let run: PlotPoint[] = []
  for (const p of points) {
    if (run.length > 0 && p.index !== run[run.length - 1].index + 1) {
      runs.push(run)
      run = []
    }
    run.push(p)
  }
  if (run.length > 0) runs.push(run)

  const lines = runs
    // A run of one has no line in it — the dot is the whole of what is known there.
    .filter((r) => r.length > 1)
    .map((r) => r.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' '))

  const areas = runs
    .filter((r) => r.length > 1)
    .map((r) => {
      const top = r.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ')
      return `${top} L${r[r.length - 1].x} 100 L${r[0].x} 100 Z`
    })

  // First occurrence on a tie, so a steady window names its earliest reading rather than silently
  // preferring the newest — the two labels are about the shape of the window, not about now.
  const high = points.reduce((best, p) => (p.tempF > best.tempF ? p : best), points[0])
  const low = points.reduce((best, p) => (p.tempF < best.tempF ? p : best), points[0])

  return { points, lines, areas, high, low, min, max }
}

/** The reading nearest a touch, as a fraction across the plot. Null when there is nothing plotted. */
export function nearestReading(points: PlotPoint[], xPercent: number): PlotPoint | null {
  if (points.length === 0) return null
  return points.reduce((best, p) =>
    Math.abs(p.x - xPercent) < Math.abs(best.x - xPercent) ? p : best,
  )
}

/**
 * How a label at this x should sit against its point.
 *
 * A label centred on the first or last reading hangs off the side of the plot, where it is clipped
 * or pushes the layout. The two ends anchor to the edge instead; everything between is centred.
 */
export function labelAnchor(x: number): 'start' | 'middle' | 'end' {
  if (x < 15) return 'start'
  if (x > 85) return 'end'
  return 'middle'
}
