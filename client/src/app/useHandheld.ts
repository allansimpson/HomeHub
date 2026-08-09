import { useEffect, useState } from 'react'

/**
 * Whether this browser is a device someone is *holding*, with a camera it could scan with.
 *
 * The Pantry section has one screen that only makes sense on a phone (`/pantry/scan`), and
 * PANTRY_SCREEN §1.7 is explicit that the wall panel must not offer it — "the panel is on a wall and
 * the barcodes are in your hand". That leaves the phone needing a way in, which is what this
 * answers.
 *
 * Two conditions, and each rules out a different thing:
 *
 * - **A secure context with `getUserMedia`.** No camera API, no point offering a camera. This alone
 *   hides the control on the deployed panel today, which is served over plain HTTP.
 * - **A small viewport.** The discriminator that actually matters, because the wall panel is *also*
 *   a touchscreen. It is 2160 CSS px across; a phone is under 500. The threshold sits far from both
 *   so neither is a near miss.
 *
 * A `(pointer: coarse)` clause was tried and removed. It is correct in principle — a mouse is not
 * something you hold up to a tin — but it cannot be exercised in a headless browser, so it would
 * have shipped to the one class of device it gates on without ever having been run. The cost of
 * dropping it is that a *narrow desktop window* also offers the control, which is harmless and
 * makes the screen testable; the cost of keeping it was a silent failure on a real phone.
 *
 * Deliberately **not** gated on `BarcodeDetector` either. It is absent on every iPhone, and hiding
 * the whole screen there would also hide `TYPE ONE` — genuinely useful while standing at the
 * shelves, and the only way in for a household on iOS until the decoder is replaced. The screen
 * itself says plainly what it cannot do.
 */
export function useHandheld(): boolean {
  const [handheld, setHandheld] = useState(false)

  useEffect(() => {
    const query = window.matchMedia('(max-width: 820px)')
    const evaluate = () => {
      const camera = window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function'
      setHandheld(camera && query.matches)
    }
    evaluate()
    // Rotating a phone changes the width, and on a foldable it changes a lot.
    query.addEventListener('change', evaluate)
    return () => query.removeEventListener('change', evaluate)
  }, [])

  return handheld
}
