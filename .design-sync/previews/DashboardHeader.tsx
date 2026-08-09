import { DashboardHeader } from 'client'

/** The panel as it stands most of the day: clock, date, and the weather line. */
export const Default = () => (
  <DashboardHeader clock="7:42" ampm="PM" date="THURSDAY 16 JULY" conditions="78° CLEAR · FEELS 80°" />
)

/** Morning, with a colder conditions line — the numerals are Marcellus, the labels Josefin Sans. */
export const Morning = () => (
  <DashboardHeader clock="6:15" ampm="AM" date="MONDAY 3 FEBRUARY" conditions="19° CLOUDY · FEELS 11°" />
)

/**
 * Offline. The conditions line is replaced by the offline chip rather than showing a cached
 * temperature as though it were current.
 */
export const Offline = () => (
  <DashboardHeader clock="11:08" ampm="AM" date="SATURDAY 21 SEPTEMBER" conditions="64° RAIN" offline />
)

/** Signed in as Astrid — the monogram badge opens the profile switcher. */
export const WithProfileSwitcher = () => (
  <DashboardHeader
    clock="9:30"
    ampm="PM"
    date="TUESDAY 12 NOVEMBER"
    conditions="41° CLEAR · FEELS 36°"
    profileInitial="A"
    onSwitchProfile={() => {}}
  />
)
