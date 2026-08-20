import { useEffect, useMemo, useState } from 'react'
import { DrillInHeader, ScreenShell, ScrollArea, SectionLabel, AlertBanner, EmptyState } from '../components'
import { Icon } from '../icons/Icon'
import { useClock } from '../app/useClock'
import { useWeather } from '../app/WeatherProvider'
import { useSensors } from '../app/SensorsProvider'
import { useConnection } from '../app/ConnectionProvider'
import { alertHeadline } from '../app/needsYou'
import type { WeatherSnapshotDto, DailyDto } from '../api/types'
import { clockLabel } from '../app/dates'

type View = 'now' | 'hourly' | 'radar'
const VIEWS: View[] = ['now', 'hourly', 'radar']

/**
 * Weather (spec 05, revamped): a NOW · HOURLY · RADAR segment switches the view in place. NOW is
 * current conditions + tonight + the tappable week ahead; tapping a day opens the HOURLY Day Detail
 * (bar chart + hour rows with POP/wind, day-steppable); RADAR is a framed precip view (placeholder
 * tile). A severe NWS alert still renders the shared amber banner + hazard stripe at the very top.
 */
export function WeatherScreen() {
  const { stamp } = useClock()
  const { weather, offline } = useWeather()
  const { alerts } = useSensors()
  const { stale } = useConnection()

  const [view, setView] = useState<View>('now')
  const [dayIndex, setDayIndex] = useState(0)

  const weatherAlert = alerts.find((a) => a.source === 'weather')
  const hasData = !!weather?.current && weather.current.tempF != null
  const days = weather?.daily ?? []
  const openDay = (i: number) => {
    setDayIndex(i)
    setView('hourly')
  }

  // The dashboard banners this same alert on the same test, through the same headline — see
  // `alertHeadline`. Not tappable here: this *is* the screen it would take you to.
  const banner = weatherAlert && (
    <AlertBanner
      title={alertHeadline(weatherAlert)}
      detail={weatherAlert.message}
      severe={weatherAlert.severity === 'Severe'}
    />
  )

  const header =
    view === 'hourly' && days.length > 0 ? (
      <DayStepperHeader
        day={days[Math.min(dayIndex, days.length - 1)]}
        canPrev={dayIndex > 0}
        canNext={dayIndex < days.length - 1}
        onPrev={() => setDayIndex((i) => Math.max(0, i - 1))}
        onNext={() => setDayIndex((i) => Math.min(days.length - 1, i + 1))}
      />
    ) : (
      // Where, then when. The place is the whole title because it is the thing that changes what the
      // numbers below mean — a forecast is a claim about somewhere, and a screen that never says
      // where is one nobody can catch being wrong. The word "weather" is not in it: the nav already
      // said which section this is, and repeating it spends the line on something the reader knows.
      // Falls back to the bare word when NWS has not named the point (or has not been asked yet),
      // rather than to the coordinates, which confirm nothing to anybody standing in the kitchen.
      <DrillInHeader
        title={weather?.place ? weather.place.label : 'Weather'}
        // Meals' stamp, one line: `SUN 17 AUG · 14:32`. The stack this replaces existed because the
        // long form — `MONDAY 10 AUGUST · 5:02 PM` — is wider at this tracking than the space left
        // beside a place name, and broke wherever it ran out. The abbreviated day and month fit, so
        // the header goes back to the one-row shape every other screen has.
        status={stamp}
      />
    )

  return (
    <ScreenShell banner={banner} header={header}>
      {!hasData ? (
        <ScrollArea>
          <EmptyState
            label={offline ? 'Weather unavailable' : 'Loading weather…'}
            hint={offline ? 'Reconnecting to the forecast service.' : 'Fetching current conditions from NWS.'}
          />
        </ScrollArea>
      ) : (
        <div className="ml-weather">
          <div className="ml-weather__segments" role="tablist">
            {VIEWS.map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                className={'ml-weather__seg' + (view === v ? ' ml-weather__seg--active' : '')}
                onClick={() => setView(v)}
              >
                {v.toUpperCase()}
              </button>
            ))}
          </div>

          {view === 'now' && <NowView weather={weather!} stale={stale} onDay={openDay} />}
          {view === 'hourly' && <DayDetail weather={weather!} day={days[Math.min(dayIndex, days.length - 1)]} />}
          {view === 'radar' && <RadarView lat={weather!.latitude} lon={weather!.longitude} />}
        </div>
      )}
    </ScreenShell>
  )
}

