import { useEffect } from 'react'
import { LedgerRow, NotificationDrawer, SectionLabel, useNotifications } from 'client'

/*
 * The drawer is a sheet over the app, opened from the provider rather than a prop — so a preview
 * has to open it, and has to render something underneath for the scrim to dim.
 */
function OpenedOver({ children }: { children?: React.ReactNode }) {
  const { openDrawer } = useNotifications()
  useEffect(() => { openDrawer() }, [openDrawer])
  return (
    <>
      {children}
      <NotificationDrawer />
    </>
  )
}

/**
 * The drawer pulled down over the screen beneath it. The app stays where it was, dimmed behind the
 * scrim — the sheet never replaces the screen. With no notifications stored it shows the empty
 * inbox state.
 */
export const Open = () => (
  <OpenedOver>
    <SectionLabel label="THE HOUSE" />
    <LedgerRow title="Living Room" sub="Holding 71°" right={<span className="serif">71°</span>} />
    <LedgerRow title="Nursery" sub="Warming to 68°" right={<span className="serif">66°</span>} />
  </OpenedOver>
)
