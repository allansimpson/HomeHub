import { SectionLabel } from 'client'

/** The default heading — no tick, so the label lines up with the content beneath it. */
export const Default = () => <SectionLabel label="THE HOUSE" />

/** With a right-hand status. */
export const WithStatus = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
    <SectionLabel label="CLIMATE" status="3 OF 5 RUNNING" />
    <SectionLabel label="SENSORS" status="ALL REPORTING" statusLive />
  </div>
)

/** `live` puts the tick and label in verdigris to mark an app-level group. */
export const LiveGroup = () => <SectionLabel label="SMART VIEWS" live tick />

/** The opt-in brass tick, for a genuinely card-based screen. */
export const WithTick = () => <SectionLabel label="TONIGHT" tick />
