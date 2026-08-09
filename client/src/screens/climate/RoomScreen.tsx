import { useNavigate, useParams } from 'react-router'
import { DrillInHeader, ScreenShell, ScrollArea, SectionLabel, Stepper } from '../../components'
import { useClimate } from '../../app/ClimateProvider'
import { useNow } from '../../app/useNow'
import type { ClimateZoneDto, CorrectionName } from '../../api/types'
import { clock, duration, reading } from './climateCopy'

/** The gesture's range, and the stepper's — one room, one set of bounds. */
const MIN_F = 64
const MAX_F = 80

const TOLERANCES: { label: string; value: number }[] = [
  { label: '±0.5°', value: 0.5 },
  { label: '±1°', value: 1 },
  { label: '±2°', value: 2 },
]

const CORRECTIONS: CorrectionName[] = ['Gentle', 'Steady', 'Hard']

/**
 * Quiet hours as a short list rather than a time picker.
 *
 * The knob is "when should the machine stop talking overnight", and a household answers that with
 * "later" or "earlier", not with a minute. Four ranges cover it; a picker would spend a full-screen
 * modal on a decision nobody revisits.
 */
const QUIET_RANGES: { label: string; from: string; to: string }[] = [
  { label: '10 PM – 6 AM', from: '22:00', to: '06:00' },
  { label: '9 PM – 7 AM', from: '21:00', to: '07:00' },
  { label: '11 PM – 6 AM', from: '23:00', to: '06:00' },
  { label: 'NONE', from: '00:00', to: '00:00' },
]

/**
 * One room, in full: what it reads, what it is for, what its unit is currently being told, and how
 * hard the loop pushes to keep the two together.
 *
 * This is the keyboard-and-mouse path to everything the band's gesture does by touch, and the
 * deliberate one: the stepper here edits the **standing** target directly, which is exactly what 3a
 * and 3b shortcut. It is also the only screen in the section that shows a set point at all — as a
 * fact, never as a control (CLIMATE_SCREEN §8).
 */
export function RoomScreen() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { zones, setTarget, borrow, patchZone } = useClimate()
  const now = useNow(60_000)

  const zone = zones.find((z) => z.id === Number(id))
  if (!zone) {
    return (
      <ScreenShell header={<DrillInHeader title="Room" onBack={() => navigate('/climate')} />}>
        <div className="ml-croom__missing">This room is no longer on the panel.</div>
      </ScreenShell>
    )
  }

  const target = zone.standingTargetF ?? 72
  const step = (delta: number) =>
    void setTarget(zone.id, Math.min(MAX_F, Math.max(MIN_F, Math.round(target) + delta)))

  return (
    <ScreenShell
      header={
        <DrillInHeader
          title={zone.name}
          onBack={() => navigate('/climate')}
          status={subLine(zone)}
        />
      }
    >
      <ScrollArea>
        <div className="ml-croom">
          <section className="ml-croom__hero">
            <span className="ml-croom__reading serif">{reading(zone.readingF, true)}</span>
            <div className="ml-croom__target">
              <Stepper direction="minus" onStep={() => step(-1)} label={`Lower ${zone.name}`} />
              <span className="ml-croom__targetval">
                <span className="serif">{Math.round(target)}°</span>
                <span className="ml-croom__targetlabel">TARGET</span>
              </span>
              <Stepper direction="plus" onStep={() => step(1)} label={`Raise ${zone.name}`} />
            </div>
          </section>

          <section className="ml-croom__section">
            <SectionLabel
              label="The unit"
              status={unitState(zone)}
              statusLive={!zone.isPaused && zone.state !== 'probeLost' && zone.state !== 'unreachable'}
            />
            <Fact label="Setpoint now" value={zone.unitSetPointF == null ? '—' : `${Math.round(zone.unitSetPointF)}°`} />
            <Fact label="Mode" value={zone.unitMode ?? '—'} />
            <Fact label="Last write" value={lastWrite(zone, now)} />
            {/*
              The sentence that makes the whole split legible. Someone standing at the panel wondering
              why the number on the wall unit keeps changing gets their answer here, in the one place
              the set point is visible at all.
            */}
            <p className="ml-croom__sentence">
              The setpoint is HomeHub's to move. Change it on the unit and the loop will put it back
              within ten minutes.
            </p>
          </section>

          <section className="ml-croom__section">
            <SectionLabel label="Nudge" status={`TWO HOURS, THEN BACK TO ${Math.round(target)}°`} />
            <div className="ml-croom__nudge">
              <button type="button" className="ml-croom__nudgebtn" onClick={() => void borrow(zone.id, clampT(target - 2))}>
                −2°
              </button>
              <button type="button" className="ml-croom__nudgebtn" onClick={() => void borrow(zone.id, clampT(target + 2))}>
                +2°
              </button>
            </div>
          </section>

          <section className="ml-croom__section">
            <SectionLabel label="How it holds" />

            <Knob label="Hold tolerance">
              {TOLERANCES.map((t) => (
                <ChipButton
                  key={t.value}
                  label={t.label}
                  selected={zone.toleranceF === t.value}
                  onClick={() => void patchZone(zone.id, { toleranceF: t.value })}
                />
              ))}
            </Knob>

            <Knob label="Correction">
              {CORRECTIONS.map((c) => (
                <ChipButton
                  key={c}
                  label={c.toUpperCase()}
                  selected={zone.correction === c}
                  onClick={() => void patchZone(zone.id, { correction: c })}
                />
              ))}
            </Knob>

            <Knob label="Quiet hours">
              {QUIET_RANGES.map((q) => (
                <ChipButton
                  key={q.label}
                  label={q.label}
                  selected={zone.quietFrom.startsWith(q.from) && zone.quietTo.startsWith(q.to)}
                  onClick={() => void patchZone(zone.id, { quietFrom: q.from, quietTo: q.to })}
                />
              ))}
            </Knob>

            <Knob label="Pause this room">
              <ChipButton
                label="HOLDING"
                selected={!zone.isPaused}
                onClick={() => void patchZone(zone.id, { isPaused: false })}
              />
              <ChipButton
                label="PAUSED"
                selected={zone.isPaused}
                onClick={() => void patchZone(zone.id, { isPaused: true })}
              />
            </Knob>
          </section>
        </div>
      </ScrollArea>
    </ScreenShell>
  )
}

