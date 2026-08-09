import { useEffect } from 'react'
import { AttendantOverlay, useAttendant } from 'client'

/*
 * The overlay renders null until the provider is opened — there is no `open` prop, because the two
 * real ways in are the Dashboard block and the wake word. Opening it on mount is what a preview of
 * an overlay has to do; the alternative is a blank card that says nothing about the component.
 */
function Opened() {
  const { openAttendant } = useAttendant()
  useEffect(() => { openAttendant() }, [openAttendant])
  return <AttendantOverlay />
}

/**
 * The Attendant, open over the screen it interrupted. With no conversation stored and no assistant
 * configured it shows the panel's empty/with-history state — the chrome, header and push-to-talk
 * affordance, which is what the card is for.
 */
export const Open = () => <Opened />
