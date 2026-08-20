import { useEffect } from 'react'
import { PinPad } from '../components'
import { PIN_LENGTH } from './lockGating'

interface LockPinSheetProps {
  /** The chosen person. The sheet cannot exist without one — that is its whole point. */
  name: string
  initial: string
  digits: string
  /** The line under the name: FOUR DIGITS, a cooldown, or why the keys stopped answering. */
  subline: string
  onPress: (digit: string) => void
  onBackspace: () => void
  onClear: () => void
  /** CANCEL, a scrim tap, or the sheet going quiet. Clears the digits and deselects the profile. */
  onCancel: () => void
}

/**
 * A half-entered PIN is the one thing on this screen worth forgetting quickly. Everything else here
 * is public — three names on a wall — but four digits left on the keypad because somebody was
 * called away is an unlock waiting for whoever walks past next.
 */
const ABANDON_MS = 60_000

/**
 * The PIN sheet, raised over the chooser and headed by the chosen person's name.
 *
 * The keypad lives here and only here, so there is no code path in which a digit press has no
 * owner. Mounted with the sheet rather than with the screen, which is the same invariant stated in
 * the component tree.
 *
 * @category Screens
 */
export function LockPinSheet({
  name, initial, digits, subline, onPress, onBackspace, onClear, onCancel,
}: LockPinSheetProps) {
  // Going quiet mid-entry returns to the chooser. The app-level idle timer deliberately does not run
  // while the panel is locked, so without this the sheet would sit open with digits in it all night.
  useEffect(() => {
    const timer = window.setTimeout(onCancel, ABANDON_MS)
    return () => window.clearTimeout(timer)
  }, [onCancel, digits])

  return (
    <>
      <div className="ml-pinsheet__scrim" onClick={onCancel} />
      <div className="ml-pinsheet" role="dialog" aria-modal="true" aria-label={`${name}’s PIN`}>
        <div className="ml-pinsheet__head">
          <span className="ml-pinsheet__avatar serif" aria-hidden="true">{initial}</span>
          <span className="ml-pinsheet__titles">
            <span className="ml-pinsheet__name serif">{name}’s PIN</span>
            <span className="ml-pinsheet__sub">{subline}</span>
          </span>
          <button type="button" className="ml-pinsheet__cancel label" onClick={onCancel}>
            Cancel
          </button>
        </div>

        <PinPad
          digits={digits}
          length={PIN_LENGTH}
          onPress={onPress}
          onBackspace={onBackspace}
          onClear={onClear}
        />
      </div>
    </>
  )
}
