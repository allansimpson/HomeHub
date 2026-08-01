import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, ApiError } from '../../api/client'
import { usePantry } from '../../app/PantryProvider'
import { useSession } from '../../app/SessionProvider'
import { trimNumber } from '../../app/pantryDomain'
import type { OrderImportDto, OrderImportLineDto } from '../../api/types'
import { AmountField, PantryLabel, PantryModal, PrimaryButton, SecondaryButton } from './parts'

/**
 * "An order arrived" (PANTRY_SCREEN §4, id 9d) — one review screen for three input formats.
 *
 * **Nothing is written until `PUT n AWAY`.** A scan is one item and its run list is the undo; a bad
 * import is twenty-four wrong rows, so this one defers (DECISIONS PG3). `NOT NOW` leaves it pending
 * and it reappears as a single ruled row on 9a.
 *
 * The raw string stays on every row for ever. It is the only way a wrong interpretation gets
 * caught, and hiding it once the panel has guessed a name would make the guess look like a fact.
 */
export function ImportScreen() {
  const navigate = useNavigate()
  const { id = '' } = useParams()
  const { activeProfileId } = useSession()
  const { refresh } = usePantry()

  const isNew = id === 'new'
  const [imported, setImported] = useState<OrderImportDto | null>(null)
  const [payload, setPayload] = useState('')
  const [vendor, setVendor] = useState('')
  const [busy, setBusy] = useState(false)
  const [taken, setTaken] = useState<string | null>(null)
  const [editing, setEditing] = useState<OrderImportLineDto | null>(null)

  useEffect(() => {
    if (isNew) return
    let cancelled = false
    void api.getImport(Number(id))
      .then((result) => { if (!cancelled) setImported(result) })
      .catch(() => { if (!cancelled) navigate('/pantry', { replace: true }) })
    return () => { cancelled = true }
  }, [id, isNew, navigate])

  const parse = async () => {
    if (!payload.trim() || busy) return
    setBusy(true)
    try {
      const created = await api.createImport({
        source: 'Email',
        vendorLabel: vendor.trim() || null,
        rawPayload: payload,
      })
      setImported(created)
      navigate(`/pantry/import/${created.id}`, { replace: true })
    } finally {
      setBusy(false)
    }
  }

  const apply = async () => {
    if (!imported || busy) return
    setBusy(true)
    try {
      await api.applyImport(imported.id, activeProfileId)
      await refresh()
      navigate('/pantry', { replace: true })
    } catch (err) {
      // 409 — somebody else got there first. They are told who, not shown a failure (PG7).
      if (err instanceof ApiError && err.status === 409) {
        const current = err.body as OrderImportDto | undefined
        setTaken(current?.appliedByName
          ? `${current.appliedByName} put this away already.`
          : 'Someone already put this away.')
        setImported(current ?? imported)
      }
    } finally {
      setBusy(false)
    }
  }

  if (isNew && !imported) {
    return (
      <PantryModal
        back={() => navigate('/pantry')}
        title="AN ORDER ARRIVED"
        meta="PASTE IT"
        footer={
          <div className="pt-modal__foot">
            <div className="pt-footer__row">
              <PrimaryButton grow={2.2} onClick={() => void parse()} disabled={!payload.trim() || busy}>
                READ IT
              </PrimaryButton>
              <SecondaryButton onClick={() => navigate('/pantry')}>NOT NOW</SecondaryButton>
            </div>
          </div>
        }
      >
        <div className="pt-source">
          <span className="pt-source__label">WHERE IT CAME FROM</span>
          <p className="pt-source__body">
            Paste the order email you forwarded, or the store app&rsquo;s share text. A photo of a
            receipt lands on this same screen once its text has been read out.
          </p>
        </div>
        <label className="pt-field">
          <span className="pt-field__label">WHO FROM</span>
          <input
            className="pt-field__input"
            value={vendor}
            placeholder="Walmart"
            onChange={(e) => setVendor(e.target.value)}
          />
        </label>
        <label className="pt-field">
          <span className="pt-field__label">THE ORDER</span>
          <textarea
            className="pt-field__input pt-field__area"
            value={payload}
            rows={10}
            placeholder={'GV HVY WHP CRM 32Z\nMM CHKN BRST 2.5LB PK\n…'}
            onChange={(e) => setPayload(e.target.value)}
          />
        </label>
      </PantryModal>
    )
  }

  if (!imported) return null

  const applicable = imported.lines.filter((l) => l.confidence !== 'Unreadable').length
  const unreadable = imported.unreadableCount
  const alreadyApplied = imported.status === 'Applied'

  return (
    <PantryModal
      back={() => navigate('/pantry')}
      title="AN ORDER ARRIVED"
      meta={`${imported.lines.length} LINE${imported.lines.length === 1 ? '' : 'S'}`}
      footer={
        <div className="pt-modal__foot">
          {taken || alreadyApplied ? (
            <>
              <p className="pt-footnote">{taken ?? 'This order is already put away.'}</p>
              <PrimaryButton onClick={() => navigate('/pantry')}>SEE THE PANTRY</PrimaryButton>
            </>
          ) : (
            <>
              <div className="pt-footer__row">
                <PrimaryButton grow={2.2} onClick={() => void apply()} disabled={busy || applicable === 0}>
                  {`PUT ${applicable} AWAY`}
                </PrimaryButton>
                <SecondaryButton onClick={() => navigate('/pantry')}>NOT NOW</SecondaryButton>
              </div>
              {unreadable > 0 && (
                <p className="pt-footnote">
                  {`The ${unreadable === 1 ? 'one it couldn’t read stays' : `${unreadable} it couldn’t read stay`} here until you name ${unreadable === 1 ? 'it' : 'them'}.`}
                </p>
              )}
            </>
          )}
        </div>
      }
    >
      <div className="pt-source">
        <div className="pt-source__head">
          <span className="pt-source__vendor serif">{imported.vendorLabel ?? 'An order'}</span>
          <span className="pt-source__date">
            {imported.deliveredAtUtc
              ? new Date(imported.deliveredAtUtc).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase()
              : ''}
          </span>
        </div>
        <p className="pt-source__body">
          Read from the order you gave it. A photo of a receipt or the store app&rsquo;s share sheet
          lands on this same screen.
        </p>
      </div>

      {/* Three cells, and the words matter: `UNREADABLE` is a count of rows that need a human, not
          a count of failures. */}
      <div className="pt-tallybox">
        <div className="pt-tallybox__cell">
          <span className="pt-tallybox__n serif pt-tallybox__n--ok">{imported.matchedCount}</span>
          <span className="pt-tallybox__label">MATCHED</span>
        </div>
        <div className="pt-tallybox__cell">
          <span className="pt-tallybox__n serif pt-tallybox__n--new">{imported.newCount}</span>
          <span className="pt-tallybox__label">NEW</span>
        </div>
        <div className="pt-tallybox__cell">
          <span className="pt-tallybox__n serif pt-tallybox__n--warn">{unreadable}</span>
          <span className="pt-tallybox__label">UNREADABLE</span>
        </div>
      </div>

      <PantryLabel label="WHAT IT READ" meta="TAP TO CORRECT" />

      {imported.lines.length === 0 && (
        <p className="pt-group__empty">
          Nothing in that looked like a shopping list. Paste the part with the items in it.
        </p>
      )}

      {imported.lines.map((line) => (
        <button
          type="button"
          className="pt-importrow"
          key={line.id}
          onClick={() => setEditing(line)}
          disabled={alreadyApplied}
        >
          {/* Always visible, always first. */}
          <span className="pt-importrow__raw">{line.rawText}</span>
          <span className="pt-importrow__body">
            <span className={'pt-importrow__name' + (line.confidence === 'Unreadable' ? ' pt-importrow__name--unread' : '')}>
              {line.proposedName ?? 'Couldn’t read this one'}
              {line.confidence === 'New' && <span className="pt-importrow__new">NEW</span>}
            </span>
            {line.confidence === 'Unreadable' ? (
              <span className="pt-nameit pt-nameit--inline">NAME IT</span>
            ) : (
              <>
                <span className={'pt-importrow__count' + (line.confidence === 'WeightGuess' ? ' pt-importrow__count--guess' : '')}>
                  {line.confidence === 'WeightGuess' ? 'about ' : ''}
                  {line.proposedQuantity != null ? trimNumber(line.proposedQuantity) : '—'}
                  {line.proposedUnit ? ` ${line.proposedUnit}` : ''}
                </span>
                <span className="pt-importrow__loc">{line.proposedLocation.toUpperCase()}</span>
              </>
            )}
          </span>
          {/* The guess says it is a guess in the same sentence, with the evidence (PG5). */}
          {line.confidence === 'WeightGuess' && line.guessFromPounds != null && (
            <span className="pt-importrow__guess">
              {`Sold by weight — ${line.proposedQuantity != null ? trimNumber(line.proposedQuantity) : 'that'} is a guess from ${trimNumber(line.guessFromPounds)} lb. Tap to set it.`}
            </span>
          )}
        </button>
      ))}

      {editing && (
        <ImportLineSheet
          importId={imported.id}
          line={editing}
          onClose={() => setEditing(null)}
          onSaved={(next) => { setImported(next); setEditing(null) }}
        />
      )}
    </PantryModal>
  )
}