function dayLabel(d: DailyDto | undefined): string {
  if (!d) return 'Day'
  if (d.day === 'TODAY' || !d.dayKey) return d.day
  return `${d.day} ${Number(d.dayKey.slice(-2))}`
}

/**
 * Day-detail header. No back button: the NOW · HOURLY · RADAR segment sits directly below and is
 * the way back to NOW, and dropping it keeps this header the same height as the other two views.
 */
function DayStepperHeader({
  day, canPrev, canNext, onPrev, onNext,
}: {
  day: DailyDto
  canPrev: boolean
  canNext: boolean
  onPrev: () => void
  onNext: () => void
}) {
  return (
    <header className="ml-header ml-header--drillin ml-weather__dayhead">
      <div className="ml-weather__daystep">
        <button type="button" className="ml-weather__dayarrow" onClick={onPrev} disabled={!canPrev} aria-label="Previous day">
          <Icon id="ico-back" size="1.125rem" />
        </button>
        <span className="ml-weather__dayname serif">{dayLabel(day)}</span>
        <button type="button" className="ml-weather__dayarrow" onClick={onNext} disabled={!canNext} aria-label="Next day">
          <Icon id="ico-chevron-right" size="1.125rem" />
        </button>
      </div>
    </header>
  )
}

/** Amber "Tonight" sub-note when the evening's hourly window turns severe/wet. */
function tonightNote(weather: WeatherSnapshotDto): string | null {
  const hit = weather.hourly.slice(0, 12).find((h) => /storm|thunder|severe|rain|snow|sleet/i.test(h.shortForecast ?? ''))
  if (!hit) return null
  const f = (hit.shortForecast ?? '').toLowerCase()
  const kind = /storm|thunder|severe/.test(f) ? 'Storms' : /snow|sleet/.test(f) ? 'Snow' : 'Rain'
  return `${kind} arrive near ${hit.label}`
}

function NowView({ weather, stale, onDay }: { weather: WeatherSnapshotDto; stale: boolean; onDay: (i: number) => void }) {
  const c = weather.current!
  const hourly = weather.hourly.slice(0, 5)
  const note = tonightNote(weather)

  return (
    <ScrollArea>
      <div className={'ml-weather__current' + (stale ? ' ml-stale' : '')}>
        <span className="ml-weather__temp serif">{c.tempF == null ? '—' : `${Math.round(c.tempF)}°`}</span>
        <div className="ml-weather__stack">
          {c.condition && <span className="ml-weather__cond">{c.condition}</span>}
          <span className="ml-weather__hilo">
            {c.highF != null ? `High ${Math.round(c.highF)}°` : ''}
            {c.lowF != null ? ` · Low ${Math.round(c.lowF)}°` : ''}
          </span>
          <span className="ml-weather__wind">
            {c.humidity != null ? `Humidity ${Math.round(c.humidity)}%` : ''}
            {c.windMph != null ? ` · Wind ${Math.round(c.windMph)} mph` : ''}
          </span>
        </div>
      </div>

      <SectionLabel label="Tonight" status={note ? <span className="ml-tonight-note">{note}</span> : undefined} />
      <div className="ml-weather__hourly">
        {hourly.map((h, i) => (
          <div key={i} className="ml-weather__hour">
            <span className="ml-weather__hourlabel">{h.label}</span>
            <span className="ml-weather__hourdash" aria-hidden="true" />
            <span className="ml-weather__hourtemp serif">{h.tempF == null ? '—' : `${Math.round(h.tempF)}°`}</span>
          </div>
        ))}
      </div>

      <SectionLabel label="The Week Ahead" status={<span className="ml-week__hint">Tap a day for hourly</span>} />
      <div className="ml-week">
        {weather.daily.map((d, i) => (
          <button key={i} type="button" className="ml-week__row ml-week__row--tap" onClick={() => onDay(i)}>
            <span className="ml-week__day">{d.day}</span>
            <span className={'ml-week__cond' + (d.severe ? ' ml-week__cond--severe' : '')}>{d.condition}</span>
            <span className="ml-week__temps">
              <span className="ml-week__hi serif">{d.highF == null ? '—' : `${Math.round(d.highF)}°`}</span>
              <span className="ml-week__lo serif">{d.lowF == null ? '' : `${Math.round(d.lowF)}°`}</span>
            </span>
            <span className="ml-week__chev" aria-hidden="true">▸</span>
          </button>
        ))}
      </div>
    </ScrollArea>
  )
}

function popClass(pop: number | null): string {
  if (pop != null && pop >= 60) return 'ml-dayrow__popdot--high'
  if (pop != null && pop >= 30) return 'ml-dayrow__popdot--mid'
  return 'ml-dayrow__popdot--low'
}

