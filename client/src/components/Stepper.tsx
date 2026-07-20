import { useCallback, useRef } from 'react'
import { Icon } from '../icons/Icon'

interface StepperProps {
  direction: 'minus' | 'plus'
  onStep: () => void
  disabled?: boolean
  label?: string
}

const REPEAT_DELAY_MS = 400
const REPEAT_INTERVAL_MS = 90

/**
 * Square − / + control. One step per tap; long-press repeats (holds accelerate entry of
 * set-points/thresholds/times). Callers apply the update optimistically.
 */
export function Stepper({ direction, onStep, disabled, label }: StepperProps) {
  const delayRef = useRef<number | undefined>(undefined)
  const intervalRef = useRef<number | undefined>(undefined)

  const stop = useCallback(() => {
    window.clearTimeout(delayRef.current)
    window.clearInterval(intervalRef.current)
    delayRef.current = undefined
    intervalRef.current = undefined
  }, [])

  const start = useCallback(() => {
    if (disabled) return
    onStep() // immediate step on press
    delayRef.current = window.setTimeout(() => {
      intervalRef.current = window.setInterval(onStep, REPEAT_INTERVAL_MS)
    }, REPEAT_DELAY_MS)
  }, [disabled, onStep])

  return (
    <button
      className="ml-stepper"
      type="button"
      disabled={disabled}
      aria-label={label ?? (direction === 'plus' ? 'Increase' : 'Decrease')}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
    >
      <Icon id={direction === 'plus' ? 'ico-add' : 'ico-minus'} size="1.375rem" />
    </button>
  )
}
