import { BottomNav } from 'client'

/**
 * The seven deco tabs. Which one lights up comes from the router, not a prop — in a preview no
 * route matches, so this shows the bar's resting state with every tab inactive.
 */
export const Default = () => <BottomNav />
