import { useNavigate } from 'react-router'

/** The three doors, in the order P4 lists them. `One thing` stays first: it is the common case. */
const WAYS = [
  {
    to: '/kitchen/pantry/add',
    label: 'One thing',
    detail: 'scan a barcode or type it in',
  },
  {
    to: '/kitchen/pantry/delivery',
    label: 'A whole delivery',
    detail: 'screenshots of the order, read in one go',
  },
  {
    to: '/kitchen/pantry/delivery?source=receipt',
    label: 'A till receipt',
    detail: 'a photo of the paper one',
  },
]

/**
 * HOW SOMETHING GETS IN (SETTINGS_AND_IMPORT §4, panel P4).
 *
 * The `＋` in the Pantry header **no longer jumps straight to the add form**. It opens this over
 * the legible shelves.
 *
 * The sheet exists because two of the three routes had no door at all: the delivery import was
 * unreachable, and the receipt was a buried line in the add form's footer. A door nobody can find
 * is the same as a feature nobody built.
 *
 * **`One thing` stays first** because it is what people are usually doing. The sheet is not a menu
 * of equals — it is the common case with two rarer ones visible beneath it.
 */
export function KitchenAddChoiceSheet({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()

  return (
    <>
      {/* Over the shelves, not instead of them — you can still see what you were looking at. */}
      <button type="button" className="ml-kitchen__scrim" aria-label="Never mind" onClick={onClose} />
      <div className="ml-kitchen__choices" role="dialog" aria-label="How is it getting in?">
        <div className="ml-kitchen__choicestitle">How is it getting in?</div>
        {WAYS.map((way) => (
          <button
            key={way.to}
            type="button"
            className="ml-kitchen__choice"
            onClick={() => navigate(way.to)}
          >
            <span className="ml-kitchen__choicelabel">{way.label}</span>
            <span className="ml-kitchen__choicedetail">{way.detail}</span>
          </button>
        ))}
        <button type="button" className="ml-kitchen__errandalt" onClick={onClose}>
          NEVER MIND
        </button>
      </div>
    </>
  )
}
