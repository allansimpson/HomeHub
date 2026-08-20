import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { KitchenHeader, KitchenQuickRow, ScreenShell, ScrollArea } from '../../components'
import { api } from '../../api/client'
import { useMeals } from '../../app/MealsProvider'
import { useNow } from '../../app/useNow'
import {
  addPlanDays, dayNumber, entriesFor, longWeekday, plannedCount, shortWeekday, startBy, todayKey,
  weekLabel,
} from '../../app/mealsDomain'
import {
  nightLine, stockNeedsAttention, stockWord, weekBearing, weekShortfalls,
} from '../../app/kitchenDomain'
import type { MealDayDto, MealPlanEntryDto, RecipeSummaryDto } from '../../api/types'

/**
 * PLAN — the week (PLAN_WEEK §1, panel L1).
 *
 * Three rules from the spec shape this screen, and each is easy to lose:
 *
 * **Tonight sits outside the list.** It is the only night with a start time and a `COOK` action,
 * and burying it among seven equal rows loses the one thing most likely to be wanted. Seven tidy
 * rows is the alternative, and it is worse.
 *
 * **`THE REST` does not scroll.** Six nights fit the panel exactly. This is the one group in the
 * Kitchen sized to its content rather than bisecting a row — the week *is* the point of the screen,
 * and a clipped Sunday is worse than a missing scroll affordance.
 *
 * **An empty night carries its own suggestion.** That is why the section has no "what shall we
 * cook" destination: the offer lives on the night that needs it.
 */
/** How many weeks the ruler shows — the segment you are on lights up. */
const RULER_WEEKS = 4