function DayDetail({ weather, day }: { weather: WeatherSnapshotDto; day: DailyDto | undefined }) {
  const hours = day?.dayKey ? weather.hourly.filter((h) => h.dayKey === day.dayKey) : []
  const steps = hours.filter((_, i) => i % 2 === 0).slice(0, 12)

  if (steps.length === 0) {
    return (
      <ScrollArea>
        <EmptyState label="No hourly forecast" hint="This day is beyond the hourly forecast range." />
      </ScrollArea>
    )
  }

  const temps = steps.map((h) => h.tempF).filter((t): t is number => t != null)
  const bigTemp = temps.length ? Math.max(...temps) : day?.highF ?? null
  const peakHour = steps.reduce((a, b) => ((b.tempF ?? -999) > (a.tempF ?? -999) ? b : a), steps[0])
  const base = 60

  return (
    <ScrollArea>
      <div className="ml-daydetail__summary">
        <span className="ml-daydetail__temp serif">{bigTemp == null ? '—' : `${Math.round(bigTemp)}°`}</span>
        <span className={'ml-daydetail__peak' + (day?.severe ? ' ml-daydetail__peak--severe' : '')}>
          {`${day?.condition ?? ''}${peakHour?.label ? ` · High ${peakHour.label}` : ''}`}
        </span>
        <span className="ml-daydetail__hilo">
          {day?.highF != null ? `${Math.round(day.highF)}°` : '—'} / {day?.lowF != null ? `${Math.round(day.lowF)}°` : '—'}
        </span>
      </div>

      <div className="ml-daychart" aria-hidden="true">
        {steps.map((h, i) => (
          <div key={i} className="ml-daychart__col">
            <span className="ml-daychart__val serif">{h.tempF == null ? '' : `${Math.round(h.tempF)}°`}</span>
            <span className="ml-daychart__bar" style={{ height: `${Math.max(8, ((h.tempF ?? base) - base) * 6)}px` }} />
          </div>
        ))}
      </div>

      <div className="ml-dayrows">
        {steps.map((h, i) => (
          <div key={i} className="ml-dayrow">
            <span className="ml-dayrow__hour serif">{h.label}</span>
            <span className="ml-dayrow__cond">{h.shortForecast ?? ''}</span>
            <span className="ml-dayrow__pop">
              <span className={'ml-dayrow__popdot ' + popClass(h.pop)} aria-hidden="true" />
              {h.pop != null ? `${h.pop}%` : ''}
            </span>
            <span className="ml-dayrow__wind">{h.windMph != null ? `${Math.round(h.windMph)} mph` : ''}</span>
          </div>
        ))}
      </div>
    </ScrollArea>
  )
}

/* Radar (spec 05): live precipitation from RainViewer (free, open, no key) — past + nowcast frames
 * rendered as map tiles centered on the home location, with a scrubber to play/scrub through time. */
interface RainFrame {
  time: number
  path: string
}
interface RainMaps {
  host: string
  radar: { past: RainFrame[]; nowcast: RainFrame[] }
}
const RADAR_ZOOM = 7 // RainViewer radar tiles cap here; kept native so the base map stays crisp
const RADAR_TILE = 256
const RADAR_COLOR = 4 // RainViewer colour scheme (green → amber → red ≈ light/mod/heavy)
const RADAR_GRID = 2 // tiles each direction from centre → 5×5 covers the frame

/** Web-mercator fractional tile coords for a lon/lat at a zoom. */
function tileFrac(lon: number, lat: number, z: number) {
  const n = 2 ** z
  const latRad = (lat * Math.PI) / 180
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  }
}

