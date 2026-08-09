import { BackButton } from 'client'

/** The 44×44 box with its brass chevron — top-left of every drill-in. */
export const Default = () => <BackButton onClick={() => {}} />

/** A custom accessible label when "Back" isn't specific enough. */
export const CustomLabel = () => <BackButton onClick={() => {}} label="Back to Climate" />

/** In place beside a title, which is how it is always seen. */
export const BesideATitle = () => (
  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
    <BackButton onClick={() => {}} label="Back to Config" />
    <span className="serif" style={{ fontSize: '1.5rem' }}>
      Sensor History
    </span>
  </div>
)
