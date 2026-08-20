import { useState } from 'react'
import { useNavigate } from 'react-router'
import { DrillInHeader, ScreenShell, ScrollArea, SectionLabel } from '../components'
import { Icon } from '../icons/Icon'
import { useSession } from '../app/SessionProvider'
import { useBabyName } from '../app/babyName'
import { useBaby } from '../app/BabyProvider'
import { useConnection } from '../app/ConnectionProvider'
import { api, ApiError } from '../api/client'
import type { BabyHealthDto } from '../api/types'

/**
 * How far back a pull reads. Ninety days covers a newborn's whole history on the first run and is
 * harmless on every run after — the import is keyed per upstream event, so a day already held is
 * counted and not written again.
 */
const IMPORT_DAYS = 90

/**
 * The one child the panel tracks, matching `ConradView`. A second would make this a picker rather
 * than a constant, which is the same call `careSubjects` has already deferred.
 */
const CHILD_KEY = 'conrad'

/** What the integration's health means to somebody looking at a settings row. */
function healthLabel(health: BabyHealthDto | null): string {
  if (!health) return 'Reading…'
  if (!health.configured) return 'Not connected'
  switch (health.status) {
    case 'NotConfigured': return 'Not connected'
    case 'Ok': return 'Connected'
    case 'HomeAssistantUnreachable': return 'Home Assistant unreachable'
    case 'IntegrationMissing': return 'Integration not found'
    case 'Stale': return 'Last known only'
  }
}

/**
 * Baby settings — what the household calls the child, and the way in from Huckleberry.
 *
 * <b>A surface of its own rather than a row under Devices.</b> The child is not a device: the whole
 * point of the CARE split was that a baby is a log you write to and a machine is a thing you read,
 * and burying the settings the Baby tab has inside the machines' screen would undo that on the only
 * page where somebody goes looking for them.
 *
 * It is deliberately thin. Everything else the tab knows — the ten types, the medicines, the pump's
 * phases — is either derived from the log or lives in code, and inventing settings for them here
 * would be building a preferences screen nobody asked for.
 */
export function BabySettingsScreen() {
  const navigate = useNavigate()
  const { setBabyName } = useSession()
  const name = useBabyName()
  const [draft, setDraft] = useState<string | null>(null)

  const save = () => {
    if (draft === null) return
    const next = draft.trim()
    setDraft(null)
    if (next === (name ?? '')) return
    void setBabyName(next || null)
  }

  return (
    <ScreenShell header={<DrillInHeader title="Baby settings" onBack={() => navigate('/settings')} />}>
      <ScrollArea>
        <SectionLabel label="The child" status="Kept by the panel" />
        <div className="ml-litter__rows">
          <div className="ml-litter__row">
            <div>
              <div>Name</div>
              <div className="ml-litter__rowsub">Leads the Baby tab. The tab itself stays BABY.</div>
            </div>
            {draft === null ? (
              <button
                type="button"
                className="ml-litter__rowval ml-litter__catedit"
                onClick={() => setDraft(name ?? '')}
              >
                <span className="serif ml-litter__catname">{name ?? 'Not set'}</span>
                <span className="ml-litter__rowval--brass">Edit ▸</span>
              </button>
            ) : (
              <input
                className="ml-litter__catinput"
                autoFocus
                value={draft}
                maxLength={24}
                placeholder="Conrad"
                aria-label="The child’s name"
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

        {/* Says where the name does *not* go, because the nav cell keeping its word is a decision
            rather than an oversight — a tab that renames itself is a tab nobody can point at. */}
        <p className="ml-litter__note">
          Unset, the tab reads <b>Baby</b> — the same word the nav cell always shows.
        </p>

        <HuckleberrySection />
      </ScrollArea>
    </ScreenShell>
  )
}

/**
 * The bridge out of Huckleberry, and the only place in the app that names it besides the Config
 * index row that leads here.
 *
 * <b>It used to sit in the Baby tab's own footer</b>, under the logging grid, on the reasoning that
 * the log is where its results land. Two things were wrong with that. It is a catch-up somebody runs
 * once when the panel is set up, not something a household does at 3am — and the log is the one
 * surface in HomeHub built to work with no server at all, so the single control on it that cannot
 * was also the only reason that screen had to know whether it was online. Both belong here.
 */
function HuckleberrySection() {
  const { health } = useBaby()
  const { online } = useConnection()
  const [running, setRunning] = useState(false)
  /** What the last pull found, or why it did not run. Sticky — there is nothing else to report it. */
  const [result, setResult] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  const pull = async () => {
    setRunning(true)
    setResult(null)
    setFailed(false)
    try {
      const r = await api.importCare(CHILD_KEY, IMPORT_DAYS)
      setFailed(false)
      /*
       * All four figures, unlike the old inline note that had one line beside a chip to fit in.
       * `added` is the number somebody came for; the rest are what makes a second run that adds
       * nothing legible as "already have it" rather than as a pull that failed quietly.
       */
      setResult(
        `${r.imported} added · ${r.alreadyHad} already held · ${r.skipped} skipped · ${r.read} read`,
      )
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
      setFailed(true)
      setResult(online ? 'Nothing could be pulled in just now.' : 'That needs a connection.')
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      <SectionLabel label="Huckleberry" status={healthLabel(health)} />
      <div className="ml-litter__rows">
        <div className="ml-litter__row">
          <div>
            <div>Pull in history</div>
            <div className="ml-litter__rowsub">
              {`The last ${IMPORT_DAYS} days · reads only`}
            </div>
          </div>
          <button
            type="button"
            className="ml-carechip ml-babypull"
            /* Offline is stated rather than attempted: the pull reads Huckleberry's calendar
               through the server, so with nothing to reach there is no point starting it. */
            disabled={running || !online}
            onClick={() => void pull()}
          >
            <Icon id="ico-refresh" size="0.9375rem" />
            {running ? 'Pulling…' : 'Pull'}
          </button>
        </div>
      </div>

      <p className={'ml-litter__note' + (failed ? ' ml-litter__note--bad' : '')}>
        {result ?? (
          online
            ? 'Reads Huckleberry’s calendar and writes nothing back. Safe to run as often as wanted —'
              + ' each upstream event is keyed and lands once however many times it is pulled.'
            : 'Offline. The pull reads through the server, so it needs a connection.'
        )}
      </p>
    </>
  )
}
