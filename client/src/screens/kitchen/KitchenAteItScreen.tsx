import { useState } from 'react'
import { useNavigate } from 'react-router'
import {
  CutGroup, KitchenHeader, KitchenQuickRow, ScreenShell, ScrollArea, Stepper,
} from '../../components'
import { clockLabel } from '../../app/dates'
import { useNow } from '../../app/useNow'
import { useMeals } from '../../app/MealsProvider'
import { entriesFor, longWeekday, shortDate, shortWeekday, todayKey } from '../../app/mealsDomain'
import { isBefore, servingsPlanned } from '../../app/kitchenDomain'
import type { MealPlanEntryDto } from '../../api/types'

/**
 * THE QUESTION AFTERWARDS (COOKING_AND_AFTER §2, panel C2).
 *
 * The one question the whole loop depends on, asked once and never nagged. Everything downstream —
 * deduction, leftovers, the folder's cooked history, the `NOT LATELY` sort — hangs on the answer,
 * and none of it may be inferred from the date passing.
 *
 * **`NO` is a real answer** and deducts nothing. A planned night that did not happen is data.
 *
 * **`OR SOME OF IT`** is the partial case: how many sat down against how many were cooked for. That
 * difference is exactly what becomes the leftovers card on the receipt.
 *
 * **Asked once, then dropped.** Unanswered nights collect for a week and then stop being asked. A
 * guess about a night nobody remembers is worse than a gap in the record.
 */
