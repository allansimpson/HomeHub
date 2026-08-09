import { CollapsibleSection, LedgerRow, Toggle } from 'client'

/** Open, with rows inside — the header matches SectionLabel, plus the chevron. */
export const Default = () => (
  <CollapsibleSection id="preview-climate" label="CLIMATE" status="3 OF 5 RUNNING">
    <LedgerRow title="Living Room" sub="Holding 71°" right={<span className="serif">71°</span>} />
    <LedgerRow title="Nursery" sub="Warming to 68°" right={<span className="serif">66°</span>} />
  </CollapsibleSection>
)

/** A live status renders verdigris in the header. */
export const LiveStatus = () => (
  <CollapsibleSection id="preview-sensors" label="SENSORS" status="ALL REPORTING" statusLive>
    <LedgerRow title="Back Porch" sub="Updated 40 s ago" right={<span className="serif">64°</span>} />
    <LedgerRow title="Basement" sub="Updated 1 min ago" right={<span className="serif">58°</span>} />
  </CollapsibleSection>
)

/** Several sections stacked, which is how a long Config screen is organised. */
export const Stacked = () => (
  <div>
    <CollapsibleSection id="preview-household" label="HOUSEHOLD">
      <LedgerRow title="Astrid" sub="PIN set" right={<span className="label">ADULT</span>} />
      <LedgerRow title="Leif" sub="No PIN" right={<span className="label">CHILD</span>} />
    </CollapsibleSection>
    <CollapsibleSection id="preview-panel" label="PANEL" status="AUTO">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem 0' }}>
        <span>Daylight boost</span>
        <Toggle on onChange={() => {}} label="Daylight boost" />
      </div>
    </CollapsibleSection>
  </div>
)
