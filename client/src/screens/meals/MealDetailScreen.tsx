import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { ScreenShell, DrillInHeader, ScrollArea, Stepper, HoldButton } from '../../components'
import { Icon } from '../../icons/Icon'
import { api, ApiError } from '../../api/client'
import { useSession } from '../../app/SessionProvider'
import { useMeals } from '../../app/MealsProvider'
import { cookedAgoLabel, cookedCountLabel, countWord, durationLabel, nightSchedule, todayKey } from '../../app/mealsDomain'
import { cuisineLabel } from '../../app/mealsPrefs'
import type { MealDto, MealRoleName } from '../../api/types'
import { Chevron, MealsLabel, MealsModal, RuleLine } from './parts'

const ROLES: MealRoleName[] = ['Main', 'Side', 'Dessert']

/**
 * Meal detail (MEALS_GROUPS §4.2), route `/meals/meals/:id`.
 *
 * **Deliberately recipe-shaped** — the same drill-in header, servings stepper and action bar as the
 * recipe screen, so nothing new has to be learned to read one. The differences are only where a
 * meal genuinely differs: what it is made of, and the order those things get cooked in.
 */
export function MealDetailScreen() {
  const navigate = useNavigate()
  const { id } = useParams()
  const { activeProfileId } = useSession()
  const { recipes, settings, refresh } = useMeals()

  const mealId = Number(id)
  const [meal, setMeal] = useState<MealDto | null>(null)
  const [offline, setOffline] = useState(false)
  const [adding, setAdding] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const load = useCallback(async () => {
    try {
      setMeal(await api.getMeal(mealId))
      setOffline(false)
    } catch (err) {
      if (err instanceof ApiError) setOffline(true)
      else throw err
    }
  }, [mealId])

  useEffect(() => { void load() }, [load])

  /** Every write is the same document PUT — a meal is edited whole, exactly like a recipe. */
  const save = useCallback(
    async (patch: Partial<{ servings: number | null; components: { recipeId: number; role: MealRoleName }[] }>) => {
      if (!meal) return
      const next = await api.updateMeal(
        meal.id,
        {
          name: meal.name,
          servings: patch.servings !== undefined ? patch.servings : meal.servings,
          prepNote: meal.prepNote,
          cuisine: meal.cuisine,
          isArchived: meal.isArchived,
          components: patch.components ?? meal.components.map((c) => ({ recipeId: c.recipeId, role: c.role })),
          modifiedByProfileId: activeProfileId,
        },
        meal.version,
      )
      setMeal(next)
      await refresh()
    },
    [meal, activeProfileId, refresh],
  )

  const schedule = useMemo(() => {
    if (!meal) return null
    return nightSchedule(
      meal.components.map((c) => ({
        title: c.title, role: c.role, totalMinutes: c.totalMinutes, recipeId: c.recipeId,
      })),
      settings.dinnerTime,
    )
  }, [meal, settings.dinnerTime])

  if (!meal) {
    return (
      <ScreenShell header={<DrillInHeader title="MEAL" onBack={() => navigate(-1)} />}>
        <div className="ml-recipe__skeleton">{offline ? 'Not loaded — showing nothing rather than guessing.' : ''}</div>
      </ScreenShell>
    )
  }

  const servings = meal.servings ?? settings.defaultServings
  const cuisine = cuisineLabel(meal.cuisine, settings.canonicalCuisines)
  const alreadyIn = new Set(meal.components.map((c) => c.recipeId))

  const remove = async () => {
    await api.deleteMeal(meal.id, meal.version)
    await refresh()
    navigate('/meals/recipes', { replace: true })
  }

  return (
    <ScreenShell header={<DrillInHeader title={meal.name} onBack={() => navigate(-1)} />}>
      <ScrollArea>
        <div className="ml-recipe__meta">
          {cuisine && <span className="ml-recipe__cuisine">{cuisine.toUpperCase()}</span>}
          <span className="ml-recipe__times">
            {meal.timesCooked > 0
              ? `${cookedCountLabel(meal.timesCooked)} · ${cookedAgoLabel(meal.lastCookedDate)}`
              : 'NEVER COOKED'}
          </span>
        </div>

        <div className="ml-recipe__servings">
          <span className="ml-recipe__servingsmain">
            <span className="ml-recipe__servingslabel">SERVINGS</span>
            {/* Scaling the meal scales every component — each from its own base to the same target,
                which is why this says so rather than leaving it to be discovered. */}
            {/* "BOTH" at two, "ALL THREE" beyond — "ALL 2 RECIPES" is not a sentence anyone writes. */}
            <span className="ml-recipe__ratio">
              {meal.components.length === 1
                ? 'SCALES THE RECIPE IN IT'
                : meal.components.length === 2
                  ? 'BOTH RECIPES SCALE TOGETHER'
                  : `ALL ${countWord(meal.components.length)} RECIPES SCALE TOGETHER`}
            </span>
          </span>
          <span className="ml-recipe__stepper">
            <Stepper direction="minus" onStep={() => void save({ servings: Math.max(1, servings - 1) })} label="Fewer servings" />
            <span className="ml-recipe__servingsvalue serif">{servings}</span>
            <Stepper direction="plus" onStep={() => void save({ servings: Math.min(50, servings + 1) })} label="More servings" />
          </span>
        </div>
        <div className="ml-recipe__grouprule" aria-hidden="true" />

        <MealsLabel
          label="WHAT'S IN IT"
          status={meal.totalMinutes != null ? `${durationLabel(meal.totalMinutes).toUpperCase()} TOTAL` : undefined}
        />
        <div className="ml-mealparts">
          {meal.components.map((c) => (
            <div className="ml-mealparts__row" key={c.recipeId}>
              {/* 58px role column — a label, never a badge. The dish name is what gets read. */}
              <span className={'ml-mealparts__role' + (c.role === 'Main' ? ' ml-mealparts__role--main' : '')}>
                {c.role.toUpperCase()}
              </span>
              <button
                type="button"
                className="ml-mealparts__main"
                onClick={() => navigate(`/meals/recipes/${c.recipeId}`)}
              >
                <span className="ml-mealparts__title">{c.title}</span>
                <span className="ml-mealparts__meta">
                  {[c.totalMinutes != null ? durationLabel(c.totalMinutes).toUpperCase() : null,
                    c.servings != null ? `SERVES ${c.servings}` : null,
                    c.sourceName?.toUpperCase() ?? null].filter(Boolean).join(' · ')}
                </span>
              </button>
              {/* Cycling the role is a tap rather than a menu: three values, and the label already
                  shows which one it is. The main cannot be cycled away — §1 requires exactly one. */}
              {c.role !== 'Main' && (
                <button
                  type="button"
                  className="ml-mealparts__rolebtn"
                  aria-label={`Change ${c.title}'s role`}
                  onClick={() => void save({
                    components: meal.components.map((x) => x.recipeId === c.recipeId
                      ? { recipeId: x.recipeId, role: ROLES[(ROLES.indexOf(x.role) + 1) % 3] === 'Main'
                          ? 'Side' : ROLES[(ROLES.indexOf(x.role) + 1) % 3] }
                      : { recipeId: x.recipeId, role: x.role }),
                  })}
                >
                  ⇄
                </button>
              )}
              <button
                type="button"
                className="ml-mealparts__x"
                aria-label={`Take ${c.title} out`}
                disabled={meal.components.length === 1}
                onClick={() => void save({
                  components: meal.components
                    .filter((x) => x.recipeId !== c.recipeId)
                    .map((x, i) => ({ recipeId: x.recipeId, role: i === 0 ? 'Main' : x.role })),
                })}
              >
                ✕
              </button>
              <Chevron />
            </div>
          ))}
        </div>

        <button type="button" className="ml-mealparts__add" onClick={() => setAdding(true)}>
          <span>＋ Add a recipe</span>
          <span className="ml-mealparts__roles">MAIN · SIDE · DESSERT</span>
        </button>

        {meal.prepNote && (
          <div className="ml-recipe__lead">
            <MealsLabel label="BEFORE YOU START" status="THE MEAL'S OWN NOTE" />
            {meal.prepNote.split('\n').filter(Boolean).map((line, i) => (
              <div className="ml-recipe__leadline" key={i}>
                <span className="ml-recipe__leadtick" aria-hidden="true" />
                <span>{line}</span>
              </div>
            ))}
          </div>
        )}

        {/* THE ORDER, worked back from the household's dinner time. Same derivation as the home
            screen's — one function, so the two can never disagree about when to start the toast. */}
        {schedule && schedule.rows.length > 1 && (
          <div className="ml-order">
            <div className="ml-order__head">
              <span className="ml-order__label">THE ORDER</span>
              <span className="ml-order__from">{`WORKED BACK FROM ${schedule.serve}`}</span>
            </div>
            {schedule.rows.map((row, i) => (
              <div className="ml-order__row" key={`${row.recipeId ?? 'x'}-${i}`}>
                <span className="ml-order__time serif">{row.start ?? '—'}</span>
                <span className="ml-order__main">
                  <span className="ml-order__title">{row.title}</span>
                  <span className="ml-order__role">{row.role.toUpperCase()}</span>
                </span>
                {row.minutes != null && (
                  <span className="ml-order__mins">{durationLabel(row.minutes).toUpperCase()}</span>
                )}
              </div>
            ))}
            <div className="ml-order__row ml-order__row--table">
              <span className="ml-order__time serif ml-order__time--table">{schedule.serve}</span>
              <span className="ml-order__table">TO THE TABLE</span>
            </div>
          </div>
        )}

        {confirmingDelete && (
          <div className="ml-recipe__delete">
            <div className="ml-recipe__deletehead">
              <Icon id="ico-trash" size="1.125rem" />
              <span>DELETE THIS MEAL</span>
            </div>
            {/* The surprising half, said plainly: the recipes survive. A meal is a shortcut, and
                removing the shortcut cannot remove the things it pointed at. */}
            <p className="ml-recipe__deletewhy">
              {`The ${meal.components.length} recipes in it stay in the folder, and any night already `
                + 'planned from it is untouched. Only the shortcut goes.'}
            </p>
            <div className="ml-recipe__deleteactions">
              <button type="button" className="ml-recipe__keep" onClick={() => setConfirmingDelete(false)}>KEEP IT</button>
              <HoldButton destructive ms={600} onHold={() => void remove()} className="ml-recipe__holddelete">
                HOLD TO DELETE
              </HoldButton>
            </div>
          </div>
        )}
      </ScrollArea>

      <div className="ml-recipe__actions">
        <button
          type="button"
          className="ml-recipe__plan"
          onClick={() => navigate(`/meals/assign/${todayKey()}/Dinner`)}
        >
          SCHEDULE MEAL
        </button>
        <button type="button" className="ml-recipe__edit" onClick={() => setAdding(true)}>EDIT</button>
        <button
          type="button"
          className="ml-recipe__trash"
          aria-label="Delete meal"
          onClick={() => setConfirmingDelete(true)}
        >
          <Icon id="ico-trash" size="1.125rem" />
        </button>
      </div>

      {adding && (
        <MealsModal title="ADD A RECIPE" onCancel={() => setAdding(false)}>
          <ScrollArea>
            <RuleLine>THE FIRST RECIPE IS THE MAIN · ANYTHING ADDED AFTER IT IS A SIDE</RuleLine>
            <div className="ml-assign__list">
              {recipes.filter((r) => !r.isArchived && !alreadyIn.has(r.id)).map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className="ml-assign__row"
                  onClick={() => {
                    void save({
                      components: [
                        ...meal.components.map((c) => ({ recipeId: c.recipeId, role: c.role })),
                        { recipeId: r.id, role: 'Side' as MealRoleName },
                      ],
                    })
                    setAdding(false)
                  }}
                >
                  <span className="ml-assign__check" aria-hidden="true" />
                  <span className="ml-assign__rowmain">
                    <span className="ml-assign__rowtitle">{r.title}</span>
                    <span className="ml-assign__rowmeta">
                      {r.totalMinutes != null ? durationLabel(r.totalMinutes).toUpperCase() : ''}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </ScrollArea>
        </MealsModal>
      )}
    </ScreenShell>
  )
}
