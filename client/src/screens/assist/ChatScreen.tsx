import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router'
import { ScreenShell } from '../../components/ScreenShell'
import { DrillInHeader } from '../../components/DrillInHeader'
import { useAssist, useConversation } from '../../app/AssistProvider'
import { useSession } from '../../app/SessionProvider'
import { useVoice } from '../../app/VoiceProvider'
import { Icon } from '../../icons/Icon'
import { useShowThinking } from '../../app/useShowThinking'
import { ApiError } from '../../api/client'
import type { ConversationMessage } from '../../api/types'
import { AssistComposer } from './AssistComposer'
import { MessageText } from './MessageText'
import { sizeLabel } from './attachments'
import { takeHandoffAttachment } from './handoff'
import { RenameChat } from './RenameChat'
import { useStreamedTurn } from './useStreamedTurn'
import { WaitingWord } from './WaitingWord'
import type { PendingTurn } from './useStreamedTurn'
import { useScrollEdge } from './useScrollEdge'
import { turnTime } from './assistTime'

/**
 * One conversation — the transcript, lifted from the Attendant overlay's conversation view.
 *
 * What carried over unchanged: the IT TOUCHED receipt and the Speaking indicator. Both were doing
 * real work on the old surface — the receipt is what a shared panel owes anyone who reads a reply
 * they did not ask for.
 *
 * The per-turn origin tag did not survive contact with Hermes; {@link Turn} says why.
 *
 * What changed is where it lives: a route rather than a modal, so leaving goes back to the inbox
 * instead of returning to whatever screen was interrupted.
 *
 * @category Screen
 */
