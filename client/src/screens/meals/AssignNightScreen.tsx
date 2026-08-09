import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Stepper } from '../../components'
import { Icon } from '../../icons/Icon'
import { api } from '../../api/client'
import { useSession } from '../../app/SessionProvider'
import { useMeals } from '../../app/MealsProvider'
import {
  addPlanDays, countWord, durationLabel, entriesFor, longWeekday, nextFreeSlot, shortDate, daysSinceCooked,
} from '../../app/mealsDomain'
import { cuisineNameOf } from '../../app/mealsPrefs'
import type { MealSlotName, MealSummaryDto, RecipeSummaryDto } from '../../api/types'
import { MealsLabel, MealsModal, RuleLine } from './parts'

/** Ways to occupy a night without cooking. Free text, so they need no recipe to exist. */
const NOT_COOKING = ['Takeout', 'Eating out', 'Leftovers']

type Sort = 'recent' | 'cuisine'

/**
 * Assign a night (MEALS_SCREEN §3, id 4b). Reached from an empty slot, a planned slot (pre-filled),
 * or PLAN TONIGHT.
 *
 * **Every tap writes.** There is no draft to lose and no save to forget, which is why the footer
 * says so and `DONE` only closes. On a wall panel the alternative — a form you must remember to
 * commit — is how a night ends up unplanned because someone walked away mid-thought.
 */
