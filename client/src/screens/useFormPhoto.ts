import { useCallback, useRef, useState } from 'react'
import { api, ApiError } from '../api/client'
import { AttachmentRefused, readAttachment } from './assist/attachments'
import { toDraft, amber as amberFields } from '../app/eventDrafts'
import { fillSummary, planFill } from '../app/formFill'
import type { EventDraft } from '../app/eventDrafts'
import type { FillPlan, FormField } from '../app/formFill'
import type { DraftField } from '../api/types'

/** The photograph a form was filled from, as the write needs it. */
export interface FormPhoto {
  base64: string | null
  mediaType: string | null
  preview: string | null
  takenAt: string | null
}

type Stage = 'idle' | 'picking' | 'reading' | 'filled' | 'none'

/**
 * Reading a photograph into the New Engagement form.
 *
 * <b>No Barnaby, no offer, no confirm sheet — the form is the confirmation.</b> That is the whole
 * difference from the Assist entry: somebody who reached for `+` has already decided to make an
 * engagement and is standing in front of the screen that makes one, so a second surface asking them
 * to approve what they can already see and edit would be furniture.
 *
 * What replaces the sheet's safety is the merge rule (`app/formFill`): a reading may fill what is
 * empty and may never overwrite what somebody typed. Screens 16–24.
 */
export function useFormPhoto(onFill: (draft: EventDraft, fields: readonly FormField[]) => void) {
  const [stage, setStage] = useState<Stage>('idle')
  const [photo, setPhoto] = useState<FormPhoto | null>(null)
  const [draft, setDraft] = useState<EventDraft | null>(null)
  const [offers, setOffers] = useState<FormField[]>([])
  const [summary, setSummary] = useState('')
  const [amber, setAmber] = useState<Set<DraftField>>(new Set())
  const [refusal, setRefusal] = useState<string | null>(null)
  /** What the last TAKE IT replaced, so screen 24's UNDO can put it back. */
  const undo = useRef<{ field: FormField; label: string } | null>(null)
  const [undoable, setUndoable] = useState<{ field: FormField; label: string } | null>(null)

  const open = useCallback(() => setStage('picking'), [])
  const close = useCallback(() => setStage((s) => (s === 'picking' ? (draft ? 'filled' : 'idle') : s)), [draft])

  const read = useCallback(async (file: File, touched: ReadonlySet<FormField>) => {
    setRefusal(null)
    let attachment
    try {
      attachment = await readAttachment(file)
    } catch (err) {
      if (!(err instanceof AttachmentRefused)) throw err
      setRefusal(err.message)
      setStage('idle')
      return
    }
    if (attachment.kind !== 'image' || !attachment.base64) {
      setRefusal('That kind of file cannot be read. A photo of the page works.')
      setStage('idle')
      return
    }

    const held: FormPhoto = {
      base64: attachment.base64,
      mediaType: attachment.mediaType,
      preview: attachment.preview,
      takenAt: attachment.takenAt,
    }
    setPhoto(held)
    setStage('reading')

    const now = new Date()
    const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

    try {
      const result = await api.readPhoto({
        imageBase64: held.base64!,
        mediaType: held.mediaType ?? 'image/jpeg',
        localDate,
        context: null,
      })

      // Nothing on it, or no reader on this panel. Both leave the form exactly as it was — the
      // person was already writing an engagement, so nothing is cleared and nothing is blocked.
      if (!result.available || result.events.length === 0) {
        setStage('none')
        return
      }

      /*
       * The first engagement, and only the first.
       *
       * A form holds one. The design leaves the several-on-one-photo case undrawn for this entry
       * and says not to improvise it, so this takes the first and says so in the strip rather than
       * inventing a tick list on a screen that has nowhere to put one. Anybody with a term letter
       * is better served by the Assist entry, which has the list already.
       */
      const first = toDraft(result.events[0])
      const plan = planFill(first, touched)

      setDraft(first)
      setOffers(plan.offers)
      setAmber(amberFields(first))
      setSummary(summaryFor(plan, result.events.length))
      setStage('filled')
      onFill(first, plan.fill)
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
      // A server that answered with a refusal is not the photograph's fault, and the form must not
      // say it is. Same distinction the Assist path draws.
      setRefusal(err.status === 0
        ? 'The house is off the network, so that photo cannot be read yet.'
        : 'That photo could not be read just now.')
      setStage('none')
    }
  }, [onFill])

  /** Accept one held-back value. One press, one field — screen 23 is explicit that there is no bulk accept. */
  const take = useCallback((field: FormField, previousLabel: string) => {
    setOffers((cur) => cur.filter((f) => f !== field))
    undo.current = { field, label: previousLabel }
    setUndoable({ field, label: previousLabel })
  }, [])

  const clearUndo = useCallback(() => { undo.current = null; setUndoable(null) }, [])

  /** REPLACE, from the source strip — a second photograph over the first. */
  const replace = useCallback(() => setStage('picking'), [])

  const dismiss = useCallback(() => setStage(draft ? 'filled' : 'idle'), [draft])

  return {
    stage, photo, draft, offers, summary, amber, refusal, undoable,
    open, close, read, take, clearUndo, replace, dismiss,
  }
}

/** "Four empty lines filled · two of yours left alone", plus the count when a page held several. */
function summaryFor(plan: FillPlan, found: number): string {
  const base = fillSummary(plan, true)
  return found > 1 ? `${base} · first of ${found} on that photo` : base
}

