import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { DrillInHeader, ScreenShell, ScrollArea, Chip, AlertBanner, EmptyState } from '../components'
import { useSensors } from '../app/SensorsProvider'
import { api, ApiError } from '../api/client'
import type { ZoneHistoryDto } from '../api/types'

const REFRESH_MS = 30_000

/**
 * Sensor History (spec 04): room chips, the big current reading, a 12-bar temperature chart and
 * humidity meter rows — all from owned SQL history. Bars are normalized to the window's own
 * range so both room temps and sub-zero freezers render legibly.
 */
export function SensorHistoryScreen() {
  const navigate = useNavigate()
  const { zones, alerts } = useSensors()
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
      <ScreenShell header={<DrillInHeader title="Sensor History" status="24 Hours" onBack={() => navigate(-1)} />}>
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
          onBack={() => navigate(-1)}
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

        {history && <CurrentReading history={history} />}
        {history && <TemperatureChart history={history} />}
        {history && <HumidityMeters history={history} />}
      </ScrollArea>
    </ScreenShell>
  )
}

function CurrentReading({ history }: { history: ZoneHistoryDto }) {
  const today =
    history.todayHighF != null && history.todayLowF != null
      ? `Today: high ${history.todayHighF}° at ${history.todayHighAt} · low ${history.todayLowF}° at ${history.todayLowAt}`
      : 'Gathering today’s range…'
  return (
    <div className="ml-sensor__current">
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

function TemperatureChart({ history }: { history: ZoneHistoryDto }) {
  const values = history.tempBars.map((b) => b.tempF).filter((v): v is number => v != null)
  const { min, max } = useMemo(() => {
    if (values.length === 0) return { min: 0, max: 1 }
    const lo = Math.min(...values)
    const hi = Math.max(...values)
    return { min: lo, max: hi === lo ? lo + 1 : hi }
  }, [values])

  return (
    <>
      <div className="ml-section">
        <span className="ml-section__tick" aria-hidden="true" />
        <span className="ml-section__label">Temperature</span>
      </div>
      <div className="ml-tempchart">
        {history.tempBars.map((bar, i) => {
          const pct = bar.tempF == null ? 0 : 0.12 + ((bar.tempF - min) / (max - min)) * 0.88
          return (
            <div key={i} className="ml-tempchart__col">
              <span className="ml-tempchart__value serif">{bar.tempF == null ? '' : Math.round(bar.tempF)}</span>
              <div className="ml-tempchart__track">
                <div className="ml-tempchart__bar" style={{ height: `${pct * 100}%` }} />
              </div>
              <span className="ml-tempchart__time">{bar.label}</span>
            </div>
          )
        })}
      </div>
    </>
  )
}

function HumidityMeters({ history }: { history: ZoneHistoryDto }) {
  return (
    <>
      <div className="ml-section">
        <span className="ml-section__tick ml-section__tick--live" aria-hidden="true" />
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
