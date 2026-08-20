import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { CutGroup, DrillInHeader, ScreenShell, ScrollArea } from '../../components'
import { api } from '../../api/client'
import { agoLabel, longWeekday, planDate } from '../../app/mealsDomain'
import { calendarDaysUntil } from '../../app/kitchenDomain'
import type { DeductionReceiptDto, ReceiptLineDto } from '../../api/types'

/**
 * THE RECEIPT (COOKING_AND_AFTER §3, panel C3).
 *
 * A chrome-free errand, and **the only place stock is deducted** — so it is also the only place the
 * whole loop can be wrong. Every decision here follows from that.
 *
 * **Every deduction shows the before.** `had 6 · −6`, not just `−6`. A wrong number is then
 * catchable at the moment it happens rather than discovered weeks later when nobody can say what
 * changed it.
 *
 * **`LEFT ALONE` names the staples explicitly** rather than silently skipping them. The pantry's
 * honesty has to survive the one operation that could hide it.
 *
 * **Everything here is already applied.** The ticks are undo, not consent — `UNDO ALL` reverses the
 * lot as a single compensating event, taking any leftovers with it.
 */
export function KitchenReceiptScreen() {
  const navigate = useNavigate()
  const { entryId } = useParams<{ entryId: string }>()
  const planEntryId = Number(entryId)

  const [receipt, setReceipt] = useState<DeductionReceiptDto | null>(null)
  const [decided, setDecided] = useState(false)
  const [added, setAdded] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    if (!Number.isFinite(planEntryId)) return
    // A 204 means nothing was deductible, which is a normal outcome in the first weeks — the screen
    // simply has nothing to show rather than reporting an error.
    void api.deductForNight(planEntryId).then((r) => setReceipt(r ?? null)).catch(() => {})
  }, [planEntryId])

  useEffect(load, [load])

  const decide = async (decision: 'Fridge' | 'Freezer' | 'None') => {
    setBusy(true)
    try {
      await api.decideLeftovers(planEntryId, decision)
      setDecided(true)
    } finally {
      setBusy(false)
    }
  }

  const undoAll = async () => {
    setBusy(true)
    try {
      await api.undoDeduction(planEntryId)
      navigate('/kitchen', { replace: true })
    } finally {
      setBusy(false)
    }
  }

  if (!receipt) {
    return (
      <ScreenShell nav={false} header={<DrillInHeader title="" onBack={() => navigate('/kitchen')} />}>
        <div className="ml-kitchen__emptyshelf">Nothing came off the shelves for this night.</div>
      </ScreenShell>
    )
  }

  // One band, not two. An estimated line is still a thing that came off the shelves; splitting them
  // out made the count on `TAKEN OFF` disagree with the sentence above it, and put the honesty note
  // ("out of a jar — no way to count that") in a section somebody could skip.
  const taken = [...receipt.counted, ...receipt.estimated]

  /**
   * What this night took to nothing.
   *
   * `hitNone` is the receipt's own list of items the deduction emptied, so this is a fact the
   * server worked out rather than a re-reading of the numbers on screen — the two could otherwise
   * disagree about a line somebody has since undone.
   */
  const nowShort = taken
    .filter((l) => !l.undone && receipt.hitNone.includes(l.pantryItemId))
    .map((l) => l.name)

  /** Put them straight on the list, which is the only thing anybody would do next. */
  const addTheShort = async () => {
    setBusy(true)
    try {
      const lines = taken
        .filter((l) => !l.undone && receipt.hitNone.includes(l.pantryItemId))
        .map((l) => ({
          text: l.name,
          sourceKind: 'LowStock' as const,
          pantryItemId: l.pantryItemId,
        }))
      if (lines.length > 0) await api.addGroceryLines(lines)
      setAdded(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <ScreenShell
      nav={false}
      header={
        <DrillInHeader
          title="What that used"
          onBack={undoAll}
          backLabel="UNDO ALL"
        />
      }
    >
      <ScrollArea>
        <div className="ml-kitchen__meta">
          {receipt.dishName.toUpperCase()} · FOR {receipt.servings} · {whenEaten(receipt.date)}
        </div>
        <div className="ml-kitchen__receiptlede">
          {taken.length === 1
            ? 'One thing came off the shelves.'
            : `${taken.length} things came off the shelves.`}
        </div>

        {/* ---- Taken off, with the before beside the after ---- */}
        {taken.length > 0 && (
          <>
            <div className="ml-band">
              <span className="ml-band__label">TAKEN OFF</span>
              <span className="ml-band__meta">{taken.length}</span>
            </div>
            <CutGroup rows={7} rowHeight={42} className="ml-band-shade">
              {taken.map((line) => <Line key={line.eventId} line={line} />)}
            </CutGroup>
          </>
        )}

        {/* Named, not skipped. The one operation that could hide the pantry's honesty must not. */}
        {receipt.leftAlone.length > 0 && (
          <>
            <div className="ml-band ml-band--quiet">
              <span className="ml-band__label">LEFT ALONE</span>
              <span className="ml-band__meta">{receipt.leftAlone.length}</span>
            </div>
            <div className="ml-band-shade">
              {receipt.leftAlone.map((name) => (
                <div key={name} className="ml-row ml-kitchen__waitingrow">
                  <span className="ml-row__value">{name}</span>
                  <span className="ml-kitchen__eventwho">never counted</span>
                </div>
              ))}
            </div>
          </>
        )}

        {/* ---- The leftovers card ---- */}
        {receipt.produced && !decided && (
          <>
            <div className="ml-band ml-band--amber">
              <span className="ml-band__label">AND WHAT'S LEFT OVER</span>
            </div>
            <div className="ml-band-shade">
              <div className="ml-kitchen__leftovers">
                <div className="ml-kitchen__leftoverhead">
                  <span className="ml-kitchen__recipename">{receipt.produced.suggestedName}</span>
                  {/* Labelled a guess because it is one — the number comes from how many sat down,
                      which nobody promised was exact. */}
                  <span className="ml-kitchen__guess">A GUESS</span>
                </div>

                <div className="ml-kitchen__facts">
                  <div className="ml-kitchen__fact">
                    <span className="ml-kitchen__factlabel">COOKED FOR</span>
                    <span className="ml-kitchen__factvalue">{receipt.servings}</span>
                  </div>
                  <div className="ml-kitchen__fact">
                    <span className="ml-kitchen__factlabel">SPARE PORTIONS</span>
                    <span className="ml-kitchen__factvalue">
                      {receipt.produced.suggestedPortions} of {receipt.servings}
                    </span>
                  </div>
                </div>

                <div className="ml-kitchen__askwhy">
                  Put them somewhere and a leftovers night stops needing anything bought.
                </div>

                {/* Three answers, no keypad. The number is a guess, so asking somebody to type it
                    precisely would be false precision dressed up as care. */}
                <div className="ml-kitchen__errandrow">
                  <button type="button" className="ml-kitchen__shop" disabled={busy}
                    onClick={() => decide('Fridge')}>FRIDGE</button>
                  <button type="button" className="ml-kitchen__errandalt" disabled={busy}
                    onClick={() => decide('Freezer')}>FREEZER</button>
                  <button type="button" className="ml-kitchen__errandalt" disabled={busy}
                    onClick={() => decide('None')}>NONE LEFT</button>
                </div>
              </div>
            </div>
          </>
        )}

        {/*
          ---- What this settles ----

          The consequences in both directions, which is the block that turns a receipt into
          something worth reading twice: what no longer needs buying, and what just became short for
          a later night. C3's own build note says this space can only be closed with real content —
          the panel had 285px of void and the answer was this, not a bigger number somewhere.
        */}
        <div className="ml-band">
          <span className="ml-band__label">WHAT THIS SETTLES</span>
        </div>
        <div className="ml-band-shade">
          {receipt.produced && decided && (
            <div className="ml-row ml-kitchen__waitingrow">
              <span className="ml-row__value">{receipt.produced.suggestedName}</span>
              <span className="ml-kitchen__settledyes">nothing to buy</span>
            </div>
          )}
          {nowShort.length > 0 && (
            <div className="ml-row ml-kitchen__waitingrow">
              <span className="ml-row__value">{nowShort.join(', ')}</span>
              <span className="ml-kitchen__settledshort">
                {nowShort.length === 1 ? 'now needs buying' : 'now need buying'}
              </span>
            </div>
          )}
          {!decided && nowShort.length === 0 && (
            <div className="ml-kitchen__askwhy">
              Nothing on a later night changed because of this.
            </div>
          )}

          {/* Who and when. PANTRY_SHELVES §2 makes naming the author a rule for every event, and
              this is the one operation that moves the most stock at once. */}
          <div className="ml-kitchen__written">
            <span>
              {receipt.writtenByName
                ? `Written by ${receipt.writtenByName}`
                : 'Written at the panel'}
              {receipt.writtenAtUtc && ` · ${agoLabel(receipt.writtenAtUtc)}`}
            </span>
            {nowShort.length > 0 && (
              <button
                type="button"
                className="ml-kitchen__banddoor"
                disabled={busy || added}
                onClick={addTheShort}
              >
                {added ? 'ADDED' : `ADD THE ${nowShort.length}`}
              </button>
            )}
          </div>
        </div>

        <div className="ml-kitchen__errandrow">
          {/* Beside `THAT'S RIGHT` because this is the moment the finished dish exists — the one
              time a photograph of it can actually be taken (RECIPES §2). */}
          <button
            type="button"
            className="ml-kitchen__errandalt"
            onClick={() => navigate(`/kitchen/recipes/${receipt.planEntryId}`)}
          >
            PHOTOGRAPH IT
          </button>
          <button type="button" className="ml-kitchen__shop" onClick={() => navigate('/kitchen')}>
            THAT'S RIGHT
          </button>
        </div>
      </ScrollArea>
    </ScreenShell>
  )
}

/**
 * One deducted line — `Chicken breasts · had 6 · −6`.
 *
 * **The before and the change, in two separate cells.** §3 is specific about the form, and the
 * reason is that `had 6 → 0` makes you do the subtraction to find out what this night actually
 * used. The whole point of showing the before is catching a wrong number at the moment it happens.
 */
function Line({ line }: { line: ReceiptLineDto }) {
  const had = line.from != null ? `had ${trim(line.from)}` : line.note ? 'jar opened' : null
  const change = line.from != null && line.to != null
    ? `−${trim(line.from - line.to)}`
    : line.resultingState?.toLowerCase() ?? ''

  return (
    <div className={`ml-row ml-kitchen__receiptrow${line.undone ? ' ml-kitchen__eventrow--undone' : ''}`}>
      <span className="ml-kitchen__shelfname">{line.name}</span>
      <span className="ml-kitchen__shelfstate">{had}</span>
      <span className="ml-kitchen__shelfamount">{change}</span>
    </div>
  )
}

const trim = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ''))

/** `EATEN LAST NIGHT` / `EATEN THURSDAY` — the receipt's third meta fact. */
function whenEaten(date: string): string {
  const days = calendarDaysUntil(planDate(date), new Date())
  if (days === 0) return 'EATEN TODAY'
  if (days === 1) return 'EATEN LAST NIGHT'
  return `EATEN ${longWeekday(date).toUpperCase()}`
}
