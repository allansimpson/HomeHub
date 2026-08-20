import { BackButton } from 'client'

/** The 44×44 box with its brass chevron — top-left of every drill-in. */
export const Default = () => <BackButton onClick={() => {}} />

/** A custom accessible label when "Back" isn't specific enough. */
export const CustomLabel = () => <BackButton onClick={() => {}} label="Back to Climate" />

/**
 * Naming the screen behind it — the Notifications inbox, which the account avatar opens directly, so
 * the arrow is the only route on to Config for somebody who arrived from the dashboard.
 */
export const Labelled = () => <BackButton onClick={() => {}} text="Config" />

/** In place beside a title, which is how it is always seen. */
export const BesideATitle = () => (
  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
    <BackButton onClick={() => {}} label="Back to Config" />
    <span className="serif" style={{ fontSize: '1.5rem' }}>
      Sensor History
    </span>
  </div>
)
