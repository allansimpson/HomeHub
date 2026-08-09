/**
 * Meals settings and the cuisine namespace.
 *
 * These are **household** settings, not per-profile (MEALS_DATA_CONTRACT §3.5): the recipe folder
 * and the week plan are shared by design, so "which slots the week shows" is a property of the
 * kitchen rather than of whoever last unlocked the panel. That is why nothing here is keyed by
 * profile id, unlike `todoPrefs`.
 *
 * localStorage rather than a server blob because there is no server-side settings surface for them
 * yet and none of it is worth a migration: the whole set is four values, and losing them degrades
 * to sensible defaults rather than to a broken screen.
 */
import type { MealSlotName, RecipeSummaryDto } from '../api/types'

const KEY = 'homehub.meals.settings.v1'

/** Folder sort, remembered per household (MEALS_BEHAVIOURS §6). */
export type FolderSort = 'not-lately' | 'cuisine' | 'tag' | 'az'

export interface MealsSettings {
  /**
   * Which slots the week screen, the assign segment and the counters show. Dinner is always
   * present — a meal planner that can be configured to plan no meals is a bug, not a preference —
   * and the settings screen renders its toggle locked for the same reason.
   */
  visibleSlots: MealSlotName[]
  /** `HH:MM`, 24-hour. The only input the start-by arithmetic needs. */
  dinnerTime: string
  /**
   * How many the household actually cooks for. Recipes open at this number and planned nights
   * default to it, whatever the source page's own yield was.
   *
   * **This never rewrites a recipe's `servings`.** That field means "what the amounts stored below
   * make", so a page whose amounts feed six keeps saying six — and the panel scales those amounts
   * live to this number instead, showing `SCALED FROM 6 → 8`. Stamping 8 onto the stored value
   * would leave six portions' worth of ingredients labelled as feeding eight, and every later
   * scale would compute off that false base. It would also break unevenly: a line the parser
   * couldn't read has no quantity to multiply, so it would sit at its original amount while every
   * line around it grew.
   */
  defaultServings: number
  /**
   * The household's spelling of each cuisine. Imports are matched onto this list so "Italy" and
   * "italian" don't become two groups in the folder.
   */
  canonicalCuisines: string[]
  /** Whether the Attendant offers the longest-uncooked recipe on the folder. */
  suggestUncooked: boolean
  folderSort: FolderSort
  /** Recipe id of the last Attendant suggestion that was dismissed, so it isn't offered straight back. */
  dismissedSuggestionId: number | null
}

/**
 * Breakfast off, lunch on, dinner on. Breakfast is the one most households never plan, and a row
 * of empty breakfast slots on every day of the week is noise that makes the screen look emptier
 * than the week actually is (DECISIONS.md).
 */
export const DEFAULT_MEALS_SETTINGS: MealsSettings = {
  visibleSlots: ['Lunch', 'Dinner'],
  dinnerTime: '18:30',
  defaultServings: 8,
  canonicalCuisines: [
    'Italian', 'Thai', 'Indian', 'Mexican', 'Chinese', 'Japanese',
    'French', 'Greek', 'Middle Eastern', 'British', 'American', 'Vietnamese',
  ],
  suggestUncooked: true,
  folderSort: 'not-lately',
  dismissedSuggestionId: null,
}

/** Every slot this UI writes, in the order they occur in a day. `Other` is never written. */
export const ALL_SLOTS: MealSlotName[] = ['Breakfast', 'Lunch', 'Dinner']

export function loadMealsSettings(): MealsSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULT_MEALS_SETTINGS
    const stored = JSON.parse(raw) as Partial<MealsSettings>
    return {
      ...DEFAULT_MEALS_SETTINGS,
      ...stored,
      // Re-derived rather than trusted: a hand-edited or half-migrated blob could otherwise hide
      // dinner, and every screen from the home tab down assumes dinner exists.
      visibleSlots: normaliseSlots(stored.visibleSlots),
    }
  } catch {
    return DEFAULT_MEALS_SETTINGS
  }
}

export function saveMealsSettings(settings: MealsSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings))
  } catch {
    /* storage full / unavailable — the defaults are a fine fallback */
  }
}

/** Keep only real slots, always include Dinner, and hold day order. */
function normaliseSlots(slots: MealSlotName[] | undefined): MealSlotName[] {
  const wanted = new Set(slots ?? DEFAULT_MEALS_SETTINGS.visibleSlots)
  wanted.add('Dinner')
  return ALL_SLOTS.filter((s) => wanted.has(s))
}

// ---- Cuisine: a reserved tag namespace, not a column (MEALS_DATA_CONTRACT §2) ----

export const CUISINE_PREFIX = 'cuisine:'

/**
 * The storage form of a cuisine name: lowercase, hyphenated, prefixed. `Middle Eastern`,
 * `middle eastern` and `MIDDLE-EASTERN` all land on `cuisine:middle-eastern`, which is the whole
 * point — one spelling each, so the folder groups by cuisine instead of by typing habit.
 */
export function cuisineTag(name: string): string {
  return CUISINE_PREFIX + name.trim().toLowerCase().replace(/\s+/g, '-')
}

/** The cuisine tag on a recipe, or null when it has none — the `UNCATEGORISED` case. */
export function cuisineOf(recipe: { tags: string[] }): string | null {
  return recipe.tags.find((t) => t.toLowerCase().startsWith(CUISINE_PREFIX)) ?? null
}

/**
 * Display form: strip the prefix and title-case. Matched back onto the household's canonical
 * spelling where one exists, so a recipe imported as `cuisine:middle-eastern` reads exactly as the
 * settings screen spells it rather than as this function's best guess at capitalisation.
 */
export function cuisineLabel(tag: string | null, canonical: string[] = []): string | null {
  if (!tag) return null
  const bare = tag.slice(CUISINE_PREFIX.length)
  const match = canonical.find((c) => cuisineTag(c) === tag)
  if (match) return match
  return bare
    .split('-')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
}

/** A recipe's plain (non-cuisine) tags — what the `TAG` sort and the search's tag chips use. */
export function plainTags(recipe: { tags: string[] }): string[] {
  return recipe.tags.filter((t) => !t.toLowerCase().startsWith(CUISINE_PREFIX))
}

/** The display cuisine for a summary row, or null. Convenience over the two calls above. */
export function cuisineNameOf(recipe: RecipeSummaryDto, canonical: string[]): string | null {
  return cuisineLabel(cuisineOf(recipe), canonical)
}
