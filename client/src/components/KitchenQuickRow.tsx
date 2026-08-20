import { useNavigate } from 'react-router'
import { KITCHEN_DESTINATIONS, type KitchenDestination } from '../app/kitchenDomain'

/** The count under each label. Undefined renders nothing rather than a zero nobody has counted. */
export interface QuickRowCounts {
  /** Nights planned this week. No denominator — "0 of 7" scolds (DECISIONS R5). */
  plan?: string
  /** Things on the shelves. */
  pantry?: string
  /** Recipes in the folder. */
  recipes?: string
  /** Open lines on the grocery list. */
  list?: string
}

interface KitchenQuickRowProps {
  /** Which destination is showing, if any. The answering page itself lights nothing. */
  active?: KitchenDestination
  counts?: QuickRowCounts
}

const ROUTES: Record<KitchenDestination, string> = {
  Plan: '/kitchen/plan',
  Pantry: '/kitchen/pantry',
  Recipes: '/kitchen/recipes',
  List: '/kitchen/list',
}

/**
 * The four destinations, docked above the bottom nav (Kitchen home panel).
 *
 * The section replaced three tabs named after database tables — `WEEK`, `RECIPES`, `PANTRY` — with
 * one answering page and these four. The distinction the design turns on: a segment control makes
 * you choose before you have been told anything, whereas this row makes no claim on your attention.
 * The page above it has already answered what is for dinner, what is turning and what to buy; the
 * row is for when you want to go and *look* at something, which is a different intent.
 *
 * **The counts do the work.** `7 OPEN` and `41 THINGS` mean you rarely need to open either
 * destination to know where you stand — which is why they are part of the row rather than a detail
 * inside it.
 *
 * Four is the ceiling. A fifth cell would turn this back into the tab bar the section just removed.
 */
export function KitchenQuickRow({ active, counts }: KitchenQuickRowProps) {
  const navigate = useNavigate()

  const countFor = (d: KitchenDestination): string | undefined => {
    switch (d) {
      case 'Plan': return counts?.plan
      case 'Pantry': return counts?.pantry
      case 'Recipes': return counts?.recipes
      case 'List': return counts?.list
    }
  }

  return (
    <nav className="ml-quickrow" aria-label="Kitchen destinations">
      {KITCHEN_DESTINATIONS.map((destination) => {
        const isActive = destination === active
        const count = countFor(destination)
        return (
          <button
            key={destination}
            type="button"
            className={`ml-quickrow__cell${isActive ? ' ml-quickrow__cell--active' : ''}`}
            // The row is navigation, so the current destination is a page state rather than a
            // pressed control — `aria-current` says that, where `aria-pressed` would imply a toggle.
            aria-current={isActive ? 'page' : undefined}
            onClick={() => navigate(ROUTES[destination])}
          >
            <span className="ml-quickrow__label">{destination.toUpperCase()}</span>
            {count != null && <span className="ml-quickrow__count">{count}</span>}
          </button>
        )
      })}
    </nav>
  )
}
