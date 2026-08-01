import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ScreenShell, DrillInHeader, ScrollArea, Stepper, HoldButton } from '../../components'
import { Icon } from '../../icons/Icon'
import { api, ApiError } from '../../api/client'
import { useSession } from '../../app/SessionProvider'
import { useMeals } from '../../app/MealsProvider'
import {
  durationLabel, entriesFor, nightSchedule, scalableLines, scaleLine, schedulableEntries, todayKey,
} from '../../app/mealsDomain'
import { cuisineLabel, cuisineOf } from '../../app/mealsPrefs'
import type { RecipeDto } from '../../api/types'
import { AttributionStrip, Chevron, MealAlert, MealsLabel, RuleLine } from './parts'
import { CookView } from './CookView'
import { diffIngredients } from './recipeDiff'

/**
 * Recipe detail (MEALS_SCREEN §7, ids 1f reference / 1g partial / 5a attributed / 4d cook).
 *
 * The reference view is the default and the cook view is a mode of it, reached by `?view=cook`, so
 * switching between them keeps the servings you set and does not touch the back stack.
 */
export function RecipeDetailScreen() {
  const navigate = useNavigate()
  const { id } = useParams()
  const [params, setParams] = useSearchParams()
  const { activeProfileId } = useSession()
  const { settings, week, recipes } = useMeals()

  const [recipe, setRecipe] = useState<RecipeDto | null>(null)
  const [offline, setOffline] = useState(false)
  /** Non-null once the stepper has been touched; until then the value below is derived. */
  const [chosenServings, setChosenServings] = useState<number | null>(null)
  const [seenAttribution, setSeenAttribution] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const recipeId = Number(id)

  const load = useCallback(async () => {
    try {
      const next = await api.getRecipe(recipeId)
      setRecipe(next)
      setOffline(false)
    } catch (err) {
      if (err instanceof ApiError) setOffline(true)
      else throw err
    }
  }, [recipeId])

  useEffect(() => { void load() }, [load])

  /**
   * How many ingredient lines differ from the parent, for the lineage strip's `n DIFFER` control.
   *
   * Fetched rather than stored: the count is a function of two recipes that both change
   * independently, so persisting it would be a number that goes stale the first time either side is
   * edited. Null until it resolves, and the control reads COMPARE in the meantime rather than
   * claiming a figure it does not have.
   */
  const [parentDiffCount, setParentDiffCount] = useState<number | null>(null)
  useEffect(() => {
    if (recipe?.forkedFrom == null || recipe.forkedFromTitle == null) { setParentDiffCount(null); return }
    let cancelled = false
    void (async () => {
      try {
        const parent = await api.getRecipe(recipe.forkedFrom!)
        if (!cancelled) setParentDiffCount(diffIngredients(parent, recipe).length)
      } catch {
        if (!cancelled) setParentDiffCount(null)
      }
    })()
    return () => { cancelled = true }
  }, [recipe])

  const cooking = params.get('view') === 'cook'

  const scaled = useMemo(() => {
    if (!recipe) return { scalable: 0, total: 0 }
    return scalableLines(recipe.ingredients)
  }, [recipe])

  /**
   * What this recipe opens at, most specific first: an explicit tap on the stepper, then the
   * servings the night was actually planned at, then the household's own number, and only then the
   * source page's yield.
   *
   * The household default outranks the recipe because "we cook for eight" is a fact about the
   * kitchen and the page's yield is a fact about the page. The stored `servings` is left alone —
   * it still says what the amounts make, which is what lets the ratio line honestly read
   * `SCALED FROM 6 → 8` instead of quietly presenting six portions as eight.
   *
   * Derived rather than seeded into state, because the recipe and the week arrive independently:
   * seeding on load meant whichever request landed first decided the number.
   */
  const servings =
    chosenServings
    ?? plannedServings(week, recipeId)
    ?? settings.defaultServings
    ?? recipe?.servings
    ?? null

  /**
   * The rest of tonight's plate, when this recipe is part of an arrangement.
   *
   * Derived from the week the provider already holds rather than fetched: the entries carry title
   * and cook time precisely so the cook view can build its tabs and its schedule without a request
   * per dish while someone is standing at the stove.
   */
  const tonightEntries = useMemo(() => {
    const day = week?.days.find((d) => d.date === todayKey())
    const dinner = entriesFor(day, 'Dinner')
    return dinner.some((e) => e.recipeId === recipeId) ? dinner : []
  }, [week, recipeId])

  const siblings = useMemo(
    () => tonightEntries
      .filter((e) => e.recipeId != null && e.recipeId !== recipeId)
      .map((e) => ({
        id: e.recipeId!,
        title: e.recipeTitle ?? '',
        // From the folder summary the provider already holds. The plan entry doesn't carry a step
        // count, and a tab reading "1/0" is worse than one reading nothing at all.
        steps: recipes.find((r) => r.id === e.recipeId)?.stepCount ?? 0,
      })),
    [tonightEntries, recipeId, recipes],
  )

  const nightScheduleForCook = useMemo(
    () => (tonightEntries.length > 1
      ? nightSchedule(schedulableEntries(tonightEntries), settings.dinnerTime)
      : null),
    [tonightEntries, settings.dinnerTime],
  )
  const setServings = setChosenServings

  if (!recipe) {
    return (
      <ScreenShell header={<DrillInHeader title="RECIPE" onBack={() => navigate(-1)} />}>
        {/* Ruled structure rather than a spinner — no screen in this section shows loading as its
            primary state (MEALS_BEHAVIOURS §1). */}
        <div className="ml-recipe__skeleton">{offline ? 'Not loaded — showing nothing rather than guessing.' : ''}</div>
      </ScreenShell>
    )
  }

  const factor = servings != null && recipe.servings ? servings / recipe.servings : 1
  const partial = recipe.completeness === 'Partial'
  const cuisine = cuisineLabel(cuisineOf(recipe), settings.canonicalCuisines)

  if (cooking) {
    return (
      <CookView
        recipe={recipe}
        siblings={siblings}
        schedule={nightScheduleForCook}
        servings={servings}
        factor={factor}
        onServings={setServings}
        onRead={() => { params.delete('view'); setParams(params, { replace: true }) }}
        onBack={() => navigate(-1)}
        // Switching tabs is a route change, so the back button still leaves the cook view rather
        // than walking backwards through the dishes.
        onSwitch={(id) => navigate(`/meals/recipes/${id}?view=cook`, { replace: true })}
      />
    )
  }

  // Never attribute a profile to itself, and never after the strip has been read once.
  const showAttribution =
    !seenAttribution &&
    recipe.modifiedByProfileId != null &&
    recipe.modifiedByProfileId !== activeProfileId

  return (
    <ScreenShell header={<DrillInHeader title={recipe.title} onBack={() => navigate(-1)} />}>
      <ScrollArea>
        <div className="ml-recipe__meta">
          {cuisine && <span className="ml-recipe__cuisine">{cuisine.toUpperCase()}</span>}
          <span className="ml-recipe__times">{timesLine(recipe)}</span>
        </div>

        {/* Attribution above lineage when both apply (MEALS_FORK §4.2): news first, then the
            standing fact. */}
        {showAttribution && (
          <AttributionStrip
            recipe={recipe}
            onSeeWhat={() => { setSeenAttribution(true); navigate(`/meals/recipes/${recipe.id}/edit?diff=1`) }}
          />
        )}

        {/* Lineage strip — permanent and not dismissible. That is the difference between it and the
            attribution strip it sits beside: this is a fact about the recipe, not news about it. */}
        {recipe.forkedFrom != null && (
          <div className="ml-lineage">
            <span className="ml-lineage__main">
              <span className="ml-lineage__label">YOUR VERSION OF</span>
              <span className="ml-lineage__parent">{recipe.forkedFromTitle ?? 'a deleted recipe'}</span>
            </span>
            {/* Both controls disappear once the parent is gone — there is nothing left to open or
                compare against, and the name stays as plain text. */}
            {recipe.forkedFromTitle && (
              <>
                <button
                  type="button"
                  className="ml-lineage__open"
                  onClick={() => navigate(`/meals/recipes/${recipe.id}/diff`)}
                >
                  {parentDiffCount == null
                    ? 'COMPARE'
                    : `${parentDiffCount} DIFFER`}
                </button>
                <button
                  type="button"
                  className="ml-lineage__chev"
                  aria-label={`Open ${recipe.forkedFromTitle}`}
                  onClick={() => navigate(`/meals/recipes/${recipe.forkedFrom}`)}
                >
                  <Chevron />
                </button>
              </>
            )}
          </div>
        )}

        <div className="ml-recipe__servings">
          <span className="ml-recipe__servingsmain">
            <span className="ml-recipe__servingslabel">SERVINGS</span>
            <span className="ml-recipe__ratio">
              {scaled.total > 0 ? `${scaled.scalable} OF ${scaled.total} LINES SCALE` : 'NO AMOUNTS TO SCALE'}
            </span>
          </span>
          <span className="ml-recipe__stepper">
            {/* Stepped from the *displayed* value, not from `chosenServings`. That state is null
                until the first tap, so a callback form would step from nothing and jump the number
                to 1 rather than nudging the six on screen. */}
            <Stepper direction="minus" onStep={() => setServings(Math.max(1, (servings ?? 1) - 1))} label="Fewer servings" />
            <span className="ml-recipe__servingsvalue serif">{servings ?? '—'}</span>
            <Stepper direction="plus" onStep={() => setServings(Math.min(50, (servings ?? 0) + 1))} label="More servings" />
          </span>
        </div>
        <div className="ml-recipe__grouprule" aria-hidden="true" />

        {/* A partial recipe's amber alert takes the place BEFORE YOU START would occupy: both are
            "read this before you commit to cooking it", and showing both would bury the one that
            matters. */}
        {partial ? (
          <MealAlert
            title="NO STEPS FOUND"
            sentence={recipe.incompleteReason ?? 'The page had ingredients but no method.'}
            action={
              recipe.sourceUrl ? (
                <a className="ml-mealalert__action" href={recipe.sourceUrl} target="_blank" rel="noreferrer">
                  OPEN SOURCE
                </a>
              ) : undefined
            }
          />
        ) : (
          (recipe.prepNote || recipe.leadMinutes != null) && (
            <div className="ml-recipe__lead">
              <MealsLabel
                label="BEFORE YOU START"
                status={recipe.leadMinutes != null ? `LEAD ${durationLabel(recipe.leadMinutes).toUpperCase()}` : undefined}
              />
              {(recipe.prepNote ?? '').split('\n').filter(Boolean).map((line, i) => (
                <div className="ml-recipe__leadline" key={i}>
                  <span className="ml-recipe__leadtick" aria-hidden="true" />
                  <span>{line}</span>
                </div>
              ))}
              <div className="ml-recipe__leadadd">＋ Add a note for next time</div>
            </div>
          )
        )}

        {/* A label with nothing under it reads as a section that failed to load. A recipe saved as
            just a name and a link legitimately has no ingredients yet, so the heading waits until
            there is something to head. */}
        {recipe.ingredients.length > 0 && (
          <MealsLabel
            label="INGREDIENTS"
            status={factor !== 1 && recipe.servings ? `SCALED FROM ${recipe.servings} → ${servings}` : undefined}
          />
        )}
        <div className="ml-recipe__lines">
          {recipe.ingredients.map((line, i) => {
            const heading = line.sectionHeading && line.sectionHeading !== recipe.ingredients[i - 1]?.sectionHeading
            return (
              <div key={line.id}>
                {heading && <div className="ml-recipe__subhead">{line.sectionHeading!.toUpperCase()}</div>}
                <div className="ml-recipe__line">
                  {/* An 8px tick marks a line that moves with the servings; an empty spacer keeps
                      the text edge straight for the ones that do not. */}
                  <span className={'ml-recipe__tick' + (line.quantity != null ? ' ml-recipe__tick--on' : '')} aria-hidden="true" />
                  <span className={'ml-recipe__linetext' + (line.quantity == null ? ' ml-recipe__linetext--raw' : '')}>
                    {scaleLine(line.rawText, line.quantity, factor)}
                  </span>
                  {line.quantity == null && <span className="ml-recipe__aswritten">AS WRITTEN</span>}
                </div>
              </div>
            )
          })}
        </div>

        {/* Keyed on "are there steps", not on the importer's verdict. A recipe saved from a pasted
            link is `Complete` by the server's rule — a manual recipe is done when the person says it
            is — but with no steps it would otherwise render METHOD · 0 STEPS above an empty list.
            Same absence, same block; only the sentence differs, because "the page didn't give one"
            and "nobody has typed one yet" are different situations to be in. */}
        {recipe.steps.length === 0 ? (
          <div className="ml-recipe__nomethod">
            <p className="ml-recipe__nomethodtext">
              {partial
                ? "The source page didn't give a method. You can type the steps in, or open the original and cook from there — the ingredients above are still yours."
                : recipe.sourceUrl
                  ? 'No method here yet. The original page is one tap away, and anything you type in stays on the panel.'
                  : 'No method here yet. A recipe is allowed to be just a name — add the steps whenever you want them.'}
            </p>
            <div className="ml-recipe__nomethodactions">
              <button type="button" className="ml-recipe__addsteps" onClick={() => navigate(`/meals/recipes/${recipe.id}/edit`)}>
                ADD STEPS
              </button>
              {recipe.sourceUrl && (
                <a className="ml-recipe__opensource" href={recipe.sourceUrl} target="_blank" rel="noreferrer">
                  OPEN SOURCE
                </a>
              )}
            </div>
          </div>
        ) : (
          <>
            <MealsLabel label="METHOD" status={`${recipe.steps.length} STEP${recipe.steps.length === 1 ? '' : 'S'}`} />
            <div className="ml-recipe__steps">
              {recipe.steps.map((step, i) => (
                <div className="ml-recipe__step" key={step.id}>
                  <span className="ml-recipe__stepnum serif">{i + 1}</span>
                  <span className="ml-recipe__steptext">{step.text}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {confirmingDelete && <DeleteBlock recipe={recipe} onKeep={() => setConfirmingDelete(false)} />}
      </ScrollArea>

      <div className="ml-recipe__actions">
        <button
          type="button"
          className="ml-recipe__plan"
          onClick={() => navigate(`/meals/assign/${todayKey()}/Dinner`)}
        >
          PUT ON A NIGHT
        </button>
        <button type="button" className="ml-recipe__edit" onClick={() => navigate(`/meals/recipes/${recipe.id}/edit`)}>
          EDIT
        </button>
        {recipe.steps.length > 0 && (
          <button
            type="button"
            className="ml-recipe__cook"
            onClick={() => { params.set('view', 'cook'); setParams(params) }}
          >
            COOK
          </button>
        )}
        <button
          type="button"
          className="ml-recipe__trash"
          aria-label="Delete recipe"
          onClick={() => setConfirmingDelete(true)}
        >
          <Icon id="ico-trash" size="1.125rem" />
        </button>
      </div>
    </ScreenShell>
  )
}

/**
 * `SERIOUS EATS · 15 PREP · 20 COOK`.
 *
 * Never composes a total from prep + cook. A recipe that gave only one of them has no honest total,
 * and inventing one turns a missing number into a wrong number — which the start-by arithmetic on
 * the Meals home would then quietly repeat back as a time to start cooking.
 */
function timesLine(recipe: RecipeDto): string {
  const parts: string[] = []
  if (recipe.sourceName) parts.push(recipe.sourceName.toUpperCase())
  if (recipe.prepMinutes != null) parts.push(`${recipe.prepMinutes} PREP`)
  if (recipe.cookMinutes != null) parts.push(`${recipe.cookMinutes} COOK`)
  if (recipe.prepMinutes == null && recipe.cookMinutes == null && recipe.totalMinutes != null) {
    parts.push(durationLabel(recipe.totalMinutes).toUpperCase())
  }
  return parts.join(' · ')
}

/** The servings a currently-planned night set for this recipe, if any. */
function plannedServings(week: { days: { date: string; entries: { recipeId: number | null; servingsOverride: number | null }[] }[] } | null, recipeId: number): number | null {
  for (const day of week?.days ?? []) {
    for (const e of day.entries) {
      if (e.recipeId === recipeId && e.servingsOverride != null) return e.servingsOverride
    }
  }
  return null
}

/**
 * Delete, with the consequence stated in words before the control that does it.
 *
 * Terracotta and hold-to-confirm because this is the one destructive action in the section. The
 * planned nights survive as plain text, which is the part people don't expect — so it is said
 * plainly rather than left to be discovered.
 */
function DeleteBlock({ recipe, onKeep }: { recipe: RecipeDto; onKeep: () => void }) {
  const navigate = useNavigate()
  const { week, refresh } = useMeals()
  const plannedNights = (week?.days ?? []).reduce(
    (n, d) => n + d.entries.filter((e) => e.recipeId === recipe.id).length,
    0,
  )

  const remove = async () => {
    await api.deleteRecipe(recipe.id, recipe.version)
    await refresh()
    navigate('/meals/recipes', { replace: true })
  }

  return (
    <div className="ml-recipe__delete">
      <div className="ml-recipe__deletehead">
        <Icon id="ico-trash" size="1.125rem" />
        <span>DELETE THIS RECIPE</span>
      </div>
      <p className="ml-recipe__deletewhy">
        {plannedNights > 0
          ? `${plannedNights === 1 ? 'One night is' : `${plannedNights} nights are`} planned with it. ` +
            `They will keep the name ${recipe.title} as plain text and stop linking anywhere.`
          : 'Nothing is planned with it. The recipe goes and nothing else changes.'}
      </p>
      <div className="ml-recipe__deleteactions">
        <button type="button" className="ml-recipe__keep" onClick={onKeep}>KEEP IT</button>
        <HoldButton destructive ms={600} onHold={() => void remove()} className="ml-recipe__holddelete">
          HOLD TO DELETE
        </HoldButton>
      </div>
      <RuleLine>PLANNED NIGHTS ARE NEVER BLANKED — WHAT YOU ATE IS NOT THE FOLDER'S TO TIDY</RuleLine>
    </div>
  )
}
