import { useState } from 'react'
import { ScreenShell } from './ScreenShell'
import { ScrollArea } from './ScrollArea'
import { SectionLabel } from './SectionLabel'
import { Icon } from '../icons/Icon'
import type { IconId } from '../icons/Icon'
import { HOUSEHOLD_MARKS, markDefinition } from '../app/calendarMarks'
import type { MarkDefinition, MarkKey } from '../app/calendarMarks'

/**
 * The mark box: the control on the left of a CONFIG calendar row, the editor's MARK field, and the
 * picker's own preview. Unmarked reads as a dashed box with a `+` — an invitation, not a broken icon.
 *
 * @category Controls
 */
export function MarkBox({
  mark,
  onClick,
  label,
  size,
}: {
  mark: MarkDefinition | null
  onClick?: () => void
  /** Names the thing being marked, for the button's accessible label. */
  label?: string
  size?: 'preview'
}) {
  const className =
    'ml-markbox' + (size === 'preview' ? ' ml-markbox--preview' : '') + (mark?.icon ? '' : ' ml-markbox--empty')
  const body = mark?.icon ? (
    <Icon id={mark.icon} size="1.25rem" className={'ml-mark' + (mark.key === 'medical' ? ' ml-mark--medical' : '')} />
  ) : (
    <span aria-hidden="true">+</span>
  )
  if (!onClick) return <span className={className}>{body}</span>
  return (
    <button type="button" className={className} onClick={onClick} aria-label={`Mark for ${label ?? 'calendar'}`}>
      {body}
    </button>
  )
}

/** The four marks the provider sets. Shown locked so an overridden mark explains itself. */
const LOCKED_MARKS: { icon: IconId; label: string; sub: string; inferred?: boolean }[] = [
  { icon: 'ico-mark-cake', label: 'Birthday', sub: 'Stated' },
  { icon: 'ico-mark-cake', label: 'Birthday', sub: 'Inferred', inferred: true },
  { icon: 'ico-mark-gift', label: 'Anniversary', sub: 'Kind' },
  { icon: 'ico-mark-post', label: 'Booking', sub: 'From Gmail' },
]

interface MarkPickerProps {
  /** What is being marked — a calendar's name, or an event's title. */
  subject: string
  /** Currently stored mark key, or null. */
  value: string | null
  onCancel: () => void
  onSave: (mark: MarkKey) => void
  /**
   * Caption for the empty cell. A calendar with no mark shows a plain rule; an *event* with no mark
   * falls back to its kind and its calendar, which is a different sentence.
   */
  noneLabel?: string
  /** The line under the preview box — a sample calendar item, or the event's own time. */
  sample?: string
  /**
   * Whether the locked group applies. It explains what overrides a *calendar's* mark; on an event
   * whose own mark already wins outright it would say the opposite of the truth.
   */
  showLocked?: boolean
  /** A line under the grid explaining what this particular mark will override. */
  note?: string
}

/**
 * Full-screen mark picker (spec 14): preview, the 20 household marks, and — for a calendar — the
 * four marks the event decides for itself.
 *
 * @category Controls
 */
export function MarkPicker({ subject, value, onCancel, onSave, noneLabel, sample, showLocked = true, note }: MarkPickerProps) {
  const [draft, setDraft] = useState<MarkKey>(() => markDefinition(value)?.key ?? 'none')
  const preview = markDefinition(draft)

  const header = (
    <header className="ml-header ml-editor-header">
      <button type="button" className="ml-editor-header__cancel" onClick={onCancel}>
        Cancel
      </button>
      <span className="ml-editor-header__title serif">CHOOSE A MARK</span>
      <button type="button" className="ml-editor-header__save" onClick={() => onSave(draft)}>
        Save
      </button>
    </header>
  )

  return (
    <ScreenShell header={header} avatar={false}>
      <ScrollArea>
        <div className="ml-markpreview">
          <MarkBox mark={preview} size="preview" />
          <div className="ml-markpreview__body">
            <div className="ml-markpreview__label label">Preview · {subject}</div>
            <div className="ml-markpreview__sample">{sample ?? 'Reading group · 11:00 AM'}</div>
          </div>
        </div>

        <SectionLabel label="Household marks" />
        <div className="ml-markgrid">
          {HOUSEHOLD_MARKS.map((m) => (
            <button
              key={m.key}
              type="button"
              className={'ml-markcell' + (m.key === draft ? ' ml-markcell--selected' : '')}
              onClick={() => setDraft(m.key)}
            >
              <span className="ml-markcell__icon">
                {m.icon ? <Icon id={m.icon} size="1.375rem" className="ml-mark ml-mark--pick" /> : <span className="ml-agenda__nomark" />}
              </span>
              <span className="ml-markcell__caption">{m.key === 'none' ? (noneLabel ?? m.label) : m.label}</span>
            </button>
          ))}
        </div>

        {note && <div className="ml-settings__footnote">{note}</div>}

        {showLocked && (
          <>
            <SectionLabel label="Set by the event, not by you" />
            <div className="ml-markgrid ml-markgrid--locked">
              {LOCKED_MARKS.map((m) => (
                <div key={`${m.label}-${m.sub}`} className="ml-markcell ml-markcell--locked">
                  <span className="ml-markcell__icon">
                    <Icon id={m.icon} size="1.375rem" className={'ml-mark' + (m.inferred ? ' ml-mark--inferred' : '')} />
                  </span>
                  <span className="ml-markcell__caption">{m.label}</span>
                  <span className="ml-markcell__sub">{m.sub}</span>
                </div>
              ))}
            </div>
            <div className="ml-settings__footnote">These four override the calendar’s mark on the events that carry them.</div>
          </>
        )}
      </ScrollArea>
    </ScreenShell>
  )
}