export function ChatScreen() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { agent, agents, refresh, patch } = useAssist()
  const { activeProfile } = useSession()
  const { speaking, stopSpeaking } = useVoice()
  const { showThinking } = useShowThinking()
  const [renaming, setRenaming] = useState(false)

  const { state } = useLocation()

  const conversationId = id ? Number(id) : null
  const { conversation, messages, loading, reload } = useConversation(conversationId)
  const { pending, live, run, cancel, settle, dismiss, retry } = useStreamedTurn(conversationId)
  const { ref: scrollRef, more, measure } = useScrollEdge<HTMLDivElement>()

  /** The turn that opened this chat, which is the one that knows where the chat went. */
  const opener = pending[0] ?? null
  /** Turns that finished and are waiting for the ledger to catch up. */
  const settled = pending.filter((t) => t.done && !t.error)

  /**
   * The first turn of a chat started from the inbox.
   *
   * The inbox composer hands the prompt over rather than sending it, so this screen is on screen
   * with the member's own words on it before the request has even gone out. Guarded by a ref rather
   * than by clearing the router state: the navigation that gives this chat its id replaces the
   * history entry the prompt arrived on, so there is no entry left to come back to and re-send from.
   */
  const handoff = (state as { prompt?: string } | null)?.prompt
  const handedOff = useRef(false)
  useEffect(() => {
    if (handedOff.current) return
    // Collected whether or not there are words, and *before* the guard below: a turn can be an
    // attachment on its own, and a slot left full would attach itself to whatever chat was started
    // next.
    const attached = takeHandoffAttachment()
    if (!handoff && !attached) return
    handedOff.current = true
    void run(handoff ?? '', attached)
  }, [handoff, run])

  /**
   * A new chat, once the server has named it.
   *
   * Watched rather than handed back through a callback: the turn outlives this screen now, so the
   * moment it lands is not necessarily a moment this screen is mounted for — and a callback closing
   * over a `navigate` from a screen nobody is on is a navigation nobody asked for. Replace rather
   * than push, so Back goes to the inbox instead of to an empty composer that would immediately
   * start another.
   */
  useEffect(() => {
    if (conversationId === null && opener?.conversationId) {
      navigate(`/assist/c/${opener.conversationId}`, { replace: true })
    }
  }, [conversationId, opener?.conversationId, navigate])

  // The stored transcript, once a turn is in it. Only for a chat that already existed — a new one
  // navigates above, and the screen it lands on loads its own.
  //
  // Keyed on how many turns have finished rather than on a boolean, so a queue of three reloads three
  // times: each reply is stored as it lands, and a flag that was already true when the second one
  // finished would leave the transcript a turn behind for as long as the queue kept it that way.
  const finishedCount = settled.length
  useEffect(() => {
    if (conversationId !== null && finishedCount > 0) void reload()
  }, [conversationId, finishedCount, reload])

  /**
   * Hand each finished turn over once the stored transcript actually contains it.
   *
   * Matched on the reply's own id rather than on the transcript growing past a mark taken when the
   * turn began. The mark could not survive this screen being unmounted halfway through — it came
   * back as zero, every stored turn counted as growth, and the reply settled into a gap before the
   * reload that would have filled it.
   *
   * A `messageId` of zero means nothing was stored (the household has conversation storage off), so
   * that turn is the only copy of the reply there is and it stays on screen.
   */
  useEffect(() => {
    for (const turn of pending) {
      if (!turn.done || turn.error || turn.messageId === 0) continue
      if (messages.some((m) => m.id === turn.messageId)) settle(turn.key)
    }
  }, [pending, messages, settle])

  /**
   * Whether the end of the conversation is what the reader is looking at.
   *
   * <b>Following the newest line is a default, not a rule.</b> It used to be a rule: every render
   * scrolled the box to the bottom, so a reply arriving over twenty seconds dragged the view down
   * with it and there was no way to read the beginning of a long answer until it had finished. The
   * one thing you want to do with a long answer — start reading it — was the one thing the screen
   * would not let you do.
   *
   * So scrolling up is taken as what it plainly is: a decision to look at something other than the
   * end. It holds until the reader goes back to the bottom themselves, or taps the control that does
   * it for them.
   *
   * A ref rather than state: this is read on every batch of deltas and written on every scroll
   * event, and neither is a reason to re-render a transcript. What the *jump control* renders from
   * is `more` from `useScrollEdge`, which answers the same question and is already state.
   */
  const pinned = useRef(true)

  useEffect(() => {
    const box = scrollRef.current
    if (!box) return
    // Same pixel of slack as `useScrollEdge`, and for the same reason: a box scrolled fully down
    // routinely lands a fraction short.
    const track = () => { pinned.current = box.scrollTop + box.clientHeight >= box.scrollHeight - 1 }
    /**
     * Keep the newest turn in view when the *box* changes size rather than the content.
     *
     * On a phone the software keyboard shortens the layout viewport, and the transcript is the
     * section that gives up the room (the type stays the size it was — `app/remScale.ts`). Nothing
     * above reacts to that: the box gets shorter, `scrollTop` stays where it was, and the reply you
     * were reading slides up behind the composer at the exact moment you start answering it.
     */
    const repin = () => { if (pinned.current) box.scrollTo({ top: box.scrollHeight, behavior: 'auto' }) }
    track()
    box.addEventListener('scroll', track, { passive: true })
    const observer = new ResizeObserver(repin)
    observer.observe(box)
    return () => {
      box.removeEventListener('scroll', track)
      observer.disconnect()
    }
  }, [scrollRef])

  /**
   * Follow the newest turn — while the reader is still at the newest turn.
   *
   * A transcript that opens at the top makes you scroll to find out what happened, which is the
   * opposite of what you came for, so the default is the end. `auto` rather than `smooth` while a
   * reply is arriving: a smooth scroll re-targeted every frame never catches up with the text.
   *
   * The `pinned` check is what makes reading a long reply from the start possible at all — see the
   * ref above. It is read rather than depended on deliberately: this effect must run on every batch
   * of deltas, and must not itself be what decides to move the view.
   */
  useEffect(() => {
    if (pinned.current) {
      scrollRef.current?.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: pending ? 'auto' : 'smooth',
      })
    }
    // The content just changed height, which no scroll or resize event reports.
    measure()
  }, [messages, pending, scrollRef, measure])

  /** Back to the live end of the conversation, from wherever the reader had got to. */
  const jumpToEnd = useCallback(() => {
    const box = scrollRef.current
    if (!box) return
    pinned.current = true
    box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' })
  }, [scrollRef])

  // Opening a chat marks it read server-side, so the inbox badge behind this screen is now stale.
  useEffect(() => { void refresh() }, [refresh])

  // The agent this *conversation* belongs to, which is not necessarily the one selected in the
  // inbox: a chat's agent is fixed at its first message and never changes (the panel is shared, and
  // switching agents in the list must not relabel a transcript somebody else is reading).
  const owner = agents.find((a) => a.key === conversation?.agentKey)
  const agentName = owner?.name ?? agent?.name ?? 'Assist'
  const memberName = activeProfile?.name ?? 'You'
  const title = conversation?.title ?? (conversationId === null ? `New chat` : '')

  /**
   * Rename this chat.
   *
   * Goes through the provider's `patch` rather than the API directly, so the row in the inbox behind
   * this screen changes with it — the list is polled, and a title that took twenty seconds to catch
   * up would look like the rename had not saved.
   *
   * A failure puts the server's name back by reloading rather than by reverting to what was on
   * screen: the write may have landed and the response may have been what was lost, and guessing
   * wrong there would show the household a name their panel no longer holds.
   */
  const rename = useCallback(
    async (next: string) => {
      if (conversationId === null) return
      try {
        await patch(conversationId, { title: next })
      } catch (err) {
        if (!(err instanceof ApiError)) throw err
        // The provider renamed the row optimistically. Reloading the list is what puts the server's
        // answer back — including "it did not change", which is the whole point of doing it.
        await refresh()
      }
      await reload()
      setRenaming(false)
    },
    [conversationId, patch, refresh, reload],
  )

  return (
    <ScreenShell
      header={
        <DrillInHeader
          title={title}
          onBack={() => navigate('/assist')}
          status={agentName}
          // Only once the chat exists. A turn still in flight has no id to rename and no name worth
          // correcting — it is called "New chat" precisely because nothing has decided yet.
          onTitleClick={conversationId === null ? undefined : () => setRenaming(true)}
          titleAction="Rename this chat"
        />
      }
      avatarBadge={false}
    >
      {/* The fade lives on the wrapper, not the scroll box: it has to sit still while the text
          moves under it, and an overlay inside a scrolling element scrolls with the content. */}
      <div className={'ml-transcript__frame' + (more ? ' ml-transcript__frame--more' : '')}>
        <div className="ml-transcript" ref={scrollRef}>
          {loading && messages.length === 0 && <div className="ml-transcript__loading">Loading…</div>}

          {messages.map((m) => (
            <Turn key={m.id} turn={m} memberName={memberName} agentName={agentName} />
          ))}

          {/* The turns in flight — and, for a moment after each finishes, the turn that has arrived
              but is not in the ledger yet. Each hands over when the reloaded transcript contains it,
              never before: clearing on `done` blanked the reply until the reload landed, so the
              answer somebody was mid-sentence through vanished and came back.

              A list rather than one, because a chat can now hold a queue — see `useStreamedTurn`. */}
          {pending.map((turn) => (
            <PendingTurnView
              key={turn.key}
              turn={turn}
              memberName={memberName}
              agentName={agentName}
              showThinking={showThinking}
              onStop={() => cancel(turn.key)}
              onRetry={() => void retry(turn.key)}
              onDismiss={() => dismiss(turn.key)}
            />
          ))}

          {speaking && <SpeakingIndicator onStop={stopSpeaking} />}

          {/* The receipt, at the foot of the transcript where the last reply left it. */}
          <ItTouched messages={messages} />
        </div>

        {/*
          Back to the end, for a reader who left it.

          The other half of letting someone scroll up mid-reply: having stopped following a long
          answer, the way back used to be dragging through however much of it had arrived since.
          Shown on the same condition as the fade — there is content below — so the affordance and
          the signal that there is something to go to appear and disappear together.
        */}
        {more && (
          <button type="button" className="ml-transcript__jump" onClick={jumpToEnd}>
            Newest
            <span aria-hidden="true"> ↓</span>
          </button>
        )}
      </div>

      {/*
        Never disabled by a reply in progress.

        It used to be, and that was the rule the household kept running into: a follow-up thought had
        to be held in your head until the agent stopped talking. Now the message goes on screen as
        QUEUED and is sent the moment the turn ahead of it finishes (`app/assistTurns.ts`), which is
        both what the member meant and the only ordering the far end will accept anyway.
      */}
      <AssistComposer
        agentName={agentName}
        conversationId={conversationId}
        onStream={run}
        // The square's third reading. Only when there is nothing written — with something to send,
        // sending is what the square does, and the queue is what makes that possible mid-reply.
        replying={live !== null}
        onStop={() => { if (live) cancel(live.key) }}
      />

      {renaming && (
        <RenameChat title={title} onCancel={() => setRenaming(false)} onConfirm={rename} />
      )}
    </ScreenShell>
  )
}

