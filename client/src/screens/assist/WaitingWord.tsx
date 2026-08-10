import { useEffect, useState } from 'react'
import { advance, startTyping, visible, TICK_MS, WAITING_WORDS } from './waitingWords'

/**
 * The line a turn shows between "sent" and the first word of the reply.
 *
 * It replaces a caret that only pulsed. A pulse says the panel is awake; it does not say anybody is
 * working, and on a wall panel four feet away it is easy to miss entirely — the gap before a slow
 * agent's first token read as a tap that had not registered. A word being typed out, erased and
 * replaced is unmistakably *something happening*, and it costs nothing but a timer.
 *
 * Styled as live status, not as reply text: dimmer, letter-spaced, the same treatment as the tool
 * line. Nothing an agent actually said is ever set this way, so there is no moment where the
 * furniture's small talk could be mistaken for the answer.
 */
export function WaitingWord() {
  // A random opening word per turn. Always starting at "Pontificating" would make the flourish
  // read as a fixed loading string after the second time anybody saw it.
  const [state, setState] = useState(() => startTyping(Math.floor(Math.random() * WAITING_WORDS.length)))

  // Someone who has asked for less motion has asked for exactly this kind of thing to stop. They
  // still get the word — it is information — just not the typing.
  const [still] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  )

  useEffect(() => {
    if (still) return
    const id = window.setInterval(() => setState((s) => advance(s)), TICK_MS)
    return () => window.clearInterval(id)
  }, [still])

  const word = WAITING_WORDS[state.wordIndex % WAITING_WORDS.length]

  return (
    // One `role="status"` with a fixed label, rather than letting the cycling text be announced:
    // a screen reader should hear "waiting for a reply" once, not a new vocabulary word every two
    // seconds. The visible text is decorative once that has been said.
    <span className="ml-turn__waiting" role="status" aria-label="Waiting for a reply">
      <span className="ml-turn__waitingword" aria-hidden="true">
        {still ? word : visible(state)}
      </span>
      {/* Against the last character typed, and steady while characters are still landing — the
          caret is meant to be the thing writing the word, not a second animation beside it. It
          blinks again on the hold, when there is nothing else on the line moving. */}
      <span
        className={
          'ml-turn__caret' + (!still && state.phase !== 'holding' ? ' ml-turn__caret--steady' : '')
        }
        aria-hidden="true"
      />
    </span>
  )
}
