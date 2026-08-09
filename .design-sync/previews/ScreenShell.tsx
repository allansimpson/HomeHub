import { AlertBanner, DrillInHeader, LedgerRow, ScreenShell, SectionLabel } from 'client'

/** The full scaffold: header → double-rule → content → bottom nav, with the account avatar. */
export const Default = () => (
  <ScreenShell header={<DrillInHeader title="Climate" status="3 OF 5 RUNNING" statusLive />}>
    <SectionLabel label="THE HOUSE" />
    <LedgerRow title="Living Room" sub="Holding 71°" right={<span className="serif">71°</span>} />
    <LedgerRow title="Nursery" sub="Warming to 68°" right={<span className="serif">66°</span>} />
    <LedgerRow title="Main Bedroom" sub="Paused" right={<span className="serif">73°</span>} />
  </ScreenShell>
)

/** A full-bleed banner sits ABOVE the header, per spec 05. */
export const WithBanner = () => (
  <ScreenShell
    banner={<AlertBanner title="Severe thunderstorm warning" detail="Until 8:15 PM" severe />}
    header={<DrillInHeader title="Weather" status="16 JULY · 19:42" />}
  >
    <SectionLabel label="TONIGHT" />
    <LedgerRow title="Storms likely" sub="Heaviest 7–9 PM" right={<span className="serif">78°</span>} />
  </ScreenShell>
)

/** `nav={false}` — the Lock screen hides the bottom nav and the avatar with it. */
export const WithoutNav = () => (
  <ScreenShell nav={false} header={<DrillInHeader title="Locked" />}>
    <SectionLabel label="ENTER PIN" />
    <LedgerRow title="Astrid" sub="PIN required when idle" />
  </ScreenShell>
)