export function KitchenAteItScreen() {
  const navigate = useNavigate()
  const { week, recipes, setEaten } = useMeals()
  const today = todayKey()
  // The header carries the date and the clock, as every full-chrome Kitchen page does.
  const now = new Date(useNow(60_000))

  const [portions, setPortions] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  // Past dinners with no answer yet, soonest-last so the most recent is asked first.
  const waiting = (week?.days ?? [])
    .filter((d) => isBefore(d.date, today))
    .flatMap((d) => entriesFor(d, 'Dinner') as MealPlanEntryDto[])
    .filter((e) => e.wasEaten == null)
    .sort((a, b) => b.date.localeCompare(a.date))

  const asking = waiting[0]
  const rest = waiting.slice(1)

  const plannedFor = servingsPlanned(asking, recipes)

  const settled = (week?.days ?? [])
    .filter((d) => isBefore(d.date, today))
    .flatMap((d) => entriesFor(d, 'Dinner') as MealPlanEntryDto[])
    .filter((e) => e.wasEaten != null)

  const answer = async (entry: MealPlanEntryDto, ate: boolean, portionsEaten?: number) => {
    setBusy(true)
    try {
      await setEaten({ date: entry.date, slot: 'Dinner', wasEaten: ate, portionsEaten })
      // Saying yes is what moves stock, so the receipt is where the answer leads. Saying no moves
      // nothing and stays here — there is nothing to show.
      if (ate) navigate(`/kitchen/receipt/${entry.id}`)
      else setPortions(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <ScreenShell
      header={<KitchenHeader title="KITCHEN" meta={`${shortDate(today)} · ${clockLabel(now)}`} />}
      dock={<KitchenQuickRow />}
    >
      <ScrollArea>
        {asking ? (
          <>
            <div className="ml-band">
              <span className="ml-band__label">
                {shortWeekday(asking.date) === shortWeekday(today) ? 'LAST NIGHT' : longWeekday(asking.date).toUpperCase()}
              </span>
            </div>
            <div className="ml-band-shade">
              <div className="ml-kitchen__dish">{asking.recipeTitle ?? asking.freeText}</div>
              {plannedFor != null && (
                <div className="ml-kitchen__meta">PLANNED FOR {plannedFor}</div>
              )}

              <div className="ml-kitchen__askline">Did you have it?</div>

              <div className="ml-kitchen__errandrow">
                <button
                  type="button"
                  className="ml-kitchen__shop"
                  disabled={busy}
                  onClick={() => answer(asking, true)}
                >
                  YES, WE ATE IT
                </button>
                <button
                  type="button"
                  className="ml-kitchen__errandalt"
                  disabled={busy}
                  onClick={() => answer(asking, false)}
                >
                  NO
                </button>
              </div>

              {/* Says plainly what yes does. The household should never be surprised by stock
                  moving — the answer and its consequence belong in the same sentence. */}
              <div className="ml-kitchen__askwhy">
                Saying yes is what takes things off the shelves. Nothing has moved yet.
              </div>
            </div>

            {/* ---- The partial case ---- */}
            {plannedFor != null && plannedFor > 1 && (
              <>
                <div className="ml-band ml-band--amber">
                  <span className="ml-band__label">OR SOME OF IT</span>
                </div>
                <div className="ml-band-shade">
                  <div className="ml-kitchen__askwhy">
                    If only some of it got eaten, say how many sat down.
                  </div>
                  <div className="ml-kitchen__partial">
                    {/* Stepper is one square button, so the pair is composed here with the value
                        between them — the same arrangement the assign sheet uses. */}
                    <Stepper
                      direction="minus"
                      label="One fewer"
                      disabled={(portions ?? plannedFor) <= 1}
                      onStep={() => setPortions(Math.max(1, (portions ?? plannedFor) - 1))}
                    />
                    <span className="ml-kitchen__partialvalue">
                      {portions ?? plannedFor}
                    </span>
                    <Stepper
                      direction="plus"
                      label="One more"
                      disabled={(portions ?? plannedFor) >= plannedFor}
                      onStep={() => setPortions(Math.min(plannedFor, (portions ?? plannedFor) + 1))}
                    />
                    <span className="ml-kitchen__partialof">of the {plannedFor} planned</span>
                    <button
                      type="button"
                      className="ml-kitchen__errandalt"
                      disabled={busy}
                      onClick={() => answer(asking, true, portions ?? plannedFor)}
                    >
                      {portions ?? plannedFor} ATE
                    </button>
                  </div>
                </div>
              </>
            )}
          </>
        ) : (
          <div className="ml-kitchen__emptyshelf">Nothing is waiting on an answer.</div>
        )}

        {/* ---- Other nights still unanswered ---- */}
        {rest.length > 0 && (
          <>
            <div className="ml-band">
              <span className="ml-band__label">STILL WAITING</span>
              <span className="ml-band__meta">{rest.length}</span>
            </div>
            {/* 60px waiting rows — the figure §6 names for this panel. */}
            <CutGroup rows={3} rowHeight={60} className="ml-band-shade">
              {rest.map((entry) => (
                <div key={entry.id} className="ml-row ml-kitchen__waitingrow">
                  <span className="ml-kitchen__recipetext">
                    <span className="ml-kitchen__recipename">{entry.recipeTitle ?? entry.freeText}</span>
                    <span className="ml-kitchen__recipewhy">{longWeekday(entry.date)}</span>
                  </span>
                  <span className="ml-kitchen__inlineanswers">
                    <button type="button" disabled={busy} onClick={() => answer(entry, true)}>YES</button>
                    <span aria-hidden="true"> · </span>
                    <button type="button" disabled={busy} onClick={() => answer(entry, false)}>NO</button>
                  </span>
                </div>
              ))}
            </CutGroup>
            {/* Older than a week stops being asked about — a guess about a night nobody remembers is
                worse than a gap in the record. */}
            <div className="ml-kitchen__askwhy">Older than a week stops being asked about.</div>
          </>
        )}

        {settled.length > 0 && (
          <>
            <div className="ml-band ml-band--quiet">
              <span className="ml-band__label">SETTLED</span>
              <span className="ml-band__meta">{settled.length}</span>
            </div>
            <CutGroup rows={3} rowHeight={60} className="ml-band-shade">
              {settled.map((entry) => (
                <div key={entry.id} className="ml-row ml-kitchen__waitingrow">
                  <span className="ml-row__value">{entry.recipeTitle ?? entry.freeText}</span>
                  <span className={entry.wasEaten ? 'ml-kitchen__settledyes' : 'ml-kitchen__settledno'}>
                    {entry.wasEaten ? `eaten ${longWeekday(entry.date)}` : "didn't happen"}
                  </span>
                </div>
              ))}
            </CutGroup>
          </>
        )}
      </ScrollArea>
    </ScreenShell>
  )
}