function RadarView({ lat, lon }: { lat: number | null; lon: number | null }) {
  const [maps, setMaps] = useState<RainMaps | null>(null)
  const [frame, setFrame] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('https://api.rainviewer.com/public/weather-maps.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('radar'))))
      .then((m: RainMaps) => {
        if (cancelled) return
        setMaps(m)
        setFrame(Math.max(0, (m.radar?.past?.slice(-7).length ?? 1) - 1)) // start at "now"
      })
      .catch(() => !cancelled && setFailed(true))
    return () => {
      cancelled = true
    }
  }, [])

  const frames = useMemo<RainFrame[]>(() => {
    if (!maps?.radar) return []
    return [...maps.radar.past.slice(-7), ...maps.radar.nowcast.slice(0, 6)] // ~last hour + next hour
  }, [maps])
  const nowIndex = Math.max(0, (maps?.radar?.past?.slice(-7).length ?? 1) - 1)

  useEffect(() => {
    if (!playing || frames.length === 0) return
    const id = window.setInterval(() => setFrame((f) => (f + 1) % frames.length), 700)
    return () => window.clearInterval(id)
  }, [playing, frames.length])

  const idx = Math.min(frame, Math.max(0, frames.length - 1))
  const active = frames[idx]

  const legend = (
    <div className="ml-radar__legend">
      <span><span className="ml-radar__key ml-radar__key--light" aria-hidden="true" />Light</span>
      <span><span className="ml-radar__key ml-radar__key--mod" aria-hidden="true" />Moderate</span>
      <span><span className="ml-radar__key ml-radar__key--heavy" aria-hidden="true" />Heavy</span>
    </div>
  )

  if (lat == null || lon == null) {
    return (
      <div className="ml-radar">
        <div className="ml-radar__map"><span className="ml-radar__tilelabel">Radar unavailable — no location</span></div>
      </div>
    )
  }

  const { x: fx, y: fy } = tileFrac(lon, lat, RADAR_ZOOM)
  const cx = Math.floor(fx)
  const cy = Math.floor(fy)
  const x0 = cx - RADAR_GRID
  const y0 = cy - RADAR_GRID
  const tiles: { tx: number; ty: number }[] = []
  for (let dx = -RADAR_GRID; dx <= RADAR_GRID; dx++)
    for (let dy = -RADAR_GRID; dy <= RADAR_GRID; dy++) tiles.push({ tx: cx + dx, ty: cy + dy })

  const frameLabel = active
    ? clockLabel(new Date(active.time * 1000))
    : ''

  return (
    <div className="ml-radar">
      <div className="ml-radar__map">
        <span className="ml-radar__tilelabel">Radar · RainViewer</span>
        {legend}
        <div
          className="ml-radar__tiles"
          style={{ left: `calc(50% - ${(fx - x0) * RADAR_TILE}px)`, top: `calc(50% - ${(fy - y0) * RADAR_TILE}px)` }}
        >
          {/* Dark base map (coastlines, roads, city labels) so the location reads under the radar. */}
          {tiles.map(({ tx, ty }) => (
            <img
              key={`base-${tx}-${ty}`}
              className="ml-radar__basetile"
              alt=""
              loading="lazy"
              src={`https://a.basemaps.cartocdn.com/dark_all/${RADAR_ZOOM}/${tx}/${ty}.png`}
              style={{ left: `${(tx - x0) * RADAR_TILE}px`, top: `${(ty - y0) * RADAR_TILE}px` }}
            />
          ))}
          {active && maps &&
            tiles.map(({ tx, ty }) => (
              <img
                key={`radar-${tx}-${ty}`}
                className="ml-radar__tile"
                alt=""
                loading="lazy"
                src={`${maps.host}${active.path}/${RADAR_TILE}/${RADAR_ZOOM}/${tx}/${ty}/${RADAR_COLOR}/1_1.png`}
                style={{ left: `${(tx - x0) * RADAR_TILE}px`, top: `${(ty - y0) * RADAR_TILE}px` }}
              />
            ))}
        </div>
        <span className="ml-radar__marker" aria-hidden="true" />
        <span className="ml-radar__attrib">© OpenStreetMap · CARTO · RainViewer</span>
        {failed && <span className="ml-radar__err">Radar unavailable — reconnecting</span>}
      </div>

      <div className="ml-radar__scrubber">
        <button
          type="button"
          className="ml-radar__play"
          aria-label={playing ? 'Pause radar' : 'Play radar'}
          onClick={() => setPlaying((p) => !p)}
          disabled={frames.length === 0}
        >
          <span className={playing ? 'ml-radar__pauseglyph' : 'ml-radar__playglyph'} aria-hidden="true" />
        </button>
        <input
          className="ml-radar__range"
          type="range"
          min={0}
          max={Math.max(0, frames.length - 1)}
          value={idx}
          onChange={(e) => {
            setPlaying(false)
            setFrame(Number(e.target.value))
          }}
          aria-label="Radar time"
          disabled={frames.length === 0}
        />
      </div>
      <div className="ml-radar__track">
        <span className="ml-radar__tick">−1H</span>
        <span className="ml-radar__tick">−30M</span>
        <span className="ml-radar__now">{idx === nowIndex ? 'NOW' : frameLabel}</span>
        <span className="ml-radar__tick">+30M</span>
        <span className="ml-radar__tick">+1H</span>
      </div>
    </div>
  )
}
