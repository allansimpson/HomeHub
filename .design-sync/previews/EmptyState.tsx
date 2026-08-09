import { EmptyState } from 'client'

/** Label plus the hint that says what would fill it. */
export const Default = () => (
  <EmptyState label="Nothing on the calendar" hint="Events from the household calendars appear here" />
)

/** Label alone, where the section title already carries the context. */
export const LabelOnly = () => <EmptyState label="No alerts" />

/** The offline case — still styled, never a blank or an error screen. */
export const NotConfigured = () => (
  <EmptyState label="No sensors yet" hint="Add SensorPush credentials in Config to start recording" />
)
