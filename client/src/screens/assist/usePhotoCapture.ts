import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../../api/client'
import { useConnection } from '../../app/ConnectionProvider'
import { useWriteQueue } from '../../app/WriteQueueProvider'
import { declaresIntent, offersAnEvent } from './photoCapture'
import type { SheetPhoto, WrittenEvent } from './EventConfirmSheet'
import type { TurnAttachment } from '../../app/assistTurns'
import type { DraftEventDto } from '../../api/types'

/**
 * Where a photograph has got to on its way to being an engagement.
 *
 * `silent` is a state and not an absence: a photo of the cat has been read, found to contain no
 * engagement worth mentioning, and deliberately produces nothing on screen. Keeping it distinct from
 * "no capture at all" is what stops the panel reading the same picture twice.
 */
export type CaptureStage = 'reading' | 'offer' | 'sheet' | 'none' | 'offline' | 'written' | 'silent'

export interface Capture {
  /** The turn this photograph arrived on. One capture per attachment, and it outlives the turn. */
  id: string
  photo: SheetPhoto
  stage: CaptureStage
  /**
   * What the member typed alongside the photo.
   *
   * Kept on the capture rather than only in the reading's request because the sheet needs it too:
   * "here's Theo's camp flyer" is the household saying whose calendar this belongs on, and that is
   * the only evidence there is for the chip's default (`defaultCalendar`).
   */
  context: string
  /**
   * No turn is carrying this photograph, so the capture draws it.
   *
   * True when it was handed over with no question — the agent is not asked, so there is no turn in
   * the transcript to hold the picture. See `ChatScreen.takePhoto` for why that call is not made.
   */
  ownTurn: boolean
  drafts: DraftEventDto[]
  /** Why there is nothing, in the household's words. Drawn on the turn for screen 10. */
  reason: string | null
  written: WrittenEvent[]
  photoKept: boolean
}