/**
 * One stored turn: who, when, and what they said.
 *
 * **No origin tag.** There used to be a chip beside the agent's name reading `BARNABY` — the same
 * word, in caps, a few millimetres from itself. It was the surviving half of a `LOCAL` / `CLOUD`
 * privacy affordance, and the half that could not do that job: HomeHub cannot know whether a turn
 * Hermes answered left the house, because Hermes chooses the model, the provider and any fallback, so
 * the tag was reduced to naming the agent that the label already named. A duplicate is not a
 * safeguard. If Hermes ever reports locality authoritatively the claim can come back as something
 * that actually says it, in a form that is not a second copy of the name.
 */
function Turn({ turn, memberName, agentName }: {
  turn: ConversationMessage
  memberName: string
  agentName: string
}) {
  return (
    <div className={'ml-turn ml-turn--' + turn.role}>
      <div className="ml-turn__label">
        {turn.role === 'user' ? memberName : agentName}
        <span className="ml-turn__time">{turnTime(turn.atUtc)}</span>
        <CopyTurn text={turn.text} />
      </div>
      {turn.attachmentName && (
        <TurnAttachmentLine
          name={turn.attachmentName}
          kind={turn.attachmentKind}
          bytes={turn.attachmentBytes}
        />
      )}
      {turn.text && <div className="ml-turn__text"><MessageText text={turn.text} /></div>}
    </div>
  )
}

