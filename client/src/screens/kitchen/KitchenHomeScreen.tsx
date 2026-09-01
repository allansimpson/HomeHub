import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { KitchenHeader, KitchenQuickRow, ScreenShell, ScrollArea } from '../../components'
import { api } from '../../api/client'
import { useMeals } from '../../app/MealsProvider'
import { useNow } from '../../app/useNow'
import { clockLabel } from '../../app/dates'
import {
  entriesFor, plannedCount, shortDate, shortWeekday, startBy, todayKey,
} from '../../app/mealsDomain'
import {
  missingTonight, nextNights, nightsNeedingSomething, stockNeedsAttention, stockWord, turningBand,
  usesSentence, wantedNames,
} from '../../app/kitchenDomain'
import type { DueRecipeDto, GroceryListDto, MealPlanEntryDto, StockCheckDto } from '../../api/types'

/**
 * The Kitchen's answering page — the panel you land on.
 *
 * It replaces a three-tab structure (`WEEK`, `RECIPES`, `PANTRY`) that named database tables rather
 * than reasons to open the app. The rule this screen is built on: **answer first, destinations
 * second.** Everything above the quick row is a fact the household wanted; the row is for going to
 * look at something, which is a different intent and belongs lower.
 *
 * The five bands are in a fixed order, and the order is load-bearing:
 *
 * 1. **Tonight** — the dish, when to start, what is missing. Nothing goes above it.
 * 2. **Use it or lose it** — the band that owns waste, ending in one thing to cook rather than a
 *    list to feel bad about. It disappears entirely when nothing is turning.
 * 3. **The next few nights** — three, not seven. The full week is behind PLAN.
 * 4. **What we need** — named in one line, with shopping as a door on the heading.
 * 5. **Anything owing** — one line, counted, never a badge.
 */
