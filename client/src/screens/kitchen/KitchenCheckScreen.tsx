import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import {
  KitchenDrillInHeader, KitchenQuickRow, ScreenShell, ScrollArea, SectionLabel, Stepper,
} from '../../components'
import { api } from '../../api/client'
import { amountLabel } from '../../app/pantryDomain'
import {
  beliefLine, believedLabel, checkLede, checkQueue, runTally, settledChanged, settledLine,
} from '../../app/kitchenDomain'
import type { SettledRow } from '../../app/kitchenDomain'
import type { PantryItemDto } from '../../api/types'

/**
 * RUN A CHECK (PANTRY_SHELVES §3, panel P3).
 *
 * The correction pass — **a flow, not a form**, because it is done standing at a cupboard rather
 * than sitting at a desk. One card at a time, in shelf order.
 *
 * **Five answers, weighted, and the weighting is the design.** `THAT'S RIGHT` is brass and leads;
 * `ALL GONE` is its secondary peer; `CAN'T FIND IT` and `SKIP` are tertiary links under both. They
 * were four equal bordered boxes, which is the one arrangement §3's table rules out — it puts "the
 * commonest answer, one tap" at the same weight as "I gave up", and a household that taps the wrong
 * one of those has zeroed a shelf.
 *
 * **`CAN'T FIND IT` is deliberately not `ALL GONE`.** A thing you could not see is not a thing you
 * do not have, and conflating them is how a shelf count quietly becomes fiction.
 *
 * **Each answer is written the moment it is given.** Unlike the add errand there is no session to
 * commit — a check that lost its work halfway up the stairs would never be run twice. `UNDO LAST`
 * is what makes that safe: the ledger reverses an answer rather than the screen forgetting it.
 */
