import { describe, expect, it } from 'vitest'
import { selectPendingChat, selectTurns } from './assistTurns'
import type { AssistTurn } from './assistTurns'

/**
 * Which turns a screen is shown (ASSIST.md · the chat view).
 *
 * The rest of the store is React plumbing; this is the judgement. A turn now outlives the screen that
 * started it, so "what is in flight for the chat I am showing" stopped being a local variable and
 * became a lookup — and every way the household loses a message again runs through getting this
 * answer wrong.
 */

let next = 0

function turn(group: string, conversationId: number | null = null): AssistTurn {
  const seq = ++next
  return {
    key: `${group}#${seq}`, group, seq, conversationId,
    prompt: 'when do the bins go out',
    attachment: null,
    text: '', thinking: '', tool: null, started: false, opened: false, queued: false,
    recovering: false, done: false, stopping: false, messageId: 0, outcome: null, error: null,
  }
}

const index = (...turns: AssistTurn[]): Record<string, AssistTurn> =>
  Object.fromEntries(turns.map((t) => [t.key, t]))

describe('selectTurns', () => {
  it('finds nothing when nothing is in flight', () => {
    expect(selectTurns({}, null)).toEqual([])
    expect(selectTurns({}, 7)).toEqual([])
  })

  it('gives a chat its own turn', () => {
    const live = turn('c:7', 7)
    expect(selectTurns(index(live), 7)).toEqual([live])
  })

  it('does not give one chat another chat\'s turn', () => {
    expect(selectTurns(index(turn('c:7', 7)), 9)).toEqual([])
  })

  it('finds the turn of a chat that has no id yet', () => {
    const opening = turn('new:1')
    expect(selectTurns(index(opening), null)).toEqual([opening])
  })

  /*
   * The regression this rule exists for. A turn that lands is not re-filed under the id it was just
   * given: the render in which it lands is the render the screen learns where to navigate to, and
   * moving it then made it vanish from the only screen still asking about it — so the reply blinked
   * out on the way to its own conversation.
   */
  it('keeps a landed turn visible to the screen that has not navigated yet', () => {
    const landed = { ...turn('new:1', 42), done: true, messageId: 900 }
    expect(selectTurns(index(landed), null)).toEqual([landed])
    expect(selectTurns(index(landed), 42)).toEqual([landed])
  })

  it('shows a chat both the turn that opened it and the one sent since', () => {
    const opener = { ...turn('new:1', 42), done: true, messageId: 900 }
    const next = turn('c:42', 42)
    expect(selectTurns(index(opener, next), 42)).toEqual([opener, next])
  })

  it('takes only the newest unnamed chat', () => {
    const older = turn('new:1')
    const newer = turn('new:2')
    expect(selectTurns(index(older, newer), null)).toEqual([newer])
  })

  it('does not mistake a named chat\'s turn for an unnamed one', () => {
    expect(selectTurns(index(turn('c:7', 7)), null)).toEqual([])
  })

  /*
   * The queue, which is the whole reason this returns a list. A follow-up sent while a reply is
   * arriving has to appear under the message it followed — in the order it was sent, not the order
   * the object keys happen to enumerate in.
   */
  it('puts a chat\'s turns in the order they were sent', () => {
    const first = turn('c:7', 7)
    const second = turn('c:7', 7)
    const third = turn('c:7', 7)
    // Deliberately indexed out of order: insertion order must not be what decides this.
    expect(selectTurns(index(third, first, second), 7)).toEqual([first, second, third])
  })

  it('keeps a queue behind the turn that opened a chat', () => {
    const opener = turn('new:1')
    const queued = { ...turn('new:1'), queued: true }
    expect(selectTurns(index(opener, queued), null)).toEqual([opener, queued])
  })
})

/**
 * The row the inbox draws for a chat the server has not written down yet.
 *
 * The bug it exists for: start a chat, go back before the reply lands, and the list showed nothing —
 * a message the household had definitely sent, in neither the inbox nor anywhere they could reach.
 * These pin the two ends of its life, because both of them are ways to lose the row again.
 */
describe('selectPendingChat', () => {
  it('has nothing to draw when nothing is in flight', () => {
    expect(selectPendingChat({}, [])).toBeNull()
  })

  it('draws a chat that has been started and has no id yet', () => {
    const opener = { ...turn('new:1'), prompt: 'when do the bins go out' }
    expect(selectPendingChat(index(opener), [])).toEqual({
      title: 'when do the bins go out',
      preview: '',
      status: 'Sending',
    })
  })

  /*
   * The distinction a whole day went into making by hand.
   *
   * "Sending" means nothing is known to have left the panel. Once the server has named the turn, the
   * wait is an agent thinking — which can honestly run to the better part of a minute — and saying
   * the same word for both left no way to tell a turn that was working from one that was never going
   * anywhere.
   */
  it('separates a turn still going out from one being thought about', () => {
    const sending = turn('new:1')
    expect(selectPendingChat(index(sending), [])?.status).toBe('Sending')

    const thinking = { ...turn('new:2'), opened: true }
    expect(selectPendingChat(index(thinking), [])?.status).toBe('Thinking')
  })

  it('shows the reply as it arrives', () => {
    const opener = { ...turn('new:1'), started: true, text: 'Thursday, and the' }
    expect(selectPendingChat(index(opener), [])?.status).toBe('Replying')
    expect(selectPendingChat(index(opener), [])?.preview).toBe('Thursday, and the')
  })

  /** Nothing was stored, so this row is the only place the member's words still exist. */
  it('keeps drawing a turn that failed, and says so', () => {
    const failed = { ...turn('new:1'), error: 'The assistant is unreachable right now.' }
    expect(selectPendingChat(index(failed), [])).toEqual({
      title: 'when do the bins go out',
      preview: 'The assistant is unreachable right now.',
      status: 'Failed',
    })
  })

  /**
   * The id arrives on the stream's last event; the list that will carry the real row is a round trip
   * behind it. Standing down here would blank the row for the length of that trip.
   */
  it('holds on after the id lands, until the real row is in the list', () => {
    const landed = { ...turn('new:1', 12), done: true }
    expect(selectPendingChat(index(landed), [])?.status).toBe('Just now')
    expect(selectPendingChat(index(landed), [3, 12])).toBeNull()
  })

  it('titles the chat from the opening message, not the last one', () => {
    const opener = { ...turn('new:1'), prompt: 'when do the bins go out' }
    const queued = { ...turn('new:1'), prompt: 'and the recycling?', queued: true }
    expect(selectPendingChat(index(opener, queued), [])?.title).toBe('when do the bins go out')
  })
})
