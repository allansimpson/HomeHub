import { useNavigate } from 'react-router'
import { EventConfirmSheet } from './EventConfirmSheet'
import { confirmationProse, longDate, receiptLines, spokenTime } from './photoCapture'
import { localDay } from '../../app/eventDrafts'
import { dayKey } from '../../app/dates'
import type { Capture } from './usePhotoCapture'
import type { EventDraft } from '../../app/eventDrafts'
import type { DraftEventDto } from '../../api/types'
import type { SheetPhoto, WrittenEvent } from './EventConfirmSheet'

interface Props {
  capture: Capture
  agentName: string
  /** A turn is being written. The offer waits — it appends after the answer, never over it. */
  busy: boolean
  onAnswer: (yes: boolean) => void
  onDiscard: () => void
  onAdded: (written: WrittenEvent[], photoKept: boolean) => void
  onUndo: () => void
  /** ANOTHER PHOTO — back to the attach panel with nothing else in the way. */
  onAnotherPhoto: () => void
}

/**
 * Everything a photograph says on the transcript, from "reading it" to the receipt.
 *
 * Screens 02–04, 10, 11 and 15 of `design_handoff_photo_event`. Each stage is one block at the foot
 * of the conversation, in the agent's own turn shape, because that is what it is: Barnaby saying
 * something about a picture somebody handed over.
 */
export function PhotoCapture({ capture, agentName, busy, onAnswer, onDiscard, onAdded, onUndo, onAnotherPhoto }: Props) {
  const navigate = useNavigate()

  // Nothing to say. A photo of the cat is read, found to hold no engagement, and produces silence —
  // which is a deliberate outcome rather than a missing one.
  if (capture.stage === 'silent') return null

  if (capture.stage === 'sheet') {
    return (
      <EventConfirmSheet
        drafts={capture.drafts}
        photo={capture.photo}
        context={capture.context}
        onDiscard={onDiscard}
        onAdded={onAdded}
        onEdit={(draft: EventDraft, photo: SheetPhoto) => {
          // The full New Event modal, pre-filled. The sheet is a confirmation, not an editor — a
          // flyer that needs real correcting needs the screen built for correcting.
          //
          // Flattened to plain values on the way: this goes through the history entry, so the day
          // travels as `YYYY-MM-DD` rather than as a `Date`, and the photo carries only the two
          // fields the write needs. An object URL would not survive the trip and is not wanted there.
          navigate('/calendar/new', {
            state: {
              draft: {
                title: draft.title,
                date: dayKey(draft.date),
                allDay: draft.allDay,
                begins: draft.begins,
                ends: draft.ends,
                where: draft.where,
                note: draft.note,
              },
              photo: { base64: photo.base64, takenAt: photo.takenAt },
            },
          })
        }}
      />
    )
  }

  return (
    <>
      {/*
        The photograph itself, when no turn is carrying it.

        A picture handed over with no question does not go to the agent — there is nothing to answer,
        and the look costs more than the reading does. But it still has to be *on screen*: the design
        has the user's turn holding the photo with Barnaby reading it underneath (screen 02), and a
        panel that swallowed the picture and started talking about engagements would be answering
        something nobody could see they had asked.

        Drawn only for the photo-only path. When a turn carries the image, that turn draws it and this
        would be the same picture twice.
      */}
      {capture.ownTurn && capture.photo.preview && (
        <div className="ml-turn ml-turn--user">
          <div className="ml-turn__attachimage">
            <img src={capture.photo.preview} alt="The photograph you handed over" />
          </div>
        </div>
      )}

    <div className="ml-turn ml-turn--assistant">
      <div className="ml-turn__label">{agentName}</div>

      {capture.stage === 'reading' && (
        <>
          <div className="ml-turn__text">Reading it…</div>
          {/* Indeterminate, and honest about it: nothing downstream reports progress through a
              vision pass, so a bar that filled would be an animation pretending to be a measurement. */}
          <div className="ml-capture__track" aria-hidden="true"><span className="ml-capture__fill" /></div>
        </>
      )}

      {capture.stage === 'offline' && (
        <>
          <div className="ml-turn__text">
            The house is off the network, so I can’t read the photo yet. I’m holding it — I’ll take the
            details off it the moment we’re back.
          </div>
          {/* Never screen 10's "another photo in better light": the picture is not the problem, and
              sending somebody back out to re-take it would be the panel blaming its own network. */}
          <div className="ml-capture__fault">
            <span className="ml-capture__faultsquare" aria-hidden="true" />
            <span className="ml-capture__faulttext">No network</span>
            <span className="ml-capture__faultstate">Retrying</span>
          </div>
          <div className="ml-capture__actions">
            <button type="button" className="ml-capture__btn ml-capture__btn--go" onClick={() => navigate('/calendar/new')}>
              Enter it myself
            </button>
            <button type="button" className="ml-capture__btn" onClick={onDiscard}>Discard</button>
          </div>
        </>
      )}

      {capture.stage === 'none' && (
        <>
          <div className="ml-turn__text">
            {capture.reason ?? 'I can’t find a date or a time on that one.'}
            {' '}Another photo in better light would help, or tell me the details and I’ll write them down.
          </div>
          <div className="ml-capture__actions">
            <button type="button" className="ml-capture__btn ml-capture__btn--go" onClick={onAnotherPhoto}>
              Another photo
            </button>
            <button type="button" className="ml-capture__btn ml-capture__btn--alt" onClick={() => navigate('/calendar/new')}>
              Enter it myself
            </button>
          </div>
        </>
      )}

      {/* The offer waits for the answer it would otherwise talk over. A question somebody asked is
          more urgent than an engagement they have not been told about yet. */}
      {capture.stage === 'offer' && !busy && <Offer capture={capture} onAnswer={onAnswer} />}

      {capture.stage === 'written' && (
        <>
          <div className="ml-turn__text">{confirmationProse(capture.written)}</div>
          <div className="ml-touched">
            <span className="ml-touched__label">It touched</span>
            {receiptLines(capture.written, capture.photoKept).map((line) => (
              <span key={line} className="ml-touched__row">
                <span className="ml-touched__mark ml-touched__mark--written" aria-hidden="true" />
                <span className="ml-touched__text">{line}</span>
              </span>
            ))}
          </div>
          <div className="ml-capture__actions">
            <button type="button" className="ml-capture__btn ml-capture__btn--alt" onClick={() => navigate('/calendar')}>
              See it on the calendar
            </button>
            {/* Takes back everything that press wrote, never the last one — a term letter's four
                dates were one decision and are undone as one. */}
            <button type="button" className="ml-capture__btn" onClick={onUndo}>Undo</button>
          </div>
        </>
      )}
    </div>
    </>
  )
}

