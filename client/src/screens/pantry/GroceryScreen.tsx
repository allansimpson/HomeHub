import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ScreenShell, DrillInHeader, ScrollArea } from '../../components'
import { usePantry } from '../../app/PantryProvider'
import { useNow } from '../../app/useNow'
import { grocerySections, mirrorLines, provenanceLine, trimNumber } from '../../app/pantryDomain'
import { Chevron, PantryLabel, PrimaryButton, SecondaryButton, TickBox } from './parts'

/**
 * The grocery list (PANTRY_SCREEN §5, id 9e).
 *
 * HomeHub owns this list; To Do is a projection of it. Two things follow, and both are visible on
 * this screen: every row can say *why* it is here, and ticking one puts stock back on a shelf —
 * neither of which a mirrored list could carry (DECISIONS P8).
 */
export function GroceryScreen() {
  const navigate = useNavigate()
  const { grocery, checkGrocery, addToGrocery, clearChecked } = usePantry()
  // A minute: the mirror strip states a relative age and it has to stay honest while someone reads
  // it. Everything else on the screen is static.
  const now = new Date(useNow(60_000))
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)

  const lines = grocery?.lines ?? []
  const sections = grocerySections(lines)
  const checkedCount = lines.filter((l) => l.checkedAtUtc).length
  const mirror = grocery?.mirror
  const strip = mirror ? mirrorLines(mirror, now) : null

  const submit = async () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    setAdding(false)
    await addToGrocery({ text, sourceKind: 'Hand' })
  }

  return (
    <ScreenShell
      header={
        <DrillInHeader
          title="GROCERY"
          onBack={() => navigate('/pantry')}
          status={`${grocery?.openCount ?? 0} OPEN`}
        />
      }
    >
      {/* Permanent, never a toast. Direction and age, always — a mirror nobody can see is a mirror
          nobody trusts (DECISIONS PG8). */}
      {strip && (
        <button
          type="button"
          className={`pt-mirror pt-mirror--${strip.tone}`}
          onClick={() => navigate('/settings/tasks')}
        >
          <span className="pt-mirror__dot" aria-hidden="true" />
          <span className="pt-mirror__main">
            <span className="pt-mirror__label">{strip.label}</span>
            <span className="pt-mirror__detail">{strip.detail}</span>
          </span>
          <Chevron />
        </button>
      )}

      <ScrollArea>
        {lines.length === 0 ? (
          <div className="pt-empty pt-empty--short">
            <span className="pt-empty__title serif">Nothing on the list</span>
            <span className="pt-empty__body">
              Things you&rsquo;ll need for this week&rsquo;s meals turn up here on their own.
            </span>
          </div>
        ) : (
          sections.map((section) => (
            section.lines.length === 0 ? null : (
              <div className={'pt-gsection' + (section.key === 'done' ? ' pt-gsection--done' : '')} key={section.key}>
                <PantryLabel label={section.label} meta={section.lines.length} />
                {section.lines.map((line) => {
                  const done = Boolean(line.checkedAtUtc)
                  return (
                    <div className={'pt-grow' + (done ? ' pt-grow--done' : '')} key={line.id}>
                      <TickBox
                        checked={done}
                        label={line.text}
                        onToggle={() => void checkGrocery(line.id, !done)}
                      />
                      <span className="pt-grow__main">
                        <span className="pt-grow__name">
                          {line.text}
                          {line.quantity != null && line.quantity > 1 && (
                            <span className="pt-grow__qty">{`×${trimNumber(line.quantity)}`}</span>
                          )}
                        </span>
                        {/* Once ticked, provenance is replaced by the return trip: what the tick
                            just did is more use than why the line was added. */}
                        <span className={'pt-grow__sub' + (done ? ' pt-grow__sub--return' : '')}>
                          {done ? (line.returnTrip ?? 'Ticked off') : provenanceLine(line)}
                        </span>
                      </span>
                    </div>
                  )
                })}
              </div>
            )
          ))
        )}
      </ScrollArea>

      <div className="pt-footer pt-footer--column">
        {adding ? (
          <div className="pt-addrow">
            <input
              className="pt-field__input"
              autoFocus
              value={draft}
              placeholder="Kitchen roll"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void submit() }}
            />
            <SecondaryButton onClick={() => { setDraft(''); setAdding(false) }}>CANCEL</SecondaryButton>
            <PrimaryButton onClick={() => void submit()} disabled={!draft.trim()}>ADD</PrimaryButton>
          </div>
        ) : (
          <div className="pt-footer__row">
            <PrimaryButton grow={2.4} onClick={() => setAdding(true)}>ADD SOMETHING</PrimaryButton>
            <SecondaryButton
              onClick={() => void clearChecked()}
              disabled={checkedCount === 0}
            >
              {`CLEAR ${checkedCount}`}
            </SecondaryButton>
          </div>
        )}
        <p className="pt-footnote">Ticking something off puts it back in the pantry.</p>
      </div>
    </ScreenShell>
  )
}
