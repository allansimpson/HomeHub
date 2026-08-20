import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api, ApiError } from '../api/client'
import type {
  AssignMealInput,
  CoOccurrenceDto,
  MealEatenInput,
  MealPlanInput,
  MealSlotName,
  MealSummaryDto,
  MealWeekDto,
  RecipeSummaryDto,
  RecipeTagCountDto,
} from '../api/types'
import { useWriteQueue } from './WriteQueueProvider'
import { useSession } from './SessionProvider'
import { entryFor, planKey, weekStart } from './mealsDomain'
import { loadMealsSettings, saveMealsSettings, type MealsSettings } from './mealsPrefs'

/**
 * The Meals section's shared state: the week being viewed, the recipe folder, the tag counts, and
 * the household settings.
 *
 * One provider for the whole section rather than a fetch per screen, because the screens overlap
 * constantly — the home tab needs tonight's entry *and* the recipe behind it, the folder marks
 * rows planned for tonight from the same week the planner shows, and the assign modal picks from
 * the same folder list the folder screen renders. Fetching those separately would have three
 * screens disagreeing about the same night.
 *
 * **Cached reads stay visible** (MEALS_BEHAVIOURS §1). A failed refresh sets `offline` and keeps
 * the last good data on screen; no screen in this section shows a spinner as its primary state,
 * because a stale week is more use on a wall panel than an empty one.
 */
interface MealsState {
  /** The seven days currently being viewed. Null only before the very first response. */
  week: MealWeekDto | null
  /** Monday of the viewed week, `YYYY-MM-DD`. */
  weekStartKey: string
  /** Move the viewed week. Session-only state — the panel reopens on the current week. */
  setWeekStartKey: (key: string) => void
  recipes: RecipeSummaryDto[]
  /** Saved meals — folder items alongside recipes, on the same list and the same sort. */
  meals: MealSummaryDto[]
  /** Sets cooked together often enough to offer naming. Confirmed nights only. */
  coOccurrences: CoOccurrenceDto[]
  tags: RecipeTagCountDto[]
  loading: boolean
  offline: boolean
  settings: MealsSettings
  updateSettings: (patch: Partial<MealsSettings>) => void
  refresh: () => Promise<void>
  /** Assign a slot. Optimistic, queued when offline. */
  planMeal: (input: MealPlanInput) => Promise<void>
  /** Empty a slot — the whole arrangement. Optimistic, queued when offline. */
  clearMeal: (date: string, slot: MealSlotName) => Promise<void>
  /** Take one dish off a night, leaving the rest. */
  removeEntry: (entryId: number) => Promise<void>
  /** Expand a saved meal onto a night, replacing whatever was there. */
  assignSavedMeal: (input: AssignMealInput) => Promise<void>
  /** Answer the morning-after ask. The only writer of `wasEaten`. */
  setEaten: (input: MealEatenInput) => Promise<void>
}

const MealsContext = createContext<MealsState | null>(null)

/**
 * Two minutes. The plan changes at human speed — someone deciding what to cook — so this is about
 * catching a phone's edit, not about liveness.
 */
const POLL_MS = 2 * 60_000

