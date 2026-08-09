import { useCallback, useEffect, useState } from 'react'
import { getShowThinking, setShowThinking } from './assistPrefs'
import { useSession } from './SessionProvider'

/**
 * Whether this member has asked to watch the agent think, and the switch that changes it.
 *
 * A hook rather than a read at the point of use, for one reason: the preference is edited in Config
 * and read in the chat, which are different subtrees. `localStorage` fires no event a component can
 * subscribe to for a write made in the same document, so the setter announces the change itself and
 * every reader listens. Without that, turning the switch on and going back to a chat that was already
 * mounted would show no working until something else happened to re-render it, which reads as a
 * switch that did not take.
 *
 * Re-reads on the profile changing too. It is a per-member preference, and a panel that switched
 * profiles while a chat was open would otherwise keep showing the last member's answer.
 */
export function useShowThinking(): { showThinking: boolean; setShowThinking: (on: boolean) => void } {
  const { activeProfileId } = useSession()
  const [on, setOn] = useState(() => getShowThinking(activeProfileId))

  useEffect(() => {
    const read = () => setOn(getShowThinking(activeProfileId))
    read()
    window.addEventListener('homehub:assistprefs', read)
    // Another tab or window on the same panel. Rare, and free to support.
    window.addEventListener('storage', read)
    return () => {
      window.removeEventListener('homehub:assistprefs', read)
      window.removeEventListener('storage', read)
    }
  }, [activeProfileId])

  const set = useCallback(
    (next: boolean) => {
      setShowThinking(activeProfileId, next)
      // Set locally as well as announced: the event is what tells everybody *else*, and waiting for
      // it to come back round would leave the switch that was just pressed a frame behind itself.
      setOn(next)
    },
    [activeProfileId],
  )

  return { showThinking: on, setShowThinking: set }
}
