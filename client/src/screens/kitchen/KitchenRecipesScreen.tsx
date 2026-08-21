import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { CutGroup, KitchenHeader, KitchenQuickRow, ScreenShell, ScrollArea } from '../../components'
import { api } from '../../api/client'
import { useMeals } from '../../app/MealsProvider'
import { cookedAgoLabel } from '../../app/mealsDomain'
import { cuisineNameOf } from '../../app/mealsPrefs'
import type { CookabilityDto, RecipeSummaryDto } from '../../api/types'

/**
 * RECIPES — the folder (RECIPES §1, panel R1).
 *
 * **Divided by cookability, not by cuisine.** That is the question people arrive with; alphabetical
 * and by-cuisine folders both make the reader do the sorting. Cuisine is how you *narrow*, which is
 * why it is a chip row filtering both bands rather than a tree you navigate.
 *
 * The two bands are `COOK IT TONIGHT` and `EVERYTHING ELSE`, and a recipe the panel cannot fully
 * read goes in the second reading `can't say` — never in the first. That single rule is what keeps
 * the ready band worth trusting at seven in the evening.
 */
/** A folder row carries two lines, so its cut is 56px rather than the shelves' 42 (RECIPES §6). */
const ROW_HEIGHT = 56

/** Rows visible before the cut, per band. */
const BAND_ROWS = 4

