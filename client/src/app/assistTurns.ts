import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../api/client'
import type { AssistStreamHandlers } from '../api/client'
import { beginFirstPaint } from './firstPaint'

/**
 * Every turn currently being written — or waiting to be — wherever the household happens to be
 * standing.
 *
 * <b>A turn belongs to the app, not to the screen that started it.</b> It used to live in the chat
 * screen's own state, which meant leaving that screen unmounted the hook, the unmount aborted the
 * request, and the abort was the only thing telling the server anything — so walking to the Weather
 * tab while a reply was being written threw the message away. Nothing is stored until a turn ends,
 * so there was nothing left to come back to: not the reply, not the member's own words.
 *
 * Hoisting it here is the fix. The store is mounted above the router, so navigation cannot reach it,
 * and the chat screen becomes a *view* of a turn rather than its owner — it renders whatever is in
 * flight for the conversation it is showing, and finds it still there when it comes back. Stopping a
 * turn is now an explicit request the member makes ({@link TurnState.cancelTurn}), which is what lets
 * the server tell "they pressed Stop" apart from "the panel went to sleep".
 *
 * <b>A chat can hold more than one.</b> There used to be exactly one turn per conversation, and the
 * composer was disabled for the whole time a reply was arriving — so a follow-up thought had to be
 * held in your head until the agent stopped talking, which is not how anybody actually converses.
 * Now a chat holds a short queue: a message sent mid-reply goes on screen immediately and is sent the
 * moment the turn ahead of it finishes. Strictly one at a time and strictly in order, because that
 * is what the other end is — a Hermes session is sequential, and the server holds a per-conversation
 * lock besides. Queueing here rather than firing both is the difference between a queue you can see
 * and two requests contending for the same lock behind the panel's back.
 */
export interface AssistTurn {
  /** Identity within this store. Unique per turn, and never re-filed — see {@link selectTurns}. */
  key: string
  /**
   * The chat this turn belongs to *on this panel* — `c:<id>`, or `new:<n>` before there is an id.
   *
   * Distinct from {@link conversationId} because it has to exist before that does: turns queued
   * behind the first message of a brand-new chat need something to queue behind, and the id they
   * will eventually share does not exist until the first of them lands.
   */
  group: string
  /** Creation order across the whole store. What puts a chat's turns in the order they were sent. */
  seq: number
  /**
   * The chat this turn belongs to.
   *
   * Null until a new chat's first turn lands and the server names it — at which point every turn
   * queued behind it in the same group is told too. The chat screen watches this: a turn started on
   * `/assist/c` navigates to its real route the moment one exists.
   */
  conversationId: number | null
  /** What the member said. On screen immediately, before anything has been sent. */
  prompt: string
  /** What they handed over with it, or null. On screen from the same moment, and for the same reason. */
  attachment: TurnAttachment | null
  /** The reply so far. Grows as deltas arrive. */
  text: string
  /**
   * The agent's working so far — what it is reasoning through on the way to the reply.
   *
   * <b>Never part of {@link text}.</b> Reasoning contradicts itself and abandons conclusions, so
   * folding it in would put sentences the agent decided not to say into the transcript. It is
   * collected whether or not anybody has asked to see it, and drawn only for a member who has
   * (`assistPrefs`) — which keeps the toggle instant rather than something that takes effect on the
   * turn after next.
   *
   * Empty for most agents. A model with no exposed reasoning simply never sends any, which is not a
   * failure state and draws as nothing at all.
   */
  thinking: string
  /** A house tool the agent is running right now, or null. */
  tool: string | null
  /** True once the first character has arrived — the moment the panel stops looking asleep. */
  started: boolean
  /**
   * True once the server has named the turn — it is on the other end and being worked on.
   *
   * <b>The difference between two waits that looked identical.</b> Before the server says `open`,
   * nothing is known to have left the panel; after it, an agent is thinking and the wait is honest.
   * Both used to draw as the word "Sending", so a turn that never went out and a turn that was
   * taking forty seconds to reason were the same sentence — and a morning went into telling them
   * apart by reading server logs, which is not a thing anybody standing at a panel can do.
   */
  opened: boolean
  /**
   * Sent by the member, not yet sent to the agent: there is a turn ahead of it in this chat.
   *
   * On screen from the moment it is typed. A queued message that stayed invisible until its turn
   * came would look exactly like one that had not been accepted.
   */
  queued: boolean
  /**
   * The connection died and the panel is asking the server what became of the turn.
   *
   * Not an error, and deliberately not drawn as one — see {@link useAssistTurns} for what this is
   * for. The member's words and whatever reply had arrived stay on screen throughout.
   */
  recovering: boolean
  /**
   * The reply is complete and this turn is waiting to be handed over to the stored transcript.
   *
   * It stays on screen through that wait. Clearing on completion blanks the reply until the reload
   * lands, so the answer somebody is mid-sentence through vanishes and comes back.
   */
  done: boolean
  /** The member pressed Stop and the turn is winding down. The control is gone; the text is not. */
  stopping: boolean
  /**
   * The stored reply this turn became, or 0 if nothing was stored.
   *
   * How the screen knows the transcript has actually caught up — it looks for this id among the
   * loaded messages. It used to compare message *counts* against a mark taken when the turn started,
   * which cannot survive the screen being unmounted halfway through: the mark came back as zero and
   * the turn settled into a gap.
   */
  messageId: number
  /** Why the reply stops where it does — `stop`, `incomplete`, `length`, `interrupted`. */
  outcome: string | null
  /** Set when the turn failed outright. Nothing was stored, so `prompt` is the only copy. */
  error: string | null
}

