import { useNavigate } from 'react-router-dom'
import { ScreenShell, DrillInHeader } from '../../components'
import { Icon } from '../../icons/Icon'
import { useMeals } from '../../app/MealsProvider'
import {
  addPlanDays, dayNumber, entryFor, plannedCount, shortWeekday, todayKey, weekLabel,
} from '../../app/mealsDomain'
import { ALL_SLOTS } from '../../app/mealsPrefs'
import type { MealDayDto, MealPlanEntryDto, MealSlotName } from '../../api/types'
import { Chevron } from './parts'

const SLOT_LETTER: Record<MealSlotName, string> = { Breakfast: 'B', Lunch: 'L', Dinner: 'D', Other: '·' }

/**
 * Week planner (MEALS_SCREEN §2, id 4c). Seven day blocks rendered straight from the response —
 * the API always returns exactly seven days including the empty ones, so nothing here gap-fills.
 *
 * Which slots appear is a household setting; dinner is always one of them.
 */
export function MealsWeekScreen() {
  const navigate = useNavigate()
  const { week, weekStartKey, setWeekStartKey, settings } = useMeals()
  const today = todayKey()
  const slots = settings.visibleSlots
  const hidden = ALL_SLOTS.filter((s) => !slots.includes(s))
  const planned = plannedCount(week, slots)

  // Rendered from the key rather than the response so paging feels immediate — the header moves on
  // the tap, and the seven blocks fill in when the fetch lands.
  const days: (MealDayDto | undefined)[] = Array.from({ length: 7 }, (_, i) => {
    const key = addPlanDays(weekStartKey, i)
    return week?.days.find((d) => d.date === key) ?? (week ? { date: key, entries: [] } : undefined)
  })
  const keys = Array.from({ length: 7 }, (_, i) => addPlanDays(weekStartKey, i))

  const isEmptyWeek = week != null && planned === 0

  return (
    <ScreenShell header={<DrillInHeader title="MEALS" onBack={() => navigate('/meals')} />}>
      <div className="ml-mealweek__pager">
        <button
          type="button"
          className="ml-mealweek__page"
          aria-label="Previous week"
          onClick={() => setWeekStartKey(addPlanDays(weekStartKey, -7))}
        >
          ◂
        </button>
        <span className="ml-mealweek__label serif">{weekLabel(weekStartKey)}</span>
        <button
          type="button"
          className="ml-mealweek__page"
          aria-label="Next week"
          onClick={() => setWeekStartKey(addPlanDays(weekStartKey, 7))}
        >
          ▸
        </button>
      </div>
      <div className="ml-mealweek__pagerrule" aria-hidden="true" />

      {/* The rows are the invitation, so an empty week gets one line of instruction rather than a
          centred EmptyState that would replace the very thing you tap to fix it. */}
      {isEmptyWeek && (
        <p className="ml-mealweek__teach">Nothing planned. Tap a night to put dinner on it.</p>
      )}

      <div className="ml-mealweek__days">
        {keys.map((key, i) => (
          <div
            key={key}
            className={'ml-mealweek__day' + (key === today ? ' ml-mealweek__day--today' : '')}
          >
            <div className="ml-mealweek__date">
              <span className="ml-mealweek__weekday">{shortWeekday(key)}</span>
              <span className="ml-mealweek__daynum serif">{dayNumber(key)}</span>
            </div>
            <div className="ml-mealweek__slots">
              {slots.map((slot) => (
                <SlotLine
                  key={slot}
                  date={key}
                  slot={slot}
                  entry={entryFor(days[i], slot)}
                  emptyWeek={isEmptyWeek}
                  isToday={key === today}
                  onAssign={() => navigate(`/meals/assign/${key}/${slot}`)}
                  onOpenRecipe={(id) => navigate(`/meals/recipes/${id}`)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="ml-mealweek__footer">
        <span className="ml-mealweek__footnote">
          {hidden.length > 0
            ? `${hidden.map((s) => s.toUpperCase()).join(' · ')} HIDDEN · `
            : ''}
          <button type="button" className="ml-mealweek__settingslink" onClick={() => navigate('/meals/settings')}>
            MEALS SETTINGS
          </button>
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
 * One slot on one day, in whichever of the three states it is in.
 *
 * The chevron is the whole affordance for "this opens something", so it tracks `recipeId` rather
 * than the row being filled: a night whose recipe was deleted keeps its title as plain text and
 * must stop looking like a link, while linked leftovers read "Leftovers" and *do* drill through,
 * because they resolve to a recipe (MEALS_SCREEN §2.4).
 */
function SlotLine({
  date, slot, entry, emptyWeek, isToday, onAssign, onOpenRecipe,
}: {
  date: string
  slot: MealSlotName
  entry: MealPlanEntryDto | undefined
  emptyWeek: boolean
  isToday: boolean
  onAssign: () => void
  onOpenRecipe: (id: number) => void
}) {
  const dinner = slot === 'Dinner'
  const letter = (
    <span className={'ml-mealweek__slotletter' + (dinner ? ' ml-mealweek__slotletter--dinner' : '')}>
      {SLOT_LETTER[slot]}
    </span>
  )

  if (!entry) {
    // An add button on every empty breakfast is noise, so only dinner gets the invitation; the
    // other slots get an em dash and stay tappable.
    const label = dinner ? (emptyWeek && isToday ? 'Tonight' : '＋ Nothing planned') : '—'
    return (
      <div className="ml-mealweek__slot">
        {letter}
        <button
          type="button"
          className="ml-mealweek__slotmain"
          onClick={onAssign}
          aria-label={`Plan ${slot.toLowerCase()} on ${date}`}
        >
          <span className={'ml-mealweek__empty' + (dinner ? ' ml-mealweek__empty--dinner' : '')}>{label}</span>
        </button>
      </div>
    )
  }

  const linksToRecipe = entry.recipeId != null
  // Free text wins the title even when a recipe is attached: that is what makes linked leftovers
  // read "Leftovers — Chicken Piccata" rather than showing Monday's dish twice in one week.
  const title = entry.freeText ?? entry.recipeTitle ?? ''
  const linkedName = entry.freeText && entry.recipeTitle ? entry.recipeTitle : null

  return (
    <div className="ml-mealweek__slot">
      {letter}
      {/* Two targets, because the row answers two different questions. The body is "change this
          night" — the planner's whole job, and what §3 means by reaching the assign modal from a
          planned slot. The chevron is "show me the recipe". Rows with no recipe behind them have no
          chevron at all, which is exactly how a night whose recipe was deleted stops reading as a
          link while keeping its title. */}
      <button type="button" className="ml-mealweek__slotmain" onClick={onAssign}>
        <span className={'ml-mealweek__entry' + (dinner ? ' ml-mealweek__entry--dinner' : '')}>
          <span className={entry.freeText ? 'ml-mealweek__free' : 'ml-mealweek__title'}>{title}</span>
          {linkedName && <span className="ml-mealweek__linked">{`— ${linkedName}`}</span>}
          {entry.servingsOverride != null && (
            <span className="ml-mealweek__for">{`FOR ${entry.servingsOverride}`}</span>
          )}
        </span>
      </button>
      {linksToRecipe && (
        <button
          type="button"
          className="ml-mealweek__open"
          onClick={() => onOpenRecipe(entry.recipeId!)}
          aria-label={`Open ${entry.recipeTitle ?? title}`}
        >
          <Chevron />
        </button>
      )}
    </div>
  )
}