export function KitchenCheckScreen() {
  const navigate = useNavigate()

  const [queue, setQueue] = useState<PantryItemDto[]>([])
  const [at, setAt] = useState(0)
  const [nudged, setNudged] = useState<number | null>(null)
  const [done, setDone] = useState<SettledRow[]>([])
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    void api.getPantry()
      // Stale rows, in shelf order — the selection and the ordering answer different questions.
      // See `checkQueue`.
      .then((p) => setQueue(checkQueue(p.items)))
      .catch(() => {})
  }, [])

  useEffect(load, [load])

  const item = queue[at]
  const advance = () => { setNudged(null); setAt((i) => i + 1) }

  /**
   * Write one answer.
   *
   * **Confirming writes too.** `THAT'S RIGHT` changes no number but it is still a sighting, and the
   * queue is built from how stale a number is: an answer that wrote nothing would leave the row as
   * unconfirmed as it was before, so the same handful of items would head every single run and the
   * ones behind them would never be reached.
   *
   * `seen` is false for the one answer that is not a sighting — see the caller.
   */
  const settle = async (
    answer: SettledRow['answer'], quantity?: number, seen = true,
  ) => {
    if (!item) return
    setBusy(true)
    const was = amountLabel(item)
    try {
      if (seen) {
        await api.updatePantryItem(item.id, {
          name: item.name,
          location: item.location,
          tracking: item.tracking,
          quantity: quantity ?? item.quantity,
          unit: item.unit,
          estimateState: item.estimateState,
          packSize: item.packSize,
          packUnit: item.packUnit,
        }, item.version)
      }

      // The ledger row this answer wrote, so `UNDO LAST` has something to reverse. Fetched rather
      // than returned, because the PATCH answers with the item — and an undo that re-PATCHed the old
      // number back would be a second correction in the history rather than the retraction of a
      // first, which is exactly what `PantryEvent.UndoneByEventId` exists to avoid.
      const eventId = seen
        ? await api.getPantryEvents(item.id, 1).then((e) => e[0]?.id ?? null).catch(() => null)
        : null

      setDone((prev) => [{
        itemId: item.id,
        eventId,
        name: item.name,
        answer,
        was,
        now: quantity == null ? was : amountLabel({ ...item, quantity }),
      }, ...prev])
      advance()
    } finally {
      setBusy(false)
    }
  }

  /**
   * Take the last answer back.
   *
   * It reverses the ledger row and steps the card back to the item it was about, because an answer
   * somebody wants to undo is almost always one they want to give again — landing them on the *next*
   * item would mean walking the queue round a second time to reach it.
   */
  const undoLast = async () => {
    const last = done[0]
    if (!last) return
    setBusy(true)
    try {
      if (last.eventId != null) await api.undoPantryEvent(last.eventId)
      setDone((prev) => prev.slice(1))
      setNudged(null)
      setAt((i) => Math.max(0, i - 1))
      load()
    } finally {
      setBusy(false)
    }
  }

  const header = (
    <KitchenDrillInHeader
      title="Check the shelves"
      onExit={() => navigate('/kitchen/pantry')}
      // `STOP` beside `DONE`, and they are not the same word for the same thing. Every answer is
      // already written, so leaving loses nothing either way — but `STOP` is walking away mid-run
      // and `DONE` is saying the run is finished, and a household that only ever sees one of them
      // cannot tell the panel which it meant. How far through you are is on the bar, not up here.
      exit="STOP"
      status={
        <span className="ml-kitchen__headeraction">
          <button type="button" onClick={() => navigate('/kitchen/pantry')}>DONE</button>
        </span>
      }
    />
  )

  if (!item) {
    return (
      <ScreenShell
        avatar={false}
        header={header}
        dock={<KitchenQuickRow active="Pantry" />}
      >
        <ScrollArea>
          <div className="ml-kitchen__receiptlede">
            {done.length === 0
              ? 'Nothing on the shelves needs confirming.'
              : `${runTally(done)}. Every one of them is written.`}
          </div>
          {done.length > 0 && <Settled rows={done} onUndo={() => void undoLast()} busy={busy} />}
        </ScrollArea>
      </ScreenShell>
    )
  }

  const showing = nudged ?? item.quantity ?? 0
  const ahead = queue.slice(at + 1)

  return (
    <ScreenShell
      // No account badge: `DONE` has the right-hand cell, which is how the handoff draws it.
      avatar={false}
      header={header}
      dock={<KitchenQuickRow active="Pantry" />}
    >
      <ScrollArea>
        {/* What the run is and how long it will take, before anyone commits to it. */}
        <div className="ml-kitchen__checklede">{checkLede(queue.length)}</div>

        {/*
          Progress, because a flow with no visible end is one people abandon — and the count beside
          the bar, because a bar alone says "some of the way" where `2 OF 6` says how many more
          questions there are. §3 asks for both.
        */}
        <div className="ml-kitchen__checkprogress">
          <span className="ml-kitchen__bar">
            {/* Counts the card you are looking at, so the fill and `2 OF 6` beside it are the same
                fraction. They were not: the bar counted answered cards and the label counted the
                current one, so a run always showed a bar one card behind its own number. */}
            <span
              className="ml-kitchen__barfill"
              style={{ width: `${((at + 1) / queue.length) * 100}%` }}
            />
          </span>
          <span className="ml-kitchen__checkcount">{at + 1} OF {queue.length}</span>
        </div>

        {/*
          One card, and it is a card — bordered and filled, so the question is visibly a thing on
          top of the page rather than the top of the page. The two lists below it are what the run
          looks like from outside; this is the run itself.
        */}
        <div className="ml-kitchen__checkcard">
          {/* The shelf, not just the room. `MIDDLE SHELF` is drawn here and cannot be built yet —
              nothing models a sub-location — so the card names the room and stops. */}
          <span className="ml-kitchen__checkwhere">{item.location.toUpperCase()}</span>
          <span className="ml-kitchen__checkname serif">{item.name}</span>

          {/* What we believe, and how stale the belief is, in one sentence. A count without an age
              is a lie told confidently (PANTRY_BEHAVIOURS §9). */}
          <span className="ml-kitchen__checkbelief">{beliefLine(item)}</span>

          {/* The number is the middle of the card and the controls are at its edges, so the thing
              being changed is what the eye lands on rather than the pair of buttons changing it. */}
          <div className="ml-kitchen__checkcount-row">
            <Stepper
              direction="minus"
              label="One fewer"
              disabled={busy || showing <= 0}
              onStep={() => setNudged(Math.max(0, showing - 1))}
            />
            <span className="ml-kitchen__checkvalue">
              <span className="ml-kitchen__checknum serif">{showing}</span>
              <span className="ml-kitchen__checkunit">{item.unit ?? ''}</span>
            </span>
            <Stepper
              direction="plus"
              label="One more"
              disabled={busy}
              onStep={() => setNudged(showing + 1)}
            />
          </div>

          {/* Confirming is the commonest answer, so it is the one that is one tap and the one in
              brass. Winding the stepper turns it into the correction it now is. */}
          <div className="ml-kitchen__checkanswers">
            <button
              type="button"
              className="ml-kitchen__checkyes"
              disabled={busy}
              onClick={() => void settle(nudged == null ? 'confirmed' : 'changed', nudged ?? undefined)}
            >
              {nudged == null ? "THAT'S RIGHT" : `CORRECT IT TO ${nudged}`}
            </button>
            <button
              type="button"
              className="ml-kitchen__checkalt"
              disabled={busy}
              onClick={() => void settle('gone', 0)}
            >
              ALL GONE
            </button>
          </div>

          {/*
            Tertiary, and a link rather than a box. Both are ways of not answering, and drawing them
            as peers of `ALL GONE` offered "I gave up" at the weight of "the shelf is empty".

            `CAN'T FIND IT` changes no number and — unlike every other answer here — is **not a
            sighting**. Writing one would stamp the row as seen today on the strength of somebody
            failing to find it, which is the confident wrongness the section forbids. It costs the
            row its place at the front of the next check, and that is the correct price: the number
            really is still unconfirmed.
          */}
          <div className="ml-kitchen__checkpass">
            <button
              type="button"
              className="ml-kitchen__checklink"
              disabled={busy}
              onClick={() => void settle('notfound', undefined, false)}
            >
              CAN'T FIND IT
            </button>
            <button
              type="button"
              className="ml-kitchen__checklink"
              disabled={busy}
              onClick={advance}
            >
              SKIP
            </button>
          </div>
        </div>

        {/* What is coming, with what we believe about it — so the run has a visible shape. */}
        {ahead.length > 0 && (
          <>
            <SectionLabel label="STILL TO CHECK" />
            <div className="ml-kitchen__sheetlist">
              {ahead.map((next) => (
                <div key={next.id} className="ml-kitchen__usedrow ml-kitchen__usedrow--flat">
                  <span className="ml-kitchen__usedname">{next.name}</span>
                  {/* `think 500 g`, not `500 g`. Everything in this list is a guess by definition —
                      it is the list of numbers nobody has confirmed. */}
                  <span className="ml-kitchen__usedamount">{believedLabel(next)}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {done.length > 0 && <Settled rows={done} onUndo={() => void undoLast()} busy={busy} />}
      </ScrollArea>
    </ScreenShell>
  )
}

/**
 * What this run has settled, and the one control that takes it back.
 *
 * Shown on the run and again at the end, because the reason to look at it is the same in both
 * places: catching your own mis-tap while the cupboard is still open.
 */
function Settled({ rows, onUndo, busy }: { rows: SettledRow[]; onUndo: () => void; busy: boolean }) {
  return (
    <>
      <div className="ml-kitchen__sheetdivide" />
      <SectionLabel
        label="CORRECTED JUST NOW"
        status={
          <button type="button" className="ml-kitchen__undolast" disabled={busy} onClick={onUndo}>
            UNDO LAST
          </button>
        }
      />
      <div className="ml-kitchen__sheetlist">
        {rows.map((row) => (
          <div key={`${row.itemId}-${row.answer}-${row.now}`} className="ml-kitchen__usedrow ml-kitchen__usedrow--flat">
            <span className="ml-kitchen__usedname">{row.name}</span>
            {/* Verdigris on a row whose number moved. A confirmation and a correction are different
                kinds of outcome, and the colour is what lets somebody scan for the second. */}
            <span className={'ml-kitchen__usedamount' + (settledChanged(row) ? ' ml-kitchen__usedamount--changed' : '')}>
              {settledLine(row)}
            </span>
          </div>
        ))}
      </div>
      {/* Why there is no `SAVE` on this screen, said once. */}
      <div className="ml-kitchen__checkwritten">
        Each one is written the moment you answer, and each can be taken back.
      </div>
      <div className="ml-kitchen__checktally">
        <span className="ml-kitchen__checktallysaid">{runTally(rows)}</span>
        <span className="ml-kitchen__checktallymeta">THIS RUN</span>
      </div>
    </>
  )
}