function clampT(value: number): number {
  return Math.min(MAX_F, Math.max(MIN_F, Math.round(value)))
}

/** `PROBE 8A41 · SENSIBO MINI-SPLIT` — what this room is made of, in the header's second line. */
function subLine(zone: ClimateZoneDto): string {
  const probe = zone.probeRef ? `PROBE ${zone.probeRef.replace(/^sim-/, '').toUpperCase()}` : 'NO PROBE'
  return zone.unitRef ? `${probe} · SENSIBO MINI-SPLIT` : `${probe} · NO UNIT`
}

/** Who is driving, in three words. Never a percentage and never a mode name. */
function unitState(zone: ClimateZoneDto): string {
  if (zone.isPaused) return 'PAUSED — UNIT ON ITS OWN'
  if (zone.state === 'probeLost') return 'UNIT ON ITS OWN SENSOR'
  if (zone.state === 'unreachable') return 'UNREACHABLE'
  if (zone.state === 'unitOff') return 'UNIT IS OFF'
  return 'HOMEHUB IS DRIVING'
}

/** The ledger's newest row, in a sentence: when, to what, and whether it landed. */
function lastWrite(zone: ClimateZoneDto, now: number): string {
  const w = zone.lastWrite
  if (!w) return 'Nothing written yet'
  const ago = duration(now - new Date(w.atUtc).getTime())
  if (w.outcome === 'Skipped') return `${clock(w.atUtc)} · nothing sent (${w.reason.toLowerCase()})`
  const moved = w.setPointFrom == null
    ? `${Math.round(w.setPointTo)}°`
    : `${Math.round(w.setPointFrom)}° → ${Math.round(w.setPointTo)}°`
  // Both values, deliberately: a Rejected row is what someone reaching for the remote looks like,
  // and the pair is the only way to see it.
  const outcome = w.outcome === 'Written' ? '' : ` · ${w.outcome.toLowerCase()}`
  return `${clock(w.atUtc)}, ${ago} ago · ${moved}${outcome}`
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="ml-croom__fact">
      <span className="ml-croom__factlabel">{label}</span>
      <span className="ml-croom__factvalue">{value}</span>
    </div>
  )
}

function Knob({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="ml-croom__knob">
      <span className="ml-croom__knoblabel">{label}</span>
      <span className="ml-croom__chips">{children}</span>
    </div>
  )
}

function ChipButton({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={'ml-cchip' + (selected ? ' ml-cchip--on' : '')}
      aria-pressed={selected}
      onClick={onClick}
    >
      {label}
    </button>
  )
}
