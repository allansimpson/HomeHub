import { AlertBanner } from 'client'

/** A sensor threshold breach — the shape the alert engine raises. */
export const Default = () => (
  <AlertBanner title="Nursery above 78°" detail="Sustained 22 minutes · threshold 76°" onClick={() => {}} />
)

/** Severe adds the hazard stripe beneath the banner. */
export const Severe = () => (
  <AlertBanner
    title="Severe thunderstorm warning"
    detail="Until 8:15 PM · National Weather Service"
    severe
    onClick={() => {}}
  />
)

/** Title alone, when the title already says everything. */
export const TitleOnly = () => <AlertBanner title="Freezer door open 10 minutes" />

/** Both severities together, so the stripe treatment is legible as a difference. */
export const Comparison = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
    <AlertBanner title="Garage unreachable" detail="Retrying for 30 minutes" />
    <AlertBanner title="Tornado warning" detail="Take shelter now · until 6:40 PM" severe />
  </div>
)
