import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useAssist } from '../../app/AssistProvider'
import { useVoice } from '../../app/VoiceProvider'
import { speechEnabled } from '../../app/speech'
import { ApiError } from '../../api/client'
import { AttachmentRefused, readAttachment, sizeLabel } from './attachments'
import type { AttachmentDraft } from './attachments'

interface Props {
  agentName: string
  /** The chat this turn belongs to. Omitted on the inbox, where sending starts a new one. */
  conversationId?: number | null
  /** Brass border — the empty state uses it to draw the eye to the only way in. */
  emphasised?: boolean
  /**
   * Stream the turn instead of awaiting it. Supplied by the chat screen, which renders the reply as
   * it arrives; the inbox has nowhere to render deltas and uses the awaited path.
   *
   * No completion callback: a streamed turn belongs to the app rather than to the screen that started
   * it, and where it lands is something the screen watches for rather than something it is told.
   *
   * <b>Nothing here waits for it.</b> There used to be a `busy` prop that disabled the whole composer
   * for as long as a reply was arriving, which made a follow-up thought something you had to hold in
   * your head until the agent finished. The store queues instead: the message goes on screen
   * immediately and is sent when the turn ahead of it ends.
   */
  onStream?: (prompt: string, attachment?: AttachmentDraft | null) => Promise<boolean>
  /** Called with the conversation the turn landed in, so the inbox can navigate into it. */
  onSent?: (conversationId: number) => void
  /**
   * A reply is arriving right now.
   *
   * Only the right-hand square cares. The design gives that square three readings — mic, send, stop —
   * and this is what selects the third. It deliberately does <b>not</b> disable anything: a follow-up
   * typed mid-reply is queued rather than refused (`app/assistTurns.ts`), and attaching the next thing
   * is not an interruption either.
   */
  replying?: boolean
  /** Stop the reply that is arriving. Required for the square's third reading to do anything. */
  onStop?: () => void
  /**
   * Hand the text off instead of sending it.
   *
   * The inbox uses this. Sending from the list meant waiting out the *entire* reply on a screen
   * that showed no sign of it — the field cleared, and some seconds later the chat screen appeared
   * already finished. Handing the prompt to the chat screen instead puts the member's own words on
   * screen immediately and streams the answer under them, which is the same thing every subsequent
   * turn in that conversation already did.
   */
  onCompose?: (prompt: string, attachment?: AttachmentDraft | null) => void
}

/**
 * How many lines the field grows to before it starts scrolling instead.
 *
 * Five is where the transcript above stops being the thing on screen. Past that you are reading your
 * own draft rather than the conversation, and on a phone — where the software keyboard has already
 * taken half the viewport — the reply being answered would be entirely hidden behind the answer.
 */
const MAX_ROWS = 5

/**
 * The composer — a text field and a mic, above the nav bar.
 *
 * **The only way into a chat.** The design removed the NEW CHAT button and the starter chips, which
 * leaves this as the single entry point on purpose: typing here starts a chat, and the absence of a
 * `conversationId` is what tells the server to open one.
 *
 * The mic is one tap away rather than the primary control. Assist is chat-first now — but a wall
 * panel with flour on someone's hands is still the case voice exists for, so it never moves behind
 * anything.
 *
 * ## Why the field wraps
 *
 * It was an `<input>`, which cannot: a long message ran off the side one line high, scrolling under
 * the caret, so the only part of what you had written that you could see was the end of it. That is
 * survivable for a search box and wrong for the place a household describes something — and Assist's
 * longest messages are exactly the ones most worth re-reading before sending, because they are the
 * ones a short reply cannot fix.
 *
 * A `<textarea>` that grows to {@link MAX_ROWS} and then scrolls. Enter still sends, because that is
 * what it did and because the panel's on-screen keyboard's SAVE key is an Enter; **Shift+Enter** is
 * the newline for a hardware keyboard, and the on-screen keyboard's own `return` inserts one without
 * needing to be told — it reads the field's type and already does the right thing for a textarea
 * (`OnScreenKeyboard`, `multiline`).
 */