/**
 * "Saturday 14 September at 10 AM", or just the day for an all-day engagement.
 *
 * The offer names the hour where there is one because that is what makes it recognisable — somebody
 * who photographed two flyers this week needs to know which of them Barnaby is talking about.
 */
function whenOf(draft: DraftEventDto): string {
  const day = longDate(localDay(draft.date))
  if (draft.allDay || !draft.begins) return day
  const [h, m] = draft.begins.split(':').map(Number)
  const at = new Date(2000, 0, 1, h, m)
  return `${day} at ${spokenTime(at)}`
}

/**
 * The offer, in prose, with its two buttons inside the turn.
 *
 * The buttons leave the DOM on tap rather than going grey — the choice is written into the history as
 * an ordinary user turn instead, so the transcript reads as a conversation and not as a form somebody
 * filled in.
 */
function Offer({ capture, onAnswer }: { capture: Capture; onAnswer: (yes: boolean) => void }) {
  const first = capture.drafts[0]
  const more = capture.drafts.length - 1

  return (
    <>
      <div className="ml-turn__text">
        {more > 0
          ? `There are ${capture.drafts.length} engagements on that one — ${first.title} on ${longDate(localDay(first.date))}, and ${more} more. Shall I put them on the calendar?`
          : `There’s an engagement on that flyer — ${first.title}, ${whenOf(first)}. Shall I put it on the calendar?`}
      </div>
      <div className="ml-capture__actions">
        <button type="button" className="ml-capture__btn ml-capture__btn--go" onClick={() => onAnswer(true)}>Yes</button>
        <button type="button" className="ml-capture__btn" onClick={() => onAnswer(false)}>No</button>
      </div>
    </>
  )
}
