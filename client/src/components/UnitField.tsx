import { useState } from 'react'
import { resolveUnit, suggestUnits, useUnits } from '../app/units'

/**
 * A unit box that suggests as you type and stores one spelling.
 *
 * **Free text with a memory, not a picker.** Every unit a kitchen uses could not be listed in
 * advance — "sleeve", "rasher", "punnet" — so the box takes whatever is typed. What it adds is that
 * `ounces`, `oz`, `OZ` and `Oz.` all resolve to the one `oz` that everything else in the app spells,
 * and that a word somebody invented once is offered back to the next person who reaches for it.
 * Without that, the pantry and the recipe that wants it spell the same unit differently and the
 * stock check quietly cannot join them.
 *
 * The strip below the box is a single scrolling row rather than a dropdown. A wall panel types with
 * an on-screen keyboard pinned to the bottom of the screen, and a six-row menu opening downwards
 * from a mid-sheet field opens straight into it.
 *
 * The server normalises again on save and is the authority (`UnitRegistry`). Resolving here as well
 * is not a duplicate rule — it is the same rule applied early, so the field can show what will be
 * stored rather than rewriting it after the sheet has closed.
 */
export function UnitField({
  value,
  onChange,
  placeholder,
  label = 'Unit',
  className,
}: {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  label?: string
  /** Layout class for the wrapper — the host section's own, e.g. `pt-amount__unit`. */
  className?: string
}) {
  const units = useUnits()
  const [open, setOpen] = useState(false)

  const suggestions = suggestUnits(value, units)
  // What the typed text would be stored as. Highlights the chip somebody is halfway to typing, so
  // "ounc" already shows `OZ` picked out rather than waiting for the save to say so.
  const resolved = resolveUnit(value, units)

  return (
    <div className={'pt-unitfield' + (className ? ` ${className}` : '')}>
      <input
        className="pt-field__input pt-unitfield__input"
        value={value}
        aria-label={label}
        placeholder={placeholder}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => { onChange(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        // Committed on the way out rather than on every keystroke: rewriting "ounces" to "oz" under
        // the caret at the third letter is a box that fights the person typing into it.
        onBlur={() => { setOpen(false); if (value.trim()) onChange(resolved) }}
      />
      {open && suggestions.length > 0 && (
        <div className="pt-unitfield__strip" role="listbox" aria-label={`${label} suggestions`}>
          {suggestions.map((unit) => (
            <button
              type="button"
              key={unit.canonical}
              role="option"
              aria-selected={unit.canonical === resolved}
              aria-label={unit.displayName ?? unit.canonical}
              className={'pt-chip' + (unit.canonical === resolved ? ' pt-chip--on' : '')}
              // The same trick the on-screen keyboard uses on itself: without it the input blurs on
              // press, the strip unmounts, and the tap lands on whatever moved into that spot.
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => { onChange(unit.canonical); setOpen(false) }}
            >
              {/* Verbatim, against the section's habit of upper-casing every chip. This strip is
                  about which spelling gets stored, so a chip reading `ML` for `mL` would be the one
                  control in the app allowed to misreport its own answer. */}
              {unit.canonical}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