/**
 * What was handed over with a turn, as the store carries it.
 *
 * Structurally the composer's draft minus the bytes it no longer needs to keep — see
 * `screens/assist/attachments.ts`. The store holds it for two reasons: it has to travel with the
 * turn to the server, and it has to stay on screen underneath the member's words for as long as the
 * turn does, including through a queue and through a reconnect.
 */
export interface TurnAttachment {
  kind: 'image' | 'text'
  name: string
  bytes: number
  base64: string | null
  mediaType: string | null
  text: string | null
  /** An object URL for the thumbnail. Owned by whoever created it; the store only passes it along. */
  preview: string | null
  /**
   * EXIF `DateTimeOriginal` as an ISO instant, or null — read before the downscale that would have
   * stripped it. Travels with the turn because the write that keeps the photograph happens later,
   * from the confirm sheet, and by then the original file is long gone.
   */
  takenAt: string | null
}

/** The one send path, from the provider. */
type StreamFn = (
  prompt: string,
  conversationId: number | null,
  handlers: AssistStreamHandlers,
  signal?: AbortSignal,
  attachment?: TurnAttachment | null,
) => Promise<void>

export interface TurnState {
  /** Everything in flight or queued, keyed by {@link AssistTurn.key}. */
  turns: Record<string, AssistTurn>
  /**
   * Send a turn, or queue it behind one already running in the same chat.
   *
   * Resolves `true` if the reply landed and `false` if it did not. The chat screen no longer acts on
   * that answer — a failed turn keeps the member's words on screen where they can be retried, which
   * is better than pushing them back into a composer somebody may since have started typing in — but
   * the awaited, non-streaming path still needs to know.
   */
  runTurn: (
    conversationId: number | null,
    prompt: string,
    attachment?: TurnAttachment | null,
  ) => Promise<boolean>
  /** Stop a turn and take it off the screen. The member's decision, and the only thing that cancels. */
  cancelTurn: (key: string) => void
  /** Hand a finished turn over to the stored transcript. No-op unless it is finished. */
  settleTurn: (key: string) => void
  /** Dismiss a failed turn, or drop one still waiting its turn. */
  clearTurn: (key: string) => void
  /** Send a failed turn's words again, as a fresh turn in the same chat. */
  retryTurn: (key: string) => Promise<boolean>
}

const keyFor = (conversationId: number) => `c:${conversationId}`