export function KitchenRecipesScreen() {
  const navigate = useNavigate()
  const { recipes, settings } = useMeals()
  const [standing, setStanding] = useState<Map<number, CookabilityDto>>(new Map())
  const [cuisine, setCuisine] = useState<string | null>(null)
  const [term, setTerm] = useState('')

  useEffect(() => {
    let cancelled = false
    void api.getCookable()
      .then((rows) => { if (!cancelled) setStanding(new Map(rows.map((r) => [r.recipeId, r]))) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  /**
   * Cuisine chips, **ordered by how much the household cooks each one** — never alphabetically.
   * The ones you use stay in reach as the folder grows; a cuisine cooked once sits at the far end.
   */
  const cuisines = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of recipes) {
      const name = cuisineNameOf(r, settings.canonicalCuisines)
      if (!name) continue
      counts.set(name, (counts.get(name) ?? 0) + Math.max(1, r.timesCooked))
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [recipes, settings.canonicalCuisines])

  // Cuisine narrows; the search narrows further. Neither changes the structure — both bands stay,
  // because the question the folder answers is "can we cook it", not "what is it called".
  const needle = term.trim().toLowerCase()
  const shown = recipes
    .filter((r) => cuisine == null || cuisineNameOf(r, settings.canonicalCuisines) === cuisine)
    .filter((r) => needle === '' || r.title.toLowerCase().includes(needle))
  const ready = shown.filter((r) => standing.get(r.id)?.band === 'Ready')
  const rest = shown.filter((r) => standing.get(r.id)?.band !== 'Ready')

  return (
    <ScreenShell
      header={<KitchenHeader title="RECIPES" meta={`${recipes.length}`} />}
      dock={<KitchenQuickRow active="Recipes" counts={{ recipes: `${recipes.length}` }} />}
    >
      <ScrollArea>
        {/* Search and a single brass ＋ — the one door to the add errand (RECIPES §1). */}
        <div className="ml-kitchen__searchrow">
          <label className="ml-kitchen__search">
            <span className="ml-kitchen__searchglyph" aria-hidden="true">⌕</span>
            <input
              type="search"
              className="ml-kitchen__searchfield"
              placeholder="Search the folder"
              aria-label="Search the folder"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="ml-kitchen__plus"
            aria-label="Add a recipe"
            onClick={() => navigate('/kitchen/recipes/add')}
          >
            ＋
          </button>
        </div>

        {/* Side-scrolling and counted. It takes new cuisines at their earned position — no tree,
            no picker, and no "+N" that hides the tail. */}
        <div className="ml-kitchen__chips ml-cut" data-hscroll>
          <button
            type="button"
            className={`ml-kitchen__chip${cuisine == null ? ' ml-kitchen__chip--on' : ''}`}
            onClick={() => setCuisine(null)}
          >
            ALL {recipes.length}
          </button>
          {cuisines.map(([name]) => (
            <button
              key={name}
              type="button"
              className={`ml-kitchen__chip${cuisine === name ? ' ml-kitchen__chip--on' : ''}`}
              onClick={() => setCuisine(cuisine === name ? null : name)}
            >
              {name.toUpperCase()} {recipes.filter((r) => cuisineNameOf(r, settings.canonicalCuisines) === name).length}
            </button>
          ))}
        </div>

        <div className="ml-band">
          <span className="ml-band__label">COOK IT TONIGHT</span>
          <span className="ml-band__meta">{ready.length} READY</span>
        </div>
        {ready.length === 0 ? (
          // Not an error, and not a telling-off: early on, before the alias table is dense, this
          // band is legitimately empty and the folder still works.
          <div className="ml-band-shade">
            <div className="ml-kitchen__emptyshelf">Nothing is fully accounted for yet.</div>
          </div>
        ) : (
          <CutGroup rows={BAND_ROWS} rowHeight={ROW_HEIGHT} className="ml-band-shade">
            {ready.map((r) => (
              <RecipeRow key={r.id} recipe={r} standing={standing.get(r.id)}
                canonical={settings.canonicalCuisines} onOpen={() => navigate(`/kitchen/recipes/${r.id}`)} />
            ))}
          </CutGroup>
        )}

        <div className="ml-band">
          <span className="ml-band__label">EVERYTHING ELSE</span>
          <span className="ml-band__meta">{rest.length}</span>
        </div>
        <CutGroup rows={BAND_ROWS} rowHeight={ROW_HEIGHT} className="ml-band-shade">
          {rest.map((r) => (
            <RecipeRow key={r.id} recipe={r} standing={standing.get(r.id)}
              canonical={settings.canonicalCuisines} onOpen={() => navigate(`/kitchen/recipes/${r.id}`)} />
          ))}
        </CutGroup>
      </ScrollArea>
    </ScreenShell>
  )
}

/**
 * One folder row: the name, one line of why it is here, and the time.
 *
 * The second line is the whole reason the folder is worth reading. In the ready band it is the
 * recipe's own context; in `EVERYTHING ELSE` it is **what stands in the way** — `3 things short`, or
 * `can't say` for a recipe whose lines never matched.
 */
function RecipeRow({
  recipe, standing, canonical, onOpen,
}: {
  recipe: RecipeSummaryDto
  standing?: CookabilityDto
  /** The household's canonical cuisine list — "Italy" and "Italian" must not become two groups. */
  canonical: string[]
  onOpen: () => void
}) {
  const why = (): { text: string; tone: 'quiet' | 'short' | 'cantsay' } => {
    if (standing?.band === 'Short') {
      const n = standing.shortCount
      return { text: n === 1 ? '1 thing short' : `${n} things short`, tone: 'short' }
    }
    if (standing?.band === 'CantSay') {
      return { text: "can't say", tone: 'cantsay' }
    }
    return {
      text: [cuisineNameOf(recipe, canonical), cookedAgoLabel(recipe.lastCookedDate)].filter(Boolean).join(' · '),
      tone: 'quiet',
    }
  }

  const reason = why()

  return (
    <button type="button" className="ml-row ml-kitchen__recipe" onClick={onOpen}>
      <span className="ml-kitchen__recipetext">
        <span className="ml-kitchen__recipename">{recipe.title}</span>
        <span className={`ml-kitchen__recipewhy ml-kitchen__recipewhy--${reason.tone}`}>
          {reason.text}
        </span>
      </span>
      {recipe.totalMinutes != null && (
        <span className="ml-kitchen__recipetime">{recipe.totalMinutes} min</span>
      )}
    </button>
  )
}
