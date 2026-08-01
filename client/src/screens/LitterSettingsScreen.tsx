import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { DrillInHeader, EmptyState, ScreenShell, ScrollArea, SectionLabel, Toggle } from '../components'
import { useLitter } from '../app/LitterProvider'
import { useCatName } from '../app/catName'
import { useSession } from '../app/SessionProvider'
import type { LitterRobotDto, LitterSelectName, LitterSelectDto } from '../api/types'

/** HA hands back bare lower-case values (`off`, `auto`, `high`, `15`). */
function pretty(value: string): string {
  if (/^\d+$/.test(value)) return value
  return value.charAt(0).toUpperCase() + value.slice(1)
}

interface SettingRow {
  key: LitterSelectName
  /** Key in the `selects` map — the camelCase form the API returns. */
  field: string
  label: string
  hint: string
  /** Append to each option, e.g. minutes. */
  unit?: string
}

/**
 * The four multi-position settings, in the order they matter to a household.
 *
 * The options are deliberately NOT listed here. Every set below came back different from what both
 * design passes predicted — the night light is `off/on/auto`, not Off/Low/Medium/High, and the wait
 * offers five values, not three — so the panel renders whatever the entity declares. Hardcoding a
 * vocabulary is how a control ends up offering something the robot rejects.
 */
const SETTINGS: SettingRow[] = [
  {
    key: 'nightlight',
    field: 'nightLight',
    label: 'Night light',
    hint: 'The globe light. Auto follows the robot’s own light sensor.',
  },
  {
    key: 'cleancyclewait',
    field: 'cleanCycleWait',
    label: 'Wait after the cat leaves',
    hint: 'How long the robot waits before cycling.',
    unit: 'min',
  },
  {
    key: 'globebrightness',
    field: 'globeBrightness',
    label: 'Globe brightness',
    hint: 'How bright the night light runs.',
  },
  {
    key: 'panelbrightness',
    field: 'panelBrightness',
    label: 'Panel brightness',
    hint: 'The unit’s own display, not this panel.',
  },
]

/**
 * Litter Settings — everything on this screen is a real, commandable entity.
 *
 * Each control writes and then re-reads: a setting shows as changed only once the robot reports it
 * back. Nothing here reports success because a call returned.
 */
/**
 * The cat's name — the only control on this screen that is not a Home Assistant entity.
 *
 * Every other setting here writes to HA and waits to be read back. This one is kept by the panel, so
 * it changes the instant it is saved: there is no robot round-trip to wait for, and pretending there
 * were would be the wrong kind of consistency.
 *
 * The robot reports *a* cat and never *which* cat, so this is not identity. With one cat in the
 * household it is simply the better word, and clearing it puts every sentence back to "the cat".
 */
function CatSection() {
  const { setCatName, settings, setLitterFullPercent } = useSession()
  const cat = useCatName()
  const [draft, setDraft] = useState<string | null>(null)
  const fullPercent = settings?.litterFullPercent ?? 80

  const save = () => {
    if (draft === null) return
    const next = draft.trim()
    setDraft(null)
    if (next === (cat.name ?? '')) return
    void setCatName(next || null)
  }

  return (
    <>
      <SectionLabel label="The cat" status="Kept by the panel, not the robot" />
      <div className="ml-litter__rows">
        <div className="ml-litter__row">
          <div>
            <div>Name</div>
            <div className="ml-litter__rowsub">Used wherever the box reports a cat</div>
          </div>
          {draft === null ? (
            <button type="button" className="ml-litter__rowval ml-litter__catedit" onClick={() => setDraft(cat.name ?? '')}>
              <span className="serif ml-litter__catname">{cat.name ?? 'Not set'}</span>
              <span className="ml-litter__rowval--brass">Edit ▸</span>
            </button>
          ) : (
            <input
              className="ml-litter__catinput"
              autoFocus
              value={draft}
              maxLength={24}
              placeholder="Mika"
              aria-label="The cat’s name"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={save}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save()
                if (e.key === 'Escape') setDraft(null)
              }}
            />
          )}
        </div>
      </div>

      {/* Sits with the cat's name rather than under "On the robot": both are kept by the panel and
          neither round-trips to Home Assistant. The robot has its own drawer-full fault and no
          say in this number. */}
      <SectionLabel label="Change the litter" status="Asked for by the panel" />
      <div className="ml-litter__rows">
        <div className="ml-litter__row">
          <div>
            <div>Tell me at</div>
            <div className="ml-litter__rowsub">
              {`Alerts on the home screen once the drawer passes ${fullPercent}%`}
            </div>
          </div>
          <div className="ml-litter__pct">
            {/* − then value then ＋, matching every other stepper on the panel. Lower means asked
                sooner, which is the direction the labels name. */}
            <button
              type="button"
              className="ml-litter__pctstep"
              aria-label="Ask sooner"
              disabled={fullPercent <= 10}
              onClick={() => void setLitterFullPercent(Math.max(10, fullPercent - 5))}
            >
              −
            </button>
            <span className="serif ml-litter__pctval">{`${fullPercent}%`}</span>
            <button
              type="button"
              className="ml-litter__pctstep"
              aria-label="Ask later"
              disabled={fullPercent >= 100}
              onClick={() => void setLitterFullPercent(Math.min(100, fullPercent + 5))}
            >
              ＋
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

