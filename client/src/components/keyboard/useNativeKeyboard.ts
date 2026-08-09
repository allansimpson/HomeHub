import { useEffect, useState } from 'react'

/**
 * Whether this device should use its **own** keyboard instead of HomeHub's.
 *
 * The on-screen keyboard exists for one device: the wall panel, which has no hardware keyboard and
 * whose whole point is that every surface on it is drawn in the same hand. A phone is the opposite
 * case on both counts — it already has a keyboard, that keyboard is better than ours (autocorrect,
 * swipe, dictation, the layout the person's thumbs already know), and ours would cover most of a
 * screen that has none to spare.
 *
 * **The test is viewport width, not the user agent.** Sniffing the UA string is guessing at a device
 * from a string that device chose; width is the thing that actually matters here and is the same
 * number the layout already keys off (`--gutter` narrows at the same 540px). The panel is over a
 * thousand CSS pixels wide however it reports itself, and a phone is not — including a phone that
 * lies about being a phone.
 *
 * A media-query listener rather than a one-shot read, so rotating a tablet across the boundary
 * switches keyboards instead of leaving the wrong one docked until the next reload.
 */
const NATIVE_KEYBOARD_QUERY = '(max-width: 540px)'

export function useNativeKeyboard(): boolean {
  const [native, setNative] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.(NATIVE_KEYBOARD_QUERY).matches === true,
  )

  useEffect(() => {
    const mq = window.matchMedia?.(NATIVE_KEYBOARD_QUERY)
    if (!mq) return
    const onChange = () => setNative(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return native
}
