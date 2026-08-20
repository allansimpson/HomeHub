import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { CutGroup, DrillInHeader, ScreenShell, ScrollArea, Stepper } from '../../components'
import { api } from '../../api/client'
import { DecisionCard } from './DecisionCard'
import {
  amountOf, planPutAway,
  type PutAwayLanding, type PutAwayQuestion,
} from '../../app/kitchenDomain'
import type { PantryItemDto } from '../../api/types'

/** How a disagreement got settled. Held here until the footer commits — nothing writes before it. */
type Settlement = 'same' | 'separate' | 'split' | 'whole'

/**
 * PUTTING IT AWAY (LIST_AND_SHOPPING §4, panel G4).
 *
 * **Ticked is not received.** Nothing reaches the pantry until this panel is committed. That gap is
 * the whole point of the panel: a tick in the shop records what you meant to buy, and only this
 * screen records what actually came home. Collapsing the two would make every substitution and
 * every wrong pack size invisible.
 *
 * The decision cards here are literally {@link DecisionCard} — the same control the review uses,
 * because both panels are asking the household to settle a disagreement between what the app
 * believed and what is true.
 *
 * **Dates are offered for fresh things only, pre-filled, and always ignorable.** This is the one
 * narrow place a date enters the pantry (ADD_TO_PANTRY §6); everywhere else the household is asked
 * for a date it will not have, and that is how a pantry fills with fiction.
 */
