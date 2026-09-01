import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { KitchenDivider, KitchenDrillInHeader, ScreenShell, ScrollArea } from '../../components'
import { api } from '../../api/client'
import { countdown, ingredientsForStep, stepTimerMinutes } from '../../app/kitchenDomain'
import { clockLabel } from '../../app/dates'
import { useNow } from '../../app/useNow'
import type { RecipeDto, StockCheckDto } from '../../api/types'

/**
 * COOKING (COOKING_AND_AFTER §1, panel C1).
 *
 * A full-page errand with no chrome, and **the largest type in the section** — this is read from
 * across a worktop, at arm's length, with wet hands.
 *
 * **Cooking deducts nothing.** Starting to cook is not eating. The panel can be abandoned at step
 * three with no consequence at all, and `WHEN YOU'VE EATEN` says so on the screen rather than
 * leaving the household to wonder what it has already committed them to. The deduction happens
 * once, later, when somebody answers *did you have it* — and that is the only place it happens.
 *
 * **`PAUSE` leaves it resumable**, because the common interruption in a kitchen is not abandoning
 * the recipe.
 */
export function KitchenCookScreen() {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const [params] = useSearchParams()
  const entryId = params.get('entry')

  const [recipe, setRecipe] = useState<RecipeDto | null>(null)
  const [check, setCheck] = useState<StockCheckDto | null>(null)
  const [at, setAt] = useState(0)
  const [done, setDone] = useState<Set<number>>(new Set())
  const [timer, setTimer] = useState<number | null>(null)
  // The wall clock in the header — the time of day, not the step timer.
  const now = new Date(useNow(60_000))

  const load = useCallback(() => {
    if (!id) return
    void api.getRecipe(Number(id)).then(setRecipe).catch(() => {})
    void api.checkStock(Number(id), undefined, entryId ? Number(entryId) : undefined)
      .then((c) => setCheck(c ?? null)).catch(() => {})
  }, [id, entryId])

  useEffect(load, [load])

  // The offered timer, counting once started. Nothing here touches stock.
  useEffect(() => {
    if (timer == null || timer <= 0) return
    const h = window.setInterval(() => setTimer((t) => (t == null ? null : t - 1)), 1000)
    return () => window.clearInterval(h)
  }, [timer])

  const steps = useMemo(() => recipe?.steps ?? [], [recipe])
  const step = steps[at]
  const offered = step ? stepTimerMinutes(step.text) : null

  if (!recipe || !step) {
    return (
      <ScreenShell nav={false} header={<KitchenDrillInHeader exit="BACK" onExit={() => navigate(-1)} />}>
        <div className="ml-kitchen__emptyshelf">Nothing to cook here.</div>
      </ScreenShell>
    )
  }

  const advance = () => {
    setDone((prev) => new Set(prev).add(step.id))
    setTimer(null)
    if (at + 1 < steps.length) setAt(at + 1)
  }

  const beside = ingredientsForStep(recipe.ingredients, step.text)

  return (
    <ScreenShell
      nav={false}
      header={
        <KitchenDrillInHeader
          // Where you are, not what you are making — you know what you are making; you are holding
          // it. The clock on the right is the time of day, which is the thing somebody mid-recipe
          // actually looks up (COOKING_AND_AFTER §1).
          label={`STEP ${at + 1} OF ${steps.length}`}
          onExit={() => navigate(-1)}
          exit="PAUSE"
          status={clockLabel(now)}
        />
      }
    >
      <ScrollArea>
        {/* One segment per step, so where you are is legible without reading a number. */}
        <div className="ml-kitchen__segment">
          {steps.map((s, i) => (
            <span
              key={s.id}
              className={'ml-kitchen__segcell' + (i <= at ? ' ml-kitchen__segcell--on' : '')}
            />
          ))}
        </div>

        {/* 26px, the largest step type in the section. */}
        <div className="ml-kitchen__steptext">{step.text}</div>

        {beside.length > 0 && (
          <>
            <KitchenDivider label="For this step" count={beside.length} gap={false} />
            <div>
              {/* Only this step's ingredients. The full list is a scroll away and having it here
                  would put twelve lines in front of somebody who needs three. */}
              {beside.map((text) => (
                <div key={text} className="ml-row ml-kitchen__steping">{text}</div>
              ))}
            </div>
          </>
        )}

        {/* Offered, not started — a timer that began on its own would be counting the wrong thing
            about half the time. */}
        {offered != null && (
          <div className="ml-kitchen__timer">
            <span className="ml-kitchen__timernum">
              {countdown(timer ?? offered * 60)}
            </span>
            <button
              type="button"
              className="ml-kitchen__errandalt"
              onClick={() => setTimer(timer == null ? offered * 60 : null)}
            >
              {timer == null ? `START ${offered} MIN` : 'STOP IT'}
            </button>
          </div>
        )}

        <div className="ml-kitchen__errandactions">
          <button type="button" className="ml-kitchen__shop" onClick={advance}>
            {at + 1 < steps.length ? 'NEXT STEP' : 'THAT WAS THE LAST STEP'}
          </button>
          {at > 0 && (
            <button type="button" className="ml-kitchen__errandalt" onClick={() => setAt(at - 1)}>
              BACK A STEP
            </button>
          )}
        </div>

        {/* The whole recipe, reachable without leaving. */}
        <KitchenDivider label="The whole thing" count={`${steps.length} STEPS`} />
        {/* 50px rows here, not the recipe panel's 46 — this one is read at arm's length with wet
            hands, and each group's cut derives from its own row height (COOKING_AND_AFTER §6). */}
        <div>
          {steps.map((s, i) => (
            <button
              key={s.id}
              type="button"
              className={
                'ml-row ml-kitchen__stepline ml-kitchen__stepline--cook'
                + (done.has(s.id) ? ' ml-kitchen__stepline--done' : '')
              }
              onClick={() => setAt(i)}
            >
              <span className="ml-kitchen__stepnum">{i + 1}</span>
              <span className="ml-kitchen__steplinetext">{s.text}</span>
            </button>
          ))}
        </div>

        {/*
          What is *not* happening. Saying it here is what makes abandoning the panel safe: the
          household can walk away at step three knowing the shelves are untouched.
        */}
        <KitchenDivider label="When you've eaten" />
        <div>
          <div className="ml-kitchen__askwhy">
            {check
              ? `${check.totalLines} ${check.totalLines === 1 ? 'thing comes' : 'things come'} off the shelves once somebody says you ate it.`
              : 'Things come off the shelves once somebody says you ate it.'}
            {' Nothing has yet — cooking on its own changes nothing.'}
          </div>
        </div>
      </ScrollArea>
    </ScreenShell>
  )
}
