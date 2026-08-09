import { DrillInHeader } from 'client'

/** Back chevron, Marcellus title, right-aligned status. */
export const Default = () => (
  <DrillInHeader title="Sensor History" onBack={() => {}} status="16 JULY · 19:42" />
)

/** A live status renders in verdigris. */
export const LiveStatus = () => (
  <DrillInHeader title="Climate" onBack={() => {}} status="3 OF 5 RUNNING" statusLive />
)

/**
 * No back affordance. A main tab destination is reached from the bottom nav, so there is nothing
 * to go back to — only drill-ins carry `onBack`.
 */
export const TabDestination = () => <DrillInHeader title="Meals" status="WEEK OF 14 JULY" />

/** Title alone, where the screen has no status worth stating. */
export const TitleOnly = () => <DrillInHeader title="Notifications" onBack={() => {}} />
