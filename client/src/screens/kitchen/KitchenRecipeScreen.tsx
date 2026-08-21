import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { CutGroup, DrillInHeader, ScreenShell, ScrollArea } from '../../components'
import { api } from '../../api/client'
import { useMeals } from '../../app/MealsProvider'
import { cookedAgoLabel, cookedCountLabel } from '../../app/mealsDomain'
import { isFlagged } from '../../app/pantryDomain'
import { isBuyable, stockVerdict } from '../../app/kitchenDomain'
import { cuisineLabel, cuisineOf } from '../../app/mealsPrefs'
import type { RecipeDto, StockCheckDto } from '../../api/types'

/**
 * A RECIPE OPENED (RECIPES §2, panel R2).
 *
 * **The photo strip sits above the ingredients**, which is not the obvious order. A photograph of
 * the finished dish is the fastest way to recognise something you have cooked before — faster than
 * a title and far faster than an ingredient list — so it outranks both. Photos can be taken at any
 * point, including at the end of cooking, which is when the dish actually exists.
 *
 * **`WHAT IT NEEDS` uses the same one word as the week** (`ALL IN` / `n SHORT`), so the recipe and
 * the planner can never be caught disagreeing about the same pantry.
 *
 * **`about` can never read as short.** Estimated stock renders in the quiet brass and stays out of
 * the shortfall count, because the panel does not know how much is in the jar.
 */