export function MealsProvider({ children }: { children: ReactNode }) {
  const { run } = useWriteQueue()
  const { activeProfileId } = useSession()
  const [weekStartKey, setWeekStartKey] = useState(() => planKey(weekStart(new Date())))
  const [week, setWeek] = useState<MealWeekDto | null>(null)
  const [recipes, setRecipes] = useState<RecipeSummaryDto[]>([])
  const [meals, setMeals] = useState<MealSummaryDto[]>([])
  const [coOccurrences, setCoOccurrences] = useState<CoOccurrenceDto[]>([])
  const [tags, setTags] = useState<RecipeTagCountDto[]>([])
  const [loading, setLoading] = useState(true)
  const [offline, setOffline] = useState(false)
  const [settings, setSettings] = useState<MealsSettings>(loadMealsSettings)

  // The week key the in-flight fetch was issued for. Paging quickly can land an older response
  // after a newer one, which would show last week's plan under this week's header.
  const wanted = useRef(weekStartKey)
  wanted.current = weekStartKey

  const refresh = useCallback(async () => {
    const forKey = weekStartKey
    try {
      const [nextWeek, nextRecipes, nextMeals, nextTags, nextPairs] = await Promise.all([
        api.getMealWeek(forKey),
        api.getRecipes(),
        api.getMeals(),
        api.getRecipeTags(),
        api.getCoOccurrences(),
      ])
      if (wanted.current === forKey) setWeek(nextWeek)
      setRecipes(nextRecipes)
      setMeals(nextMeals)
      setTags(nextTags)
      setCoOccurrences(nextPairs)
      setOffline(false)
    } catch (err) {
      // Keep whatever is on screen. The app-level reconnect bar already says the panel is offline;
      // blanking the week to say it again would cost the one thing still worth looking at.
      if (err instanceof ApiError) setOffline(true)
      else throw err
    } finally {
      setLoading(false)
    }
  }, [weekStartKey])

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      if (!cancelled) await refresh()
    }
    void tick()
    const id = window.setInterval(tick, POLL_MS)
    const onSync = () => void refresh()
    window.addEventListener('homehub:sync', onSync)
    return () => {
      cancelled = true
      window.clearInterval(id)
      window.removeEventListener('homehub:sync', onSync)
    }
  }, [refresh])

  const updateSettings = useCallback((patch: Partial<MealsSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      saveMealsSettings(next)
      return next
    })
  }, [])

  /**
   * Apply a plan change locally before the write leaves, so tapping a night feels instant
   * (MEALS_BEHAVIOURS §1). `entry` null removes the slot.
   */
  const applyLocally = useCallback((date: string, slot: MealSlotName, patch: Partial<MealPlanEntryLike> | null) => {
    setWeek((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        days: prev.days.map((day) => {
          if (day.date !== date) return day
          const existing = entryFor(day, slot)
          if (patch === null) return { ...day, entries: day.entries.filter((e) => e.slot !== slot) }
          const merged = {
            // A slot that had nothing gets a placeholder id and version; the refresh that follows
            // replaces it with the server's. Negative so it can never collide with a real row.
            id: existing?.id ?? -1,
            date,
            slot,
            recipeId: null,
            recipeTitle: null,
            recipeHasImage: false,
            freeText: null,
            servingsOverride: null,
            wasEaten: null,
            // A slot the panel is filling optimistically is being replaced, so the entry is the
            // main at position 0 until the refresh says otherwise. Adding a *second* dish is not
            // applied optimistically — see removeEntry for why guessing an arrangement is worse
            // than a beat of latency.
            position: 0,
            role: 'Main' as const,
            totalMinutes: null,
            // Deliberately null rather than carried over from `existing`: the night just changed,
            // so whatever it used to say about stock is about a different night's worth of
            // ingredients. The refresh that follows brings the re-settled word (KITCHEN_LOOP_ADDENDUM
            // §1), and until then the row simply says nothing — which is the honest state and the
            // one the pantry's advisory posture calls for.
            stockSummary: null,
            version: existing?.version ?? 0,
            ...existing,
            ...patch,
          }
          return {
            ...day,
            entries: [...day.entries.filter((e) => e.slot !== slot), merged].sort(
              (a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot),
            ),
          }
        }),
      }
    })
  }, [])

  const planMeal = useCallback(
    async (input: MealPlanInput) => {
      const existing = week?.days.find((d) => d.date === input.date)
      const current = existing ? entryFor(existing, input.slot) : undefined
      applyLocally(input.date, input.slot, {
        recipeId: input.recipeId ?? null,
        recipeTitle: input.recipeId
          ? (recipes.find((r) => r.id === input.recipeId)?.title ?? current?.recipeTitle ?? null)
          : null,
        freeText: input.freeText ?? null,
        servingsOverride: input.servingsOverride ?? null,
        // Re-planning onto a different dish drops the answer, matching what the server does — so
        // the optimistic view and the reconciled one agree instead of flickering.
        wasEaten:
          current && current.recipeId === (input.recipeId ?? null) && current.freeText === (input.freeText ?? null)
            ? current.wasEaten
            : null,
      })
      await run({
        domain: 'meal',
        method: 'PUT',
        path: '/meals/plan',
        // Stamped here rather than at each call site, so every path that plans a night — the assign
        // modal, the week screen, the confirm sheet's "move it" — attributes identically.
        body: { ...input, profileId: input.profileId ?? activeProfileId },
        baseVersion: current?.version,
        label: `${input.slot} on ${input.date}`,
      })
      await refresh()
    },
    [week, recipes, applyLocally, run, refresh, activeProfileId],
  )

  const clearMeal = useCallback(
    async (date: string, slot: MealSlotName) => {
      const day = week?.days.find((d) => d.date === date)
      const current = day ? entryFor(day, slot) : undefined
      applyLocally(date, slot, null)
      await run({
        domain: 'meal',
        method: 'DELETE',
        path: `/meals/plan?date=${date}&slot=${slot}`,
        baseVersion: current?.version,
        label: `Clear ${slot} on ${date}`,
      })
      await refresh()
    },
    [week, applyLocally, run, refresh],
  )

  /**
   * Remove one dish from a night. Not optimistic: the arrangement's positions and roles are
   * re-packed server-side (dropping the main promotes the next dish), and guessing that locally
   * would show a night the server is about to disagree with.
   */
  const removeEntry = useCallback(
    async (entryId: number) => {
      await run({
        domain: 'meal',
        method: 'DELETE',
        path: `/meals/plan/entry/${entryId}`,
        label: 'Remove a dish',
      })
      await refresh()
    },
    [run, refresh],
  )

  const assignSavedMeal = useCallback(
    async (input: AssignMealInput) => {
      await run({
        domain: 'meal',
        method: 'POST',
        path: `/meals/saved/${input.mealId}/assign`,
        body: input,
        label: `Meal on ${input.date}`,
      })
      await refresh()
    },
    [run, refresh],
  )

  const setEaten = useCallback(
    async (input: MealEatenInput) => {
      applyLocally(input.date, input.slot, { wasEaten: input.wasEaten })
      // No baseVersion: the question has one true answer, so there is nothing here worth prompting
      // a conflict over (see MealsController.Eaten).
      await run({
        domain: 'meal',
        method: 'PUT',
        path: '/meals/plan/eaten',
        body: input,
        label: `Confirm ${input.slot} on ${input.date}`,
      })
      await refresh()
    },
    [applyLocally, run, refresh],
  )

  const value = useMemo<MealsState>(
    () => ({
      week, weekStartKey, setWeekStartKey, recipes, meals, coOccurrences, tags, loading, offline,
      settings, updateSettings, refresh, planMeal, clearMeal, removeEntry, assignSavedMeal, setEaten,
    }),
    [week, weekStartKey, recipes, meals, coOccurrences, tags, loading, offline, settings, updateSettings,
      refresh, planMeal, clearMeal, removeEntry, assignSavedMeal, setEaten],
  )

  return <MealsContext.Provider value={value}>{children}</MealsContext.Provider>
}

const SLOT_ORDER: MealSlotName[] = ['Breakfast', 'Lunch', 'Dinner', 'Other']

/** The shape `applyLocally` merges into; a plan entry without the server-assigned fields. */
type MealPlanEntryLike = {
  recipeId: number | null
  recipeTitle: string | null
  freeText: string | null
  servingsOverride: number | null
  wasEaten: boolean | null
}

// eslint-disable-next-line react-refresh/only-export-components
export function useMeals(): MealsState {
  const ctx = useContext(MealsContext)
  if (!ctx) throw new Error('useMeals must be used within a MealsProvider')
  return ctx
}
