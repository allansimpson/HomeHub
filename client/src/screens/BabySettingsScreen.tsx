import { useState } from 'react'
import { useNavigate } from 'react-router'
import { DrillInHeader, ScreenShell, ScrollArea, SectionLabel } from '../components'
import { useSession } from '../app/SessionProvider'
import { useBabyName } from '../app/babyName'

/**
 * Baby settings — what the household calls the child.
 *
 * <b>It held the pull out of Huckleberry until 2026-08-30.</b> That integration was phased out in
 * favour of the panel's own log; the section, its `Pull in history` control and the health row above
 * it went with it, leaving the one setting that was ever really the household's.
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
      </ScrollArea>
    </ScreenShell>
  )
}
