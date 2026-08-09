import { Chip } from 'client'

/** The three states side by side — the variant axis that matters. */
export const States = () => (
  <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
    <Chip label="ALL" active onClick={() => {}} />
    <Chip label="TODAY" onClick={() => {}} />
    <Chip label="LIVE" live active onClick={() => {}} />
  </div>
)

/** As a room selector — the most common use. */
export const RoomSelector = () => (
  <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
    <Chip label="LIVING ROOM" active onClick={() => {}} />
    <Chip label="NURSERY" onClick={() => {}} />
    <Chip label="MAIN BEDROOM" onClick={() => {}} />
    <Chip label="OFFICE" onClick={() => {}} />
  </div>
)

/** WHO multi-select, with the household's profiles. */
export const WhoMultiSelect = () => (
  <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
    <Chip label="ASTRID" active onClick={() => {}} />
    <Chip label="RAGNAR" active onClick={() => {}} />
    <Chip label="LEIF" onClick={() => {}} />
  </div>
)
