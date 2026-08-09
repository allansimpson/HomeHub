import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { nextComponent, normaliseForSearch, scaleLine, type ScheduleRow } from '../../app/mealsDomain'
import { useNow } from '../../app/useNow'
import type { RecipeDto } from '../../api/types'

/** A sibling's remembered step for this session, for the tab's progress count. */
function stepOf(recipeId: number): number {
  const stored = Number(sessionStorage.getItem(`homehub.meals.cookstep.${recipeId}`))
  return Number.isFinite(stored) && stored > 0 ? stored + 1 : 1
}

/**
 * Cook view (MEALS_SCREEN §7c, id 4d). One step at a time, at a size readable from across a
 * kitchen with your hands in something.
 *
 * Everything competing with the current step is gone: no nav, no folder, no method list. The step
 * text is 26px and the ingredients it needs are 20px, which is the whole design — the failure mode
 * this replaces is squinting at a 15px numbered list to find where you were.
 *
 * Step timers land here in M4; the footer says so rather than leaving a gap that reads as missing.
 */
export function CookView({
  recipe, siblings = [], schedule, servings, factor, onServings, onRead, onBack, onSwitch,
}: {
  recipe: RecipeDto
  /**
   * The other recipes on tonight's plate, if any. Empty for a single-recipe night, which then looks
   * exactly as MEALS_SCREEN §7c already specifies — §7 requires that to be true.
   */
  siblings?: { id: number; title: string; steps: number }[]
  /** Tonight's derived order, for the next-component strip. Null when there is only one dish. */
  schedule?: { rows: ScheduleRow[]; serve: string | null } | null
  servings: number | null
  factor: number
  onServings: (next: number | null) => void
  onRead: () => void
  onBack: () => void
  /** Switch to another recipe's tab. */
  onSwitch?: (recipeId: number) => void
}) {
  // Per panel session, not per day: a step should survive an accidental navigation, but coming back
  // to the panel tomorrow on "step 3 of 6" would be worse than starting over (MEALS_BEHAVIOURS §6).
  //
  // Keyed by recipe, so each dish on a multi-recipe night keeps its own position — switching to the
  // toast and back must not lose where you were in the sauce (§4.5).
  const storageKey = `homehub.meals.cookstep.${recipe.id}`
  const [index, setIndex] = useState(() => {
    const stored = Number(sessionStorage.getItem(storageKey))
    return Number.isFinite(stored) && stored > 0 ? Math.min(stored, recipe.steps.length - 1) : 0
  })

  // Reset to this recipe's own remembered position when the tab changes.
  useEffect(() => {
    const stored = Number(sessionStorage.getItem(`homehub.meals.cookstep.${recipe.id}`))
    setIndex(Number.isFinite(stored) && stored > 0 ? Math.min(stored, recipe.steps.length - 1) : 0)
  }, [recipe.id, recipe.steps.length])

  useEffect(() => { sessionStorage.setItem(storageKey, String(index)) }, [storageKey, index])

  useWakeLock()

  // A minute is the right tick — the strip counts down in minutes and nothing here ticks seconds.
  const now = new Date(useNow(60_000))
  // Excludes the recipe on screen: the strip's job is to stop the *other* dish being forgotten,
  // and naming the one you are already standing over is noise.
  const upcoming = schedule ? nextComponent(schedule.rows, now, recipe.id) : null
  // "At its moment" — within the rounding the schedule itself uses.
  const dueNow = upcoming != null && upcoming.minutesAway <= 0

  const tabs = siblings.length > 0
    ? [{ id: recipe.id, title: recipe.title, steps: recipe.steps.length }, ...siblings]
        .sort((a, b) => a.id - b.id)
    : []

  const step = recipe.steps[index]
  const next = recipe.steps[index + 1]

  const uses = useMemo(() => ingredientsFor(recipe, index, factor), [recipe, index, factor])

  if (!step) return null

  return (
    <div className="ml-shell">
      <div className="ml-shell__body ml-shell__body--noavatar">
        <header className="ml-cook__header">
          <button type="button" className="ml-backbtn" onClick={onBack} aria-label="Back">◂</button>
          <span className="ml-cook__title serif">{recipe.title}</span>
          <span className="ml-cook__modes" role="tablist">
            <button type="button" role="tab" aria-selected={false} className="ml-cook__mode" onClick={onRead}>READ</button>
            <button type="button" role="tab" aria-selected className="ml-cook__mode ml-cook__mode--active">COOK</button>
          </span>
        </header>
        <div className="ml-doublerule" aria-hidden="true">
          <div className="ml-doublerule__brass" />
          <div className="ml-doublerule__gap" />
          <div className="ml-doublerule__hair" />
        </div>

        {/* Tab bar (§4.5) — the panel's underline pattern. The step count beside each name doubles
            as progress, so a glance says both "which dish" and "how far in". Absent entirely for a
            single-recipe night. */}
        {tabs.length > 1 && (
          <div className="ml-cooktabs" role="tablist">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={t.id === recipe.id}
                className={'ml-cooktabs__tab' + (t.id === recipe.id ? ' ml-cooktabs__tab--active' : '')}
                onClick={() => t.id !== recipe.id && onSwitch?.(t.id)}
              >
                <span className="ml-cooktabs__name">{t.title}</span>
                {/* Omitted rather than shown as "1/0" when the step count isn't known — a progress
                    figure with a zero denominator reads as a broken recipe. */}
                {t.steps > 0 && (
                  <span className="ml-cooktabs__count">
                    {t.id === recipe.id ? `${index + 1}/${t.steps}` : `${stepOf(t.id)}/${t.steps}`}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        <div className="ml-cook__servings">
          <span className="ml-cook__servingsmain">
            <span className="ml-cook__servingsvalue serif">{servings ?? '—'}</span>
            <span className="ml-cook__servingslabel">SERVINGS</span>
          </span>
          {/* Two cells, no value cell: the number is already large on the left, and repeating it
              inside the stepper would be the second-biggest thing on a screen whose biggest thing
              should be the step. */}
          <span className="ml-cook__steppers">
            <button type="button" className="ml-cook__adjust" onClick={() => onServings(Math.max(1, (servings ?? 1) - 1))} aria-label="Fewer servings">
              <Icon id="ico-minus" size="1.375rem" />
            </button>
            <button type="button" className="ml-cook__adjust" onClick={() => onServings(Math.min(50, (servings ?? 0) + 1))} aria-label="More servings">
              <Icon id="ico-add" size="1.375rem" />
            </button>
          </span>
        </div>
        <div className="ml-cook__grouprule" aria-hidden="true" />

        <div className="ml-cook__body">
          {/* The next-component strip. Hairline until its moment, then amber with START NOW — and
              that is the *entire* live behaviour here. No ticking clocks and no per-step timers;
              those are M4, and inventing them now would be the screen doing more than it can keep
              promises about. */}
          {upcoming && (
            <button
              type="button"
              className={'ml-cooknext' + (dueNow ? ' ml-cooknext--now' : '')}
              onClick={() => upcoming.row.recipeId != null && onSwitch?.(upcoming.row.recipeId)}
            >
              <span className="ml-cooknext__time serif">{upcoming.row.start}</span>
              <span className="ml-cooknext__text">
                {dueNow
                  ? `${upcoming.row.title} goes on now`
                  : `${upcoming.row.title} goes on in ${upcoming.minutesAway} minutes`}
              </span>
              <span className="ml-cooknext__flag">{dueNow ? 'START NOW' : 'NOT YET'}</span>
            </button>
          )}

          <span className="ml-cook__counter">{`STEP ${index + 1} OF ${recipe.steps.length}`}</span>
          <p className="ml-cook__text">{step.text}</p>

          {uses.length > 0 && (
            <div className="ml-cook__uses">
              <span className="ml-cook__useslabel">USES</span>
              {uses.map((line) => <span className="ml-cook__use" key={line}>{line}</span>)}
            </div>
          )}

          {next && <p className="ml-cook__next">{`Next — ${next.text}`}</p>}
        </div>

        <div className="ml-cook__nav">
          <button
            type="button"
            className="ml-cook__back"
            disabled={index === 0}
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
            aria-label="Previous step"
          >
            ◂
          </button>
          <button
            type="button"
            className="ml-cook__forward"
            disabled={index >= recipe.steps.length - 1}
            onClick={() => setIndex((i) => Math.min(recipe.steps.length - 1, i + 1))}
          >
            NEXT STEP
          </button>
        </div>
        <p className="ml-mealrule ml-cook__footnote">SCREEN STAYS AWAKE WHILE COOKING · TIMERS ARRIVE IN M4</p>
      </div>
    </div>
  )
}

/**
 * Hold a screen wake lock for as long as the cook view is mounted, and release it on the way out so
 * the panel goes back to its normal ambient dimming.
 *
 * Re-acquired on `visibilitychange` because the browser drops the lock whenever the document is
 * hidden — without that, one glance at another tab leaves the kitchen screen free to sleep again
 * halfway through a recipe.
 */
function useWakeLock() {
  useEffect(() => {
    type WakeLockSentinel = { release: () => Promise<void> }
    type WakeLockNavigator = Navigator & { wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinel> } }
    const wakeLock = (navigator as WakeLockNavigator).wakeLock
    if (!wakeLock) return

    let sentinel: WakeLockSentinel | null = null
    let released = false

    const acquire = async () => {
      // Not supported, denied by policy, or the document is hidden — all three are "no wake lock",
      // and none is worth interrupting someone mid-recipe over.
      try { sentinel = await wakeLock.request('screen') } catch { sentinel = null }
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !released) void acquire()
    }

    void acquire()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      released = true
      document.removeEventListener('visibilitychange', onVisibility)
      void sentinel?.release().catch(() => { /* already gone */ })
    }
  }, [])
}

/**
 * The ingredients this step actually mentions, at the current scale.
 *
 * Matched on the parsed `name` and only when the parser produced one: a fuzzy match against
 * `rawText` would pull in "2 tbsp olive oil, divided" for any step containing the word "oil",
 * and a USES block listing things the step does not use is worse than no USES block. Steps whose
 * ingredients could not be matched simply show none.
 */
function ingredientsFor(recipe: RecipeDto, index: number, factor: number): string[] {
  const step = recipe.steps[index]
  if (!step) return []
  const haystack = normaliseForSearch(step.text)
  return recipe.ingredients
    .filter((line) => {
      if (!line.name) return false
      const name = normaliseForSearch(line.name)
      // Two characters would match half the recipe; a whole word is the useful unit here.
      return name.length > 2 && haystack.includes(name)
    })
    .map((line) => scaleLine(line.rawText, line.quantity, factor))
}