export function KitchenPlanScreen() {
  const navigate = useNavigate()
  const { week, weekStartKey, setWeekStartKey, recipes, settings } = useMeals()
  const now = new Date(useNow(60_000))

  const [turning, setTurning] = useState<ReadonlySet<number>>(new Set())
  const [shortfalls, setShortfalls] = useState<ReturnType<typeof weekShortfalls>>([])
  const [saved, setSaved] = useState(false)

  const today = todayKey()
  const days = week?.days ?? []
  const tonightDay = days.find((d) => d.date === today)
  const tonight = tonightDay ? (entriesFor(tonightDay, 'Dinner')[0] as MealPlanEntryDto | undefined) : undefined
  const tonightRecipe = tonight?.recipeId != null
    ? recipes.find((r) => r.id === tonight.recipeId)
    : undefined
  const timing = startBy(settings.dinnerTime, tonightRecipe?.totalMinutes ?? null, now)

  // "The rest" is every night of the shown week that is not tonight — six on the current week, all
  // seven on any other. Tonight is lifted out only where it actually falls.
  const rest = days.filter((d) => d.date !== today)
  const bearing = weekBearing(weekStartKey, today, RULER_WEEKS)

  // Which recipes would use something on the turn, so a night can say so in teal. Advisory: a
  // failure leaves the line off rather than showing an error.
  useEffect(() => {
    let cancelled = false
    void api.getDueRecipes(20)
      .then((d) => {
        if (!cancelled) setTurning(new Set(d.filter((r) => r.score > 0).map((r) => r.recipeId)))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  /**
   * What the week is short of, by thing.
   *
   * One check per planned night, which is what the review does too — the week's own `stockSummary`
   * says *that* a night is short but never *what* of, and the band has to name things or it cannot
   * be shopped from.
   */
  const loadShortfalls = useCallback(() => {
    // Keyed off `week`, never off a derived array. `week?.days ?? []` is a fresh array on every
    // render, so depending on it would re-run this effect every render — one stock check per
    // planned night, forever, for as long as the panel is open.
    const planned = (week?.days ?? []).flatMap((d) => d.entries).filter((e) => e.recipeId != null)
    if (planned.length === 0) { setShortfalls([]); return }

    let cancelled = false
    void Promise.all(planned.map(async (entry) => ({
      entry,
      check: await api.checkStock(
        entry.recipeId as number, entry.servingsOverride ?? undefined, entry.id),
    })))
      .then((results) => { if (!cancelled) setShortfalls(weekShortfalls(results)) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [week])

  useEffect(() => loadShortfalls(), [loadShortfalls])

  return (
    <ScreenShell
      header={
        <KitchenHeader
          title="THE WEEK"
          meta={`${plannedCount(week, settings.visibleSlots)} PLANNED`}
        />
      }
      dock={<KitchenQuickRow active="Plan" />}
    >
      <ScrollArea>
        {/* Weeks move sideways, matching the baby panels — arrows either side of the range rather
            than a calendar. A month grid answers "which day is the 14th", which is not a question
            anyone asks while planning dinner. */}
        <div className="ml-kitchen__pager">
          <button
            type="button"
            className="ml-kitchen__pagerarrow"
            aria-label="The week before"
            onClick={() => setWeekStartKey(addPlanDays(weekStartKey, -7))}
          >
            ‹
          </button>
          <span className="ml-kitchen__pagercentre">
            <span className="ml-kitchen__pagerlabel serif">{weekLabel(weekStartKey)}</span>
            {/* Which week, in words — the range alone does not say whether you are looking at the
                one you are living in, which is the thing you most need to know before editing it. */}
            <span className="ml-kitchen__pagerwhen">{bearing.word}</span>
            {/* A four-segment ruler rather than a scrollbar: it says how far you have wandered from
                this week without implying the plan has an end. */}
            <span className="ml-kitchen__ruler" aria-hidden="true">
              {Array.from({ length: RULER_WEEKS }, (_, i) => (
                <span
                  key={i}
                  className={
                    'ml-kitchen__rulerseg'
                    + (i === bearing.index ? ' ml-kitchen__rulerseg--on' : '')
                  }
                />
              ))}
            </span>
          </span>
          <button
            type="button"
            className="ml-kitchen__pagerarrow"
            aria-label="The week after"
            onClick={() => setWeekStartKey(addPlanDays(weekStartKey, 7))}
          >
            ›
          </button>
        </div>

        {/* ---- Tonight, outside the list ---- */}
        {tonight && (
          <>
            <div className="ml-band">
              <span className="ml-band__label">TONIGHT · {shortWeekday(today)} {dayNumber(today)}</span>
            </div>
            <div className="ml-band-shade">
              <div className="ml-kitchen__tonightrow">
                <span className="ml-kitchen__leadtitle">
                  {tonight.recipeTitle ?? tonight.freeText}
                </span>
                <Verdict entry={tonight} />
              </div>
              <div className="ml-kitchen__tonightmeta">
                <span>
                  {[
                    tonight.servingsOverride != null ? `for ${tonight.servingsOverride}` : null,
                    tonightRecipe?.totalMinutes != null ? `${tonightRecipe.totalMinutes} min` : null,
                    timing && timing.lateBy <= 0 ? `start ${timing.start}` : null,
                  ].filter(Boolean).join(' · ')}
                </span>
                {tonight.recipeId != null && (
                  <button
                    type="button"
                    className="ml-kitchen__cook"
                    onClick={() => navigate(`/kitchen/cook/${tonight.recipeId}?entry=${tonight.id}`)}
                  >
                    COOK
                  </button>
                )}
              </div>
            </div>
          </>
        )}

        {/* ---- The rest. Sized to its content: no cut, no scroller. ---- */}
        <div className="ml-band">
          <span className="ml-band__label">THE REST</span>
          <span className="ml-band__meta">{rest.length} NIGHTS</span>
        </div>
        <div className="ml-band-shade">
          {rest.map((day) => (
            <NightRow
                key={day.date}
                day={day}
                recipes={recipes}
                turning={turning}
                // An empty night and a planned one are different questions: one asks what to
                // cook, the other asks about the thing already there.
                onOpen={() => navigate(
                  entriesFor(day, 'Dinner').length > 0
                    ? `/kitchen/plan/${day.date}`
                    : `/kitchen/plan/${day.date}/fill`,
                )}
                onFill={() => navigate(`/kitchen/plan/${day.date}/fill`)}
              />
          ))}
        </div>

        {/* ---- What the whole week is short of, collected once ---- */}
        {shortfalls.length > 0 && (
          <>
            <div className="ml-band ml-band--amber">
              <span className="ml-band__label">THE WEEK NEEDS</span>
              <span className="ml-band__meta">
                {shortfalls.length} {shortfalls.length === 1 ? 'THING' : 'THINGS'}
              </span>
            </div>
            <div className="ml-band-shade">
              {/* Named by thing, with the night that wants it beside — the band exists so the list
                  can be made in one pass, and a list of nights cannot be shopped from. */}
              {shortfalls.map((want) => (
                <div key={want.key} className="ml-row ml-kitchen__shelfrow">
                  <span className="ml-kitchen__shelfname">{want.name}</span>
                  <span className="ml-kitchen__shelfstate">{longWeekday(want.night.date)}</span>
                  <span className="ml-kitchen__shelfamount">{want.needed ?? '—'}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Both close the panel (PLAN_WEEK §1). Saving a week is how a plan that worked becomes one
            you can put back next month without rebuilding it night by night. */}
        <div className="ml-kitchen__errandrow">
          {/* Named from the range it covers rather than asking for one. A keyboard between the
              household and saving a week they liked is how the feature goes unused; the name is
              editable wherever saved weeks are listed. */}
          <button
            type="button"
            className="ml-kitchen__errandalt"
            disabled={saved}
            onClick={() => {
              setSaved(true)
              void api.saveWeek(weekLabel(weekStartKey), weekStartKey)
                .catch(() => setSaved(false))
            }}
          >
            {saved ? 'SAVED' : 'SAVE THIS WEEK'}
          </button>
          <button
            type="button"
            className="ml-kitchen__shop"
            onClick={() => navigate('/kitchen/list/review')}
          >
            WHAT WE NEED
          </button>
        </div>
      </ScrollArea>
    </ScreenShell>
  )
}

/**
 * One night in `THE REST`.
 *
 * **An empty night carries its own suggestion** — a bordered card naming what could fill it. That
 * card is why the section has no "what shall we cook" destination at all: the offer lives on the
 * night that needs it, where the question is actually being asked (PLAN_WEEK §1).
 *
 * The row is a `div` rather than a button because the empty state holds a second control, and a
 * button inside a button is not a thing the DOM will render.
 */
function NightRow({
  day, recipes, turning, onOpen, onFill,
}: {
  day: MealDayDto
  recipes: RecipeSummaryDto[]
  turning: ReadonlySet<number>
  onOpen: () => void
  onFill: () => void
}) {
  const entry = entriesFor(day, 'Dinner')[0] as MealPlanEntryDto | undefined
  const recipe = entry?.recipeId != null ? recipes.find((r) => r.id === entry.recipeId) : undefined
  const sub = entry ? nightLine(entry, recipe, turning) : null

  return (
    <div className="ml-row ml-kitchen__night">
      <span className="ml-kitchen__nightday">
        <span className="ml-kitchen__nightweekday">{shortWeekday(day.date)}</span>
        <span className="ml-kitchen__nightnumber">{dayNumber(day.date)}</span>
      </span>

      {entry ? (
        <button type="button" className="ml-kitchen__nightbody" onClick={onOpen}>
          <span className="ml-kitchen__rowtext">
            <span className="ml-row__value">{entry.recipeTitle ?? entry.freeText}</span>
            {sub && (
              <span className={`ml-kitchen__rowsub${sub.tone === 'good' ? ' ml-kitchen__rowsub--good' : ''}`}>
                {sub.text}
              </span>
            )}
          </span>
          <Verdict entry={entry} />
        </button>
      ) : (
        <span className="ml-kitchen__rowtext">
          <button type="button" className="ml-kitchen__nightempty" onClick={onOpen}>
            ＋ Nothing planned
          </button>
          <button type="button" className="ml-kitchen__suggest" onClick={onFill}>
            <span className="ml-kitchen__suggesttext">Something you could cook</span>
            <span className="ml-kitchen__chev">›</span>
          </button>
        </span>
      )}
    </div>
  )
}

/**
 * The one word.
 *
 * Amber is reserved for `SHORT` — the only one of the four that is actionable. `CAN'T SAY` in amber
 * would be telling the household to act on the thing the panel has just admitted it cannot work out.
 */
function Verdict({ entry }: { entry: MealPlanEntryDto }) {
  const word = stockWord(entry)
  if (!word) return null

  return (
    <span
      className={
        'ml-kitchen__verdict'
        + (stockNeedsAttention(entry.stockSummary) ? ' ml-kitchen__verdict--short' : '')
        + (entry.stockSummary === 'NoClaim' ? ' ml-kitchen__verdict--quiet' : '')
      }
    >
      {word}
    </span>
  )
}
