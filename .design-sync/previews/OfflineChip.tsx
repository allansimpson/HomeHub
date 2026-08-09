import { DashboardHeader, OfflineChip } from 'client'

/** The chip on its own. */
export const Default = () => <OfflineChip />

/** In place: the dashboard header swaps the conditions line for it while the panel is reconnecting. */
export const InHeader = () => (
  <DashboardHeader clock="11:08" ampm="AM" date="SATURDAY 21 SEPTEMBER" conditions="64° RAIN" offline />
)
