import { useEffect, useState } from 'react'
import { usePantry } from '../../app/PantryProvider'
import { LOCATIONS, ageLabel, trimNumber } from '../../app/pantryDomain'
import { refreshUnits } from '../../app/units'
import { UnitField } from '../../components'
import { api } from '../../api/client'
import type {
  EstimateStateName, PantryEventDto, PantryItemDto, PantryLocationName, TrackingClassName,
} from '../../api/types'
import { AmountField, PrimaryButton, SecondaryButton } from './parts'

const TRACKING: { value: TrackingClassName; label: string; note: string }[] = [
  { value: 'Counted', label: 'COUNTED', note: 'Whole things you can see at a glance' },
  { value: 'Estimated', label: 'ESTIMATED', note: 'A container — plenty, low, or none' },
  { value: 'NotCounted', label: 'A STAPLE', note: 'Never counted, never chased' },
]

const ESTIMATES: EstimateStateName[] = ['Plenty', 'Low', 'None']

/**
 * The row sheet, and the `ADD BY HAND` form — the same fields either way (Stage 1).
 *
 * The tracking class is chosen here rather than inferred, and it is the field that decides
 * everything downstream: whether the stock check can claim a shortfall, whether cooking deducts
 * arithmetic or moves one step, and whether the item can ever appear as missing. It is therefore
 * shown with its consequence in words next to each option, not as a three-way toggle to be guessed
 * at.
 */
