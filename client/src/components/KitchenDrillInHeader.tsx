import type { ReactNode } from 'react'

interface KitchenDrillInHeaderProps {
  /**
   * The word in the boxed control top-left — `BACK`, `CANCEL`, `PAUSE`, `LATER`, `STOP`.
   *
   * Always a word, never the arrow the ledger screens use. A Kitchen drill-in is as often a session
   * you are abandoning as a screen you are leaving, and `CANCEL` and `BACK` are not the same
   * promise — a glyph makes the household guess which one it is holding.
   */
  exit?: string
  onExit?: () => void
  /**
   * The screen's own name, centred in Marcellus — `Add to pantry`, `Check the shelves`.
   *
   * Mutually exclusive with {@link label}: the centre cell says either what the screen is or where
   * in the data you are standing, and a header carrying both says one of them twice.
   */
  title?: string
  /**
   * A context label in place of a name — `CUPBOARD`, `SAT 23 AUG`, `STEP 3 OF 6`, `ITALIAN`.
   *
   * Used where the screen's own name is already the page heading in the body. The header then spends
   * its one slot on the thing the body cannot repeat: which shelf, which night, which step.
   */
  label?: string
  /** The right-hand cell — `14 LEFT`, a clock, or a control such as `DONE` / `COMPLETE`. */
  status?: ReactNode
  /** Render the status in verdigris (live/OK). */
  statusLive?: boolean
}

/**
 * The Kitchen's drill-in header: boxed word · centred title · status.
 *
 * **Not `DrillInHeader`.** The ledger screens (Config, Assist, Sensor History) put a 32px Marcellus
 * title hard left behind a 44px arrow box; every drilled-in Kitchen panel in the handoff is a
 * `1fr auto 1fr` grid with the title centred between a worded exit and a status
 * (`design_handoff_kitchen/designs`, eight panel files, no exceptions). Sharing one component
 * between the two would mean a variant flag on every call site in both sections, and the two
 * systems have never agreed about this header — so they get one each.
 *
 * The right cell is left empty on screens that carry the account avatar, which is pinned over it by
 * {@link ScreenShell}; screens with a `status` are the ones the handoff draws without an avatar.
 *
 * @category Shell
 */
export function KitchenDrillInHeader({
  exit, onExit, title, label, status, statusLive,
}: KitchenDrillInHeaderProps) {
  return (
    <header className="ml-header ml-kitchenhead">
      <div className="ml-kitchenhead__exit">
        {exit && onExit && (
          <button
            type="button"
            className={'ml-kitchenhead__exitbtn'
              + (ABANDONS.has(exit.toUpperCase()) ? ' ml-kitchenhead__exitbtn--abandon' : '')}
            onClick={onExit}
          >
            {exit}
          </button>
        )}
      </div>

      {title !== undefined && title !== '' && (
        <span className="ml-kitchenhead__title serif">{title}</span>
      )}
      {label !== undefined && label !== '' && (
        <span className="ml-kitchenhead__label">{label}</span>
      )}
      {/* The grid is three columns whether or not the middle one has anything in it, so the exit and
          the status never slide inward on a header that happens to be untitled. */}
      {(title === undefined || title === '') && (label === undefined || label === '') && <span />}

      <div className={'ml-kitchenhead__status' + (statusLive ? ' ml-kitchenhead__status--live' : '')}>
        {status}
      </div>
    </header>
  )
}

/**
 * The exit words that give something up, as against the ones that merely leave.
 *
 * `BACK`, `PAUSE` and `STOP` return to a screen that will still be there; these three abandon a
 * session, a queue or a set of answers. The handoff sets them a step quieter, and the tone is the
 * panel declining to invite the more expensive of the two.
 */
const ABANDONS = new Set(['CANCEL', 'LATER', 'UNDO ALL', 'NEVER MIND'])
