/**
 * The vocabulary and the typing state machine for the "still thinking" line in a turn.
 *
 * Kept apart from the component for the usual reason in this folder: the interesting part is a pure
 * reducer over a tick, and a reducer can be tested without a DOM. The component owns the timer and
 * nothing else.
 */

/**
 * What the panel says while an agent is composing itself.
 *
 * Gerunds, and deliberately ornate ones. The panel is a piece of furniture in a house, and the few
 * seconds before a reply is the one moment it has nothing useful to say — so it may as well be
 * good company.
 *
 * The list is the household's, chosen by hand. Two notes for whoever edits it next: keep them
 * unique (a repeat inside one wait reads as a stuck animation, and there is a test for it), and
 * type them plainly — the original list arrived with a soft hyphen hidden inside "Discerning",
 * which is invisible in an editor and renders as "Discern-ing" the moment the line wraps.
 */
export const WAITING_WORDS = [
  'Cogitating',
  'Cerebrating',
  'Pondering',
  'Synthesizing',
  'Discerning',
  'Excogitating',
  'Assimilating',
  'Deliberating',
  'Perpending',
  'Meditating',
  'Devising',
  'Weighing',
  'Considering',
  'Discombobulating',
  'Envisioning',
  'Mulling',
  'Actualizing',
  'Ruminating',
  'Finagling',
  'Hatching',
] as const

/** Milliseconds per tick — one character typed or erased, or one unit of the hold. */
export const TICK_MS = 55

/** Ticks a fully typed word rests before it starts erasing. About 1.1s at {@link TICK_MS}. */
export const HOLD_TICKS = 20

export interface TypedWordState {
  /** Index into {@link WAITING_WORDS}. Wraps. */
  wordIndex: number
  /** How many leading characters of the word are currently shown. */
  chars: number
  phase: 'typing' | 'holding' | 'erasing'
  /** Ticks spent holding so far. Meaningless outside the holding phase. */
  held: number
}

/** A state that begins typing `wordIndex` from nothing. */
export const startTyping = (wordIndex: number): TypedWordState => ({
  wordIndex,
  chars: 0,
  phase: 'typing',
  held: 0,
})

/**
 * One tick.
 *
 * Type the word out a character at a time, rest on it, erase it the same way, then move to the
 * next. Erasing rather than cutting to the next word is what makes it read as one line being
 * rewritten instead of a slideshow, which is the difference between "still working" and "something
 * just changed".
 */
export function advance(
  state: TypedWordState,
  words: readonly string[] = WAITING_WORDS,
  holdTicks: number = HOLD_TICKS,
): TypedWordState {
  const word = words[state.wordIndex % words.length] ?? ''

  switch (state.phase) {
    case 'typing':
      return state.chars >= word.length
        ? { ...state, phase: 'holding', held: 0 }
        : { ...state, chars: state.chars + 1 }

    case 'holding':
      return state.held + 1 >= holdTicks
        ? { ...state, phase: 'erasing', held: 0 }
        : { ...state, held: state.held + 1 }

    case 'erasing':
      return state.chars <= 1
        ? startTyping((state.wordIndex + 1) % words.length)
        : { ...state, chars: state.chars - 1 }
  }
}

/** The text to show for a state — the word, revealed as far as it has been typed. */
export const visible = (
  state: TypedWordState,
  words: readonly string[] = WAITING_WORDS,
): string => (words[state.wordIndex % words.length] ?? '').slice(0, state.chars)
