import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { api } from '../../api/client'
import { usePantry } from '../../app/PantryProvider'
import { useSession } from '../../app/SessionProvider'
import { useMeals } from '../../app/MealsProvider'
import {
  evidenceLine, isFlagged, moveTarget, neededLabel, numberWord, shortfallTitle, tailLine,
} from '../../app/pantryDomain'
import { shortDate } from '../../app/mealsDomain'
import type { StockCheckDto, StockCheckLineDto } from '../../api/types'
import { Chevron, PantryLabel, PantryModal, PrimaryButton, SecondaryButton } from './parts'

/**
 * The stock check (PANTRY_SCREEN §2, id 9b) — shown immediately after a recipe is chosen for a
 * night, over the Meals assign flow.
 *
 * **This screen is not a gate and cannot become one** (PANTRY_BEHAVIOURS §1, DECISIONS PG1). The
 * plan entry is already written before it appears, it has no `CANCEL`, and dismissing it costs
 * nothing and loses nothing. Force-quitting mid-modal leaves the night planned.
 *
 * It also does not appear at all when every line resolves `Fine` or `NotCounted`. There is no "you
 * have everything" screen — the assignment simply completes in silence.
 */
export function StockCheckScreen() {
  const navigate = useNavigate()
  const { date = '', slot = 'Dinner' } = useParams()
  const [params] = useSearchParams()
  const recipeId = Number(params.get('recipeId'))
  const planEntryId = params.get('planEntryId') ? Number(params.get('planEntryId')) : undefined

  const { activeProfileId } = useSession()
  const { addManyToGrocery } = usePantry()
  const { week, settings, planMeal, refresh: refreshMeals } = useMeals()

  const [check, setCheck] = useState<StockCheckDto | null>(null)
  const [servings, setServings] = useState<number | undefined>(
    params.get('servings') ? Number(params.get('servings')) : undefined,
  )
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  const leave = () => navigate(`/meals/week`, { replace: true })

  useEffect(() => {
    if (!recipeId) { leave(); return }
    let cancelled = false
    void api.checkStock(recipeId, servings, planEntryId)
      .then((result) => {
        if (cancelled) return
        // Nothing worth saying: every line fine, or the check was already dismissed for this entry.
        if (!result || result.flaggedCount === 0) { leave(); return }
        setCheck(result)
      })
      // The pantry is advisory. If the check cannot be reached the night stands and the modal gets
      // out of the way — no error, no retry banner (PANTRY_BEHAVIOURS §1).
      .catch(() => { if (!cancelled) leave() })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipeId, servings, planEntryId])

  if (!check || done) return null

  const flagged = check.lines.filter((l) => isFlagged(l.status))
  const tail = tailLine(check.totalLines, check.flaggedCount, check.notCountedNames)

  const toGroceryLines = () => flagged.map((line) => ({
    text: line.name,
    pantryItemId: line.pantryItemId,
    sourceKind: 'Meal' as const,
    sourceRecipeId: check.recipeId,
    sourceRecipeTitle: check.recipeTitle,
    sourceDate: date || null,
  }))

  const addAll = async () => {
    if (busy) return
    setBusy(true)
    try {
      await addManyToGrocery(toGroceryLines())
      setDone(true)
      navigate('/meals/pantry/grocery')
    } finally {
      setBusy(false)
    }
  }

  /** "We've got these — the panel's wrong": every listed item, marked seen today. */
  const weHaveThem = async () => {
    if (busy) return
    setBusy(true)
    try {
      await api.correctStock({
        lines: flagged
          .filter((l) => l.pantryItemId != null)
          .map((l) => ({ pantryItemId: l.pantryItemId!, atLeast: numericNeed(l) })),
        profileId: activeProfileId,
      })
      setDone(true)
      leave()
    } finally {
      setBusy(false)
    }
  }

  /**
   * "Move it to Friday" — the first free night on or after the next delivery.
   *
   * §3 words the target as "the next date whose stock check clears", but the check has no date
   * dimension: it compares a recipe against the shelves *now*, so asking it about Thursday and
   * about Friday returns the same answer and no date would ever "clear". The thing that actually
   * changes the shelves is a delivery, and the panel does know roughly when those land — so the
   * target is the first free night from the usual delivery weekday onward, which is what the
   * consequence line has been promising all along ("the delivery lands Thursday").
   *
   * With fewer than three deliveries on record there is no weekday to work from, and this falls
   * back to §3's stated fallback: the first free night.
   */
  const moveIt = async () => {
    if (busy || !date) return
    setBusy(true)
    try {
      const target = moveTarget(date, check.usualDeliveryWeekday, week, settings.visibleSlots)
      await planMeal({ date: target, slot: slot as 'Dinner', recipeId: check.recipeId, servingsOverride: servings })
      await refreshMeals()
      setDone(true)
      leave()
    } finally {
      setBusy(false)
    }
  }

  const cookForFewer = () => {
    // Re-runs the check in place: the effect above re-fires on `servings` and replaces the list.
    setServings((current) => Math.max(1, (current ?? check.servings) - 2))
  }

  const leaveIt = async () => {
    if (planEntryId) await api.dismissStockCheck(planEntryId).catch(() => {})
    setDone(true)
    leave()
  }

  return (
    <PantryModal
      back={leave}
      title="STOCK CHECK"
      meta={date ? shortDate(date).toUpperCase() : undefined}
      footer={
        <div className="pt-modal__foot">
          <PrimaryButton onClick={() => void addAll()} disabled={busy}>
            {`ADD THE ${numberWord(flagged.length).toUpperCase()} TO THE GROCERY LIST`}
          </PrimaryButton>
          <SecondaryButton onClick={() => navigate('/meals/recipes?pick=stocked')}>
            SHOW ME SOMETHING I CAN COOK
          </SecondaryButton>

          {/* Four ruled rows, each stating its consequence — not four buttons. §2.10 is explicit
              that the shortfall actions are all available but must not read as a menu of equals;
              the last one is muted because it is the do-nothing. */}
          <div className="pt-actions">
            <ActionRow
              title={check.usualDeliveryWeekday
                ? `Move it to ${check.usualDeliveryWeekday}`
                : 'Move it to another night'}
              note={check.usualDeliveryWeekday
                ? `the delivery lands ${check.usualDeliveryWeekday}`
                : 'to the next free night'}
              onClick={() => void moveIt()}
            />
            <ActionRow
              title={`Cook for ${Math.max(1, check.servings - 2)} instead`}
              note="re-runs the check on fewer"
              onClick={cookForFewer}
            />
            <ActionRow
              title="We’ve got these — the panel’s wrong"
              note={`marks all ${numberWord(flagged.length)} seen today`}
              onClick={() => void weHaveThem()}
            />
            <ActionRow
              title="Leave it, I’ll sort it"
              note="no list, no reminder"
              muted
              onClick={() => void leaveIt()}
            />
          </div>
        </div>
      }
    >
      <h2 className="pt-check__title serif">{shortfallTitle(flagged.length)}</h2>
      <p className="pt-check__sub">
        for <span className="pt-check__dish">{check.recipeTitle}</span>, cooking for {check.servings}.{' '}
        {weekdayWord(date)} {slot.toLowerCase()} is already saved — this is a heads-up, not a gate.
      </p>

      <div className="pt-check__divider" aria-hidden="true" />

      <PantryLabel label="WORTH A LOOK" amber meta={`${check.flaggedCount} OF ${check.totalLines} LINES`} />

      {flagged.map((line) => (
        <div className="pt-check__row" key={line.ingredientId}>
          <div className="pt-check__head">
            <span className="pt-check__name">{line.name}</span>
            {/* Amber only when the panel believes you are actually short; muted when it cannot
                tell. The difference between "you need six" and "we don't know" is the whole
                point of the six statuses, and it has to be visible at a glance. */}
            <span className={'pt-check__needs' + (line.status === 'Unknown' || line.status === 'NoMatch' ? ' pt-check__needs--unsure' : '')}>
              {neededLabel(line.needed)}
            </span>
          </div>
          <span className="pt-check__evidence">{evidenceLine(line)}</span>
        </div>
      ))}

      {tail && <p className="pt-check__tail">{tail}</p>}
    </PantryModal>
  )
}

function ActionRow({
  title,
  note,
  muted,
  onClick,
}: {
  title: string
  note: string
  muted?: boolean
  onClick: () => void
}) {
  return (
    <button type="button" className={'pt-action' + (muted ? ' pt-action--muted' : '')} onClick={onClick}>
      <span className="pt-action__main">
        <span className="pt-action__title">{title}</span>
        <span className="pt-action__note">{note}</span>
      </span>
      <Chevron />
    </button>
  )
}

function weekdayWord(isoDate: string): string {
  if (!isoDate) return 'That night'
  const [y, m, d] = isoDate.split('-').map(Number)
  if (!y || !m || !d) return 'That night'
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long' })
}

/** The numeric part of `needs 6`, for "at least what the recipe needs". */
function numericNeed(line: StockCheckLineDto): number | null {
  if (!line.needed) return null
  const match = /^[\d.]+/.exec(line.needed)
  return match ? Number(match[0]) : null
}

