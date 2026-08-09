import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { api } from '../../api/client'
import { usePantry } from '../../app/PantryProvider'
import { estimateWord, trimNumber } from '../../app/pantryDomain'
import type { DeductionReceiptDto, ReceiptLineDto } from '../../api/types'
import { PantryLabel, PantryModal, PrimaryButton, SecondaryButton, TickBox } from './parts'

/**
 * "Taken out of the pantry" (PANTRY_SCREEN §6, id 9f) — the receipt, shown after a night is
 * confirmed as eaten.
 *
 * **Everything on this screen is already applied.** The ticks are undo, not consent: unticking a
 * line reverses that single `Deducted` event, and both footer buttons close. Framing it as a
 * confirmation would make the deduction wait on somebody walking past the panel, and a pantry that
 * only updates when you agree with it is a pantry that stops being right.
 */
export function DeductionScreen() {
  const navigate = useNavigate()
  const { planEntryId = '' } = useParams()
  const entryId = Number(planEntryId)
  const { refresh, undoEvent, addManyToGrocery } = usePantry()

  const [receipt, setReceipt] = useState<DeductionReceiptDto | null>(null)
  const [undone, setUndone] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)

  const leave = () => navigate('/meals', { replace: true })

  useEffect(() => {
    if (!entryId) { leave(); return }
    let cancelled = false
    void api.deductForNight(entryId)
      .then((result) => {
        if (cancelled) return
        // 204 — nothing was deductible. The screen simply does not appear (§6, behaviours §6).
        if (!result) { leave(); return }
        setReceipt(result)
      })
      // The pantry never blocks the Meals flow. A failed deduction leaves the night confirmed.
      .catch(() => { if (!cancelled) leave() })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryId])

  if (!receipt) return null

  const toggle = async (line: ReceiptLineDto) => {
    if (busy || undone.has(line.eventId)) return
    setBusy(true)
    try {
      await undoEvent(line.eventId)
      setUndone((prev) => new Set(prev).add(line.eventId))
    } finally {
      setBusy(false)
    }
  }

  const undoAll = async () => {
    if (busy) return
    setBusy(true)
    try {
      await api.undoDeduction(entryId)
      await refresh()
      leave()
    } finally {
      setBusy(false)
    }
  }

  // Only lines that actually hit zero, and only while they are still undone-free — unticking the
  // chicken should take the offer away with it.
  const emptied = receipt.counted
    .filter((l) => l.to != null && l.to <= 0 && !undone.has(l.eventId))
    .concat(receipt.estimated.filter((l) => l.resultingState === 'None' && !undone.has(l.eventId)))

  const offerToList = async () => {
    if (busy || emptied.length === 0) return
    setBusy(true)
    try {
      await addManyToGrocery(emptied.map((l) => ({
        text: l.name,
        pantryItemId: l.pantryItemId,
        sourceKind: 'LowStock' as const,
      })))
      leave()
    } finally {
      setBusy(false)
    }
  }

  return (
    <PantryModal
      backLabel={whenWord(receipt.date)}
      title="OFF THE SHELVES"
      meta={`FOR ${receipt.servings}`}
      footer={
        <div className="pt-modal__foot">
          <div className="pt-footer__row">
            <PrimaryButton grow={2.2} onClick={leave} disabled={busy}>THAT&rsquo;S RIGHT</PrimaryButton>
            <SecondaryButton onClick={() => void undoAll()} disabled={busy}>UNDO ALL</SecondaryButton>
          </div>
          {emptied.length > 0 && (
            <button type="button" className="pt-footnote pt-footnote--tap" onClick={() => void offerToList()}>
              {`${emptied.map((l) => l.name).join(', ')} hit none — want them on the grocery list?`}
            </button>
          )}
        </div>
      }
    >
      <h2 className="pt-check__title serif">Taken out of the pantry</h2>
      <p className="pt-check__sub">
        You said you cooked <span className="pt-check__dish">{receipt.dishName}</span>, so I&rsquo;ve
        assumed the recipe&rsquo;s amounts came out of the shelves. Untick anything that
        didn&rsquo;t.
      </p>

      {receipt.counted.length > 0 && (
        <>
          <PantryLabel label="COUNTED" meta="EXACT" />
          {receipt.counted.map((line) => {
            const reversed = undone.has(line.eventId) || line.undone
            return (
              <div className={'pt-receipt' + (reversed ? ' pt-receipt--undone' : '')} key={line.eventId}>
                <TickBox checked={!reversed} label={`Undo ${line.name}`} onToggle={() => void toggle(line)} />
                <span className="pt-receipt__name">{line.name}</span>
                <span className="pt-receipt__from">{line.from != null ? trimNumber(line.from) : '—'}</span>
                <span className="pt-receipt__arrow" aria-hidden="true">→</span>
                <span className={'pt-receipt__to' + (line.to != null && line.to <= 0 ? ' pt-receipt__to--none' : '')}>
                  {line.to != null && line.to <= 0 ? 'none' : trimNumber(line.to ?? 0)}
                </span>
              </div>
            )
          })}
        </>
      )}

      {receipt.estimated.length > 0 && (
        <>
          {/* The label is the promise: this group claims no arithmetic, because none was honest. */}
          <PantryLabel label="BY ESTIMATE" meta="NO ARITHMETIC CLAIMED" />
          {receipt.estimated.map((line) => {
            const reversed = undone.has(line.eventId) || line.undone
            return (
              <div className={'pt-receipt pt-receipt--est' + (reversed ? ' pt-receipt--undone' : '')} key={line.eventId}>
                <TickBox checked={!reversed} label={`Undo ${line.name}`} onToggle={() => void toggle(line)} />
                <span className="pt-receipt__main">
                  <span className="pt-receipt__name">{line.name}</span>
                  {line.note && <span className="pt-receipt__note">{line.note}</span>}
                </span>
                <span className={'pt-receipt__state' + (line.resultingState === 'None' ? ' pt-receipt__to--none' : '')}>
                  {estimateWord(line.resultingState)}
                </span>
              </div>
            )
          })}
        </>
      )}

      {receipt.leftAlone.length > 0 && (
        <>
          <PantryLabel label="LEFT ALONE" meta="STAPLES" />
          <div className="pt-receipt pt-receipt--staples">
            <span className="pt-receipt__name">{receipt.leftAlone.join(', ')}</span>
            <span className="pt-receipt__state">NOT COUNTED</span>
          </div>
        </>
      )}
    </PantryModal>
  )
}

/** `YESTERDAY` / `TUESDAY` / a date — the left cell of the modal header. */
function whenWord(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  if (!y || !m || !d) return ''
  const date = new Date(y, m - 1, d)
  const today = new Date()
  const days = Math.round(
    (new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - date.getTime()) / 86_400_000,
  )
  if (days === 0) return 'TODAY'
  if (days === 1) return 'YESTERDAY'
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: 'long' }).toUpperCase()
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase()
}