/** Today, as the panel reckons it — the anchor for a year no flyer printed. */
function localToday(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/**
 * Reading an attached photograph for engagements, and everything that follows from it.
 *
 * <b>Its own lifecycle, deliberately beside the turn rather than inside it.</b> The reading is not an
 * assistant turn — it is a separate, tool-less call against a fixed schema, because a flyer is
 * untrusted text and the agent holds house tools. But it is also *longer-lived* than the turn that
 * carried the photo: the turn settles into the stored transcript within seconds, and by then the
 * bytes are gone, while the offer, the sheet and the receipt all still need them. So the capture
 * holds its own copy and lives here until the household is finished with it.
 */
export function usePhotoCapture() {
  const { online } = useConnection()
  const { run, withdraw } = useWriteQueue()
  const [capture, setCapture] = useState<Capture | null>(null)

  /** The prompt the photo arrived with, kept for a re-read after a reconnect. */
  const context = useRef<string>('')
  /** Attachments already read, so a re-render or a reconnect cannot pay for a second vision pass. */
  const seen = useRef(new Set<string>())

  const read = useCallback(async (id: string, photo: SheetPhoto, prompt: string) => {
    if (!photo.base64) return

    try {
      const result = await api.readPhoto({
        imageBase64: photo.base64,
        mediaType: photo.mediaType ?? 'image/jpeg',
        localDate: localToday(),
        context: prompt || null,
      })

      setCapture((cur) => {
        if (cur?.id !== id) return cur

        // No reader configured on this panel. Not a fact about the photograph, and not said as one —
        // blaming a picture that may be perfectly clear would send somebody off to take a better one.
        if (!result.available) return { ...cur, stage: 'silent' }

        // Nothing with a date on it. This one *is* about the photograph, and screen 10 says so.
        if (result.events.length === 0) {
          return { ...cur, stage: 'none', reason: result.reason }
        }

        // A date but no name — as likely a price as an engagement. Read, and said nothing about.
        if (!offersAnEvent(result.events)) return { ...cur, stage: 'silent' }

        return {
          ...cur,
          // Somebody who has already said "add it to the calendar" is not asked whether to add it to
          // the calendar. The sheet is still a confirmation; it is the *question* that is redundant.
          stage: declaresIntent(prompt) ? 'sheet' : 'offer',
          drafts: result.events,
          reason: result.reason,
        }
      })
    } catch (err) {
      if (!(err instanceof ApiError)) throw err

      /*
       * Only a *network* failure is "the house is off the network".
       *
       * This treated every `ApiError` as offline, which is a claim about the house made from a
       * status code that may say nothing of the sort. It was caught on a TEST box whose deployment
       * left the new panel in front of the old server: the reading asked for an endpoint that
       * release did not have, got a clean 404 over a perfectly healthy network, and the panel
       * announced that the house was off the network and it was holding the photo — a confident,
       * specific, wrong diagnosis, and one that also promised a re-read on a reconnect that was
       * never going to come because nothing was disconnected.
       *
       * `ApiError` carries status 0 for a fetch that never completed (see `api/client.ts`), which is
       * the honest signal for offline. A refusal from a server that answered is something else, and
       * the panel has nothing true to say about it: it cannot claim the network is down and must not
       * blame a photograph it never got to read. So it says nothing, and the fault is left to the
       * places built to carry it — the server's own log, and the startup line that states whether
       * reading photographs is switched on at all.
       */
      const offline = err.status === 0
      setCapture((cur) => (cur?.id === id ? { ...cur, stage: offline ? 'offline' : 'silent' } : cur))
    }
  }, [])

  /**
   * A photograph has been attached to a turn. Read it.
   *
   * Every image is read, including the ones that turn out to be nothing — the only way to find out
   * whether a photo has a date on it is to look. What is gated is Barnaby *speaking*, not the
   * looking; see {@link offersAnEvent}.
   */
  const begin = useCallback((turnKey: string, attachment: TurnAttachment, prompt: string) => {
    if (attachment.kind !== 'image' || !attachment.base64) return
    if (seen.current.has(turnKey)) return
    seen.current.add(turnKey)

    const photo: SheetPhoto = {
      base64: attachment.base64,
      mediaType: attachment.mediaType,
      preview: attachment.preview,
      takenAt: attachment.takenAt,
    }
    context.current = prompt
    setCapture({
      id: turnKey, photo, stage: online ? 'reading' : 'offline', context: prompt,
      // A key of `photo:*` is the photo-only path — nothing else put a turn on screen for it.
      ownTurn: turnKey.startsWith('photo:'),
      drafts: [], reason: null, written: [], photoKept: false,
    })
    if (online) void read(turnKey, photo, prompt)
  }, [online, read])

  // Back on the network: take the details off the photograph we have been holding. The offer turn
  // appends then, which is what the household was promised while it was waiting.
  useEffect(() => {
    if (!online || capture?.stage !== 'offline') return
    setCapture((cur) => (cur ? { ...cur, stage: 'reading' } : cur))
    void read(capture.id, capture.photo, context.current)
  }, [online, capture?.stage, capture?.id, capture?.photo, read])

  /** YES or NO to the offer. NO ends it — the photograph stays in the transcript, nothing is written. */
  const answer = useCallback((yes: boolean) => {
    setCapture((cur) => (cur ? (yes ? { ...cur, stage: 'sheet' } : null) : cur))
  }, [])

  /** DISCARD, from the sheet or the offline turn. */
  const discard = useCallback(() => setCapture(null), [])

  const added = useCallback((written: WrittenEvent[], photoKept: boolean) => {
    setCapture((cur) => (cur ? { ...cur, stage: 'written', written, photoKept } : cur))
    window.dispatchEvent(new Event('homehub:sync'))
  }, [])

  /**
   * UNDO — and it keeps its promise in all three states a write can be in.
   *
   * <b>Reachable or synced</b> take an ordinary delete, sent *without* a `baseVersion`: somebody
   * reversing their own write seconds later should not meet a conflict strip about an engagement
   * nobody else has touched. <b>Queued and unsent</b> is the one the write queue could not do — the
   * delete would 404 against an event that does not exist yet, and the create would replay on
   * reconnect and put it back. That one is withdrawn in place instead.
   *
   * The photograph is released by the same act, server-side, and only once no sibling engagement
   * still points at it — a term letter's four dates share one file.
   */
  const undo = useCallback(async () => {
    const written = capture?.written ?? []
    for (const event of written) {
      if (event.opId) {
        withdraw(event.opId)
      } else if (event.id !== null) {
        await run({
          domain: 'calendar',
          method: 'DELETE',
          path: `/calendar/events/${event.id}`,
          label: `Undo “${event.title}”`,
        })
      }
    }
    setCapture(null)
    window.dispatchEvent(new Event('homehub:sync'))
  }, [capture?.written, run, withdraw])

  return { capture, begin, answer, discard, added, undo }
}
