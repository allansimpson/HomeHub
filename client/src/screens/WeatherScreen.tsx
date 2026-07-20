import { useNavigate } from 'react-router-dom'
import { DrillInHeader, ScreenShell, ScrollArea, SectionLabel, AlertBanner, EmptyState } from '../components'
import { useClock } from '../app/useClock'
import { useWeather } from '../app/WeatherProvider'
import { useSensors } from '../app/SensorsProvider'
import type { WeatherSnapshotDto } from '../api/types'

/**
 * Weather (spec 05): big current conditions, tonight's hourly strip, and the week-ahead
 * forecast. A severe NWS alert renders the shared amber banner + hazard stripe at the top —
 * the same banner the dashboard shows, driven by the Stage 2 alert engine.
 */
export function WeatherScreen() {
  const navigate = useNavigate()
  const { time, date } = useClock()
  const { weather, offline } = useWeather()
  const { alerts } = useSensors()

  const weatherAlert = alerts.find((a) => a.source === 'weather')
  const hasData = !!weather?.current && weather.current.tempF != null

  return (
    <ScreenShell header={<DrillInHeader title="Weather" status={`${date} · ${time}`} onBack={() => navigate(-1)} />}>
      <ScrollArea>
        {weatherAlert && (
          <AlertBanner
            title={weatherAlert.message.split(':')[0] || 'Weather Alert'}
            detail={weatherAlert.message}
            severe={weatherAlert.severity === 'Severe'}
          />
        )}

        {!hasData ? (
          <EmptyState
            label={offline ? 'Weather unavailable' : 'Loading weather…'}
            hint={offline ? 'Reconnecting to the forecast service.' : 'Fetching current conditions from NWS.'}
          />
        ) : (
          <WeatherBody weather={weather!} />
        )}
      </ScrollArea>
    </ScreenShell>
  )
}

function WeatherBody({ weather }: { weather: WeatherSnapshotDto }) {
  const c = weather.current!
  const hourly = weather.hourly.slice(0, 5)

  return (
    <>
      <div className="ml-weather__current">
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

      <SectionLabel label="Tonight" />
      <div className="ml-weather__hourly">
        {hourly.map((h, i) => (
          <div key={i} className="ml-weather__hour">
            <span className="ml-weather__hourlabel">{h.label}</span>
            <span className="ml-weather__hourdash" aria-hidden="true" />
            <span className="ml-weather__hourtemp serif">{h.tempF == null ? '—' : `${Math.round(h.tempF)}°`}</span>
          </div>
        ))}
      </div>

      <SectionLabel label="The Week Ahead" />
      <div className="ml-week">
        {weather.daily.map((d, i) => (
          <div key={i} className="ml-week__row">
            <span className="ml-week__day">{d.day}</span>
            <span className={'ml-week__cond' + (d.severe ? ' ml-week__cond--severe' : '')}>{d.condition}</span>
            <span className="ml-week__temps">
              <span className="ml-week__hi serif">{d.highF == null ? '—' : `${Math.round(d.highF)}°`}</span>
              <span className="ml-week__lo serif">{d.lowF == null ? '' : `${Math.round(d.lowF)}°`}</span>
            </span>
          </div>
        ))}
      </div>
    </>
  )
}