/** Turns started before their chat had an id. Their group never changes — see {@link selectTurns}. */
const UNNAMED = 'new:'

/**
 * The turns in flight for a conversation, oldest first.
 *
 * <b>A turn keeps the group it was born with.</b> A chat with no id has nothing to key on, so its
 * turns are found by being unnamed — and they go on being found that way after the first one lands,
 * because the render in which it lands is the render the screen learns where to navigate to.
 * Re-filing them under the new id at that moment made them vanish from the screen still asking for
 * them, and the reply blinked out with it.
 *
 * A chat that has an id therefore collects its own group *and* the unnamed group that opened it —
 * which is the one still on screen while the transcript catches up.
 */
export function selectTurns(
  turns: Record<string, AssistTurn>,
  conversationId: number | null,
): AssistTurn[] {
  const all = Object.values(turns)
  const mine = conversationId === null
    // Newest group wins. Any older one belongs to a chat that has since been named and navigated to.
    ? all.filter((t) => t.group === newestUnnamedGroup(all))
    : all.filter((t) => t.group === keyFor(conversationId) || t.conversationId === conversationId)
  return mine.sort((a, b) => a.seq - b.seq)
}

/** A chat the inbox can list before the server has one to list. */
export interface PendingChat {
  /** The member's opening message, which is also what the chat will be named after. */
  title: string
  /** The reply so far, or what went wrong. */
  preview: string
  /**
   * Where a stored row shows a time.
   *
   * Four waits, not one. <b>Sending</b> is the only one where nothing is known to have reached the
   * server, and it is the one that used to cover all of them — including a turn the agent had been
   * reasoning over for a minute, and a turn that was never going anywhere. They are different
   * situations and only one of them is worth worrying about.
   */
  status: 'Sending' | 'Thinking' | 'Replying' | 'Just now' | 'Failed'
}

/**
 * The chat that has been started but does not exist yet, for the inbox to draw.
 *
 * <b>Nothing is written until a turn ends.</b> The server persists a conversation on the way out of
 * the stream (`AssistController.StreamChat`), which is deliberate — the member's words and the reply
 * land together, so there is no half-chat to reconcile if the panel dies mid-answer. The cost is a
 * window: type a first message, go back to the inbox before the agent has finished, and the list has
 * nothing to show, because as far as the database is concerned the chat has not happened. The turn is
 * fine — it lives here, above the router — but with no row for it there is no way back in, and the
 * only cure was waiting on a screen you had already left.
 *
 * Reads the same group {@link selectTurns} gives `/assist/c`, so the row and the route cannot
 * disagree about which chat it is.
 *
 * <b>It stands down when the real row arrives, not when the id does.</b> Those are different moments
 * — the id comes back on the stream's last event, and the list that will carry the row is a round
 * trip behind it. Standing down on the id leaves a gap where the chat is in neither place, which is
 * the same disappearing act this exists to fix, only shorter.
 */
export function selectPendingChat(
  turns: Record<string, AssistTurn>,
  knownIds: readonly number[],
): PendingChat | null {
  const group = selectTurns(turns, null)
  if (group.length === 0) return null

  const landed = group.find((t) => t.conversationId !== null)?.conversationId ?? null
  if (landed !== null && knownIds.includes(landed)) return null

  const first = group[0]
  const last = group[group.length - 1]
  return {
    title: first.prompt,
    preview: last.error ?? last.text,
    status: last.error ? 'Failed'
      : last.done ? 'Just now'
      : last.started ? 'Replying'
      : last.opened ? 'Thinking'
      : 'Sending',
  }
}

/** The most recently opened unnamed chat, by the newest turn in it. */
function newestUnnamedGroup(all: AssistTurn[]): string | null {
  let newest: AssistTurn | null = null
  for (const t of all) {
    if (!t.group.startsWith(UNNAMED)) continue
    if (!newest || t.seq > newest.seq) newest = t
  }
  return newest?.group ?? null
}

