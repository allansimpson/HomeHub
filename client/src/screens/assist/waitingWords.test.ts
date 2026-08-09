import { describe, expect, it } from 'vitest'
import { advance, startTyping, visible, WAITING_WORDS, type TypedWordState } from './waitingWords'

const WORDS = ['Ab', 'Cde'] as const
const HOLD = 3

/** Run `ticks` ticks against the small fixture vocabulary. */
const run = (from: TypedWordState, ticks: number): TypedWordState => {
  let s = from
  for (let i = 0; i < ticks; i++) s = advance(s, WORDS, HOLD)
  return s
}

describe('waiting words', () => {
  it('types one character per tick', () => {
    let s = startTyping(0)
    expect(visible(s, WORDS)).toBe('')
    s = advance(s, WORDS, HOLD)
    expect(visible(s, WORDS)).toBe('A')
    s = advance(s, WORDS, HOLD)
    expect(visible(s, WORDS)).toBe('Ab')
  })

  /**
   * Ticks for one word, start to start: `len` to type it, one more to notice it is finished,
   * `hold` resting, then `len` erasing (the last of which starts the next word).
   */
  const cycle = (len: number) => 2 * len + 1 + HOLD

  it('rests on the finished word for the hold, then erases', () => {
    // 2 ticks to type "Ab", 1 more to enter the hold.
    const typed = run(startTyping(0), 2)
    expect(typed.phase).toBe('typing')

    const holding = run(typed, 1)
    expect(holding.phase).toBe('holding')
    // The whole word stays on screen throughout the hold — this is the part a person reads.
    expect(visible(run(holding, HOLD - 1), WORDS)).toBe('Ab')

    const erasing = run(holding, HOLD)
    expect(erasing.phase).toBe('erasing')
    expect(visible(advance(erasing, WORDS, HOLD), WORDS)).toBe('A')
  })

  it('moves to the next word once erased, and wraps at the end', () => {
    const next = run(startTyping(0), cycle(2)) // "Ab"
    expect(next.wordIndex).toBe(1)
    expect(next.chars).toBe(0)
    expect(next.phase).toBe('typing')

    // "Cde" is a character longer, so its cycle is one tick longer each way.
    const wrapped = run(next, cycle(3))
    expect(wrapped.wordIndex).toBe(0)
  })

  it('never shows more than the word', () => {
    let s = startTyping(0)
    for (let i = 0; i < 200; i++) {
      s = advance(s, WORDS, HOLD)
      const word = WORDS[s.wordIndex % WORDS.length]
      expect(s.chars).toBeLessThanOrEqual(word.length)
      expect(word.startsWith(visible(s, WORDS))).toBe(true)
    }
  })

  it('cycles the real vocabulary without getting stuck', () => {
    // Guards the default arguments: a wrong modulo here would pin the line to one word forever,
    // which looks like a hang rather than a flourish.
    let s = startTyping(0)
    const seen = new Set<number>()
    for (let i = 0; i < 20_000; i++) {
      s = advance(s)
      seen.add(s.wordIndex)
    }
    expect(seen.size).toBe(WAITING_WORDS.length)
  })

  it('offers enough words that a wait rarely repeats one', () => {
    expect(WAITING_WORDS.length).toBeGreaterThanOrEqual(20)
    expect(new Set(WAITING_WORDS).size).toBe(WAITING_WORDS.length)
  })
})