export function KitchenPutAwayScreen() {
  const navigate = useNavigate()

  const [landings, setLandings] = useState<PutAwayLanding[]>([])
  const [questions, setQuestions] = useState<PutAwayQuestion[]>([])
  const [answers, setAnswers] = useState<Map<number, Settlement>>(new Map())
  const [splitInto, setSplitInto] = useState<Map<number, number>>(new Map())
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    void Promise.all([api.getGrocery(), api.getShelfLife(), api.getPantry()])
      .then(([list, shelfLife, pantry]) => {
        const sorted = planPutAway(
          list.lines.filter((l) => l.checkedAtUtc != null), pantry.items, shelfLife)
        setLandings(sorted.landings)
        setQuestions(sorted.questions)
      })
      .catch(() => {})
  }, [])

  useEffect(load, [load])

  const answered = questions.filter((q) => answers.has(q.line.id)).length
  const total = landings.length + answered

  /** The one write. Everything above has been held in the panel until now. */
  const commit = async () => {
    setBusy(true)
    try {
      for (const landing of landings) {
        if (landing.existing) {
          // Already back on its shelf, put there by the tick. All this panel has to add is what it
          // collected — where it landed, and the date if somebody kept the offered one.
          await api.updatePantryItem(landing.existing.id, {
            name: landing.existing.name,
            location: landing.location,
            tracking: landing.existing.tracking,
            quantity: landing.existing.quantity,
            unit: landing.existing.unit,
            estimateState: landing.existing.estimateState,
            packSize: landing.existing.packSize,
            packUnit: landing.existing.packUnit,
            goodUntil: landing.goodUntil,
          }, landing.existing.version)
        } else {
          await api.createPantryItem({
            name: landing.line.text,
            location: landing.location,
            tracking: 'Counted',
            quantity: landing.line.quantity ?? 1,
            unit: landing.line.unit,
            goodUntil: landing.goodUntil,
          })
        }
        await api.deleteGroceryLine(landing.line.id)
      }

      for (const q of questions) {
        const how = answers.get(q.line.id)
        // An unanswered question stays on the list, still ticked. Clearing it with the rest would
        // take the groceries off the list without them ever reaching a shelf — the one outcome
        // this panel exists to make impossible.
        if (how == null) continue

        const parts = how === 'split' ? (splitInto.get(q.line.id) ?? 2) : 1
        const each = (q.line.quantity ?? 1) / parts
        const shelf = q.existing

        // A split of something that already came back to a shelf must not add the whole amount
        // again. The row keeps one bag's worth of what the tick returned and the rest is moved into
        // new bags, so the total across them is what actually came home.
        let toMake = parts
        if (shelf) {
          await api.updatePantryItem(shelf.id, {
            name: shelf.name,
            location: how === 'split' ? 'Freezer' : shelf.location,
            tracking: shelf.tracking,
            quantity: (shelf.quantity ?? 0) - (q.line.quantity ?? 1) + each,
            unit: shelf.unit,
            estimateState: shelf.estimateState,
            packSize: shelf.packSize,
            packUnit: shelf.packUnit,
          }, shelf.version)
          toMake = parts - 1
        }

        let landed: PantryItemDto | null = shelf
        for (let i = 0; i < toMake; i += 1) {
          landed = await api.createPantryItem({
            name: q.line.text,
            location: how === 'split' ? 'Freezer' : 'Cupboard',
            tracking: 'Counted',
            quantity: each,
            unit: q.line.unit,
          })
        }

        // `SAME THING` is the answer that teaches: what was asked for now means what came home, so
        // the next substitution of it resolves instead of asking again. It has to be taught against
        // the row just created — a substituted line has no pantry item of its own, which is what
        // made it a question in the first place.
        if (how === 'same' && landed) await api.teachMatch(q.onTheList, landed.id)

        await api.deleteGroceryLine(q.line.id)
      }

      navigate('/kitchen/pantry')
    } finally {
      setBusy(false)
    }
  }

  return (
    <ScreenShell
      nav={false}
      header={
        <DrillInHeader
          title="What came home"
          onBack={() => navigate('/kitchen/list')}
          // `LATER`, not `CANCEL`. Leaving abandons nothing — the shopping stays ticked and this
          // panel is still here when somebody comes back to it.
          backLabel="LATER"
        />
      }
    >
      <ScrollArea>
        <div className="ml-kitchen__askwhy">
          Nothing reaches a shelf until this is committed.
        </div>

        {landings.length > 0 && (
          <>
            <div className="ml-band">
              <span className="ml-band__label">STRAIGHT TO THEIR SHELVES</span>
              <span className="ml-band__meta">{landings.length}</span>
            </div>
            <CutGroup rows={4} rowHeight={42} className="ml-band-shade">
              {/* No interaction on these rows at all. Anything the app is sure of should cost the
                  household nothing to accept. */}
              {landings.map((landing) => (
                <div key={landing.line.id} className="ml-row ml-kitchen__awayrow">
                  <span className="ml-kitchen__shelfname">{landing.line.text}</span>
                  <span className="ml-kitchen__awayqty">{amountOf(landing.line)}</span>
                  <span className="ml-kitchen__awaywhere">{landing.location.toLowerCase()}</span>
                </div>
              ))}
            </CutGroup>
          </>
        )}

        {questions.length > 0 && (
          <>
            <div className="ml-band ml-band--amber">
              <span className="ml-band__label">THESE NEED A DECISION</span>
              <span className="ml-band__meta">{questions.length - answered}</span>
            </div>
            <div className="ml-band-shade">
              {questions.map((q) => {
                const chosen = answers.get(q.line.id)
                const pick = (how: Settlement) =>
                  setAnswers((prev) => new Map(prev).set(q.line.id, how))
                const parts = splitInto.get(q.line.id) ?? 2

                return (
                  <DecisionCard
                    key={q.line.id}
                    item={q.line.text}
                    kind={q.kind === 'substitution' ? 'NOT WHAT WAS ASKED FOR' : 'TOO MUCH FOR ONE ITEM'}
                    leftLabel="ON THE LIST"
                    leftValue={q.onTheList}
                    rightLabel="CAME HOME"
                    rightValue={q.cameHome}
                    extra={q.kind === 'split' && chosen === 'split' ? (
                      <div className="ml-kitchen__partial">
                        <Stepper
                          direction="minus"
                          label="One bag fewer"
                          disabled={parts <= 2}
                          onStep={() => setSplitInto((p) => new Map(p).set(q.line.id, parts - 1))}
                        />
                        <span className="ml-kitchen__partialvalue">{parts}</span>
                        <Stepper
                          direction="plus"
                          label="One bag more"
                          onStep={() => setSplitInto((p) => new Map(p).set(q.line.id, parts + 1))}
                        />
                        <span className="ml-kitchen__partialof">bags</span>
                      </div>
                    ) : undefined}
                    choices={q.kind === 'substitution' ? [
                      { label: 'SAME THING', primary: chosen !== 'separate', onChoose: () => pick('same') },
                      { label: 'KEEP SEPARATE', primary: chosen === 'separate', onChoose: () => pick('separate') },
                    ] : [
                      { label: 'SPLIT · FREEZER', primary: chosen !== 'whole', onChoose: () => pick('split') },
                      { label: 'KEEP WHOLE', primary: chosen === 'whole', onChoose: () => pick('whole') },
                    ]}
                  />
                )
              })}
            </div>
          </>
        )}

        {/* Fresh things only, pre-filled, and headed OPTIONAL because it is. */}
        {landings.some((l) => l.fresh) && (
          <>
            <div className="ml-band ml-band--quiet">
              <span className="ml-band__label">FRESH · WORTH A DATE</span>
              <span className="ml-band__meta">OPTIONAL</span>
            </div>
            <div className="ml-band-shade">
              {landings.filter((l) => l.fresh).map((landing) => (
                <div key={landing.line.id} className="ml-row ml-kitchen__daterow">
                  <span className="ml-kitchen__shelfname">{landing.line.text}</span>
                  <input
                    type="date"
                    className="ml-kitchen__input"
                    value={landing.goodUntil ?? ''}
                    onChange={(e) => setLandings((prev) => prev.map((l) =>
                      l.line.id === landing.line.id
                        ? { ...l, goodUntil: e.target.value || null }
                        : l))}
                  />
                  <span className="ml-kitchen__guess">a guess</span>
                </div>
              ))}
            </div>
          </>
        )}

        {landings.length === 0 && questions.length === 0 && (
          <div className="ml-kitchen__emptyshelf">Nothing has been ticked off yet.</div>
        )}
      </ScrollArea>

      <div className="ml-kitchen__errandactions">
        <button
          type="button"
          className="ml-kitchen__shop"
          disabled={busy || total === 0}
          onClick={commit}
        >
          PUT IT ALL AWAY · {total} {total === 1 ? 'THING' : 'THINGS'}
        </button>
      </div>
    </ScreenShell>
  )
}