export function KitchenRecipeScreen() {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const { recipes, settings } = useMeals()

  const [recipe, setRecipe] = useState<RecipeDto | null>(null)
  const [check, setCheck] = useState<StockCheckDto | null>(null)

  const load = useCallback(() => {
    if (!id) return
    void api.getRecipe(Number(id)).then(setRecipe).catch(() => {})
    void api.checkStock(Number(id)).then((c) => setCheck(c ?? null)).catch(() => {})
  }, [id])

  useEffect(load, [load])

  if (!recipe) {
    return (
      <ScreenShell header={<DrillInHeader title="" onBack={() => navigate('/kitchen/recipes')} />}>
        <div className="ml-kitchen__emptyshelf">That recipe is not here.</div>
      </ScreenShell>
    )
  }

  const summary = recipes.find((r) => r.id === recipe.id)
  const lines = check?.lines ?? []
  const short = lines.filter((l) => isBuyable(l.status))
  // Lines that match nothing on the shelves. A different fact from being short, and the reason the
  // recipe stays out of `cook it tonight` rather than being guessed about.
  const unmatched = lines.filter((l) => l.status === 'NoMatch')
  const word = stockVerdict(short.length, unmatched.length)

  return (
    <ScreenShell
      header={
        <DrillInHeader
          // The cuisine, not the title. The dish gets the page's own heading below, where it can
          // carry the source-and-servings line with it; repeating it in the header would spend the
          // one slot that tells you which shelf of the folder you are on (RECIPES §2).
          title={
            // `cuisineOf` takes the tags, so this works on the full recipe rather than needing the
            // folder's summary — a recipe opened by link may not be in that list at all.
            cuisineLabel(cuisineOf(recipe), settings.canonicalCuisines)?.toUpperCase() ?? 'RECIPE'
          }
          onBack={() => navigate('/kitchen/recipes')}
          backLabel="BACK"
        />
      }
    >
      <ScrollArea>
        <div className="ml-kitchen__sheetname">{recipe.title}</div>
        <div className="ml-kitchen__meta">
          {[
            recipe.sourceName,
            recipe.servings != null && `SERVES ${recipe.servings}`,
            recipe.totalMinutes != null && `${recipe.totalMinutes} MIN`,
            summary && cookedCountLabel(summary.timesCooked).toUpperCase(),
          ].filter(Boolean).join(' · ')}
        </div>
        {summary && (
          <div className="ml-kitchen__askwhy">Last made {cookedAgoLabel(summary.lastCookedDate)}.</div>
        )}

        {/*
          Above the ingredients on purpose. Recognition beats enumeration — you know the dish from
          the photograph before you have read a single line of it.
        */}
        <div className="ml-band ml-band--quiet">
          <span className="ml-band__label">MADE IT LOOK LIKE THIS</span>
        </div>
        <div className="ml-kitchen__photostrip" data-hscroll>
          {recipe.hasImage && (
            <img
              className="ml-kitchen__photo"
              src={api.recipeImageUrl(recipe.id)}
              alt=""
            />
          )}
          <button
            type="button"
            className="ml-kitchen__photoadd"
            aria-label="Add a photo of the finished dish"
            onClick={() => navigate(`/meals/recipes/${recipe.id}/edit`)}
          >
            ＋
          </button>
        </div>
        {/* Says what the strip is for, and what the first one does. Without it the promotion rule
            is invisible — somebody reorders photos and the folder card changes for no stated reason. */}
        <div className="ml-kitchen__photocaption">
          Photos of the finished dish. The first one is on the card.
        </div>

        {/*
          `CAN'T SAY YET` (MATCHING_AND_ALIASES §1, panel M1).
          Stated above the ingredients, and stated as a *reason*: four lines match nothing, so the
          recipe stays out of `cook it tonight` rather than being guessed about.
        */}
        {unmatched.length > 0 && (
          <>
            <div className="ml-band ml-band--amber">
              <span className="ml-band__label">CAN'T SAY YET</span>
              <span className="ml-band__meta">{unmatched.length} OF {lines.length}</span>
            </div>
            <div className="ml-band-shade">
              <div className="ml-kitchen__askwhy">
                {unmatched.length === 1 ? 'One line matches' : `${unmatched.length} lines match`}
                {' '}nothing on the shelves, so this stays out of <em>cook it tonight</em>.
              </div>
              {/* The fix, priced. An unpriced chore does not get done. */}
              <div className="ml-kitchen__errandrow">
                {/* Named, because the errand asks about one line at a time and arrives with no
                    ingredient to ask about at all if it is not told which. The first unmatched line
                    is the one to start on; sorting it brings you back here with one fewer. */}
                <button
                  type="button"
                  className="ml-kitchen__errandalt"
                  onClick={() => navigate(
                    `/kitchen/matching/sort?ingredient=${encodeURIComponent(unmatched[0].name)}`,
                  )}
                >
                  SORT THE {unmatched.length}
                </button>
                <span className="ml-kitchen__askwhy">about a minute, and it never asks again</span>
              </div>
              {/*
                Somebody who does not understand the caution will read it as a bug, so the reasoning
                is on the screen rather than in a decision record.
              */}
              <div className="ml-kitchen__askwhy">
                <strong>Why not just guess?</strong> A guess that is wrong takes something off a
                shelf that is still there, and nothing afterwards knows it was a guess.
              </div>
            </div>
          </>
        )}

        <div className={'ml-band' + (short.length > 0 ? ' ml-band--amber' : '')}>
          <span className="ml-band__label">WHAT IT NEEDS</span>
          <span className="ml-band__meta">{word}</span>
        </div>
        {/* 42px ingredient rows, 46px numbered steps — each group's cut derives from its own row
            height. Reusing one panel's height on another puts the cut in the padding (RECIPES §6). */}
        <CutGroup rows={7} rowHeight={42} className="ml-band-shade">
          {recipe.ingredients.map((ing) => {
            // Paired by id, not by name. A line the parser could not name has a null `name`, so
            // matching on it would pair every unparsed ingredient with the first other unparsed
            // one — and a recipe naming butter twice would put one verdict on both rows.
            const line = lines.find((l) => l.ingredientId === ing.id)
            const flagged = line != null && isFlagged(line.status)
            const estimated = line?.lastSeenState != null
            return (
              <div
                key={ing.id}
                className={'ml-row ml-kitchen__ingrow' + (flagged && !estimated ? ' ml-kitchen__ingrow--short' : '')}
              >
                <span className="ml-kitchen__shelfname">{ing.name ?? ing.rawText}</span>
                {/* Unmatched reads `can't say` in amber; matched reads `on the shelf` in teal. The
                    two are different facts and the row must not blur them. */}
                {line && (
                  <span
                    className={
                      line.status === 'NoMatch'
                        ? 'ml-kitchen__ingstate ml-kitchen__ingstate--cantsay'
                        : 'ml-kitchen__ingstate ml-kitchen__ingstate--onshelf'
                    }
                  >
                    {line.status === 'NoMatch' ? "can't say" : 'on the shelf'}
                  </span>
                )}
                {/* Right-aligned in the mono column; `about` in the quiet brass. */}
                <span
                  className={
                    'ml-kitchen__ingamount'
                    + (estimated ? ' ml-kitchen__shelfamount--about' : '')
                  }
                >
                  {estimated ? 'about' : [ing.quantity, ing.unit].filter(Boolean).join(' ')}
                </span>
              </div>
            )
          })}
        </CutGroup>

        <div className="ml-band">
          <span className="ml-band__label">HOW IT GOES</span>
          <span className="ml-band__meta">{recipe.steps.length}</span>
        </div>
        <CutGroup rows={4} rowHeight={46} className="ml-band-shade">
          {recipe.steps.map((s, i) => (
            <div key={s.id} className="ml-row ml-kitchen__stepline">
              <span className="ml-kitchen__stepnum">{i + 1}</span>
              <span className="ml-kitchen__steplinetext">{s.text}</span>
            </div>
          ))}
        </CutGroup>
      </ScrollArea>

      <div className="ml-kitchen__errandactions">
        <div className="ml-kitchen__errandrow">
          {/* Both still work with lines unmatched. Uncertainty restricts ranking, never access. */}
          <button
            type="button"
            className="ml-kitchen__errandalt"
            onClick={() => navigate('/kitchen/plan')}
          >
            PUT IT ON A NIGHT
          </button>
          <button
            type="button"
            className="ml-kitchen__shop"
            onClick={() => navigate(`/kitchen/cook/${recipe.id}`)}
          >
            COOK IT NOW
          </button>
        </div>
      </div>
    </ScreenShell>
  )
}
