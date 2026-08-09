import { PinPad } from 'client'

/** Mid-entry: two of four digits in, so the progress dots show both filled and empty states. */
export const PartiallyEntered = () => (
  <PinPad digits="34" length={4} onPress={() => {}} onBackspace={() => {}} onClear={() => {}} />
)

/** Untouched, as the Lock screen first presents it. */
export const Empty = () => (
  <PinPad digits="" length={4} onPress={() => {}} onBackspace={() => {}} onClear={() => {}} />
)

/** A six-digit PIN — `length` drives the dot count, not the keypad. */
export const SixDigit = () => (
  <PinPad digits="9021" length={6} onPress={() => {}} onBackspace={() => {}} onClear={() => {}} />
)
