import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Icon } from '../../icons/Icon'
import { api } from '../../api/client'
import { useMeals } from '../../app/MealsProvider'
import { entryFor, longWeekday, nextFreeSlot, shortDate } from '../../app/mealsDomain'
import { cuisineNameOf } from '../../app/mealsPrefs'
import { MealsLabel, MealsModal, RuleLine } from './parts'

/**
 * What actually happened (MEALS_SCREEN §4, id 6b) — the morning-after ask for one past night.
 *
 * This is the **only** thing that writes `wasEaten`, and the reason the folder's history can be
 * trusted. Everywhere else, an unanswered night stays unanswered: the alternative — assuming that a
 * night which was planned and has passed was also cooked — is how "last cooked 3 weeks ago" becomes
 * a number nobody believes.
 *
 * The dismiss reads `LATER`, not ✕. Declining to answer is a legitimate answer and should not feel
 * like escaping a trap, which is also why the bottom nav stays.
 */
export function NightConfirmScreen() {
  const navigate = useNavigate()
  const { date = '' } = useParams()
  const { week, recipes, settings, setEaten, planMeal, clearMeal } = useMeals()

  const [answered, setAnswered] = useState<boolean | null>(null)

  const day = week?.days.find((d) => d.date === date)
  const entry = entryFor(day, 'Dinner')
  const recipe = entry?.recipeId != null ? recipes.find((r) => r.id === entry.recipeId) : undefined
  const target = nextFreeSlot(week, settings.visibleSlots)

  const close = () => navigate(-1)

  const answer = async (ate: boolean) => {
    setAnswered(ate)
    await setEaten({ date, slot: 'Dinner', wasEaten: ate })
    // Saying yes is the end of it. Saying no opens the two follow-ups below rather than closing,
    // because the useful next question is what to do with the dish that didn't get cooked.
    if (!ate) return

    // "Yes, we ate it" is the *only* thing that takes stock off the shelves (PANTRY_SCREEN §6).
    // A night answered no, or left unanswered, deducts nothing ever — that is what keeps the
    // pantry's numbers meaning something.
    if (entry) { await deduct(entry.id); return }
    close()
  }

  /**
   * Deduct the night and show the receipt (9f).
   *
   * The deduction is applied server-side before this returns, so the screen it opens is a record
   * rather than a prompt. A 204 means nothing was deductible — normal in the first weeks, when the
   * pantry knows about almost none of a recipe's lines — and the receipt simply does not appear.
   * A failure closes just as quietly: the pantry never blocks a Meals answer.
   */
  const deduct = async (planEntryId: number) => {
    try {
      const receipt = await api.deductForNight(planEntryId)
      if (receipt) { navigate(`/meals/pantry/taken/${planEntryId}`, { replace: true }); return }
    } catch {
      // Advisory in every direction (PANTRY_BEHAVIOURS §1).
    }
    close()
  }

  const moveIt = async () => {
    if (!entry || !target) return
    await planMeal({
      date: target.date,
      slot: target.slot,
      recipeId: entry.recipeId ?? undefined,
      freeText: entry.recipeId == null ? (entry.freeText ?? undefined) : undefined,
      servingsOverride: entry.servingsOverride,
    })
    await clearMeal(date, 'Dinner')
    close()
  }

  if (!entry) {
    return (
      <MealsModal title={shortDate(date)} onCancel={close} cancelLabel="LATER" nav>
        <p className="ml-confirm__gone">Nothing was planned for that night.</p>
      </MealsModal>
    )
  }

  const dish = entry.freeText ?? entry.recipeTitle ?? ''
  const meta = [
    recipe ? cuisineNameOf(recipe, settings.canonicalCuisines)?.toUpperCase() : null,
    entry.servingsOverride != null ? `COOKED FOR ${entry.servingsOverride}` : null,
  ].filter(Boolean).join(' · ')

  return (
    <MealsModal title={shortDate(date)} onCancel={close} cancelLabel="LATER" nav>
      <div className="ml-confirm">
        <MealsLabel label="PLANNED FOR DINNER" />
        <p className="ml-confirm__dish serif">{dish}</p>
        {meta && <p className="ml-confirm__meta">{meta}</p>}

        <div className="ml-confirm__targets">
          <button
            type="button"
            className={'ml-confirm__ate' + (answered === true ? ' ml-confirm__ate--on' : '')}
            onClick={() => void answer(true)}
          >
            <Icon id="ico-check" size="1.625rem" />
            <span>WE ATE IT</span>
          </button>
          <button
            type="button"
            className={'ml-confirm__didnt' + (answered === false ? ' ml-confirm__didnt--on' : '')}
            onClick={() => void answer(false)}
          >
            <span className="ml-confirm__cross" aria-hidden="true">✕</span>
            <span>WE DIDN'T</span>
          </button>
        </div>

        <MealsLabel label="IF YOU DIDN'T" />
        <button type="button" className="ml-confirm__option" disabled={!target} onClick={() => void moveIt()}>
          <span className="ml-confirm__optiontext">
            {target ? `Move it to ${longWeekday(target.date)}` : 'No free night left this week'}
          </span>
          {target && <span className="ml-confirm__optionnote">NEXT FREE NIGHT</span>}
        </button>
        <button type="button" className="ml-confirm__option" onClick={close}>
          <span className="ml-confirm__optiontext">Leave it — we ate something else</span>
        </button>

        <div className="ml-confirm__why">
          <span className="ml-confirm__whylabel">WHY THIS IS ASKED</span>
          <p className="ml-confirm__whytext">
            The folder's "last cooked" and the order it suggests things in are built from nights that
            were actually eaten. Without an answer, a night that was planned and skipped would count
            the same as one you cooked — and the suggestions would quietly stop being useful.
          </p>
          <RuleLine>
            ASKED ONCE, THE MORNING AFTER · UNANSWERED NIGHTS STAY UNCOUNTED, NEVER ASSUMED
          </RuleLine>
        </div>
      </div>
    </MealsModal>
  )
}
