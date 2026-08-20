import { useState } from 'react'
import { useNavigate } from 'react-router'
import { ScreenShell, DrillInHeader, ScrollArea, Toggle } from '../../components'
import { useMeals } from '../../app/MealsProvider'
import { formatClock, parseClock } from '../../app/mealsDomain'
import { clockFromStored } from '../../app/dates'
import { ALL_SLOTS } from '../../app/mealsPrefs'
import type { MealSlotName } from '../../api/types'
import { Chevron, MealsLabel, RuleLine } from './parts'

/** Why each slot is on or off by default — shown under the toggle so the choice isn't arbitrary. */
const SLOT_REASON: Record<MealSlotName, string> = {
  Breakfast: 'Most households never plan it',
  Lunch: 'Where the leftovers go',
  Dinner: 'The meal this section is for',
  Other: '',
}

/**
 * Meals settings (MEALS_SCREEN §11, id 4f). Per household, not per profile — the folder and the
 * plan are shared, so these are properties of the kitchen.
 */
export function MealsSettingsScreen() {
  const navigate = useNavigate()
  const { recipes, settings, updateSettings } = useMeals()
  const [newCuisine, setNewCuisine] = useState('')

  const archived = recipes.filter((r) => r.isArchived).length
  const dinner = parseClock(settings.dinnerTime) ?? 18 * 60 + 30

  const toggleSlot = (slot: MealSlotName, on: boolean) => {
    const next = on
      ? ALL_SLOTS.filter((s) => s === slot || settings.visibleSlots.includes(s))
      : settings.visibleSlots.filter((s) => s !== slot)
    updateSettings({ visibleSlots: next })
  }

  return (
    <ScreenShell header={<DrillInHeader title="MEALS SETTINGS" onBack={() => navigate(-1)} />}>
      <ScrollArea>
        <MealsLabel label="SLOTS THE WEEK SHOWS" />
        {ALL_SLOTS.map((slot) => {
          // Dinner is locked on. A meal planner that can be configured to plan no meals is a bug
          // wearing a preference's clothes, and every screen below the home tab assumes it exists.
          const locked = slot === 'Dinner'
          return (
            <div className={'ml-mealset__row' + (locked ? ' ml-mealset__row--locked' : '')} key={slot}>
              <span className="ml-mealset__rowmain">
                <span className="ml-mealset__name">{slot}</span>
                <span className="ml-mealset__reason">{SLOT_REASON[slot]}</span>
              </span>
              {locked ? (
                <span className="ml-mealset__lockednote">ALWAYS ON</span>
              ) : (
                <Toggle
                  on={settings.visibleSlots.includes(slot)}
                  onChange={(next) => toggleSlot(slot, next)}
                  label={`Show ${slot.toLowerCase()}`}
                />
              )}
            </div>
          )
        })}

        <MealsLabel label="DINNER TIME" status="FEEDS THE START-BY TIME" />
        <div className="ml-mealset__row">
          <span className="ml-mealset__rowmain">
            <span className="ml-mealset__name">When you sit down</span>
            <span className="ml-mealset__reason">The one input the start-by arithmetic needs</span>
          </span>
          <span className="ml-mealset__time">
            <button
              type="button"
              className="ml-mealset__timestep"
              aria-label="Earlier dinner"
              onClick={() => updateSettings({ dinnerTime: formatClock(dinner - 15) })}
            >
              −
            </button>
            {/* The stepper writes `formatClock` back to the server, which is the stored form; what
                stands between the two buttons is the same value said out loud. */}
            <span className="ml-mealset__timevalue serif">{clockFromStored(settings.dinnerTime)}</span>
            <button
              type="button"
              className="ml-mealset__timestep"
              aria-label="Later dinner"
              onClick={() => updateSettings({ dinnerTime: formatClock(dinner + 15) })}
            >
              ＋
            </button>
          </span>
        </div>

        <MealsLabel label="COOK FOR" status="HOW MANY YOU ACTUALLY FEED" />
        <div className="ml-mealset__row">
          <span className="ml-mealset__rowmain">
            <span className="ml-mealset__name">Servings</span>
            <span className="ml-mealset__reason">
              Recipes open at this and nights are planned for it, whatever the page said
            </span>
          </span>
          <span className="ml-mealset__time">
            <button
              type="button"
              className="ml-mealset__timestep"
              aria-label="Fewer default servings"
              onClick={() => updateSettings({ defaultServings: Math.max(1, settings.defaultServings - 1) })}
            >
              −
            </button>
            <span className="ml-mealset__timevalue serif">{settings.defaultServings}</span>
            <button
              type="button"
              className="ml-mealset__timestep"
              aria-label="More default servings"
              onClick={() => updateSettings({ defaultServings: Math.min(50, settings.defaultServings + 1) })}
            >
              ＋
            </button>
          </span>
        </div>
        {/* Says what it does NOT do, because that is the surprising half: a recipe's own yield is
            left alone so the ratio line can honestly read SCALED FROM 6 → 8. */}
        <RuleLine>
          RECIPES KEEP THE YIELD THEIR PAGE GAVE · THE AMOUNTS ARE SCALED TO THIS, NOT REWRITTEN
        </RuleLine>

        <MealsLabel label="CUISINES" status="USED FOR GROUPING" />
        <div className="ml-mealset__chips">
          {settings.canonicalCuisines.map((name) => (
            <button
              key={name}
              type="button"
              className="ml-mealset__chip"
              onClick={() => updateSettings({
                canonicalCuisines: settings.canonicalCuisines.filter((c) => c !== name),
              })}
              aria-label={`Remove ${name}`}
            >
              {name.toUpperCase()}
              <span className="ml-mealset__chipx" aria-hidden="true">✕</span>
            </button>
          ))}
          <input
            className="ml-mealset__newchip"
            value={newCuisine}
            placeholder="＋ NEW"
            aria-label="Add a cuisine"
            onChange={(e) => setNewCuisine(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              const name = newCuisine.trim()
              if (!name || settings.canonicalCuisines.some((c) => c.toLowerCase() === name.toLowerCase())) return
              updateSettings({ canonicalCuisines: [...settings.canonicalCuisines, name] })
              setNewCuisine('')
            }}
          />
        </div>
        <RuleLine>
          ONE SPELLING EACH · IMPORTS ARE MATCHED TO THIS LIST, SO "ITALY" AND "ITALIAN" DON'T
          BECOME TWO GROUPS
        </RuleLine>

        <div className="ml-mealset__grouprule" aria-hidden="true" />

        <div className="ml-mealset__row">
          <span className="ml-mealset__rowmain">
            <span className="ml-mealset__name">Suggest what you haven't cooked</span>
            <span className="ml-mealset__reason">One quiet row on the folder, dismissible</span>
          </span>
          <Toggle
            on={settings.suggestUncooked}
            onChange={(next) => updateSettings({ suggestUncooked: next })}
            label="Suggest uncooked recipes"
          />
        </div>

        <button type="button" className="ml-mealset__row ml-mealset__row--link" onClick={() => navigate('/meals/recipes')}>
          <span className="ml-mealset__rowmain">
            <span className="ml-mealset__name">Archived recipes</span>
            <span className="ml-mealset__reason">
              {archived === 1 ? '1 recipe, hidden from browsing' : `${archived} recipes, hidden from browsing`}
            </span>
          </span>
          <Chevron />
        </button>

        <RuleLine>SETTINGS ARE PER HOUSEHOLD, NOT PER PROFILE</RuleLine>
      </ScrollArea>
    </ScreenShell>
  )
}