export function KitchenHomeScreen() {
  const navigate = useNavigate()
  const { week, recipes, settings } = useMeals()
  const now = new Date(useNow(60_000))

  const [due, setDue] = useState<DueRecipeDto[]>([])
  const [pantryCount, setPantryCount] = useState<number | null>(null)
  const [grocery, setGrocery] = useState<GroceryListDto | null>(null)
  const [tonightCheck, setTonightCheck] = useState<StockCheckDto | null>(null)

  // Each of these is advisory (PANTRY_BEHAVIOURS §1): a failure leaves the band out rather than
  // showing an error, because a page that answers three questions out of four is still useful and a
  // banner about the fourth is not.
  useEffect(() => {
    let cancelled = false

    void api.getDueRecipes(5).then((d) => { if (!cancelled) setDue(d) }).catch(() => {})
    void api.getPantry().then((p) => { if (!cancelled) setPantryCount(p.total) }).catch(() => {})
    void api.getGrocery().then((g) => { if (!cancelled) setGrocery(g) }).catch(() => {})

    return () => { cancelled = true }
  }, [])

  const today = todayKey()
  const todayDay = week?.days.find((d) => d.date === today)
  const tonight = entriesFor(todayDay, 'Dinner')[0] as MealPlanEntryDto | undefined
  const recipe = tonight?.recipeId != null ? recipes.find((r) => r.id === tonight.recipeId) : undefined
  const timing = startBy(settings.dinnerTime, recipe?.totalMinutes ?? null, now)

  const turning = turningBand(due)
  const upcoming = nextNights(week, today)
  const shortNights = nightsNeedingSomething(week)
  const openLines = grocery?.openCount ?? null
  const wanted = grocery ? wantedNames(grocery.lines) : null
  const missing = missingTonight(tonightCheck ?? undefined)

  // What tonight is short of, counted. The week's one-word summary says *that* something is
  // missing; the row has to say how many, which only the check knows.
  useEffect(() => {
    if (tonight?.recipeId == null) { setTonightCheck(null); return }
    let cancelled = false
    void api.checkStock(tonight.recipeId, tonight.servingsOverride ?? undefined, tonight.id)
      .then((c) => { if (!cancelled) setTonightCheck(c ?? null) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [tonight?.recipeId, tonight?.servingsOverride, tonight?.id])

  return (
    <ScreenShell
      header={
        <KitchenHeader
          title="KITCHEN"
          meta={`${shortDate(today)} · ${clockLabel(now)}`}
        />
      }
      dock={
        <KitchenQuickRow
          counts={{
            plan: `${plannedCount(week, settings.visibleSlots)} NIGHTS`,
            pantry: pantryCount == null ? undefined : `${pantryCount} THINGS`,
            recipes: `${recipes.length}`,
            list: openLines == null ? undefined : `${openLines} OPEN`,
          }}
        />
      }
    >
      {/* The bands scroll; the quick row does not. That separation is the point of docking it
          outside the content rather than pinning it inside. */}
      <ScrollArea>
        {/* ---- 1 · Tonight ---- */}
        <div className="ml-kitchen__homehead">
          <span className="ml-kitchen__homelabel">TONIGHT</span>
        </div>

      {tonight ? (
        <div>
          <div className="ml-kitchen__dish">{tonight.recipeTitle ?? tonight.freeText}</div>
          <div className="ml-kitchen__meta">
            {[recipe?.tags[0]?.toUpperCase() ?? null,
              recipe?.servings != null ? `FOR ${tonight.servingsOverride ?? recipe.servings}` : null,
              recipe?.sourceName?.toUpperCase() ?? null]
              .filter(Boolean)
              .join(' · ')}
          </div>

          {/*
            The start time and the way to begin, in one bordered card.

            Together because they are one thought — *this is when, and here is how* — and a start
            time with no way to act on it is a fact you have to carry to another screen. The clock
            is the largest thing on the card because it is the only number on this page anybody
            reads from across a room.
          */}
          {timing && (
            <div className="ml-kitchen__startby">
              <div className="ml-kitchen__startwhen">
                {/* Past the start time the label changes rather than turning amber: a late dinner
                    is information, not an alert (MEALS_BEHAVIOURS §8). */}
                <span className="ml-kitchen__startlabel">
                  {timing.lateBy > 0 ? 'START NOW' : 'START BY'}
                </span>
                <span className="ml-kitchen__startclock serif">
                  {timing.lateBy > 0 ? `${timing.lateBy} MIN OVER` : timing.start}
                </span>
                <span className="ml-kitchen__startsub">
                  {timing.minutes} min to the table at {timing.serve}
                </span>
              </div>
              {tonight.recipeId != null && (
                <button
                  type="button"
                  className="ml-kitchen__startcook"
                  onClick={() => navigate(`/kitchen/cook/${tonight.recipeId}?entry=${tonight.id}`)}
                >
                  COOK
                </button>
              )}
            </div>
          )}

          {/* What tonight is short of — a row with a door on it, not a band. It is a fact about the
              dish above rather than a section of its own. */}
          {missing > 0 && (
            <button
              type="button"
              className="ml-kitchen__missing"
              onClick={() => navigate(`/kitchen/plan/${today}`)}
            >
              <span>
                {missing === 1 ? 'ONE THING MISSING' : `${missing} THINGS MISSING`} FOR TONIGHT
              </span>
              <span className="ml-kitchen__chev">›</span>
            </button>
          )}
        </div>
      ) : (
        // Rows are the invitation (the panel map's shared vocabulary). The only centred empty state
        // in the section is a pantry nobody has filled in — an unplanned night gets a row.
        <button
          type="button"
          className="ml-row ml-row--flush"
          onClick={() => navigate('/kitchen/plan')}
        >
          <span className="ml-kitchen__dish">＋ Nothing planned</span>
        </button>
      )}

      {/* ---- 2 · Use it or lose it. Absent entirely when nothing is turning. ---- */}
      {turning && (
        <>
          {/*
            A heading row, not a divider.

            The answering page is the one Kitchen view the divider does not reach: its panel in
            `design_handoff_kitchen_lists` is byte-identical to the previous handoff's, and it draws
            these headings as a plain label with a door opposite — no rule, no serif. That is not an
            oversight in a bundle whose whole subject is dividers; the file is listed as "unchanged,
            for context". A rule across this page would also be wrong on its own terms: the sections
            here are four different answers, not four groups of the same kind of row.
          */}
          <div className="ml-kitchen__homehead ml-kitchen__homehead--amber">
            <span className="ml-kitchen__homelabel">USE IT OR LOSE IT</span>
            <span className="ml-kitchen__homemeta">{turning.count} THINGS</span>
          </div>
          {/* A bordered card, because it ends in a choice. The heading above owns the problem; the
              card is the one thing you could do about it, and it has to look like a control. */}
          <div className="ml-kitchen__lead">
            <div className="ml-kitchen__leadclears">ONE MEAL CLEARS {turning.lead.uses.length} OF THEM</div>
            <div className="ml-kitchen__leadtitle serif">{turning.lead.title}</div>
            <div className="ml-kitchen__leadwhy">
              {usesSentence(turning.lead.uses)}. Nothing to buy.
            </div>
            {/* Two answers, and the second is what makes the first safe to offer: something worth
                cooking is not always worth cooking *tonight*. */}
            <div className="ml-kitchen__errandrow">
              <button
                type="button"
                className="ml-kitchen__shop"
                onClick={() => navigate(`/kitchen/cook/${turning.lead.recipeId}`)}
              >
                COOK IT TONIGHT
              </button>
              <button
                type="button"
                className="ml-kitchen__errandalt"
                onClick={() => navigate(`/kitchen/recipes/${turning.lead.recipeId}`)}
              >
                LOOK AT IT
              </button>
            </div>
          </div>
        </>
      )}

      {/* ---- 3 · The next few nights ---- */}
      <div className="ml-kitchen__homehead">
        <span className="ml-kitchen__homelabel">THE NEXT FEW NIGHTS</span>
        <button
          type="button"
          className="ml-kitchen__banddoor"
          onClick={() => navigate('/kitchen/plan')}
        >
          PLAN ›
        </button>
      </div>
      <div>
        {upcoming.map((day) => {
          const night = entriesFor(day, 'Dinner')[0] as MealPlanEntryDto | undefined
          const word = night ? stockWord(night) : null
          return (
            <div key={day.date} className="ml-row">
              <span className="ml-row__label">{shortWeekday(day.date)}</span>
              <span className="ml-row__value">
                {night ? (night.recipeTitle ?? night.freeText) : '＋ Nothing planned'}
              </span>
              {word && (
                <span
                  className={
                    'ml-kitchen__verdict'
                    + (stockNeedsAttention(night?.stockSummary ?? null) ? ' ml-kitchen__verdict--short' : '')
                    + (night?.stockSummary === 'NoClaim' ? ' ml-kitchen__verdict--quiet' : '')
                  }
                >
                  {word}
                </span>
              )}
            </div>
          )
        })}
      </div>

      {/* ---- 4 · What we need ---- */}
      <div className="ml-kitchen__homehead">
        <span className="ml-kitchen__homelabel">WHAT WE NEED</span>
        <button
          type="button"
          className="ml-kitchen__banddoor"
          onClick={() => navigate('/kitchen/list')}
        >
          {openLines == null ? 'GO SHOPPING ›' : `${openLines} OPEN · GO SHOPPING ›`}
        </button>
      </div>
      {/* Named, not just counted. A heading with a number behind it and nothing under it is a door
          with no sign on it — four names say whether the shop is worth making. */}
      <div>
        <div className="ml-kitchen__wanted">
          {wanted ?? 'Nothing on the list.'}
        </div>
      </div>

      {/* ---- 5 · Anything owing. One line, counted, never a badge. ---- */}
      {shortNights.length > 0 && (
        <button
          type="button"
          className="ml-kitchen__missing"
          onClick={() => navigate('/kitchen/plan')}
        >
          <span>
            {shortNights.length === 1
              ? 'ONE NIGHT NEEDS A LOOK'
              : `${shortNights.length} NIGHTS NEED A LOOK`}
          </span>
          <span className="ml-kitchen__chev">›</span>
        </button>
        )}
      </ScrollArea>
    </ScreenShell>
  )
}