/**
 * How long the panel keeps asking what became of a turn whose stream it lost.
 *
 * Generous, because the thing being waited on is an agent that may be running tools, and the whole
 * point is to outlast a phone that was asleep for part of it. It ends: a panel that has been asking
 * for four minutes is one whose server is not coming back, and at that point saying so is more use
 * than a spinner.
 */
const RECOVERY_WINDOW_MS = 4 * 60_000

/** How often to ask, while waiting. Not urgent — nobody is watching a screen that is not on. */
const RECOVERY_POLL_MS = 2_500

/**
 * Wait — but wake early if the panel comes back to the foreground.
 *
 * A hidden tab's timers are throttled to about one a minute, which is fine while nobody is looking
 * and exactly wrong at the moment somebody is: the case this whole mechanism exists for ends with a
 * member reopening the app to see their answer, and making them watch a stale screen for the
 * remainder of a throttled minute would undo most of the repair.
 */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
      resolve()
    }
    const onVisible = () => { if (document.visibilityState === 'visible') finish() }
    const timer = window.setTimeout(finish, ms)
    document.addEventListener('visibilitychange', onVisible)
  })
}

/**
 * Drives every turn, at the pace of the screen rather than of the network.
 *
 * <b>The first delta paints immediately; the rest are batched to one repaint per frame.</b> That
 * split is the whole design. A token-per-render stream on a wall panel spends its time laying out
 * text nobody has read yet, and on a 4K portrait display that is visible as jitter — but delaying the
 * *first* character to join a batch would add latency to the only moment the household is actually
 * waiting, which is the number worth protecting.
 *
 * <b>A dead connection is not a dead turn.</b> The server finishes and stores a turn whose reader has
 * gone — that is what `TurnRegistry` is for — but this end used to have no way of finding that out.
 * It saw a failed read, said "the assistant is unreachable right now", and handed the member their
 * message back to send again. On a phone that was the *ordinary* path, not an edge case: backgrounding
 * the app freezes its network within seconds, so every reply asked for just before the screen went off
 * came back as a failure over a turn that had in fact been answered — and re-sending it asked the
 * agent to redo work it had already done, which is how the household ends up reading "I have already
 * done this" and concluding the panel is broken.
 *
 * So a stream that breaks after the server has named the turn is now a reason to *ask*, not to give
 * up: the turn goes into {@link AssistTurn.recovering} and the panel polls for its outcome until it
 * has one. Only a turn that was never named — nothing reached the server at all — fails outright.
 */