export function ItemSheet({ item, onClose }: { item: PantryItemDto | null; onClose: () => void }) {
  const { addItem, updateItem, archiveItem, undoEvent } = usePantry()
  const [name, setName] = useState(item?.name ?? '')
  const [location, setLocation] = useState<PantryLocationName>(item?.location ?? 'Cupboard')
  const [tracking, setTracking] = useState<TrackingClassName>(item?.tracking ?? 'Counted')
  const [quantity, setQuantity] = useState(item?.quantity ?? 1)
  const [unit, setUnit] = useState(item?.unit ?? '')
  /**
   * Whether this thing comes in packages, and how much is in one.
   *
   * Split from the amount above because they are two different facts that shared one number until
   * now: five 3 oz pots was either "15 oz", which nobody can check by opening the fridge, or five
   * rows saying 3 oz — the same shelf listed five times. Off by default: most of a pantry is loose.
   */
  const [packaged, setPackaged] = useState((item?.packSize ?? 0) > 0)
  const [packSize, setPackSize] = useState(item?.packSize ?? 1)
  const [packUnit, setPackUnit] = useState(item?.packUnit ?? '')
  const [estimate, setEstimate] = useState<EstimateStateName>(item?.estimateState ?? 'Plenty')
  /**
   * The barcode this row answers to.
   *
   * Seeded from `catalogueRef`, which is what a scan wrote, so the field shows the code the pack
   * actually carries rather than an empty box on an item that has one.
   */
  const [barcode, setBarcode] = useState(item?.catalogueRef ?? '')
  const [history, setHistory] = useState<PantryEventDto[]>([])
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  /** A refusal from the server — today, only a barcode another item already carries. */
  const [rejected, setRejected] = useState<string | null>(null)

  // The ledger is the row sheet's second half: it is where "the pantry last saw 2, six days ago"
  // comes from, so the sheet that lets you change a number also shows what the numbers have been.
  useEffect(() => {
    if (!item) return
    let cancelled = false
    void api.getPantryEvents(item.id, 12)
      .then((events) => { if (!cancelled) setHistory(events) })
      .catch(() => { /* the sheet still works without its history */ })
    return () => { cancelled = true }
  }, [item])

  const save = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    setRejected(null)
    const typed = barcode.replace(/\s+/g, '')
    const input = {
      name: name.trim(),
      location,
      tracking,
      quantity: tracking === 'Counted' ? quantity : null,
      unit: unit.trim() || null,
      // Only when the row is actually packaged and counted. A staple or an estimate has no count for
      // a pack size to multiply, and sending one would leave a stranded size on a row nothing reads
      // it from.
      packSize: packaged && tracking === 'Counted' && packSize > 0 ? packSize : null,
      packUnit: packaged && tracking === 'Counted' ? packUnit.trim() || null : null,
      estimateState: tracking === 'Estimated' ? estimate : null,
      /*
       * Sent only when it changed. The three states are distinct on the server: absent leaves the
       * code alone (and re-teaches the catalogue from the amended name, which is the point of
       * renaming a row to what you actually call it), a code sets it, and an empty string clears
       * it. Sending the unchanged value every time would work but would make every save look like
       * a re-link in the ledger.
       */
      barcode: typed === (item?.catalogueRef ?? '') ? undefined : typed,
    }
    try {
      const refusal = item ? await updateItem(item.id, input, item.version) : await addItem(input)
      // Stay open on a refusal — the box holding the offending code is the one thing worth keeping
      // on screen, and closing would lose everything else typed alongside it.
      if (refusal) { setRejected(refusal); return }
      // A unit nobody had used before is now on record. Drop the cached list so the next person to
      // reach for "sleeve" is offered it rather than having to spell it the same way from memory.
      refreshUnits()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="pt-sheet" role="dialog" aria-label={item ? item.name : 'Add to the pantry'}>
      <div className="pt-sheet__panel">
        <header className="pt-sheet__head">
          <button type="button" className="pt-sheet__cancel" onClick={onClose}>CANCEL</button>
          <span className="pt-sheet__title">{item ? 'THIS ITEM' : 'ADD BY HAND'}</span>
          <button type="button" className="pt-sheet__save" onClick={() => void save()} disabled={busy}>
            SAVE
          </button>
        </header>

        <div className="pt-sheet__body">
          <label className="pt-field">
            <span className="pt-field__label">WHAT IS IT</span>
            <input
              className="pt-field__input"
              value={name}
              placeholder="Butter, unsalted"
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          {/*
            Directly under the name, because it is the same question asked twice — what is this? —
            and because the case that matters is somebody standing at the shelf having just been
            told the barcode is not in the catalogue.

            Optional, and quietly so: most hand entries are loose produce with no code at all, and a
            required-looking field would be a nuisance on every one of them.
          */}
          <label className="pt-field">
            <span className="pt-field__label">ITS BARCODE</span>
            <input
              className="pt-field__input"
              value={barcode}
              inputMode="numeric"
              placeholder="Optional — if the pack has one"
              onChange={(e) => { setBarcode(e.target.value); setRejected(null) }}
            />
            <span className="pt-field__note">
              {barcode.trim()
                ? 'Scanning this pack will find it from now on.'
                : 'Add it and the next scan of this pack names itself.'}
            </span>
          </label>

          {rejected && <p className="pt-field__error" role="alert">{rejected}</p>}

          <span className="pt-field__label">WHERE IT LIVES</span>
          <div className="pt-chips">
            {LOCATIONS.map((loc) => (
              <button
                type="button"
                key={loc}
                className={'pt-chip' + (location === loc ? ' pt-chip--on' : '')}
                onClick={() => setLocation(loc)}
              >
                {loc.toUpperCase()}
              </button>
            ))}
          </div>

          <span className="pt-field__label">HOW CLOSELY</span>
          <div className="pt-tracking">
            {TRACKING.map((option) => (
              <button
                type="button"
                key={option.value}
                className={'pt-tracking__row' + (tracking === option.value ? ' pt-tracking__row--on' : '')}
                onClick={() => setTracking(option.value)}
              >
                <span className="pt-tracking__name">{option.label}</span>
                <span className="pt-tracking__note">{option.note}</span>
              </button>
            ))}
          </div>

          {tracking === 'Counted' && (
            <>
              <span className="pt-field__label">HOW MANY</span>
              <div className="pt-amount">
                <AmountField value={quantity} onChange={setQuantity} label="How many" />
                {/* The unit names what one of them is — `tins`, `containers`. On a packaged row it
                    is optional and usually left empty, because the size beside it already says
                    what the thing is. */}
                <UnitField
                  className="pt-amount__unit"
                  value={unit}
                  placeholder={packaged ? 'containers' : 'tins'}
                  label="Unit"
                  onChange={setUnit}
                />
              </div>

              {/*
                The size question, asked separately and only when it applies.

                It is off by default because most of a pantry is loose — lemons, a bag of flour by
                the gram — and a size field on every row would be a box to skip on every row. Turned
                on, the count above becomes a count of packages and the shelf reads `3 oz ×5`.
              */}
              <button
                type="button"
                className={'pt-tracking__row pt-packtoggle' + (packaged ? ' pt-tracking__row--on' : '')}
                aria-pressed={packaged}
                onClick={() => setPackaged((on) => !on)}
              >
                <span className="pt-tracking__name">IT COMES IN PACKAGES</span>
                <span className="pt-tracking__note">
                  {packaged
                    ? 'The count above is how many packages, not how much'
                    : 'Yogurt pots, tins of a stated size — anything you count rather than measure'}
                </span>
              </button>

              {packaged && (
                <>
                  <span className="pt-field__label">ONE PACKAGE HOLDS</span>
                  <div className="pt-amount">
                    <AmountField value={packSize} onChange={setPackSize} label="One package holds" />
                    <UnitField
                      className="pt-amount__unit"
                      value={packUnit}
                      placeholder="oz"
                      label="Package unit"
                      onChange={setPackUnit}
                    />
                  </div>
                  {/* Said out loud, because the row is the only place the two numbers meet and
                      "which one is the count?" is the question this whole split exists to answer. */}
                  <span className="pt-field__note">
                    {packSize > 0 && packUnit.trim()
                      ? `This shelf reads ${trimNumber(packSize)} ${packUnit.trim()} ×${trimNumber(quantity)}.`
                      : 'Add a size and a unit and the shelf will read like “3 oz ×5”.'}
                  </span>
                </>
              )}
            </>
          )}

          {tracking === 'Estimated' && (
            <>
              <span className="pt-field__label">HOW MUCH IS LEFT</span>
              <div className="pt-chips">
                {ESTIMATES.map((state) => (
                  <button
                    type="button"
                    key={state}
                    className={'pt-chip' + (estimate === state ? ' pt-chip--on' : '')}
                    onClick={() => setEstimate(state)}
                  >
                    {state.toUpperCase()}
                  </button>
                ))}
              </div>
            </>
          )}

          {tracking === 'NotCounted' && (
            <p className="pt-note">
              Nothing will ever deduct this or list it as missing. That is the whole point of a
              staple.
            </p>
          )}

          {item && history.length > 0 && (
            <>
              <span className="pt-field__label">WHAT&rsquo;S HAPPENED TO IT</span>
              <div className="pt-history">
                {history.map((event) => (
                  <div className={'pt-history__row' + (event.undone ? ' pt-history__row--undone' : '')} key={event.id}>
                    <span className="pt-history__kind">{event.kind.toUpperCase()}</span>
                    <span className="pt-history__what">
                      {event.delta != null && event.delta !== 0
                        ? `${event.delta > 0 ? '+' : ''}${trimNumber(event.delta)}`
                        : (event.resultingState ?? '—')}
                    </span>
                    <span className="pt-history__when">{ageLabel(event.atUtc)}</span>
                    {!event.undone && event.kind !== 'Undone' && (
                      <button
                        type="button"
                        className="pt-history__undo"
                        onClick={() => void undoEvent(event.id)}
                      >
                        UNDO
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {item && (
          <div className="pt-sheet__foot">
            {confirmDelete ? (
              <>
                {/* Named in full, because archiving is how an item leaves the list and the ledger
                    keeps its history either way — the household should know that's what happens. */}
                <span className="pt-sheet__confirm">
                  {`Take ${item.name} off the list? Its history stays.`}
                </span>
                <SecondaryButton onClick={() => setConfirmDelete(false)}>KEEP IT</SecondaryButton>
                <PrimaryButton
                  onClick={() => { void archiveItem(item.id, item.version).then(onClose) }}
                >
                  TAKE IT OFF
                </PrimaryButton>
              </>
            ) : (
              <button type="button" className="pt-sheet__delete" onClick={() => setConfirmDelete(true)}>
                TAKE IT OFF THE LIST
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
