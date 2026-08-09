import { Stepper } from 'client'

/** The pair, as it is always used — a value between a minus and a plus. */
export const Pair = () => (
  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
    <Stepper direction="minus" onStep={() => {}} label="Cooler" />
    <span className="serif" style={{ fontSize: '2rem', minWidth: '3.5rem', textAlign: 'center' }}>
      71°
    </span>
    <Stepper direction="plus" onStep={() => {}} label="Warmer" />
  </div>
)

/** The two directions on their own. */
export const Directions = () => (
  <div style={{ display: 'flex', gap: '1rem' }}>
    <Stepper direction="minus" onStep={() => {}} />
    <Stepper direction="plus" onStep={() => {}} />
  </div>
)

/** Disabled — at the end of the allowed range, so the step would do nothing. */
export const Disabled = () => (
  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
    <Stepper direction="minus" onStep={() => {}} disabled label="Cooler" />
    <span className="serif" style={{ fontSize: '2rem', minWidth: '3.5rem', textAlign: 'center' }}>
      60°
    </span>
    <Stepper direction="plus" onStep={() => {}} label="Warmer" />
  </div>
)
