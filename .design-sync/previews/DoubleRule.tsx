import { DoubleRule, SectionLabel } from 'client'

/** The motif on its own: brass bar, gap, hairline. */
export const Default = () => <DoubleRule />

/** Where it actually appears — directly under a screen header, separating chrome from content. */
export const UnderAHeader = () => (
  <div>
    <div className="serif" style={{ fontSize: '1.75rem', paddingBottom: '0.75rem' }}>
      Climate
    </div>
    <DoubleRule />
    <div style={{ paddingTop: '1rem' }}>
      <SectionLabel label="THE HOUSE" status="3 OF 5 RUNNING" />
    </div>
  </div>
)