/**
 * What was handed over with a turn, named rather than shown.
 *
 * <b>The name, not the thing.</b> Nothing about an attachment is stored — not an image's bytes, not a
 * text file's contents; an attachment is sent, not kept. So a turn that carried a photo cannot show
 * it again, and the alternative to this line is the message reading as though the member had asked
 * about nothing at all. On a shared panel the person reading a turn is frequently not the one who
 * sent it, and a question about a picture with no sign of a picture is not a question.
 *
 * Drawn as a label rather than as an empty thumbnail, because a grey box where an image should be
 * reads as a failure to load — which invites somebody to reload a screen already showing them
 * everything it has.
 */
function TurnAttachmentLine({ name, kind, bytes }: {
  name: string
  kind: string | null
  bytes: number | null
}) {
  return (
    <div className="ml-turn__attachment">
      <Icon id={kind === 'image' ? 'ico-image' : 'ico-file'} size="0.875rem" />
      <span className="ml-turn__attachname">{name}</span>
      {bytes != null && <span className="ml-turn__attachsize">{sizeLabel(bytes)}</span>}
    </div>
  )
}

/**
 * Take this turn's words somewhere else.
 *
 * <b>Selection is not enough here.</b> The transcript now opts back into `user-select` so a reply
 * can be highlighted at all — but the surface this was written for is a wall panel with no keyboard,
 * where "select the text, then press Ctrl+C" describes a machine that is not in the room. Long-press
 * and drag on a 4K portrait display is a fiddly way to get an address out of an answer, and it is the
 * single most common reason to want one.
 *
 * So the gesture is a tap, and it copies the whole turn — which is almost always what was wanted,
 * and when it is not, the selection is still there to do the finer job.
 *
 * It sits in the label row rather than under the text: a control below a reply reads as being about
 * what comes next, and this is about what was just said. It says COPIED for a beat afterwards
 * because a clipboard write is otherwise completely invisible, and an action with no feedback gets
 * pressed again.
 */
