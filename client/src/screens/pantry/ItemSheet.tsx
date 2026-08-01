import { useEffect, useState } from 'react'
import { usePantry } from '../../app/PantryProvider'
import { LOCATIONS, ageLabel, trimNumber } from '../../app/pantryDomain'
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
  const [estimate, setEstimate] = useState<EstimateStateName>(item?.estimateState ?? 'Plenty')
  const [history, setHistory] = useState<PantryEventDto[]>([])
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

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
    const input = {
      name: name.trim(),
      location,
      tracking,
      quantity: tracking === 'Counted' ? quantity : null,
      unit: unit.trim() || null,
      estimateState: tracking === 'Estimated' ? estimate : null,
    }
    try {
      if (item) await updateItem(item.id, input, item.version)
      else await addItem(input)
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
                <input
                  className="pt-field__input pt-amount__unit"
                  value={unit}
                  placeholder="tins"
                  onChange={(e) => setUnit(e.target.value)}
                />
              </div>
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
