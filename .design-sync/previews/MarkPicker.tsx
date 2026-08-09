import { MarkPicker } from 'client'

/** Picking a mark for an event — preview cell, the 20 household marks, and the save/cancel chrome. */
export const ForAnEvent = () => (
  <MarkPicker
    subject="Reading group"
    value={null}
    sample="11:00 AM"
    noneLabel="No mark — uses the calendar's"
    showLocked={false}
    onCancel={() => {}}
    onSave={() => {}}
  />
)

/** For a calendar, with a mark already stored and the locked group explained. */
export const ForACalendar = () => (
  <MarkPicker
    subject="Leif's school"
    value="school"
    sample="Parent–teacher evening"
    note="An event with its own mark overrides this."
    onCancel={() => {}}
    onSave={() => {}}
  />
)
