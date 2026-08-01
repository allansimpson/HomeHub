import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ScrollArea } from '../../components'
import { Icon } from '../../icons/Icon'
import { api } from '../../api/client'
import { useSession } from '../../app/SessionProvider'
import { useMeals } from '../../app/MealsProvider'
import { durationLabel } from '../../app/mealsDomain'
import type { MealRoleName } from '../../api/types'
import { MealsLabel, MealsModal, RuleLine } from './parts'

/**
 * Create a meal deliberately (MEALS_GROUPS §1, the first of the two creation routes).
 *
 * The other route is emergent — cook the same pairing three times and the assign screen offers to
 * name it. Both exist equally: this one is for a pairing someone already knows they want, and
 * nothing about it is required before a night can hold two recipes.
 */
export function NewMealScreen() {
  const navigate = useNavigate()
  const { activeProfileId } = useSession()
  const { recipes, settings, refresh } = useMeals()

  const [name, setName] = useState('')
  const [picked, setPicked] = useState<number[]>([])
  const [saving, setSaving] = useState(false)

  const close = () => navigate(-1)
  const live = recipes.filter((r) => !r.isArchived)

  const toggle = (id: number) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  const create = async () => {
    if (!name.trim() || picked.length === 0 || saving) return
    setSaving(true)
    try {
      const created = await api.createMeal({
        name: name.trim(),
        // Order of picking is the order of the meal, and the first pick is the main. That is the
        // same rule as building a night by hand, so the two routes cannot disagree.
        components: picked.map((recipeId, i) => ({
          recipeId,
          role: (i === 0 ? 'Main' : 'Side') as MealRoleName,
        })),
        servings: settings.defaultServings,
        modifiedByProfileId: activeProfileId,
      })
      await refresh()
      navigate(`/meals/meals/${created.id}`, { replace: true })
    } finally {
      setSaving(false)
    }
  }

  return (
    <MealsModal
      title="NEW MEAL"
      onCancel={close}
      confirm={
        <button
          type="button"
          className="ml-edit__save"
          disabled={!name.trim() || picked.length === 0 || saving}
          onClick={() => void create()}
        >
          SAVE
        </button>
      }
    >
      <ScrollArea>
        <MealsLabel label="WHAT IS IT CALLED" />
        <input
          className="ml-add__field"
          value={name}
          placeholder="Spaghetti Night"
          aria-label="Meal name"
          onChange={(e) => setName(e.target.value)}
        />

        <MealsLabel
          label="WHAT'S IN IT"
          status={picked.length > 0 ? `${picked.length} PICKED` : undefined}
        />
        <RuleLine>THE FIRST ONE YOU PICK IS THE MAIN · THE REST ARE SIDES, CHANGEABLE AFTER</RuleLine>

        <div className="ml-assign__list">
          {live.length === 0 ? (
            <p className="ml-assign__nofolder">
              There are no recipes yet. A meal is made of them, so add a couple first.
            </p>
          ) : (
            live.map((r) => {
              const at = picked.indexOf(r.id)
              return (
                <button
                  key={r.id}
                  type="button"
                  className={'ml-assign__row' + (at >= 0 ? ' ml-assign__row--selected' : '')}
                  onClick={() => toggle(r.id)}
                >
                  <span className={'ml-assign__check' + (at >= 0 ? ' ml-assign__check--on' : '')} aria-hidden="true">
                    {at >= 0 && <Icon id="ico-check" size="0.875rem" />}
                  </span>
                  <span className="ml-assign__rowmain">
                    <span className="ml-assign__rowtitle">{r.title}</span>
                    <span className="ml-assign__rowmeta">
                      {[at === 0 ? 'MAIN' : at > 0 ? 'SIDE' : null,
                        r.totalMinutes != null ? durationLabel(r.totalMinutes).toUpperCase() : null]
                        .filter(Boolean).join(' · ')}
                    </span>
                  </span>
                </button>
              )
            })
          )}
        </div>
      </ScrollArea>
    </MealsModal>
  )
}
