import { Icon } from '../icons/Icon'

interface PinPadProps {
  /** Digits entered so far. */
  digits: string
  /** Total dots to show (PIN length). */
  length: number
  onPress: (digit: string) => void
  onBackspace: () => void
  onClear: () => void
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const

/**
 * Deco numeric keypad + progress dots, shared by the Lock screen and the Settings set-PIN
 * flow. Controlled: the parent owns `digits` and reacts when it reaches `length`.
 */
export function PinPad({ digits, length, onPress, onBackspace, onClear }: PinPadProps) {
  return (
    <div className="ml-pinpad">
      <div className="ml-pinpad__dots" aria-label={`${digits.length} of ${length} digits`}>
        {Array.from({ length }).map((_, i) => (
          <span
            key={i}
            className={'ml-pinpad__dot' + (i < digits.length ? ' ml-pinpad__dot--filled' : '')}
          />
        ))}
      </div>

      <div className="ml-pinpad__keys">
        {KEYS.map((k) => (
          <button key={k} type="button" className="ml-pinpad__key serif" onClick={() => onPress(k)}>
            {k}
          </button>
        ))}
        <button type="button" className="ml-pinpad__key ml-pinpad__key--fn label" onClick={onClear}>
          Clear
        </button>
        <button type="button" className="ml-pinpad__key serif" onClick={() => onPress('0')}>
          0
        </button>
        <button
          type="button"
          className="ml-pinpad__key ml-pinpad__key--fn"
          onClick={onBackspace}
          aria-label="Backspace"
        >
          <Icon id="ico-back" size="1rem" />
        </button>
      </div>
    </div>
  )
}