/** Correcting one line. Writes to the import, never to the pantry — that waits for `PUT n AWAY`. */
function ImportLineSheet({
  importId,
  line,
  onClose,
  onSaved,
}: {
  importId: number
  line: OrderImportLineDto
  onClose: () => void
  onSaved: (next: OrderImportDto) => void
}) {
  const [name, setName] = useState(line.proposedName ?? '')
  const [quantity, setQuantity] = useState(line.proposedQuantity ?? 1)
  const [unit, setUnit] = useState(line.proposedUnit ?? '')
  const [busy, setBusy] = useState(false)

  const save = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    try {
      const next = await api.updateImportLine(importId, line.id, {
        proposedName: name.trim(),
        proposedQuantity: quantity,
        proposedUnit: unit.trim() || null,
      })
      onSaved(next)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="pt-sheet" role="dialog" aria-label="Correct this line">
      <div className="pt-sheet__panel">
        <header className="pt-sheet__head">
          <button type="button" className="pt-sheet__cancel" onClick={onClose}>CANCEL</button>
          <span className="pt-sheet__title">WHAT IS IT</span>
          <button type="button" className="pt-sheet__save" onClick={() => void save()} disabled={busy}>SAVE</button>
        </header>
        <div className="pt-sheet__body">
          <span className="pt-importrow__raw">{line.rawText}</span>
          <label className="pt-field">
            <span className="pt-field__label">CALL IT</span>
            <input className="pt-field__input" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
          </label>
          <span className="pt-field__label">HOW MANY</span>
          <div className="pt-amount">
            <AmountField value={quantity} onChange={setQuantity} label="How many" />
            <input
              className="pt-field__input pt-amount__unit"
              value={unit}
              placeholder="ea"
              onChange={(e) => setUnit(e.target.value)}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