export function LitterSettingsScreen() {
  const navigate = useNavigate()
  const { robots, loading, pending, error, clearError, setSelect, setSwitch, setRecovery } = useLitter()
  const robot: LitterRobotDto | null = robots[0] ?? null

  const header = (
    <DrillInHeader title="Litter Settings" onBack={() => navigate('/litter')} status={robot?.name ?? ''} />
  )

  if (!robot) {
    return (
      <ScreenShell header={header}>
        {loading ? <div /> : <EmptyState label="No litter box found" />}
      </ScreenShell>
    )
  }

  const busy = (action: string) => pending.has(`${robot.slug}:${action}`)
  const offline = robot.faultClass === 'Offline'

  return (
    <ScreenShell header={header}>
      <ScrollArea>
        {error && (
          <div className="ml-baby__error" role="alert">
            <span className="ml-baby__errortext">{error}</span>
            <button type="button" className="ml-linkbtn" onClick={clearError}>Dismiss</button>
          </div>
        )}

        {/* Above THE ROBOT deliberately: it is the one thing here the household owns outright. */}
        <CatSection />

        <SectionLabel label="On the robot" status={offline ? 'Offline' : 'Writes, then re-reads'} />
        {SETTINGS.map((row) => {
          const select: LitterSelectDto | undefined = robot.controls.selects[row.field]
          if (!select) return null
          return (
            <div key={row.key} className="ml-setting">
              <div className="ml-setting__head">
                <span className="ml-setting__label">{row.label}</span>
                <span className="ml-setting__current">
                  {select.current ? `${pretty(select.current)}${row.unit ? ` ${row.unit}` : ''}` : 'Unknown'}
                </span>
              </div>
              <div className="ml-setting__hint">{row.hint}</div>
              <div className="ml-segmented">
                {select.options.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={'ml-segmented__cell' + (option === select.current ? ' ml-segmented__cell--active' : '')}
                    disabled={offline || busy(row.key)}
                    onClick={() => void setSelect(robot.slug, row.key, option)}
                  >
                    {pretty(option)}{row.unit ? ` ${row.unit}` : ''}
                  </button>
                ))}
              </div>
            </div>
          )
        })}

        <SectionLabel label="Switches" />
        <div className="ml-litter__rows">
          <div className="ml-litter__row">
            <div>
              <div>Panel lockout</div>
              <div className="ml-litter__rowsub">Disables the buttons on the unit itself</div>
            </div>
            {robot.controls.panelLock == null ? (
              <span className="ml-litter__rowval">Unknown</span>
            ) : (
              <Toggle
                on={robot.controls.panelLock}
                onChange={(on) => void setSwitch(robot.slug, 'panellock', on)}
                label="Panel lockout"
              />
            )}
          </div>
          <div className="ml-litter__row">
            <div>
              <div>Auto-recovery</div>
              {/* The count is the honest one: manual presses are excluded from the safety budget. */}
              <div className="ml-litter__rowsub">
                {`${robot.recovery.attemptsToday} of ${robot.recovery.maxAttemptsToday} automatic attempts used today`}
              </div>
            </div>
            <Toggle
              on={robot.recovery.enabled}
              onChange={(on) => void setRecovery(robot.slug, on)}
              label="Auto-recovery"
            />
          </div>
        </div>

        <SectionLabel label="Firmware" />
        <div className="ml-litter__rows">
          <div className="ml-litter__row">
            <div>
              <div>Robot firmware</div>
              {/* Read-only on purpose: updates are applied from the Whisker app, and a half-finished
                  flash on a box the cat needs is not a button worth putting on a wall. */}
              <div className="ml-litter__rowsub">
                {robot.controls.firmwareUpdateAvailable === true
                  ? 'An update is waiting — apply it from the Whisker app'
                  : 'Applied from the Whisker app, not from here'}
              </div>
            </div>
            <span
              className={
                'ml-litter__rowval' +
                (robot.controls.firmwareUpdateAvailable === true ? ' ml-litter__rowval--brass' : '')
              }
            >
              {robot.controls.firmwareVersion
                ?? (robot.controls.firmwareUpdateAvailable === null ? 'Unknown' : 'Up to date')}
            </span>
          </div>
        </div>

        {/* The dead requests are named once, in the footer rather than in a section of their own —
            a heading and a paragraph for four things that do not exist cost more room than they were
            worth, and folding them down here is what paid for THE CAT without this screen scrolling.
            They stay named so the same request is not re-filed every few months. */}
        <div className="ml-litter__footer ml-litter__footer--stacked">
          <span className="ml-litter__footnote">
            A setting shows as changed only once the robot reports it back
          </span>
          <span className="ml-litter__footnote">
            No entity exists for drawer reset, add litter, a sleep schedule or the odour cartridge
          </span>
        </div>
      </ScrollArea>
    </ScreenShell>
  )
}
