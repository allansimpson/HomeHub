import { MarkBox } from 'client'

// MarkDefinition is a plain {key, icon, label} record, so a preview can build one without
// reaching into app/calendarMarks (which the component barrel doesn't re-export).
const SCHOOL = { key: 'school' as const, icon: 'ico-mark-school' as const, label: 'School' }
const MEDICAL = { key: 'medical' as const, icon: 'ico-mark-medical' as const, label: 'Cross' }

/** Unmarked reads as a dashed box with a `+` — an invitation, not a broken icon. */
export const Unmarked = () => <MarkBox mark={null} onClick={() => {}} label="Ragnar's calendar" />

/** Marked, showing the stored glyph. */
export const Marked = () => <MarkBox mark={SCHOOL} onClick={() => {}} label="Leif's calendar" />

/** Both states together — the difference is the whole point of the control. */
export const Comparison = () => (
  <div style={{ display: 'flex', gap: '1.25rem', alignItems: 'center' }}>
    <MarkBox mark={null} onClick={() => {}} label="Unmarked" />
    <MarkBox mark={SCHOOL} onClick={() => {}} label="School" />
    <MarkBox mark={MEDICAL} onClick={() => {}} label="Medical" />
  </div>
)

/** The `preview` size, as used inside the picker's own preview cell. */
export const PreviewSize = () => <MarkBox mark={MEDICAL} size="preview" label="Dentist" />