function CopyTurn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  // Cleared on a timer that is cancelled if the turn unmounts first — a `setState` after unmount is
  // the classic way a transcript that scrolls fast starts logging warnings.
  useEffect(() => {
    if (!copied) return
    const id = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(id)
  }, [copied])

  // Nothing to copy, and nothing to draw. A turn can be empty — a reply that failed before its first
  // character still has a label.
  if (!text) return null

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      // No clipboard permission, or an insecure origin. Saying so would be a message about the
      // browser in the middle of a conversation; the text is selectable, which is the way through.
    }
  }

  return (
    <button
      type="button"
      className={'ml-turn__copy' + (copied ? ' ml-turn__copy--done' : '')}
      onClick={() => void copy()}
      aria-label={copied ? 'Copied' : 'Copy this message'}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

/**
 * One turn that is not in the stored transcript yet.
 *
 * <b>Five states, one shape.</b> Queued, being written, recovering, finished-but-not-stored-yet, and
 * failed all draw as the same pair of blocks the ledger draws, because they are all the same thing: a
 * thing somebody said and the answer to it. What changes is the line underneath.
 *
 * The one that earns the most explanation is <b>recovering</b>. It looks like a failure and is not:
 * the connection this panel was reading over has died, which on a phone happens every time the screen
 * goes off, but the turn itself is still being written on the server and will be stored whether or
 * not this panel ever hears about it. Saying "unreachable" there — which is what the panel used to
 * say — was a report about the transport dressed up as a report about the answer, and it sent people
 * off to re-ask questions that had already been answered.
 */
function PendingTurnView({ turn, memberName, agentName, showThinking, onStop, onRetry, onDismiss }: {
  turn: PendingTurn
  memberName: string
  agentName: string
  showThinking: boolean
  onStop: () => void
  onRetry: () => void
  onDismiss: () => void
}) {
  return (
    <>
      <div className="ml-turn ml-turn--user">
        <div className="ml-turn__label">
          {memberName}
          {/* Said plainly rather than by greying the block out. A queued message has been accepted —
              it is going to be sent — and a message that looks disabled reads as one that was
              refused. */}
          {turn.queued && <span className="ml-turn__queued">Queued</span>}
          <CopyTurn text={turn.prompt} />
        </div>
        {/* While the turn is still in the panel's hands the picture itself is still here, so it is
            shown. It becomes a named line once the turn settles into the stored transcript, which is
            where the bytes stop existing — see `TurnAttachmentLine`. */}
        {turn.attachment && (
          turn.attachment.preview
            ? (
              <div className="ml-turn__attachimage">
                <img src={turn.attachment.preview} alt={turn.attachment.name} />
              </div>
            )
            : (
              <TurnAttachmentLine
                name={turn.attachment.name}
                kind={turn.attachment.kind}
                bytes={turn.attachment.bytes}
              />
            )
        )}
        {turn.prompt && <div className="ml-turn__text"><MessageText text={turn.prompt} /></div>}
      </div>

      {/* Nothing has been asked yet, so there is no reply block to draw an empty caret in. */}
      {!turn.queued && (
        <div className="ml-turn ml-turn--assistant">
          <div className="ml-turn__label">
            {agentName}
            {/* Only once the reply is complete. Offering to copy a sentence that is still being
                written would hand over half of it, and the half that landed in the clipboard would
                look like the whole answer. */}
            {turn.done && !turn.error && <CopyTurn text={turn.text} />}
          </div>
          {turn.tool && (
            <div className="ml-turn__tool">
              <span className="ml-turn__toolpulse" aria-hidden="true" />
              {`${agentName} is using ${turn.tool.replace(/_/g, ' ')}…`}
            </div>
          )}
          {turn.recovering && (
            <div className="ml-turn__tool">
              <span className="ml-turn__toolpulse" aria-hidden="true" />
              {`The connection dropped — checking whether ${agentName} finished…`}
            </div>
          )}
          {/*
            The working, above the answer, for a member who asked to see it.

            Set apart and set back — dimmer type, its own label — because the one thing it must never
            be is mistaken for the reply. Reasoning contradicts itself and abandons conclusions; a
            household that read it as the answer would act on things the agent explicitly decided not
            to say. It is also live-only: nothing stores it, so it goes when the turn is handed to the
            transcript, and turning the switch on does not reveal the working of turns that already
            happened because there is none kept to reveal.
          */}
          {showThinking && turn.thinking && (
            <div className="ml-turn__thinking">
              <div className="ml-turn__thinkinglabel">Thinking</div>
              {turn.thinking}
            </div>
          )}
          <div className="ml-turn__text">
            <MessageText text={turn.text} />
            {/* Three states, and only one of them is a bare caret.
                 · Text arriving — a caret beside it, blinking as text does.
                 · Nothing yet, and nothing else to report — the typed-out word, which is the only
                   one of the three that makes a slow agent look busy rather than broken.
                 · Nothing yet, but a tool or a reconnect is already saying so above — the resting
                   caret, because two live status lines competing is worse than one.
                All gone once the reply is complete: the turn lingers on screen only until the
                stored transcript catches up, and a caret there would say it is still being
                written. */}
            {!turn.done &&
              (turn.started ? (
                <span className="ml-turn__caret" aria-hidden="true" />
              ) : turn.tool || turn.recovering ? (
                <span className="ml-turn__caret ml-turn__caret--waiting" aria-hidden="true" />
              ) : (
                <WaitingWord />
              ))}
          </div>
        </div>
      )}

      {/* Gone the moment it is pressed. The turn takes a beat to wind down — the reply is asked to
          stop rather than cut off, so what has been written survives — and a Stop still sitting there
          through that beat reads as one that did not register. A queued turn stops instantly, because
          nothing has been sent. */}
      {!turn.done && !turn.stopping && !turn.recovering && (
        <button type="button" className="ml-turn__stop" onClick={onStop}>Stop</button>
      )}

      {/*
        A turn that failed, with the member's words still above it.

        The words are the reason this is drawn at all. Nothing is stored for a failed turn, so this is
        the only copy of what was said — and the old repair, putting it back in the composer, could
        drop it on top of a message somebody had started typing since. Retry sends it again; Dismiss
        is for when the answer turned out not to be needed after all.
      */}
      {turn.error && (
        <div className="ml-turn__error" role="status">
          {turn.error}
          <div className="ml-turn__errorActions">
            <button type="button" className="ml-chip ml-chip--active" onClick={onRetry}>Retry</button>
            <button type="button" className="ml-chip" onClick={onDismiss}>Dismiss</button>
          </div>
        </div>
      )}

      {/* Why this reply stops where it does — see `cutOffNotice`. */}
      {!turn.error && cutOffNotice(turn.outcome, agentName) && (
        <div className="ml-turn__cutoff" role="status">{cutOffNotice(turn.outcome, agentName)}</div>
      )}
    </>
  )
}

/**
 * Says that the last reply stops short of where it meant to — or nothing at all.
 *
 * A cut-off answer is the failure that hides itself. "The bins go out on Tues" is a whole sentence
 * and reads as a whole answer; the household acts on it and never re-asks, because nothing about it
 * looks unfinished. The words are the same either way, so the only place the difference can live is
 * a line underneath them.
 *
 * `interrupted` says nothing on purpose: the member pressed Stop a moment ago and does not need the
 * panel explaining their own decision back to them.
 */
function cutOffNotice(outcome: string | null, agentName: string): string | null {
  switch (outcome) {
    case 'incomplete':
      return `The connection dropped before ${agentName} finished — this reply is cut off.`
    case 'length':
      return `${agentName} reached its reply limit, so this answer stops early.`
    default:
      return null
  }
}

/**
 * IT TOUCHED — what the turn changed.
 *
 * A voice assistant that writes to shared household data has to show what it did, and on a shared
 * panel the reader is often not the speaker.
 *
 * Honest limitation, carried over intact: `action` is a single string naming the *kind* of write
 * ("task"), not a list of records, so every row here is a written one. There is no read-only variant
 * to draw, and inventing the distinction from the reply text would be guessing at a receipt — the one
 * thing a receipt must not do.
 */
function ItTouched({ messages }: { messages: ConversationMessage[] }) {
  const last = [...messages].reverse().find((m) => m.role === 'assistant')
  if (!last?.action) return null

  return (
    <div className="ml-touched">
      <span className="ml-touched__label">It touched</span>
      <span className="ml-touched__row">
        <span className="ml-touched__mark ml-touched__mark--written" aria-hidden="true" />
        <span className="ml-touched__text">{actionLabel(last.action)}</span>
      </span>
    </div>
  )
}

/** The action key, in English. Unknown kinds render verbatim rather than as nothing. */
function actionLabel(action: string): string {
  switch (action) {
    case 'task': return 'A to-do list was written to'
    case 'climate': return 'A thermostat set-point was changed'
    case 'calendar': return 'The shared calendar was written to'
    case 'meals': return 'The meal plan was written to'
    case 'grocery': return 'The grocery list was written to'
    default: return `${action} was written to`
  }
}

/** Brass wave + stop chip while Piper/TTS reads a reply aloud. */
function SpeakingIndicator({ onStop }: { onStop: () => void }) {
  return (
    <div className="ml-speaking">
      <div className="ml-speaking__wave" aria-hidden="true">
        {[8, 15, 11, 16, 7].map((h, i) => (
          <span key={i} className="ml-speaking__bar" style={{ ['--h' as string]: `${h}px`, animationDelay: `${i * 90}ms` }} />
        ))}
      </div>
      <span className="ml-speaking__label">Speaking</span>
      <button type="button" className="ml-speaking__stop" onClick={onStop}>Tap to Stop</button>
    </div>
  )
}
