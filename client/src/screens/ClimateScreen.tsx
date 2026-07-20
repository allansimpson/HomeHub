import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { DrillInHeader, ScreenShell, ScrollArea, Stepper } from '../components'
import { useClimate } from '../app/ClimateProvider'
import { useConnection } from '../app/ConnectionProvider'
import type { ClimateModeName, ClimateZoneDto } from '../api/types'

const MODES: ClimateModeName[] = ['Cool', 'Heat', 'Fan', 'Auto', 'Off']

/** Short status line for the expanded zone footer. */
function statusLine(z: ClimateZoneDto): string {
  if (z.mode === 'Off' || z.setPointF == null) return 'Powered off'
  if (z.mode === 'Fan') return 'Fan running'
  if (z.mode === 'Auto') return `Holding ${z.setPointF}°`
  const verb = z.mode === 'Cool' ? 'Cooling' : 'Heating'
  if (Math.round(z.currentTempF) === Math.round(z.setPointF)) return `At set point ${z.setPointF}°`
  return `${verb} to ${z.setPointF}°`
}

/**
 * Climate (spec 08): every mini-split zone with live temp / set point / mode; the selected zone
 * expands in place with the big set-point block, mode selector and status footer. ALL OFF /
 * EVENING SCENE at the bottom. Controls are optimistic (long-press repeats) and reconcile with
 * the provider's reported state.
 */
export function ClimateScreen() {
  const navigate = useNavigate()
  const { zones, adjustSetPoint, setMode, applyScene } = useClimate()
  const { stale } = useConnection()
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const running = zones.filter((z) => z.running).length
  const selected = selectedId ?? zones.find((z) => z.running)?.id ?? zones[0]?.id ?? null

  const header = useMemo(
    () => (
      <DrillInHeader
        title="Climate"
        status={`${running} of ${zones.length} running`}
        statusLive={running > 0}
        onBack={() => navigate('/')}
      />
    ),
    [running, zones.length, navigate],
  )

  return (
    <ScreenShell header={header}>
      <ScrollArea>
        <div className={stale ? 'ml-stale' : undefined}>
        {zones.map((z) => (
          <ZoneRow
            key={z.id}
            zone={z}
            expanded={z.id === selected}
            onSelect={() => setSelectedId(z.id)}
            onStep={(d) => adjustSetPoint(z.id, d)}
            onMode={(m) => setMode(z.id, m)}
          />
        ))}
        </div>
      </ScrollArea>

      <div className="ml-climate__actions">
        <button type="button" className="ml-climate__action" onClick={() => applyScene('all-off')}>All Off</button>
        <button type="button" className="ml-climate__action ml-climate__action--accent" onClick={() => applyScene('evening')}>
          Evening Scene
        </button>
      </div>
    </ScreenShell>
  )
}

function ZoneRow({
  zone, expanded, onSelect, onStep, onMode,
}: {
  zone: ClimateZoneDto
  expanded: boolean
  onSelect: () => void
  onStep: (delta: number) => void
  onMode: (mode: ClimateModeName) => void
}) {
  const running = zone.running
  return (
    <div className={'ml-climatezone' + (expanded ? ' ml-climatezone--expanded' : '')}>
      <button type="button" className="ml-climatezone__row" onClick={onSelect}>
        <div className="ml-climatezone__main">
          <div className="ml-climatezone__name">{zone.name}</div>
          <div className="ml-climatezone__now">Now {Math.round(zone.currentTempF)}°</div>
        </div>
        <span className={'ml-modechip' + (running ? ' ml-modechip--on' : '')}>
          {running ? `${zone.mode}${zone.fanMode ? ` · ${zone.fanMode}` : ''}`.toUpperCase() : 'OFF'}
        </span>
        <span className={'ml-climatezone__set serif' + (running ? '' : ' ml-climatezone__set--off')}>
          {zone.setPointF == null ? '—' : `${zone.setPointF}°`}
        </span>
      </button>

      {expanded && (
        <div className="ml-climatezone__panel">
          <div className="ml-climate__setpoint">
            <Stepper direction="minus" onStep={() => onStep(-1)} label={`Lower ${zone.name}`} disabled={!running} />
            <div className="ml-climate__setval">
              <span className="serif">{zone.setPointF == null ? '—' : `${zone.setPointF}°`}</span>
              <span className="ml-climate__setcaption">Set Point</span>
            </div>
            <Stepper direction="plus" onStep={() => onStep(1)} label={`Raise ${zone.name}`} disabled={!running} />
          </div>

          <div className="ml-climate__modes">
            {MODES.map((m) => (
              <button
                key={m}
                type="button"
                className={'ml-chip' + (zone.mode === m ? ' ml-chip--active' : '')}
                onClick={() => onMode(m)}
              >
                {m}
              </button>
            ))}
          </div>

          <div className="ml-climate__footer">
            <span className="ml-climate__fan">{running && zone.fanMode ? `Fan · ${zone.fanMode}` : ''}</span>
            <span className={'ml-climate__status' + (running ? ' ml-climate__status--live' : '')}>{statusLine(zone)}</span>
          </div>
        </div>
      )}
    </div>
  )
}
