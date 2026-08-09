/**
 * Pantry preferences.
 *
 * **Per profile, unlike `mealsPrefs`** — and the difference is deliberate. The recipe folder and the
 * week plan are the household's, so "which slots the week shows" belongs to the kitchen. Which
 * shelf you were last looking at belongs to *you*: the person who does the freezer stocktake and
 * the person who checks the fridge before shopping want different defaults, and inheriting the
 * other's is a small daily annoyance (PANTRY_SCREEN §1.4 requires it persists per profile).
 *
 * localStorage rather than a server column because losing it degrades to `ALL`, which is a fine
 * screen — not worth a migration.
 */
export type LocationFilter = 'All' | 'Cupboard' | 'Fridge' | 'Freezer'

export interface PantryPrefs {
  filter: LocationFilter
}

const KEY = 'homehub.pantry.prefs.v1'

export const DEFAULT_PANTRY_PREFS: PantryPrefs = { filter: 'All' }

const VALID: LocationFilter[] = ['All', 'Cupboard', 'Fridge', 'Freezer']

/** Signed out is its own slot rather than an error — the panel is usable before anyone unlocks it. */
function slot(profileId: number | null | undefined): string {
  return `${KEY}.${profileId ?? 'anon'}`
}

export function loadPantryPrefs(profileId: number | null | undefined): PantryPrefs {
  try {
    const raw = window.localStorage.getItem(slot(profileId))
    if (!raw) return DEFAULT_PANTRY_PREFS
    const parsed = JSON.parse(raw) as Partial<PantryPrefs>
    // Validated rather than trusted: a value written by an older build (or by hand) must not leave
    // the segment with no cell selected, which would look like a rendering bug.
    return {
      filter: parsed.filter && VALID.includes(parsed.filter) ? parsed.filter : DEFAULT_PANTRY_PREFS.filter,
    }
  } catch {
    return DEFAULT_PANTRY_PREFS
  }
}

export function savePantryPrefs(profileId: number | null | undefined, prefs: PantryPrefs): void {
  try {
    window.localStorage.setItem(slot(profileId), JSON.stringify(prefs))
  } catch {
    // A full or disabled localStorage costs the household a remembered segment, nothing more.
  }
}