export function AssistComposer({
  agentName, conversationId, emphasised, onStream, onSent, onCompose, replying, onStop,
}: Props) {
  const { send } = useAssist()
  const { supported, listening, speaking, partial, startListening, stopListening, speak, stopSpeaking } = useVoice()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** What is attached to the turn being written, or null. One per turn — see `take`. */
  const [attachment, setAttachment] = useState<AttachmentDraft | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Read by the unmount cleanup, which must see the *current* attachment rather than the one that
  // existed when the effect was created.
  const attachmentRef = useRef(attachment)
  attachmentRef.current = attachment

  /**
   * Three pickers, because a browser file input is configured by attribute rather than by argument.
   *
   * `capture` is what separates "take a picture" from "a photo": with it, a phone opens the camera
   * directly instead of the gallery. It is ignored on a desktop, which is the right degradation —
   * that row then behaves as a second photo picker rather than as a broken one.
   */
  const photoInput = useRef<HTMLInputElement>(null)
  const cameraInput = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  /**
   * Grow the field to its content, up to the cap.
   *
   * Measured rather than counted: `\n`s are not lines once the text wraps, and the wrap point depends
   * on a width that changes with the gutter, the rem scale and whether the send button is showing.
   * Collapsing to `auto` first is what makes it shrink again when text is deleted — `scrollHeight`
   * against a fixed height only ever reports the height it was already given.
   *
   * A layout effect, not an effect: this runs between React's write and the browser's paint, so the
   * field is never painted at the wrong height. As an ordinary effect it would flash a line short on
   * the keystroke that wraps.
   */
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'

    // The line box, from the computed style rather than a guess, so this tracks the rem scaling that
    // makes the panel's type four times the size of a phone's.
    const style = getComputedStyle(el)
    const line = parseFloat(style.lineHeight) || 24
    // `scrollHeight` is content + padding and never the border, while `height` under `border-box`
    // means all three — so the border has to be added back or every field is two pixels short and
    // the last line is clipped by exactly its own underline.
    const border = el.offsetHeight - el.clientHeight
    const chrome = border + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)

    el.style.height = `${Math.min(el.scrollHeight + border, line * MAX_ROWS + chrome)}px`
  }, [text])

  const submit = useCallback(
    async (prompt: string, spoken = false) => {
      const trimmed = prompt.trim()
      // A turn can be an attachment and nothing else — handing over a photo with no question is an
      // ordinary thing to do, and the server accepts it.
      const held = attachment
      if ((!trimmed && !held) || busy) return
      setText('')
      setAttachment(null)
      setMenuOpen(false)
      setError(null)

      // Handed off rather than sent: the receiving screen owns the turn from here, including
      // putting the words back if it fails. Nothing is in flight on this screen, so nothing here
      // goes busy — the screen is about to be replaced anyway.
      //
      // Typed turns only. A spoken one is answered *aloud*, which means the whole reply has to
      // exist before anything can happen with it — there is nothing to stream and nobody looking
      // at the screen. Handing it off would open a chat nobody asked to read and say nothing.
      // The test is `readAloud`, not `spoken`. Being spoken was a proxy for being *answered aloud*,
      // which is what actually forces the awaited path: a reply that will be read out has to exist as
      // whole sentences first, there is nothing to stream, and nobody is looking at the screen anyway.
      //
      // With the voice off (`app/speech.ts`) every one of those clauses inverts, and holding the
      // awaited path cost the worst transition in the app: the listening band closed, the inbox came
      // back with its empty state, and seconds later the finished chat replaced it — so the panel
      // appeared to discard what you had just said before changing its mind.
      const readAloud = spoken && speechEnabled()

      if (onCompose && !readAloud) {
        onCompose(trimmed, held)
        return
      }

      // A streamed turn hands rendering to the screen and returns as soon as the stream is set up,
      // so the composer does not sit disabled behind its own request.
      //
      // Spoken turns take the awaited path deliberately: text-to-speech needs whole sentences, and
      // feeding it fragments would produce speech that stutters at every token boundary. The panel
      // has nothing to show mid-stream for a turn nobody is looking at.
      if (onStream && !readAloud) {
        // Sent and forgotten. A failed turn used to come back here — the text was stored nowhere, so
        // this was the only copy — but by then it could be seconds or minutes later, and refilling
        // the field would land on top of whatever the member had started typing since. The failed
        // turn now keeps its own words on screen with a Retry under them, which is a better place for
        // them than a box somebody else is using.
        void onStream(trimmed, held)
        return
      }

      setBusy(true)
      try {
        const res = await send(trimmed, conversationId ?? null, spoken)
        if (res) {
          // A spoken turn is answered aloud. Conversational register — Warm.
          if (spoken) speak(res.message.text, 'warm')
          if (res.conversationId) onSent?.(res.conversationId)
        }
      } catch (err) {
        if (!(err instanceof ApiError)) throw err
        // Put the text back rather than losing it. On a shared panel the person who typed it may
        // have walked away, and a message that vanished is worse than one that needs re-sending.
        setText(trimmed)
        setError('Unreachable right now — try again.')
      } finally {
        setBusy(false)
      }
    },
    [attachment, busy, onCompose, onStream, send, conversationId, onSent, speak],
  )

  /**
   * Take a file the member picked, or say why not.
   *
   * The refusal is checked before anything is decoded, so an unreadable file is declined instantly
   * rather than after a second of reading — and the message says what *will* work, because "receipt"
   * and "photo of the receipt" are the same errand and only one of them is possible.
   *
   * The input is cleared afterwards so picking the same file twice in a row still fires a change
   * event; without it, removing an attachment and re-adding the same one silently does nothing.
   */
  const take = useCallback(async (input: HTMLInputElement) => {
    const file = input.files?.[0]
    input.value = ''
    setMenuOpen(false)
    if (!file) return

    setError(null)
    try {
      const draft = await readAttachment(file)
      // Replace rather than append. One per turn is what the wire carries, and a second slot that
      // silently discarded the first would be worse than not offering one.
      setAttachment((prev) => {
        if (prev?.preview) URL.revokeObjectURL(prev.preview)
        return draft
      })
    } catch (err) {
      if (!(err instanceof AttachmentRefused)) throw err
      setError(err.message)
    }
  }, [])

  const removeAttachment = useCallback(() => {
    setAttachment((prev) => {
      if (prev?.preview) URL.revokeObjectURL(prev.preview)
      return null
    })
  }, [])

  // The last thumbnail's object URL, when the composer goes away with one still held. Without this
  // every picture attached and then navigated away from leaks its decoded bytes for the session.
  useEffect(() => () => { if (attachmentRef.current?.preview) URL.revokeObjectURL(attachmentRef.current.preview) }, [])

  const beginVoice = useCallback(() => {
    if (speaking) stopSpeaking() // barge-in
    if (supported) startListening((heard) => void submit(heard, true))
    else inputRef.current?.focus()
  }, [speaking, stopSpeaking, supported, startListening, submit])

  const hasText = text.trim().length > 0
  /** Anything to send — words, a picture, or a file. What turns the square into the send arrow. */
  const sendable = hasText || attachment !== null

  /**
   * Which of its three jobs the right-hand square is doing.
   *
   * <b>One square, three readings, so the thumb learns one place.</b> Send outranks stop
   * deliberately, and that is the one place this departs from the design as drawn: Turn 4D gives the
   * square wholly to Stop while a reply runs, on the assumption that you cannot send during one. That
   * assumption no longer holds — a follow-up typed mid-reply is queued rather than refused — so the
   * square follows what there is to do. With something written, it sends; with the composer empty and
   * a reply arriving, it stops; otherwise it listens.
   */
  const square: 'send' | 'stop' | 'mic' =
    sendable ? 'send' : replying ? 'stop' : 'mic'

  // The listening band replaces the composer rather than sitting above it — the same swap the
  // overlay made. Carried over unchanged, as the design asks: while the mic is open the only useful
  // controls are the live transcript and a way to stop, and leaving a text field beside them invites
  // someone to start typing into a turn that is already being spoken.
  if (listening) return <ListeningBand partial={partial} onStop={stopListening} />

  return (
    <div className="ml-composer">
      {error && <div className="ml-composer__error" role="status">{error}</div>}

      {/* The three pickers the plus opens. Off-screen rather than hidden with `display:none`, which
          Safari has historically treated as a reason not to fire the picker at all. */}
      <input
        ref={photoInput} className="ml-composer__file" type="file" accept="image/*"
        onChange={(e) => void take(e.currentTarget)} tabIndex={-1} aria-hidden="true"
      />
      <input
        ref={cameraInput} className="ml-composer__file" type="file" accept="image/*" capture="environment"
        onChange={(e) => void take(e.currentTarget)} tabIndex={-1} aria-hidden="true"
      />
      <input
        ref={fileInput} className="ml-composer__file" type="file"
        accept=".txt,.md,.markdown,.csv,.tsv,.json,.log,.yml,.yaml,.xml,.ini,.conf,text/plain"
        onChange={(e) => void take(e.currentTarget)} tabIndex={-1} aria-hidden="true"
      />

      {/*
        ATTACH — three sources, anchored to the composer rather than sheeted up from the bottom of
        the screen. The composer is what you are operating and it should not slide away while you
        choose what to put in it.
      */}
      {menuOpen && (
        <>
          {/* Tapping anywhere off the menu closes it. A full-height scrim rather than a document
              listener so the tap that dismisses is not also a tap on whatever was underneath. */}
          <button
            type="button"
            className="ml-composer__scrim"
            onClick={() => setMenuOpen(false)}
            aria-label="Close the attach menu"
          />
          <div className="ml-attachmenu" role="menu">
            <div className="ml-attachmenu__label">Attach</div>
            <button type="button" className="ml-attachmenu__row" role="menuitem" onClick={() => photoInput.current?.click()}>
              <Icon id="ico-image" size="1.25rem" />
              <span>A photo</span>
            </button>
            <button type="button" className="ml-attachmenu__row" role="menuitem" onClick={() => cameraInput.current?.click()}>
              <Icon id="ico-camera" size="1.25rem" />
              <span>Take a picture</span>
            </button>
            <button type="button" className="ml-attachmenu__row" role="menuitem" onClick={() => fileInput.current?.click()}>
              <Icon id="ico-file" size="1.25rem" />
              <span>A file</span>
            </button>
          </div>
        </>
      )}

      {/*
        What is attached, on its own line above the input and indented to clear the plus.

        The meta line states the size and nothing else. It said STAYS ON THE HOME SERVER in the
        design, and that claim was withdrawn rather than implemented: HomeHub cannot know whether a
        turn leaves the house, because Hermes chooses the model, the provider and any fallback. It is
        the same reason the LOCAL/CLOUD tag came off the turns themselves — see `Turn` in `ChatScreen`.
      */}
      {attachment && (
        <div className="ml-attachdraft">
          <div className="ml-attachdraft__thumb">
            {attachment.preview
              ? <img src={attachment.preview} alt="" className="ml-attachdraft__img" />
              : <Icon id="ico-file" size="1.375rem" />}
            <button
              type="button"
              className="ml-attachdraft__remove"
              onClick={removeAttachment}
              aria-label={`Remove ${attachment.name}`}
            >
              <span aria-hidden="true">✕</span>
            </button>
          </div>
          <div className="ml-attachdraft__body">
            <div className="ml-attachdraft__name">{attachment.name}</div>
            <div className="ml-attachdraft__meta">{sizeLabel(attachment.bytes)}</div>
          </div>
        </div>
      )}

      <div className={'ml-composer__row' + (emphasised ? ' ml-composer__row--emphasised' : '')}>
        {/*
          A box, like the two beside it — see `.ml-composer__plus`. It was a bare glyph of exactly the
          mic's width, which was symmetrical and still made the field look like it started late; the
          hierarchy is carried by the border it takes (the field's, not the mic's brass) rather than by
          being the one control without one. It stays live while a reply runs — attaching the next
          thing is not an interruption.

          The mark is its own element so it can turn without the box turning with it, and it is the
          sprite's `ico-add` rather than a `＋` character: text centres on its baseline, which left the
          mark visibly low inside a border that shows exactly where the true centre is.
        */}
        <button
          type="button"
          className={'ml-composer__plus' + (menuOpen ? ' ml-composer__plus--open' : '')}
          onClick={() => setMenuOpen((open) => !open)}
          aria-label={menuOpen ? 'Close the attach menu' : 'Attach something'}
          aria-expanded={menuOpen}
        >
          <Icon id="ico-add" size="1.25rem" className="ml-composer__plusglyph" />
        </button>
        <textarea
          ref={inputRef}
          className="ml-composer__input"
          value={text}
          rows={1}
          placeholder={`Message ${agentName}…`}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          // Enter sends; Shift+Enter is the newline. The panel's on-screen keyboard needs neither —
          // its SAVE key dispatches a plain Enter and its `return` key inserts a line itself.
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey) return
            // Without this the newline is inserted *as well*, so the field is left holding a blank
            // line after the message has gone.
            e.preventDefault()
            void submit(text)
          }}
          aria-label={`Message ${agentName}`}
        />
        {/* One square, three readings — see `square` above. Filled brass whenever it is the thing to
            press, which is both of the states that do something to a turn. */}
        {square === 'send' && (
          <button
            type="button"
            className="ml-composer__action ml-composer__action--send"
            onClick={() => void submit(text)}
            disabled={busy}
            aria-label="Send"
          >
            <span aria-hidden="true">→</span>
          </button>
        )}
        {square === 'stop' && (
          <button
            type="button"
            className="ml-composer__action ml-composer__action--stop"
            onClick={onStop}
            aria-label={`Stop ${agentName}`}
          >
            <span className="ml-composer__stopglyph" aria-hidden="true" />
          </button>
        )}
        {square === 'mic' && (
          <button
            type="button"
            className="ml-composer__action"
            onClick={beginVoice}
            aria-label={supported ? 'Speak' : 'Type'}
          >
            <Icon id="ico-assist" size="1.25rem" />
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Listening — the live partial transcript, the waveform, and a square stop control.
 *
 * Lifted wholesale from the overlay, styles and all (`.ml-listening*`, `.ml-waveform*`,
 * `.ml-emblem*` in ledger.css). The design lists the listening band among the things that carry over
 * unchanged, and it is a state worth keeping honest: on a shared wall panel, "the mic is open right
 * now and here is what it thinks it heard" is the whole privacy argument made visible.
 */
function ListeningBand({ partial, onStop }: { partial: string; onStop: () => void }) {
  return (
    <div className="ml-listening">
      <div className="ml-listening__hearing">Hearing…</div>
      <div className="ml-listening__partial">{partial || '…'}</div>

      <div className="ml-waveform" aria-hidden="true">
        {[12, 26, 36, 20, 30, 14, 24].map((h, i) => (
          <span key={i} className="ml-waveform__bar" style={{ ['--h' as string]: `${h}px`, animationDelay: `${i * 90}ms` }} />
        ))}
      </div>

      <button type="button" className="ml-emblem ml-emblem--listening" onClick={onStop} aria-label="Tap to stop">
        <span className="ml-emblem__ring">
          <span className="ml-emblem__core">
            <span className="ml-listening__stopglyph" aria-hidden="true" />
            <span className="ml-emblem__label">Tap to Stop</span>
          </span>
        </span>
      </button>
      <div className="ml-emblem__caption">Stops by itself after 5 seconds of quiet</div>
    </div>
  )
}