export function useAssistTurns(stream: StreamFn, agentKey: string | null): TurnState {
  const [turns, setTurns] = useState<Record<string, AssistTurn>>({})
  // Read by `runTurn`, which must not be rebuilt on every delta — it is a dependency of the composer's
  // submit handler, and an identity that churns per token churns the whole chat screen with it.
  const turnsRef = useRef(turns)
  turnsRef.current = turns

  const controllers = useRef(new Map<string, AbortController>())
  /** The server's name for each live turn, so Stop — and recovery — have something to ask about. */
  const turnIds = useRef(new Map<string, string>())
  /**
   * Which turns have painted a character.
   *
   * A ref rather than a read of state inside the delta handler: deciding "first delta or not" has to
   * be a decision, made once, and a state updater is not the place for one — React may run it twice.
   */
  const started = useRef(new Set<string>())
  const buffers = useRef(new Map<string, string>())
  /**
   * Reasoning waiting for the next repaint.
   *
   * Its own buffer rather than a second field on the reply's, because it is a different stream with
   * a different destination and mixing them is precisely the mistake to avoid. It shares the frame,
   * though: reasoning arrives faster than the reply and a repaint per token of it would cost more
   * than the reply's own.
   */
  const thoughts = useRef(new Map<string, string>())
  const frame = useRef<number | null>(null)
  /** Distinguishes successive turns, and successive unnamed chats. Never shown. */
  const seq = useRef(0)
  /**
   * One promise chain per chat, which is what makes the queue a queue.
   *
   * A turn is appended to its group's chain and runs when everything ahead of it has finished. The
   * ordering is the product, not a side effect: replies to a conversation arriving out of the order
   * the questions were asked in would be worse than making the second question wait.
   */
  const chains = useRef(new Map<string, Promise<boolean>>())

  // The agent is read when a turn starts, which must not rebuild `runTurn` — see above.
  const agentRef = useRef(agentKey)
  agentRef.current = agentKey

  const flush = useCallback(() => {
    frame.current = null
    if (buffers.current.size === 0 && thoughts.current.size === 0) return
    const batch = buffers.current
    const thinkBatch = thoughts.current
    buffers.current = new Map()
    thoughts.current = new Map()

    setTurns((prev) => {
      let next: Record<string, AssistTurn> | null = null
      for (const [key, text] of batch) {
        const turn = (next ?? prev)[key]
        if (!turn) continue
        next ??= { ...prev }
        next[key] = { ...turn, text: turn.text + text, started: true }
      }
      for (const [key, thinking] of thinkBatch) {
        const turn = (next ?? prev)[key]
        if (!turn) continue
        next ??= { ...prev }
        // Not `started`. That flag means the *reply* has begun — it is what stops the caret pulsing
        // and what the first-paint measurement is about — and an agent that has been reasoning for
        // ten seconds has not started answering.
        next[key] = { ...turn, thinking: turn.thinking + thinking }
      }
      return next ?? prev
    })
  }, [])

  // The app is going away — stop reading. This does not stop the turns: the server finishes them and
  // writes them down, which is the entire point of the split.
  useEffect(() => () => {
    for (const controller of controllers.current.values()) controller.abort()
    if (frame.current !== null) cancelAnimationFrame(frame.current)
  }, [])

  const forget = useCallback((key: string) => {
    controllers.current.delete(key)
    turnIds.current.delete(key)
    started.current.delete(key)
    buffers.current.delete(key)
    thoughts.current.delete(key)
  }, [])

  const patch = useCallback((key: string, change: Partial<AssistTurn>) => {
    setTurns((prev) => (prev[key] ? { ...prev, [key]: { ...prev[key], ...change } } : prev))
  }, [])

  const drop = useCallback((key: string) => {
    forget(key)
    // Out of the ref too, for the reason `runTurn` puts it there: a turn dropped before its chain
    // reaches it — Stop on something still queued — must not be found and sent by the `execute` that
    // arrives a microtask later, and must not go on counting as this chat being busy.
    if (turnsRef.current[key]) {
      const without = { ...turnsRef.current }
      delete without[key]
      turnsRef.current = without
    }
    setTurns((prev) => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }, [forget])

  /**
   * Record where a finished turn landed.
   *
   * The key does not change — {@link selectTurns} says why. A `conversationId` of zero means nothing
   * was stored (the household has conversation storage off), and must not overwrite an id the turn
   * already had.
   *
   * The id is also handed to everything queued behind it in the same new chat. Those turns were sent
   * before anybody knew where they were going; this is the moment they find out, and without it they
   * would be left pointing at a conversation that no longer needs opening.
   */
  const landed = useCallback((key: string, conversationId: number, messageId: number, outcome: string) => {
    setTurns((prev) => {
      const turn = prev[key]
      if (!turn) return prev
      const id = conversationId || turn.conversationId

      const next = { ...prev }
      next[key] = { ...turn, conversationId: id, messageId, outcome, done: true, recovering: false }

      if (id !== null && turn.group.startsWith(UNNAMED)) {
        for (const other of Object.values(prev)) {
          if (other.group === turn.group && other.key !== key && other.conversationId === null) {
            next[other.key] = { ...other, conversationId: id }
          }
        }
      }
      return next
    })
  }, [])

  /**
   * Ask the server what became of a turn this panel stopped being able to hear.
   *
   * Returns true when it found out — at which point the reply on screen is replaced with the server's
   * copy, which is the whole answer rather than the prefix that arrived before the connection died.
   *
   * A 404 ends it: this process has never heard of the turn, or has forgotten it, or it belongs to
   * somebody else. All three mean the same thing to the panel — stop asking, and read the stored
   * transcript like any other chat.
   */
  const recover = useCallback(async (key: string, turnId: string): Promise<boolean> => {
    patch(key, { recovering: true, tool: null })
    const deadline = Date.now() + RECOVERY_WINDOW_MS

    for (;;) {
      await pause(RECOVERY_POLL_MS)

      try {
        const state = await api.getAssistTurn(turnId)
        if (state.status === 'done') {
          // The server's text, not ours. What arrived before the drop is a prefix of it at best, and
          // showing a prefix as the finished answer is exactly the failure this is repairing.
          patch(key, { text: state.text ?? '', started: true, recovering: false })
          landed(key, state.conversationId, state.messageId, state.finishReason ?? 'stop')
          // The turn may have written to a list or a thermostat while nobody was connected.
          if (state.action) window.dispatchEvent(new Event('homehub:sync'))
          return true
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return false
        if (!(err instanceof ApiError)) throw err
        // Anything else is the panel still being offline. Keep asking until the window closes.
      }

      if (Date.now() > deadline) return false
    }
  }, [patch, landed])

  /**
   * On coming back to the foreground, check whether anything "in flight" actually finished.
   *
   * <b>The half a broken read cannot cover.</b> Recovery hangs off the stream failing, and a frozen
   * connection does not always fail — an operating system that suspends a background tab may leave
   * the read hanging rather than erroring it, so the panel comes back to a caret pulsing under a turn
   * the server finished minutes ago and nothing will ever say otherwise. That is the same wrong
   * answer as the one this all exists to fix, arriving by a quieter route.
   *
   * So the moment the panel is looked at again, every turn it believes is live is checked by name. A
   * turn the server says is still running is left alone; one it says has finished is taken from the
   * registry and the stale read is abandoned. A failed check means the panel is still offline, which
   * changes nothing — the stream keeps whatever chance it had.
   */
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return

      for (const turn of Object.values(turnsRef.current)) {
        if (turn.done || turn.error || turn.queued || turn.recovering) continue
        const turnId = turnIds.current.get(turn.key)
        if (!turnId) continue

        void (async () => {
          let state
          try {
            state = await api.getAssistTurn(turnId)
          } catch {
            return // Offline, or the server has forgotten it. Neither is worth acting on.
          }
          if (state.status !== 'done') return
          // Won the race with a stream that was about to deliver the same thing. Nothing to do, and
          // aborting would be pulling the rug from under a turn that is already landing.
          if (turnsRef.current[turn.key]?.done !== false) return

          // Abandoned rather than left to hang. `execute` reads this as an abort — the member's own
          // Stop looks identical from there — so it will not overwrite what lands below with an error.
          controllers.current.get(turn.key)?.abort()

          patch(turn.key, { text: state.text ?? turn.text, started: true, tool: null })
          landed(turn.key, state.conversationId, state.messageId, state.finishReason ?? 'stop')
          if (state.action) window.dispatchEvent(new Event('homehub:sync'))
        })()
      }
    }

    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [patch, landed])

  /**
   * Actually send one turn. Called by the group's chain when everything ahead of it has finished.
   *
   * Reads the turn out of the store rather than taking its prompt as an argument, for one reason
   * that matters: a turn queued behind the first message of a new chat was created before that chat
   * had an id, and by the time it runs it has one. The store is where that arrived.
   */
  const execute = useCallback(async (key: string): Promise<boolean> => {
    const turn = turnsRef.current[key]
    // Cancelled while it was waiting. Nothing was ever sent, so there is nothing to report.
    if (!turn) return true

    const controller = new AbortController()
    controllers.current.set(key, controller)
    patch(key, { queued: false })

    // Started before the request, not after: the wait the household feels begins at the tap. For a
    // queued turn that is the moment it reaches the front, which is the first moment it is waiting on
    // anything but the message ahead of it.
    const paint = beginFirstPaint(agentRef.current ?? 'unknown')

    let delivered = false
    try {
      await stream(
        turn.prompt,
        turn.conversationId,
        {
          onOpen: (turnId) => {
            turnIds.current.set(key, turnId)
            patch(key, { opened: true })
          },
          onDelta: (text) => {
            // First character: straight to the screen, no frame wait. Everything after it joins
            // the next repaint.
            if (!started.current.has(key)) {
              started.current.add(key)
              paint()
              patch(key, { text, started: true })
              return
            }
            buffers.current.set(key, (buffers.current.get(key) ?? '') + text)
            if (frame.current === null) frame.current = requestAnimationFrame(flush)
          },
          // Always batched — there is no first-character latency to protect here, because nobody is
          // waiting on the working the way they are waiting on the answer.
          onThinking: (text) => {
            thoughts.current.set(key, (thoughts.current.get(key) ?? '') + text)
            if (frame.current === null) frame.current = requestAnimationFrame(flush)
          },
          onTool: (tool, status) => patch(key, { tool: status === 'running' ? tool : null }),
          onDone: (result) => {
            if (frame.current !== null) {
              cancelAnimationFrame(frame.current)
              flush()
            }
            // Marked finished, not cleared. The screen hands it over once the stored transcript
            // contains it; until then this *is* the transcript's last turn.
            delivered = true
            landed(key, result.conversationId, result.messageId, result.finishReason)
          },
          onError: (message) => patch(key, { error: message, done: true }),
        },
        controller.signal,
        turn.attachment,
      )
    } catch {
      // The read died. Whatever arrived is already on screen — but "the connection failed" is not the
      // same statement as "the turn failed", and only one of them is true here. If the server got far
      // enough to name the turn, it is still writing it down, so ask.
      if (!controller.signal.aborted) {
        const turnId = turnIds.current.get(key)
        if (turnId && await recover(key, turnId)) {
          delivered = true
        } else {
          patch(key, {
            error: turnId
              ? 'The connection dropped and this panel could not find out how this ended. Open the chat again before re-sending.'
              : 'The assistant is unreachable right now. Please try again.',
            done: true,
            recovering: false,
          })
        }
      }
    }
    controllers.current.delete(key)

    // An aborted turn is not a failure: the member pressed Stop, and calling it one would read as the
    // panel refusing them.
    return delivered || controller.signal.aborted
  }, [stream, patch, flush, landed, recover])

  /**
   * The unnamed chat a new prompt should join, if there is one.
   *
   * Only a group whose turns have *all* still to land. Once the first has, the chat has an id and the
   * screen has navigated to it, so a prompt arriving with no id is a genuinely new chat — joining the
   * old group there would file it under a conversation somebody has already left.
   */
  const unnamedGroupToJoin = useCallback((): string | null => {
    const all = Object.values(turnsRef.current)
    const group = newestUnnamedGroup(all)
    if (!group) return null
    return all.every((t) => t.group !== group || t.conversationId === null) ? group : null
  }, [])

  const runTurn = useCallback(
    (conversationId: number | null, prompt: string, attachment: TurnAttachment | null = null): Promise<boolean> => {
      const group = conversationId === null
        ? unnamedGroupToJoin() ?? `${UNNAMED}${++seq.current}`
        : keyFor(conversationId)

      const mySeq = ++seq.current
      const key = `${group}#${mySeq}`

      // Queued when this chat is already busy. An errored turn does not count as busy — it is on
      // screen waiting to be retried or dismissed, and nothing is coming that the next message has
      // any reason to wait for.
      const waiting = Object.values(turnsRef.current)
        .some((t) => t.group === group && !t.error && !t.done)

      const created: AssistTurn = {
        key, group, seq: mySeq, conversationId, prompt, attachment,
        text: '', thinking: '', tool: null, started: false, opened: false, queued: waiting,
        recovering: false, done: false, stopping: false, messageId: 0, outcome: null, error: null,
      }

      /*
       * Into the ref as well as into state, and into the ref first.
       *
       * `execute` reads the turn back out of `turnsRef` when the chat's chain reaches it, and the
       * first link of that chain is a microtask. Where React schedules the re-render as a *task*
       * instead — an update raised from an effect, which is exactly how the inbox hands a prompt to
       * the chat screen — the lookup ran before the render that would have put the turn there.
       *
       * What that cost was invisible: `execute` found nothing, read it as "cancelled while it
       * waited", and returned success having sent nothing. No request, no error, and a turn sitting
       * on Sending for ever with the rest of the chat's queue stacked behind it, because `queued` is
       * cleared by the same call that never ran. The same message typed inside an open chat went out
       * fine — a tap is a discrete event, React flushes those in a microtask of their own, and that
       * microtask is queued before this one. Two paths, one of them racing, and which one won varied
       * by device.
       *
       * The ref is a mirror of state, so seeding it costs nothing: the next render overwrites it with
       * the committed value, which by then says the same thing. It also makes `waiting` above honest
       * for a second turn raised in the same tick as the first — it could not see it either.
       */
      turnsRef.current = { ...turnsRef.current, [key]: created }
      setTurns((prev) => ({ ...prev, [key]: created }))

      // Appended to this chat's chain either way — `execute` is what a failure ahead of it resolves
      // into, so a turn is never stranded behind one that went wrong.
      const ahead = chains.current.get(group) ?? Promise.resolve(true)
      const mine = ahead.then(() => execute(key), () => execute(key))
      chains.current.set(group, mine)
      // Let the chain go once nothing is behind this turn, so a long-lived panel does not accumulate
      // one resolved promise per conversation it has ever spoken to.
      void mine.finally(() => { if (chains.current.get(group) === mine) chains.current.delete(group) })

      return mine
    },
    [execute, unnamedGroupToJoin],
  )

  /**
   * Stop a turn.
   *
   * <b>Asked, not hung up on.</b> Those are different things, and hanging up is the one that loses
   * the half-written reply: the connection dies, the `done` frame that would have carried the text
   * into the transcript never arrives, and the answer blanks off the screen only to reappear the next
   * time the chat is opened. Asking by name lets the turn end the way every other turn ends — the
   * partial reply stays on screen, the server writes it down, and `done` says `interrupted` so the
   * panel knows not to present it as finished.
   *
   * The read is only aborted when there is no name to ask by, which means the stream had not opened
   * yet — or the turn had not been sent at all, because it was still in the queue — and there is
   * nothing written to lose either way.
   */
  const cancelTurn = useCallback((key: string) => {
    const turnId = turnIds.current.get(key)
    if (!turnId) {
      controllers.current.get(key)?.abort()
      drop(key)
      return
    }
    void api.cancelAssistTurn(turnId)
    // The control goes at the tap. A Stop that stays lit while the turn winds down reads as one that
    // did not register, and gets pressed again.
    patch(key, { stopping: true })
  }, [drop, patch])

  const settleTurn = useCallback((key: string) => {
    // Checked before anything is torn down. Forgetting unconditionally would take the abort handle
    // and the server's name for the turn away from one still being written, and the Stop under it
    // would quietly stop working.
    if (!turnsRef.current[key]?.done) return
    forget(key)
    setTurns((prev) => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }, [forget])

  /**
   * Send a failed turn's words again.
   *
   * The replacement for putting them back in the composer. A failed turn is the only copy of what
   * somebody said, and the old repair — refilling the field — could land on top of a message they had
   * started typing since, which is a worse way to lose it than the one it was fixing.
   */
  const retryTurn = useCallback((key: string): Promise<boolean> => {
    const turn = turnsRef.current[key]
    if (!turn) return Promise.resolve(false)
    drop(key)
    // The attachment goes with it. A retry that dropped the picture would send a question about
    // something the agent can no longer see, which reads as the agent having forgotten it.
    return runTurn(turn.conversationId, turn.prompt, turn.attachment)
  }, [drop, runTurn])

  return { turns, runTurn, cancelTurn, settleTurn, clearTurn: drop, retryTurn }
}
