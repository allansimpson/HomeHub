import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { DrillInHeader, ScreenShell, ScrollArea, Chip, AlertBanner, EmptyState } from '../components'
import { useSensors } from '../app/SensorsProvider'
import { useConnection } from '../app/ConnectionProvider'
import { api, ApiError } from '../api/client'
import type { ZoneHistoryDto } from '../api/types'
import { PLOT_PAD, labelAnchor, nearestReading, plotTemperatures } from './tempPlot'
import type { PlotPoint } from './tempPlot'

const REFRESH_MS = 30_000

/**
 * Sensor History (spec 04): room chips, the big current reading, the 24-hour temperature trace and
 * humidity meter rows — all from owned SQL history.
 *
 * The trace is a line rather than the twelve bars this screen shipped with. Bars are read as
 * magnitude from a baseline and there is no meaningful zero here — a sub-zero freezer made the
 * point unmissable — so they compared lengths that meant nothing. It is scaled to the window's own
 * range, which a line may legitimately be and a bar may not; `tempPlot.ts` holds the arithmetic.
 */
export function SensorHistoryScreen() {
  const navigate = useNavigate()
  const { zones, alerts } = useSensors()
  const { stale } = useConnection()
  const [params, setParams] = useSearchParams()

  const zoneParam = Number(params.get('zone'))
  const selectedId = zones.some((z) => z.id === zoneParam) ? zoneParam : zones[0]?.id ?? null

  const [history, setHistory] = useState<ZoneHistoryDto | null>(null)

  useEffect(() => {
    if (selectedId == null) return
    let cancelled = false
    const load = async () => {
      try {
        const h = await api.getZoneHistory(selectedId)
        if (!cancelled) setHistory(h)
      } catch (err) {
        if (!(err instanceof ApiError)) throw err
      }
    }
    void load()
    const id = window.setInterval(load, REFRESH_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [selectedId])

  const selectedZone = zones.find((z) => z.id === selectedId) ?? null
  const zoneAlert = alerts.find((a) => a.source === `sensor:${selectedId}`)

  if (zones.length === 0) {
    return (
      <ScreenShell header={<DrillInHeader title="Sensor History" status="24 Hours" onBack={() => navigate('/')} />}>
        <EmptyState label="No readings yet" hint="Sensor zones appear once the poller has data." />
      </ScreenShell>
    )
  }

  return (
    <ScreenShell
      header={
        <DrillInHeader
          title={selectedZone?.name ?? 'Sensor History'}
          status="Sensor History · 24 Hours"
          onBack={() => navigate('/')}
        />
      }
    >
      <ScrollArea>
        {zoneAlert && (
          <AlertBanner
            title={zoneAlert.severity === 'Severe' ? 'Severe Alert' : 'Alert'}
            detail={zoneAlert.message}
            severe={zoneAlert.severity === 'Severe'}
          />
        )}

        <div className="ml-sensor__chips">
          {zones.map((z) => (
            <Chip
              key={z.id}
              label={z.name}
              active={z.id === selectedId}
              onClick={() => setParams({ zone: String(z.id) })}
            />
          ))}
        </div>

        {history && <CurrentReading history={history} stale={stale} />}
        {history && <TemperatureChart history={history} />}
        {history && <HumidityMeters history={history} />}
      </ScrollArea>
    </ScreenShell>
  )
}

function CurrentReading({ history, stale }: { history: ZoneHistoryDto; stale: boolean }) {
  const today =
    history.todayHighF != null && history.todayLowF != null
      ? `Today: high ${history.todayHighF}° at ${history.todayHighAt} · low ${history.todayLowF}° at ${history.todayLowAt}`
      : 'Gathering today’s range…'
  return (
    <div className={'ml-sensor__current' + (stale ? ' ml-stale' : '')}>
      <span className="ml-sensor__temp serif">{history.currentTempF == null ? '—' : `${history.currentTempF}°`}</span>
      <div className="ml-sensor__meta">
        <span className="ml-sensor__now">
          {history.currentHumidity == null ? 'NO DATA' : `NOW · ${history.currentHumidity}% HUMIDITY`}
        </span>
        <span className="ml-sensor__today">{today}</span>
      </div>
    </div>
  )
}

/**
 * The 24-hour trace.
 *
 * <b>A line, where this was twelve bars.</b> Bars are read as magnitude from a baseline, and this
 * screen has no meaningful zero — the freezer lives between −5° and −10°, so the bars grew from a
 * floor the readings never approach and their heights compared nothing. See `tempPlot.ts`; the
 * geometry, the gaps and the scale all live there and are tested directly.
 *
 * <b>Two labels, not twelve.</b> Every column used to print its own number, which is the state a
 * chart is in when it has given up being read as a shape. The warmest and coldest readings in the
 * window are named — those are the two the household actually asks about — the scale rules say what
 * the trace is drawn against, and any single reading is one touch away.
 */
function TemperatureChart({ history }: { history: ZoneHistoryDto }) {
  const plot = useMemo(() => plotTemperatures(history.tempBars), [history.tempBars])
  const plotRef = useRef<HTMLDivElement>(null)
  /** The reading being inspected, by its index in the series. Null until somebody touches the plot. */
  const [heldIndex, setHeldIndex] = useState<number | null>(null)

  const held = plot.points.find((p) => p.index === heldIndex) ?? null
  const latest = plot.points.length > 0 ? plot.points[plot.points.length - 1] : null

  /*
   * Touch reads the trace.
   *
   * The bars printed all twelve values because there was no other way to have them; a line that
   * only ever showed its shape would be taking that away. Nearest-point rather than hit targets on
   * the dots themselves: the dots are 8px on a chart a finger covers, and asking somebody to hit
   * one on a wall panel is asking them to fail.
   */
  const pick = useCallback(
    (clientX: number) => {
      const box = plotRef.current?.getBoundingClientRect()
      if (!box || box.width === 0) return
      const near = nearestReading(plot.points, ((clientX - box.left) / box.width) * 100)
      setHeldIndex(near?.index ?? null)
    },
    [plot.points],
  )

  const summary =
    plot.high && plot.low
      ? `Temperature over the last 24 hours. High ${Math.round(plot.high.tempF)}° at ${plot.high.label}, low ${Math.round(plot.low.tempF)}° at ${plot.low.label}.`
      : 'Temperature over the last 24 hours. No readings yet.'

  return (
    <>
      <div className="ml-section">
        <span className="ml-section__label">Temperature</span>
        {/* Where the trace is drawn between. Without it a truncated scale — which this has to be,
            for a freezer — is a shape with nothing to read it against. */}
        {plot.high && plot.low && (
          <span className="ml-section__status">
            {`${Math.round(plot.low.tempF)}° – ${Math.round(plot.high.tempF)}°`}
          </span>
        )}
      </div>

      {plot.points.length === 0 ? (
        <p className="ml-templine__empty">Nothing has been recorded in this window.</p>
      ) : (
        <div className="ml-templine">
          <div
            ref={plotRef}
            className="ml-templine__plot"
            role="img"
            aria-label={summary}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId)
              pick(e.clientX)
            }}
            // Dragging along the trace reads across it. Only while the pointer is down: a mouse
            // crossing the chart on its way somewhere else is not an enquiry.
            onPointerMove={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId)) pick(e.clientX)
            }}
          >
            {/* The scale, as two recessive hairlines at the extremes of the window. */}
            <span className="ml-templine__rule" style={{ top: `${PLOT_PAD}%` }} aria-hidden="true" />
            <span className="ml-templine__rule" style={{ top: `${100 - PLOT_PAD}%` }} aria-hidden="true" />

            <svg
              className="ml-templine__svg"
              viewBox="0 0 100 100"
              // The plot is a box of whatever shape the panel gives it and the trace fills it; the
              // stroke is kept true by `vectorEffect` and everything that must not stretch — dots,
              // labels — is HTML on top rather than SVG inside.
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <defs>
                <linearGradient id="ml-templine-wash" x1="0" y1="0" x2="0" y2="1">
                  <stop className="ml-templine__washtop" offset="0" />
                  <stop className="ml-templine__washfoot" offset="1" />
                </linearGradient>
              </defs>
              {plot.areas.map((d, i) => (
                <path key={`a${i}`} className="ml-templine__area" d={d} />
              ))}
              {plot.lines.map((d, i) => (
                <path key={`l${i}`} className="ml-templine__stroke" d={d} vectorEffect="non-scaling-stroke" />
              ))}
            </svg>

            {/* The reading being inspected, marked the full height so it reads at a glance which
                column the number belongs to. */}
            {held && (
              <span className="ml-templine__hair" style={{ left: `${held.x}%` }} aria-hidden="true" />
            )}

            {plot.points.map((p) => (
              <span
                key={p.index}
                className={
                  'ml-templine__dot'
                  + (p.index === latest?.index ? ' ml-templine__dot--now' : '')
                  + (p.index === held?.index ? ' ml-templine__dot--held' : '')
                }
                style={{ left: `${p.x}%`, top: `${p.y}%` }}
                aria-hidden="true"
              />
            ))}

            {/* Held beats the extremes: it is the question just asked, and two numbers stacked on
                one column would collide. */}
            {held ? (
              <PlotLabel point={held} place="above" held />
            ) : (
              <>
                {plot.high && <PlotLabel point={plot.high} place="above" />}
                {plot.low && plot.low.index !== plot.high?.index && <PlotLabel point={plot.low} place="below" />}
              </>
            )}
          </div>

          <div className="ml-templine__axis" aria-hidden="true">
            {history.tempBars.map((bar, i) => (
              <span key={i} className="ml-templine__time">{bar.label}</span>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

/**
 * A value against its point — the window's extremes, or whatever is being touched.
 *
 * The anchor comes from `labelAnchor`: a label centred on the first or last reading hangs off the
 * side of the plot, and clipping the household's own numbers is not an acceptable way to place text.
 */
function PlotLabel({ point, place, held }: { point: PlotPoint; place: 'above' | 'below'; held?: boolean }) {
  const anchor = labelAnchor(point.x)
  return (
    <span
      className={
        `ml-templine__label ml-templine__label--${place} ml-templine__label--${anchor}`
        + (held ? ' ml-templine__label--held' : '')
      }
      style={{ left: `${point.x}%`, top: `${point.y}%` }}
    >
      <span className="ml-templine__labelvalue serif">{`${Math.round(point.tempF)}°`}</span>
      <span className="ml-templine__labeltime">{point.label}</span>
    </span>
  )
}

function HumidityMeters({ history }: { history: ZoneHistoryDto }) {
  return (
    <>
      <div className="ml-section">
        {/* The verdigris now lives on the label alone; the tick it used to sit on is gone with
            every other heading's. */}
        <span className="ml-section__label ml-section__label--live">Humidity</span>
      </div>
      <div className="ml-hmeters">
        {history.humidityPeriods.map((p) => (
          <div key={p.label} className="ml-hmeter">
            <span className="ml-hmeter__label">{p.label}</span>
            <div className="ml-hmeter__track">
              <div
                className={'ml-hmeter__fill' + (p.current ? ' ml-hmeter__fill--current' : '')}
                style={{ width: `${p.humidity ?? 0}%` }}
              />
            </div>
            <span className="ml-hmeter__value serif">{p.humidity == null ? '—' : `${p.humidity}%`}</span>
          </div>
        ))}
      </div>
    </>
  )
}
