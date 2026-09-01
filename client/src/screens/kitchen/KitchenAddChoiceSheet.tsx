import { useNavigate } from 'react-router'
import { Icon } from '../../icons/Icon'
import type { IconId } from '../../icons/Icon'

/** The three doors, in the order P4 lists them. `One thing` stays first: it is the common case. */
const WAYS: { to: string; icon: IconId; label: string; detail: string }[] = [
  {
    to: '/kitchen/pantry/add',
    icon: 'ico-add',
    label: 'One thing',
    detail: 'scan a barcode or type it in',
  },
  {
    to: '/kitchen/pantry/delivery',
    icon: 'ico-camera',
    label: 'A whole delivery',
    detail: 'screenshots of the order, read in one go',
  },
  {
    to: '/kitchen/pantry/delivery?source=receipt',
    icon: 'ico-receipt',
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
 * **Three ruled rows, not three boxes.** They were bordered cards with the first one filled brass
 * to mark it as the common case — which is a weight the handoff does not give it, and which made
 * the sheet read as one recommended button above two alternatives. `One thing` leads by being
 * first; that is the whole of its precedence. Each row carries its glyph and a chevron, so it looks
 * like every other row in the section that goes somewhere.
 */
export function KitchenAddChoiceSheet({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()

  return (
    <>
      {/* Over the shelves, not instead of them — you can still see what you were looking at. */}
      <button type="button" className="ml-kitchen__scrim" aria-label="Never mind" onClick={onClose} />
      <div className="ml-kitchen__choices" role="dialog" aria-label="Add to the pantry">
        {/* A label, not a question. `How is it getting in?` was a serif line the width of the sheet
            where the handoff has the section's ordinary brass heading — it made the sheet look like
            a different piece of software from the panel it slides over. */}
        <div className="ml-kitchen__choicestitle">ADD TO THE PANTRY</div>
        <div className="ml-kitchen__choicelist">
          {WAYS.map((way) => (
            <button
              key={way.to}
              type="button"
              className="ml-kitchen__choice"
              onClick={() => navigate(way.to)}
            >
              {/* The colour lives on the wrapper, not on the glyph. `Icon` sets `color: inherit`
                  as an inline style, which beats any class rule on the `<svg>` itself — so a
                  `className` that only sets a colour silently does nothing, and these rendered in
                  near-white. Wrapping lets the inherit resolve to something brass. */}
              <span className="ml-kitchen__choiceglyph">
                <Icon id={way.icon} size="1.375rem" />
              </span>
              <span className="ml-kitchen__choicewords">
                <span className="ml-kitchen__choicelabel">{way.label}</span>
                <span className="ml-kitchen__choicedetail">{way.detail}</span>
              </span>
              <span className="ml-kitchen__chev" aria-hidden="true">›</span>
            </button>
          ))}
        </div>
        <div className="ml-kitchen__choicefoot">
          <button type="button" className="ml-kitchen__errandalt" onClick={onClose}>
            NEVER MIND
          </button>
        </div>
      </div>
    </>
  )
}
