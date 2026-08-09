import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { ScrollArea } from '../../components'
import { api } from '../../api/client'
import type { RecipeDto } from '../../api/types'
import { diffIngredients } from './recipeDiff'
import { MealsLabel, MealsModal, RuleLine } from './parts'

/**
 * The read-only diff (MEALS_FORK §4.3), route `/meals/recipes/:id/diff`.
 *
 * Both values are muted here, unlike the naming sheet's version where the new value is brass:
 * **nothing is "new" when you are comparing two recipes that both already exist.** They are simply
 * two versions, and colouring one as the change would be taking a side.
 */
export function RecipeDiffScreen() {
  const navigate = useNavigate()
  const { id } = useParams()

  const [pair, setPair] = useState<{ child: RecipeDto; parent: RecipeDto } | null>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const child = await api.getRecipe(Number(id))
      if (child.forkedFrom == null) { if (!cancelled) setMissing(true); return }
      try {
        const parent = await api.getRecipe(child.forkedFrom)
        if (!cancelled) setPair({ child, parent })
      } catch {
        // The parent has been deleted. There is nothing to compare against, and saying so is the
        // honest answer rather than rendering an empty diff that looks like "no differences".
        if (!cancelled) setMissing(true)
      }
    })()
    return () => { cancelled = true }
  }, [id])

  const close = () => navigate(-1)

  if (missing) {
    return (
      <MealsModal title="HOW THEY DIFFER" onCancel={close} cancelLabel="CLOSE">
        <p className="ml-fork__safe">
          The recipe this was a version of is gone, so there is nothing left to compare it with.
          This one is unaffected.
        </p>
      </MealsModal>
    )
  }

  if (!pair) {
    return <MealsModal title="HOW THEY DIFFER" onCancel={close} cancelLabel="CLOSE"><div /></MealsModal>
  }

  const { child, parent } = pair
  const diffs = diffIngredients(parent, child)
  const same = child.ingredients.length - diffs.filter((d) => d.from !== null && d.to !== null).length

  return (
    <MealsModal title="HOW THEY DIFFER" onCancel={close} cancelLabel="CLOSE">
      <ScrollArea>
        <div className="ml-diff__heads">
          <span className="ml-diff__head">{parent.title}</span>
          <span className="ml-diff__arrow">→</span>
          <span className="ml-diff__head ml-diff__head--mine">{child.title}</span>
        </div>

        <MealsLabel
          label="HOW THEY DIFFER"
          status={`${diffs.length} LINE${diffs.length === 1 ? '' : 'S'}`}
        />
        {diffs.length === 0 ? (
          <p className="ml-fork__safe">
            The amounts are identical. The difference is in the name only.
          </p>
        ) : (
          <div className="ml-fork__diff">
            {diffs.map((d, i) => (
              <div className="ml-fork__diffrow" key={i}>
                <span className="ml-fork__diffname">{d.name}</span>
                <span className="ml-diff__was mono">{d.from ?? 'not in it'}</span>
                <span className="ml-fork__arrow">→</span>
                <span className="ml-diff__now mono">{d.to ?? 'dropped'}</span>
              </div>
            ))}
          </div>
        )}

        {/* Naming what is identical, so the diff is a comparison rather than a list of complaints. */}
        <p className="ml-fork__safe">
          {`Everything else matches: the steps, ${parent.sourceName ? `the source (${parent.sourceName}), ` : ''}`
            + `the cuisine and the tags${same > 0 ? `, and ${same} ingredient line${same === 1 ? '' : 's'}` : ''}.`}
        </p>

        <RuleLine>DELETING EITHER ONE LEAVES THE OTHER UNTOUCHED</RuleLine>
      </ScrollArea>
    </MealsModal>
  )
}
