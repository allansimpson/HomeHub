import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ScreenShell, DrillInHeader, ScrollArea } from '../../components'
import { Icon } from '../../icons/Icon'
import { api } from '../../api/client'
import { useSession } from '../../app/SessionProvider'
import { useMeals } from '../../app/MealsProvider'
import { useNow } from '../../app/useNow'
import {
  countWord, durationLabel, entriesFor, formatClock, nightSchedule, schedulableEntries, plannedCount,
  shortDate, shortWeekday, startBy, todayKey, unconfirmedPastDinner,
} from '../../app/mealsDomain'
import { cuisineNameOf } from '../../app/mealsPrefs'
import type { MealPlanEntryDto, RecipeSummaryDto } from '../../api/types'
import { Chevron, MealAlert } from './parts'

/**
 * Meals home (MEALS_SCREEN §1, id 6a) — the tab, and the daily-use surface.
 *
 * Tonight first, because "what's for dinner and when do I start it" is the question this section
 * exists to answer and it is asked every single day. The week, the folder and everything else are
 * one tap away; none of them go above the dish.
 */
export function MealsHomeScreen() {
  const navigate = useNavigate()
  const { week, recipes, settings, setEaten } = useMeals()
  const { activeProfileId } = useSession()
  // A minute is the right tick: START BY is a clock time and lateness is counted in minutes.
  const now = new Date(useNow(60_000))
  const [prepDone, setPrepDone] = useState(false)

  const today = todayKey()
  const todayDay = week?.days.find((d) => d.date === today)
  const tonightAll = entriesFor(todayDay, 'Dinner')
  const tonight = tonightAll[0]
  const recipe = tonight?.recipeId != null ? recipes.find((r) => r.id === tonight.recipeId) : undefined

  // An arrangement's start-by is its *earliest* component — the moment anything has to begin.
  // Using only the main would tell you to start at 18:05 for a dish that needs to be on at 17:40.
  const longest = tonightAll.reduce<number | null>(
    (max, e) => (e.totalMinutes != null && (max == null || e.totalMinutes > max) ? e.totalMinutes : max),
    null,
  )
  const timing = startBy(settings.dinnerTime, longest, now)

  // The order only earns its section when there is an order — one dish is a start-by, not a
  // sequence, and §7 requires a single-recipe night look exactly as it did before meals existed.
  const schedule = tonightAll.length > 1
    ? nightSchedule(schedulableEntries(tonightAll), settings.dinnerTime)
    : null
  const planned = plannedCount(week, settings.visibleSlots)
  const lastNight = useMemo(() => unconfirmedPastDinner(week, today), [week, today])

  // The rest of the week, from tomorrow. Today is already the top of the screen.
  const rest = (week?.days ?? []).filter((d) => d.date > today)

  const clock = `${shortDate(today)} · ${formatClock(now.getHours() * 60 + now.getMinutes())}`

  /**
   * The one-tap YES on the LAST NIGHT row — the same act as answering `yes` on the confirm screen,
   * so it has to take the same stock off the shelves (PANTRY_SCREEN §6). Two ways to say "we ate
   * it" that disagree about the pantry would make the numbers depend on which button you happened
   * to reach for.
   */
  const confirmAte = async (night: MealPlanEntryDto) => {
    await setEaten({ date: night.date, slot: 'Dinner', wasEaten: true })
    try {
      const receipt = await api.deductForNight(night.id, activeProfileId)
      if (receipt) navigate(`/pantry/taken/${night.id}`)
    } catch {
      // The pantry is advisory: a failed deduction leaves the night confirmed and says nothing.
    }
  }

  return (
    <ScreenShell header={<DrillInHeader title="MEALS" status={clock} />}>
      <ScrollArea>
        <div className="ml-mealhome__tonightlabel">TONIGHT</div>

        {tonight ? (
          <>
            <button
              type="button"
              className="ml-mealhome__dishbtn"
              onClick={() => (tonight.recipeId != null
                ? navigate(`/meals/recipes/${tonight.recipeId}`)
                : navigate(`/meals/assign/${today}/Dinner`))}
            >
              <span className="ml-mealhome__dish serif">{tonight.freeText ?? tonight.recipeTitle}</span>
              <span className="ml-mealhome__dishmeta">
                {tonightMeta(tonight, recipe, settings.canonicalCuisines, tonightAll.length)}
              </span>
            </button>

            {/* Null totalMinutes hides the block and keeps the dish: a recipe that never said how
                long it takes cannot be turned into a time to start cooking. */}
            {timing && (
              <div className="ml-mealhome__startby">
                <div className="ml-mealhome__startmain">
                  <span className="ml-mealhome__startlabel">
                    {timing.lateBy > 0 ? 'START NOW' : 'START BY'}
                  </span>
                  <span className="ml-mealhome__starttime serif">
                    {timing.lateBy > 0 ? `${timing.lateBy} MIN LATE` : timing.start}
                  </span>
                  <span className="ml-mealhome__startnote">
                    {schedule
                      ? `Everything lands at ${timing.serve}`
                      : `${durationLabel(timing.minutes)} to the table at ${timing.serve}`}
                  </span>
                </div>
                <button
                  type="button"
                  className="ml-mealhome__cook"
                  disabled={tonight.recipeId == null}
                  onClick={() => navigate(`/meals/recipes/${tonight.recipeId}?view=cook`)}
                >
                  <Icon id="ico-meals" size="1.625rem" />
                  <span>COOK</span>
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="ml-mealhome__nothing">
            <span className="ml-mealhome__dish ml-mealhome__dish--empty serif">Nothing planned</span>
            <button
              type="button"
              className="ml-mealhome__plantonight"
              onClick={() => navigate(`/meals/assign/${today}/Dinner`)}
            >
              PLAN TONIGHT
            </button>
          </div>
        )}

        {/* One at a time, and only inside the next half hour — amber means "do this in the next few
            minutes", and a prep note about tomorrow is not that. */}
        {!prepDone && recipe?.prepNote && timing && timing.lateBy > -30 && (
          <MealAlert
            sentence={recipe.prepNote}
            action={
              <button type="button" className="ml-mealalert__action" onClick={() => setPrepDone(true)}>DONE</button>
            }
          />
        )}

        {/* THE ORDER (MEALS_GROUPS §4.1). Static ruled rows, deliberately: the cook view is where a
            component counts down. A home screen that nudged per component would fire three notices
            a night and break the notification rate rules. */}
        {schedule && schedule.rows.length > 0 && (
          <div className="ml-order">
            <div className="ml-order__head">
              <span className="ml-order__label">THE ORDER</span>
              <span className="ml-order__from">{`FROM A ${schedule.serve} TABLE`}</span>
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

        {lastNight && (
          <div className="ml-mealhome__lastnight">
            <span className="ml-mealhome__lastmain">
              <span className="ml-mealhome__lastlabel">LAST NIGHT</span>
              <span className="ml-mealhome__lastq">
                {`Did you have ${lastNight.freeText ?? lastNight.recipeTitle}?`}
              </span>
            </span>
            <button
              type="button"
              className="ml-mealhome__yes"
              onClick={() => void confirmAte(lastNight)}
            >
              YES
            </button>
            <button
              type="button"
              className="ml-mealhome__no"
              onClick={() => navigate(`/meals/confirm/${lastNight.date}`)}
            >
              NO
            </button>
          </div>
        )}

        <div className="ml-mealhome__weekhead">
          <span className="ml-mealhome__weeklabel">THE REST OF THE WEEK</span>
          <button type="button" className="ml-mealhome__planlink" onClick={() => navigate('/meals/week')}>
            PLAN ▸
          </button>
        </div>

        <div className="ml-mealhome__week">
          {rest.map((day) => {
            const arrangement = entriesFor(day, 'Dinner')
            const dinner = arrangement[0]
            const dayRecipe = dinner?.recipeId != null ? recipes.find((r) => r.id === dinner.recipeId) : undefined
            const lead = dayRecipe && (dayRecipe.leadMinutes != null || dayRecipe.prepNote)
              ? leadLine(dayRecipe, settings.dinnerTime)
              : null
            return (
              <button
                type="button"
                className="ml-mealhome__day"
                key={day.date}
                onClick={() => (dinner?.recipeId != null
                  ? navigate(`/meals/recipes/${dinner.recipeId}`)
                  : navigate(`/meals/assign/${day.date}/Dinner`))}
              >
                <span className="ml-mealhome__dayname">{shortWeekday(day.date)}</span>
                <span className="ml-mealhome__daymain">
                  <span className={'ml-mealhome__daytitle' + (dinner ? '' : ' ml-mealhome__daytitle--empty')}>
                    {dinner ? (dinner.freeText ?? dinner.recipeTitle) : 'Nothing planned'}
                  </span>
                  {lead && <span className="ml-mealhome__daylead">{lead}</span>}
                </span>
                {/* Words, not a badge — a night of several dishes says how many rather than wearing
                    a marker that has to be learned. */}
                {arrangement.length > 1 && (
                  <span className="ml-mealhome__daycount">{`${countWord(arrangement.length)} RECIPES`}</span>
                )}
                {dinner?.recipeId != null && <Chevron />}
              </button>
            )
          })}
        </div>
      </ScrollArea>

      <div className="ml-mealhome__footer">
        {/* No denominator. "Six of seven" would frame every unplanned night as a gap to fill, and
            not planning Friday is a decision, not an omission. */}
        <span className="ml-mealhome__count">
          {`${countWord(planned)} NIGHT${planned === 1 ? '' : 'S'} PLANNED THIS WEEK`}
        </span>
        <button type="button" className="ml-mealfolderbtn" onClick={() => navigate('/meals/recipes')}>
          <Icon id="ico-list" size="1.0625rem" />
          <span>FOLDER</span>
        </button>
      </div>
    </ScreenShell>
  )
}

/**
 * `ITALIAN · COOKING FOR 6 · SERIOUS EATS`.
 *
 * `COOKING FOR n` appears only when the night overrides the recipe's own yield — repeating the
 * recipe's default would be stating that nothing was changed, on the line with the least room.
 */
function tonightMeta(
  entry: MealPlanEntryDto,
  recipe: RecipeSummaryDto | undefined,
  canonical: string[],
  dishCount: number,
): string {
  const parts: string[] = []
  if (recipe) {
    const cuisine = cuisineNameOf(recipe, canonical)
    if (cuisine) parts.push(cuisine.toUpperCase())
    if (entry.servingsOverride != null && entry.servingsOverride !== recipe.servings) {
      parts.push(`COOKING FOR ${entry.servingsOverride}`)
    }
    // The source belongs to the main recipe; on a multi-dish night it would be attributing the
    // whole meal to one component's website. The dish count is the more useful thing to say there.
    if (dishCount > 1) parts.push(`${countWord(dishCount)} RECIPES`)
    else if (recipe.sourceName) parts.push(recipe.sourceName.toUpperCase())
  } else if (entry.servingsOverride != null) {
    parts.push(`COOKING FOR ${entry.servingsOverride}`)
  }
  return parts.join(' · ')
}

/** `START 14:00 · PORK OUT FRIDAY NIGHT` — the second line on a week row with lead time. */
function leadLine(recipe: RecipeSummaryDto, dinnerTime: string): string {
  const parts: string[] = []
  const timing = startBy(dinnerTime, recipe.totalMinutes, new Date())
  if (timing) parts.push(`START ${timing.start}`)
  if (recipe.prepNote) parts.push(recipe.prepNote.split('\n')[0].toUpperCase())
  else if (recipe.leadMinutes != null) parts.push(`LEAD ${durationLabel(recipe.leadMinutes).toUpperCase()}`)
  return parts.join(' · ')
}
