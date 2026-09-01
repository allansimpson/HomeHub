import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { KitchenDivider, KitchenDrillInHeader, ScreenShell, ScrollArea, Stepper } from '../../components'
import { inHandLabel } from '../../app/kitchenDomain'
import { api } from '../../api/client'
import { useMeals } from '../../app/MealsProvider'
import { mainFor, shortDate } from '../../app/mealsDomain'
import { isFlagged, numberWord } from '../../app/pantryDomain'
import type { StockCheckDto, StockCheckLineDto } from '../../api/types'

/**
 * ONE NIGHT OPENED (PLAN_WEEK §2, panel L2).
 *
 * **`COOKING FOR` is the load-bearing control.** Servings live on the night rather than the recipe,
 * and changing them re-runs everything below — the shortfalls, the claims, the leftovers estimate.
 * Cooking for eight from a recipe written for four wants twice as much, and a panel that changed
 * only the label would quietly under-buy by half.
 *
 * **An `about` item can never read as short.** Estimated stock lives in `ALREADY IN` whatever the
 * arithmetic looks like: the panel does not know how much is in the jar, so it must not claim the
 * night will run out.
 */
export function KitchenNightScreen() {
  const navigate = useNavigate()
  const { date } = useParams<{ date: string }>()
  const { week, recipes, planMeal } = useMeals()

  const [check, setCheck] = useState<StockCheckDto | null>(null)
  const [servings, setServings] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  const day = week?.days.find((d) => d.date === date)
  const entry = mainFor(day, 'Dinner')
  const recipe = entry?.recipeId != null ? recipes.find((r) => r.id === entry.recipeId) : undefined
  const target = servings ?? entry?.servingsOverride ?? recipe?.servings ?? null

  const load = useCallback(() => {
    if (entry?.recipeId == null) return
    void api.checkStock(entry.recipeId, target ?? undefined, entry.id)
      .then((c) => setCheck(c ?? null))
      .catch(() => {})
  }, [entry?.recipeId, entry?.id, target])

  useEffect(load, [load])

  if (!entry) {
    return (
      <ScreenShell header={<KitchenDrillInHeader exit="BACK" onExit={() => navigate('/kitchen/plan')} />}>
        <div className="ml-kitchen__emptyshelf">Nothing is planned for this night.</div>
      </ScreenShell>
    )
  }

  /** Changing servings rewrites the night, which is what re-runs the arithmetic underneath. */
  const commitServings = async (next: number) => {
    setServings(next)
    setBusy(true)
    try {
      await planMeal({ date: entry.date, slot: 'Dinner', recipeId: entry.recipeId, servingsOverride: next })
    } finally {
      setBusy(false)
    }
  }

  const short = (check?.lines ?? []).filter((l) => isFlagged(l.status))
  const inHand = (check?.lines ?? []).filter((l) => !isFlagged(l.status))

  return (
    <ScreenShell
      header={
        <KitchenDrillInHeader
          // The date names the night; the dish gets the page's own heading below. A header
          // carrying the recipe title would say the same thing twice and lose which night it is.
          label={shortDate(entry.date)}
          onExit={() => navigate('/kitchen/plan')}
          exit="BACK"
        />
      }
    >
      <ScrollArea>
        <div className="ml-kitchen__sheetname">{entry.recipeTitle ?? entry.freeText}</div>
        {recipe && (
          <div className="ml-kitchen__meta">
            {[recipe.sourceName, recipe.totalMinutes && `${recipe.totalMinutes} MIN`]
              .filter(Boolean).join(' · ').toUpperCase()}
          </div>
        )}

        {/* The control the rest of the panel hangs off. */}
        {target != null && (
          <>
            <div className="ml-kitchen__cookingfor">
              <span className="ml-kitchen__factlabel">COOKING FOR</span>
              <Stepper
                direction="minus"
                label="One fewer"
                disabled={busy || target <= 1}
                onStep={() => commitServings(target - 1)}
              />
              <span className="ml-kitchen__partialvalue">{target}</span>
              <Stepper
                direction="plus"
                label="One more"
                disabled={busy}
                onStep={() => commitServings(target + 1)}
              />
              {recipe?.servings != null && target !== recipe.servings && (
                <span className="ml-kitchen__partialof">written for {recipe.servings}</span>
              )}
            </div>
            <div className="ml-kitchen__askwhy">Everything below is worked out from this.</div>
          </>
        )}

        {short.length > 0 && (
          <>
            <KitchenDivider label={shortLabel(short.length)} amber gap={false} />
            <div>
              {short.map((line) => <ShortRow key={line.ingredientId} line={line} />)}
            </div>
          </>
        )}

        {inHand.length > 0 && (
          <>
            <KitchenDivider label="Already in" count={inHand.length} />
            {/* Nine rows, then it bisects (PLAN_WEEK §2). The short band above deliberately does
                not scroll — a shortfall you have to scroll to see all of is one you will act on
                incompletely. */}
            <div>
              {inHand.map((line) => (
                <div key={line.ingredientId} className="ml-row ml-kitchen__shelfrow">
                  <span className="ml-kitchen__shelfname">{line.name}</span>
                  {/* How much is *in* — the question the band's own heading asks. `about` in the
                      quiet brass: an approximation that is visibly one, and never in the short
                      band however the numbers look. */}
                  <span
                    className={
                      'ml-kitchen__shelfamount'
                      + (line.lastSeenState ? ' ml-kitchen__shelfamount--about' : '')
                    }
                  >
                    {inHandLabel(line)}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="ml-kitchen__errandactions">
          <button
            type="button"
            className="ml-kitchen__shop"
            disabled={short.length === 0}
            onClick={() => navigate('/kitchen/list')}
          >
            ADD THE {short.length} TO THE LIST
          </button>
          <div className="ml-kitchen__errandrow">
            <button type="button" className="ml-kitchen__errandalt" onClick={() => navigate('/kitchen/plan')}>
              MOVE IT
            </button>
            <button type="button" className="ml-kitchen__errandalt" onClick={() => navigate('/kitchen/recipes')}>
              SWAP
            </button>
          </div>
        </div>
      </ScrollArea>
    </ScreenShell>
  )
}

/**
 * A short line, said as what is needed against what is in.
 *
 * The two numbers side by side are the whole argument — "need 6 cans / 4 in" tells you what to do
 * in a way that "short" alone never can.
 */
function ShortRow({ line }: { line: StockCheckLineDto }) {
  return (
    <div className="ml-row ml-kitchen__shortrow">
      <span className="ml-kitchen__shelfname">{line.name}</span>
      <span className="ml-kitchen__shortneed">
        {line.needed ? `need ${line.needed}` : ''}
      </span>
      <span className="ml-kitchen__shorthave">
        {/* Spoken for by an earlier night reads differently from simply absent — the thing is
            here, and that changes what you would do about it. */}
        {line.status === 'ClaimedAway'
          ? 'claimed'
          : line.status === 'NoMatch' || line.status === 'Unknown'
            ? "can't say"
            : line.lastSeenQuantity != null ? `${line.lastSeenQuantity} in` : 'none in'}
      </span>
    </div>
  )
}

/**
 * `Three things short` — words up to ten, figures beyond, as the section does everywhere else.
 *
 * `numberWord` returns the word in lower case because it is usually read mid-sentence; a divider
 * label is the start of one, so the capital is put back here rather than by changing a helper
 * eleven other call sites depend on.
 */
function shortLabel(count: number): string {
  if (count === 1) return 'One thing short'
  const word = numberWord(count)
  return `${word.charAt(0).toUpperCase()}${word.slice(1)} things short`
}
