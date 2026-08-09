import { Toggle } from 'client'

/** Both positions of the default brass switch. */
export const OnAndOff = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
    <Toggle on onChange={() => {}} label="Quiet hours" />
    <Toggle on={false} onChange={() => {}} label="Daylight boost" />
  </div>
)

/** The `live` variant marks app-level smart switches in verdigris rather than brass. */
export const LiveVariant = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
    <Toggle on onChange={() => {}} variant="live" label="Today view" />
    <Toggle on={false} onChange={() => {}} variant="live" label="All lists" />
  </div>
)

/** In a settings list, which is where the switch actually lives. */
export const InRows = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span>Require PIN when idle</span>
      <Toggle on onChange={() => {}} label="Require PIN when idle" />
    </div>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span>Store conversations</span>
      <Toggle on={false} onChange={() => {}} label="Store conversations" />
    </div>
  </div>
)