export function AssignNightScreen() {
  const navigate = useNavigate()
  const { date = '', slot: slotParam } = useParams()
  const { activeProfileId } = useSession()
  const { week, recipes, meals, coOccurrences, settings, planMeal, clearMeal, removeEntry, assignSavedMeal, refresh } = useMeals()

  const visible = settings.visibleSlots
  const [slot, setSlot] = useState<MealSlotName>(
    visible.includes((slotParam ?? '') as MealSlotName) ? (slotParam as MealSlotName) : 'Dinner',
  )
  const [sort, setSort] = useState<Sort>('recent')
  const [typed, setTyped] = useState('')
  const [leftoversOn, setLeftoversOn] = useState(false)
  const [dismissedPromote, setDismissedPromote] = useState(false)
  const [namingMeal, setNamingMeal] = useState<string | null>(null)
  /** True while the pick list is adding *alongside* the night rather than replacing it. */
  const [adding, setAdding] = useState(false)

  const day = week?.days.find((d) => d.date === date)
  const arrangement = entriesFor(day, slot)
  const entry = arrangement[0]
  const chosen = entry?.recipeId != null ? recipes.find((r) => r.id === entry.recipeId) : undefined

  // Total cook time across the night, for the block header. A partial sum still beats showing
  // nothing when one component never said how long it takes.
  const nightMinutes = arrangement.some((e) => e.totalMinutes != null)
    ? arrangement.reduce((n, e) => n + (e.totalMinutes ?? 0), 0)
    : null

  /**
   * A pairing the household has confirmed cooking together three times, that isn't already saved.
   * Only offered once the night on screen *is* that set — offering to name a pairing you are not
   * currently looking at would be an interruption rather than a shortcut.
   */
  const promotable = useMemo(() => {
    const ids = arrangement.map((e) => e.recipeId).filter((id): id is number => id != null).sort()
    if (ids.length < 2 || dismissedPromote) return null
    const key = ids.join(',')
    return coOccurrences.find((c) => [...c.recipeIds].sort().join(',') === key) ?? null
  }, [arrangement, coOccurrences, dismissedPromote])

  // Where the leftovers would go. Named explicitly rather than as "the next free night" so the
  // checkbox makes a promise the screen can keep — and hidden entirely when the week has no room.
  //
  // Searched from the day *after* the one being planned. Starting on the same day offers today's
  // lunch for leftovers of tonight's dinner, which is both impossible and the kind of wrong that
  // makes a checkbox look like it was written by someone who never cooked.
  const leftoverTarget = useMemo(
    () => nextFreeSlot(week, visible, addPlanDays(date, 1)),
    [week, visible, date],
  )

  // The household's number wins over the page's yield, for the same reason as on the detail screen:
  // how many you cook for is a property of the kitchen, not of the recipe you happened to open.
  const servings = entry?.servingsOverride ?? settings.defaultServings ?? chosen?.servings ?? null

  const browsable = useMemo(() => {
    const rows = recipes.filter((r) => !r.isArchived)
    if (sort === 'cuisine') {
      return [...rows].sort((a, b) => {
        const ca = cuisineNameOf(a, settings.canonicalCuisines) ?? '￿'
        const cb = cuisineNameOf(b, settings.canonicalCuisines) ?? '￿'
        return ca.localeCompare(cb) || a.title.localeCompare(b.title)
      })
    }
    // "Recent first" here means longest-uncooked first — on a screen whose question is "what shall
    // we have", the useful order is what you have not had lately.
    return [...rows].sort((a, b) => daysSinceCooked(b) - daysSinceCooked(a) || a.title.localeCompare(b.title))
  }, [recipes, sort, settings.canonicalCuisines])

  const pickRecipe = async (recipe: RecipeSummaryDto) => {
    setTyped('')
    // A night planned without touching the stepper still records the household's number, so the
    // week row reads FOR 8 and the cook view opens at 8 without anyone restating it every time.
    await planMeal({
      date,
      slot,
      recipeId: recipe.id,
      servingsOverride: entry?.servingsOverride ?? settings.defaultServings ?? null,
      // `adding` is the whole difference between "change the night" and "grow the night", and it is
      // only ever true because someone tapped ＋ Add another recipe. Picking without that still
      // replaces, which is what every existing habit expects.
      replace: !adding,
    })
    if (adding) setAdding(false)

    // The stock check (PANTRY_SCREEN §2, id 9b). Fired **after** the night is written, which is the
    // rule the whole pantry section hangs on: the check is a heads-up, not a gate, so the plan
    // survives whatever happens next — including force-quitting mid-modal (DECISIONS PG1).
    //
    // `checkStock` answers 204 when every line resolves fine or the check was already dismissed for
    // this entry, and this navigates nowhere in that case. There is deliberately no "you have
    // everything" screen; a clean assignment completes in silence.
    if (!adding) await maybeCheckStock(recipe.id)
  }

  /**
   * Ask the pantry whether the night is worth a heads-up, and open 9b if it is.
   *
   * Failures are swallowed on purpose (PANTRY_BEHAVIOURS §1): if the pantry service is down the
   * assignment proceeds and the check is skipped silently — no error, no retry banner. A stock
   * check that isn't there is worth less than nothing to a standing adult with wet hands.
   */
  const maybeCheckStock = async (recipeId: number) => {
    try {
      const target = servings ?? settings.defaultServings ?? undefined
      const result = await api.checkStock(recipeId, target)
      if (!result || result.flaggedCount === 0) return
      navigate(
        `/meals/pantry/check/${date}/${slot}?recipeId=${recipeId}` +
          (target != null ? `&servings=${target}` : ''),
        { replace: true },
      )
    } catch {
      // Advisory in every direction.
    }
  }

  /** Put a saved meal on the night — expands into one entry per component. */
  const pickMeal = async (meal: MealSummaryDto) => {
    setTyped('')
    await assignSavedMeal({
      date,
      slot,
      mealId: meal.id,
      servingsOverride: meal.servings ?? settings.defaultServings ?? null,
    })
  }

  /** Name the pairing currently on the night. Leaves the night exactly as it is (§4.3). */
  const saveAsMeal = async (name: string) => {
    const components = arrangement
      .filter((e) => e.recipeId != null)
      .map((e) => ({ recipeId: e.recipeId!, role: e.role }))
    if (components.length < 2) return
    await api.createMeal({ name: name.trim(), components, servings: servings ?? undefined, modifiedByProfileId: activeProfileId })
    setNamingMeal(null)
    await refresh()
  }

  const pickText = async (text: string) => {
    setTyped('')
    await planMeal({ date, slot, freeText: text })
  }

  const changeServings = async (delta: number) => {
    if (!chosen) return
    const base = servings ?? chosen.servings ?? 4
    const next = Math.max(1, Math.min(50, base + delta))
    await planMeal({ date, slot, recipeId: chosen.id, servingsOverride: next })
  }

  /** Put the leftovers on the next free slot, linked back to tonight's recipe. */
  const toggleLeftovers = async (on: boolean) => {
    setLeftoversOn(on)
    if (!chosen || !leftoverTarget) return
    if (on) {
      // Both `recipeId` and `freeText`: the row reads "Leftovers" but still opens this recipe, at
      // the servings it was actually cooked at (MEALS_DATA_CONTRACT §3.1).
      await planMeal({
        date: leftoverTarget.date,
        slot: leftoverTarget.slot,
        recipeId: chosen.id,
        freeText: 'Leftovers',
        servingsOverride: servings,
      })
    } else {
      await clearMeal(leftoverTarget.date, leftoverTarget.slot)
    }
  }

  const close = () => navigate(-1)

  return (
    <MealsModal
      title={shortDate(date)}
      onCancel={close}
      footer={
        <div className="ml-assign__bar">
          <span className="ml-assign__barnote">SAVED AS YOU TAP</span>
          <button type="button" className="ml-assign__done" onClick={close}>DONE</button>
        </div>
      }
    >
      <div className="ml-assign__scroll">
        {/* One visible slot means the segment would be a single cell reading "DINNER" next to a
            header that already says which night — nothing to choose between. */}
        {visible.length > 1 && (
          <div className="ml-assign__slots" role="tablist">
            {visible.map((s) => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={s === slot}
                className={'ml-assign__slot' + (s === slot ? ' ml-assign__slot--active' : '')}
                onClick={() => setSlot(s)}
              >
                {s.toUpperCase()}
              </button>
            ))}
          </div>
        )}

        {arrangement.length > 0 && (
          <div className="ml-assign__chosen">
            {/* ON THIS NIGHT (MEALS_GROUPS §4.3) — replaces the single chosen-recipe block. One row
                per dish with a 52px role column and its own remove control, so a night is edited
                dish by dish rather than rebuilt. */}
            <div className="ml-assign__nighthead">
              <span className="ml-assign__nightlabel">ON THIS NIGHT</span>
              <span className="ml-assign__nightmeta">
                {[nightMinutes != null ? durationLabel(nightMinutes).toUpperCase() : null,
                  servings != null ? `FOR ${servings}` : null].filter(Boolean).join(' · ')}
              </span>
            </div>

            {arrangement.map((e) => (
              <div className="ml-assign__nightrow" key={e.id}>
                <span className="ml-assign__nightrole">{e.role.toUpperCase()}</span>
                <span className="ml-assign__nighttitle">{e.freeText ?? e.recipeTitle}</span>
                <button
                  type="button"
                  className="ml-assign__nightx"
                  aria-label={`Remove ${e.recipeTitle ?? e.freeText}`}
                  onClick={() => void (arrangement.length === 1 ? clearMeal(date, slot) : removeEntry(e.id))}
                >
                  ✕
                </button>
              </div>
            ))}

            <button
              type="button"
              className="ml-assign__addrecipe"
              onClick={() => setAdding((v) => !v)}
            >
              {adding ? '− Done adding' : '＋ Add another recipe'}
            </button>

            <div className="ml-assign__minorrule" aria-hidden="true" />

            <div className="ml-assign__cooking">
              <span className="ml-assign__cookingmain">
                <span className="ml-assign__cookinglabel">COOKING FOR</span>
                <span className="ml-assign__cookingsays">{servingsConsequence(servings, chosen?.servings ?? null)}</span>
              </span>
              <span className="ml-assign__stepper">
                <Stepper direction="minus" onStep={() => void changeServings(-1)} label="Fewer servings" />
                <span className="ml-assign__servings serif">{servings ?? '—'}</span>
                <Stepper direction="plus" onStep={() => void changeServings(1)} label="More servings" />
              </span>
            </div>

            {leftoverTarget && (
              <button
                type="button"
                className="ml-assign__leftovers"
                aria-pressed={leftoversOn}
                onClick={() => void toggleLeftovers(!leftoversOn)}
              >
                <span className={'ml-assign__check' + (leftoversOn ? ' ml-assign__check--on' : '')} aria-hidden="true">
                  {leftoversOn && <Icon id="ico-check" size="0.875rem" />}
                </span>
                <span className="ml-assign__leftoverstext">
                  {`Put the leftovers on ${longWeekday(leftoverTarget.date)} ${leftoverTarget.slot.toLowerCase()}`}
                </span>
              </button>
            )}
          </div>
        )}

        {/* The promote strip (MEALS_GROUPS §4.3). Offered on the third *confirmed* co-occurrence —
            never the third planned one, because a pairing planned and skipped three times is not a
            habit. Taking it writes the meal and leaves the night exactly as it is. */}
        {promotable && (
          <div className="ml-promote">
            <span className="ml-promote__count">
              {`YOU'VE COOKED THESE TOGETHER ${promotable.times}×`}
            </span>
            {namingMeal === null ? (
              <>
                <span className="ml-promote__ask">Save the pairing so it's one tap next time?</span>
                <span className="ml-promote__actions">
                  <button
                    type="button"
                    className="ml-promote__name"
                    onClick={() => setNamingMeal(promotable.titles.join(' & '))}
                  >
                    NAME IT
                  </button>
                  <button type="button" className="ml-promote__no" onClick={() => setDismissedPromote(true)}>
                    NOT NOW
                  </button>
                </span>
              </>
            ) : (
              <input
                className="ml-promote__input"
                autoFocus
                value={namingMeal}
                maxLength={60}
                aria-label="Name this meal"
                onChange={(e) => setNamingMeal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && namingMeal.trim()) void saveAsMeal(namingMeal)
                  if (e.key === 'Escape') setNamingMeal(null)
                }}
              />
            )}
          </div>
        )}

        <div className="ml-assign__grouprule" aria-hidden="true" />

        <MealsLabel label="OR NOT COOKING" />
        <div className="ml-assign__chips">
          {NOT_COOKING.map((text) => (
            <button
              key={text}
              type="button"
              className={'ml-assign__chip' + (entry?.freeText === text ? ' ml-assign__chip--active' : '')}
              onClick={() => void pickText(text)}
            >
              {text.toUpperCase()}
            </button>
          ))}
          <span className="ml-assign__typewrap">
            <span className="ml-assign__typeglyph" aria-hidden="true">✎</span>
            <input
              className="ml-assign__type"
              value={typed}
              placeholder="TYPE SOMETHING"
              aria-label="Type what you are having"
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && typed.trim()) void pickText(typed.trim())
              }}
            />
          </span>
        </div>

        {typed.trim() && (
          <div className="ml-assign__typed">
            <span className="ml-assign__typedvalue">{typed.trim()}</span>
            <button
              type="button"
              className="ml-assign__promote"
              onClick={() => navigate(`/meals/recipes/new?title=${encodeURIComponent(typed.trim())}`)}
            >
              {`＋ Save "${typed.trim()}" as a recipe`}
            </button>
            <RuleLine>
              A RECIPE CAN BE JUST A NAME — INGREDIENTS AND STEPS CAN COME LATER, OR NEVER
            </RuleLine>
          </div>
        )}

        <div className="ml-assign__pickhead">
          <MealsLabel label={adding ? 'ADD ANOTHER RECIPE' : 'OR COOK SOMETHING'} />
          <button
            type="button"
            className="ml-assign__sort"
            onClick={() => setSort((s) => (s === 'recent' ? 'cuisine' : 'recent'))}
          >
            {sort === 'recent' ? 'MEALS FIRST ▾' : 'BY CUISINE ▾'}
          </button>
        </div>

        {/* Saved meals above single recipes (§4.3) — the "don't hunt for it" half of the ask. Hidden
            while adding a second dish: a saved meal replaces the whole night, so offering one
            mid-arrangement would silently discard what has just been built. */}
        {!adding && sort === 'recent' && meals.length > 0 && (
          <div className="ml-assign__list">
            {meals.filter((m) => !m.isArchived).map((meal) => (
              <button key={`meal-${meal.id}`} type="button" className="ml-assign__row" onClick={() => void pickMeal(meal)}>
                <span className="ml-assign__check" aria-hidden="true" />
                <span className="ml-assign__rowmain">
                  <span className="ml-assign__rowtitle">{meal.name}</span>
                  <span className="ml-assign__rowmeta">{mealMeta(meal)}</span>
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="ml-assign__list">
          {browsable.length === 0 ? (
            <p className="ml-assign__nofolder">
              The folder is empty. Anything typed above still plans the night.
            </p>
          ) : (
            browsable.map((recipe) => {
              const selected = chosen?.id === recipe.id
              return (
                <button
                  key={recipe.id}
                  type="button"
                  className={'ml-assign__row' + (selected ? ' ml-assign__row--selected' : '')}
                  onClick={() => void pickRecipe(recipe)}
                >
                  <span className={'ml-assign__check' + (selected ? ' ml-assign__check--on' : '')} aria-hidden="true">
                    {selected && <Icon id="ico-check" size="0.875rem" />}
                  </span>
                  <span className="ml-assign__rowmain">
                    <span className="ml-assign__rowtitle">{recipe.title}</span>
                    <span className="ml-assign__rowmeta">{recipeMeta(recipe, settings.canonicalCuisines)}</span>
                  </span>
                </button>
              )
            })
          )}
        </div>
      </div>
    </MealsModal>
  )
}

/**
 * `SPAGHETTI BOLOGNESE + GARLIC TOAST · 47 MIN` — a meal's meta line names its parts.
 *
 * Words rather than a badge (§4.4): what distinguishes a meal from a recipe in the list is that its
 * meta line lists dishes where a recipe's lists a source and a time. Truncated past three parts,
 * because the line has to stay one line.
 */
function mealMeta(meal: MealSummaryDto): string {
  const named = meal.recipeTitles.slice(0, 3).map((t) => t.toUpperCase()).join(' + ')
  const parts = [meal.recipeTitles.length > 3 ? `${named}…` : named]
  if (meal.totalMinutes != null) parts.push(durationLabel(meal.totalMinutes).toUpperCase())
  return parts.join(' · ')
}

/** `ITALIAN · 35 MIN · RECIPE SERVES 4` — every part omitted when its field is null. */
function recipeMeta(recipe: RecipeSummaryDto, canonical: string[]): string {
  const parts: string[] = []
  const cuisine = cuisineNameOf(recipe, canonical)
  if (cuisine) parts.push(cuisine.toUpperCase())
  // Never composed from prep + cook: a recipe that gave only one of them has no honest total.
  if (recipe.totalMinutes != null) parts.push(durationLabel(recipe.totalMinutes).toUpperCase())
  if (recipe.servings != null) parts.push(`RECIPE SERVES ${recipe.servings}`)
  return parts.join(' · ')
}

/**
 * What cooking for this many actually means, in words.
 *
 * The number is already on screen in the stepper; repeating it as "6 servings" would say nothing.
 * What the cook wants to know is whether that is more than the recipe makes and what the surplus is
 * good for — so that is what this says.
 */
function servingsConsequence(target: number | null, base: number | null): string {
  if (target == null || base == null) return 'The recipe does not say what it makes'
  const diff = target - base
  if (diff === 0) return 'Exactly what the recipe makes'
  // `countWord` returns the uppercase form the section's tracked rule lines use. This is prose, so
  // it is cased back down — a shouted TWO in the middle of a sentence reads as a different voice.
  if (diff < 0) return `${sentenceCase(countWord(-diff))} fewer than the recipe makes`
  if (diff === 1) return 'One extra portion'
  return `${sentenceCase(countWord(diff))} extra portions — enough for a lunch`
}

function sentenceCase(word: string): string {
  return word.charAt(0) + word.slice(1).toLowerCase()
}
