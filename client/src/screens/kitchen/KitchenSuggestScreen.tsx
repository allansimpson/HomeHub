import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { CutGroup, DrillInHeader, ScreenShell, ScrollArea } from '../../components'
import { api } from '../../api/client'
import { useMeals } from '../../app/MealsProvider'
import { cookedAgoLabel, longWeekday, shortDate } from '../../app/mealsDomain'
import { usesSentence } from '../../app/kitchenDomain'
import type { CookabilityDto, DueRecipeDto, RecipeSummaryDto } from '../../api/types'

/**
 * FILLING AN EMPTY NIGHT (PLAN_WEEK §3, panel L3).
 *
 * Ranked in the order the household asked for, and the order is the design:
 *
 * 1. **`USES SOMETHING TURNING`** — the top-ranked reason, and the only one that gets a card.
 * 2. **`NOTHING TO BUY`** — the bulk of the answer.
 * 3. **`ONE OR TWO SHORT`** — because one missing thing is not a reason to cook something worse.
 * 4. **`QUICK, AND NOT LATELY`** — for when nothing above appeals.
 *
 * **Every row carries when you last made it**, so the same four dinners do not recur forever. That
 * is the quiet failure mode of every suggestion list: without it, the ranking converges on whatever
 * the household happens to have stocked and never surprises them again.
 */
export function KitchenSuggestScreen() {
  const navigate = useNavigate()
  const { date } = useParams<{ date: string }>()
  const { recipes, planMeal } = useMeals()

  const [due, setDue] = useState<DueRecipeDto[]>([])
  const [standing, setStanding] = useState<Map<number, CookabilityDto>>(new Map())
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    void api.getDueRecipes(5).then(setDue).catch(() => {})
    void api.getCookable()
      .then((rows) => setStanding(new Map(rows.map((r) => [r.recipeId, r]))))
      .catch(() => {})
  }, [])

  useEffect(load, [load])

  const put = async (recipeId: number) => {
    if (!date) return
    setBusy(true)
    try {
      await planMeal({ date, slot: 'Dinner', recipeId })
      navigate('/kitchen/plan')
    } finally {
      setBusy(false)
    }
  }

  const lead = due.find((d) => d.score > 0)
  const leadRecipe = lead ? recipes.find((r) => r.id === lead.recipeId) : undefined

  const band = (predicate: (r: RecipeSummaryDto) => boolean): RecipeSummaryDto[] =>
    recipes.filter((r) => r.id !== lead?.recipeId && predicate(r))

  const ready = band((r) => standing.get(r.id)?.band === 'Ready')
  const nearly = band((r) => {
    const s = standing.get(r.id)
    return s?.band === 'Short' && s.shortCount <= 2
  })
  // Quick and not lately, from what is left — the fallback when nothing above appeals.
  const quick = band((r) =>
    standing.get(r.id)?.band !== 'Ready'
    && (r.totalMinutes ?? 999) <= 25
    && !nearly.some((n) => n.id === r.id))

  return (
    <ScreenShell
      header={
        <DrillInHeader
          title={date ? shortDate(date) : 'A NIGHT'}
          onBack={() => navigate('/kitchen/plan')}
          backLabel="BACK"
        />
      }
    >
      <ScrollArea>
        <div className="ml-kitchen__sheetname">What could you cook?</div>
        <div className="ml-kitchen__askwhy">
          Sorted by what is turning first, then by what needs no shopping.
        </div>

        {/* The one card. Turning-first was the household's call, and it earns the only card. */}
        {lead && leadRecipe && (
          <>
            <div className="ml-band ml-band--amber">
              <span className="ml-band__label">USES SOMETHING TURNING</span>
            </div>
            <div className="ml-kitchen__lead">
              <div className="ml-kitchen__leadtitle">{leadRecipe.title}</div>
              <div className="ml-kitchen__leadwhy">
                {usesSentence(lead.uses)}.
                {leadRecipe.totalMinutes != null && ` ${leadRecipe.totalMinutes} minutes.`}
                {standing.get(leadRecipe.id)?.band === 'Ready' && ' Nothing to buy.'}
              </div>
              <div className="ml-kitchen__errandrow">
                <button
                  type="button"
                  className="ml-kitchen__shop"
                  disabled={busy}
                  onClick={() => put(leadRecipe.id)}
                >
                  PUT IT ON {date ? longWeekday(date).toUpperCase() : 'THIS NIGHT'}
                </button>
                <button
                  type="button"
                  className="ml-kitchen__errandalt"
                  onClick={() => navigate(`/kitchen/recipes/${leadRecipe.id}`)}
                >
                  LOOK AT IT
                </button>
              </div>
            </div>
          </>
        )}

        <Band label="NOTHING TO BUY" rows={ready} onPick={put} busy={busy} />
        <Band label="ONE OR TWO SHORT" rows={nearly} onPick={put} busy={busy}
          why={(r) => {
            const n = standing.get(r.id)?.shortCount ?? 0
            return n === 1 ? 'needs one thing' : `needs ${n} things`
          }} />
        <Band label="QUICK, AND NOT LATELY" rows={quick} onPick={put} busy={busy} />

        <div className="ml-kitchen__errandrow">
          <button type="button" className="ml-kitchen__errandalt" onClick={() => navigate('/kitchen/recipes')}>
            SEARCH THE FOLDER
          </button>
          {/* A night can always be free text. Not every dinner is a recipe, and a planner that
              insisted otherwise would be one people work around. */}
          <button type="button" className="ml-kitchen__errandalt" onClick={() => navigate('/kitchen/plan')}>
            WRITE SOMETHING IN
          </button>
        </div>
      </ScrollArea>
    </ScreenShell>
  )
}

function Band({
  label, rows, onPick, busy, why,
}: {
  label: string
  rows: RecipeSummaryDto[]
  onPick: (id: number) => void
  busy: boolean
  why?: (r: RecipeSummaryDto) => string
}) {
  if (rows.length === 0) return null

  return (
    <>
      <div className="ml-band">
        <span className="ml-band__label">{label}</span>
        <span className="ml-band__meta">{rows.length}</span>
      </div>
      {/* Every suggestion band is a scroller that bisects — the ranking is the point, and a hard
          slice at five hides the tail of a list the household is meant to browse (PLAN_WEEK §3). */}
      <CutGroup rows={3} rowHeight={56} className="ml-band-shade">
        {rows.map((r) => (
          <button
            key={r.id}
            type="button"
            className="ml-row ml-kitchen__recipe"
            disabled={busy}
            onClick={() => onPick(r.id)}
          >
            <span className="ml-kitchen__recipetext">
              <span className="ml-kitchen__recipename">{r.title}</span>
              {why && <span className="ml-kitchen__recipewhy ml-kitchen__recipewhy--short">{why(r)}</span>}
            </span>
            {r.totalMinutes != null && (
              <span className="ml-kitchen__recipetime">{r.totalMinutes} min</span>
            )}
            {/* When it was last made — what stops the same four dinners recurring forever. */}
            <span className="ml-kitchen__lastmade">{cookedAgoLabel(r.lastCookedDate)}</span>
          </button>
        ))}
      </CutGroup>
    </>
  )
}
