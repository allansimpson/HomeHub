import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { CutGroup, DrillInHeader, ScreenShell, ScrollArea, Stepper } from '../../components'
import { api } from '../../api/client'
import type { ShelfLifeDto } from '../../api/types'

/** The three bands, in the order S1 lists them. */
const STATES: { key: ShelfLifeDto['state']; label: string }[] = [
  { key: 'Fresh', label: 'FRESH' },
  { key: 'Chilled', label: 'CHILLED' },
  { key: 'Opened', label: 'ONCE OPENED' },
]

/**
 * HOW LONG THINGS LAST (SETTINGS_AND_IMPORT §1, panel S1).
 *
 * **Grouped by the state food is in, not by aisle.** How long a jar lasts depends on whether it has
 * been opened, not on where it was sold — and an aisle-shaped list would put the opened jar beside
 * the unopened one and imply they are the same question.
 *
 * **The blast radius is stated on the panel, twice.** These numbers decide what floats to the top of
 * *worth using soon* and nothing else: never a use-by date, never a notification. A settings screen
 * that does not say what it touches is one nobody will risk changing — and this one silently
 * reorders a band on the home page, which is exactly the sort of thing people need told.
 */
export function KitchenShelfLifeScreen() {
  const navigate = useNavigate()
  const [rows, setRows] = useState<ShelfLifeDto[]>([])
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    void api.getShelfLife().then(setRows).catch(() => {})
  }, [])

  useEffect(load, [load])

  const nudge = async (row: ShelfLifeDto, by: number) => {
    const days = Math.max(1, row.days + by)
    if (days === row.days) return

    // Optimistic — a stepper that waits on a round trip per tap is one you cannot hold down.
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, days, isSeeded: false } : r)))
    setBusy(true)
    try { await api.setShelfLife(row.id, days) } finally { setBusy(false) }
  }

  const reset = async () => {
    setBusy(true)
    try { setRows(await api.resetShelfLife()) } finally { setBusy(false) }
  }

  return (
    <ScreenShell
      header={
        <DrillInHeader
          title="How long things last"
          onBack={() => navigate('/kitchen/pantry')}
          backLabel="BACK"
        />
      }
    >
      <ScrollArea>
        {/* Said once at the top… */}
        <div className="ml-kitchen__askwhy">
          These decide what floats to the top of <em>worth using soon</em>. They are never a use-by
          date and never a notification.
        </div>

        {STATES.map(({ key, label }) => {
          const band = rows.filter((r) => r.state === key)
          if (band.length === 0) return null

          return (
            <div key={key}>
              <div className="ml-band">
                <span className="ml-band__label">{label}</span>
                <span className="ml-band__meta">{band.length}</span>
              </div>
              {/* 69px rows — two 44px steppers set the height, and the group's cut derives from
                  that rather than from a shelf row. */}
              <CutGroup rows={4} rowHeight={69} className="ml-band-shade">
                {band.map((row) => (
                  <div key={row.id} className="ml-row ml-kitchen__shelfliferow">
                    <span className="ml-kitchen__shelflifename">{row.foodKind}</span>

                    {/* Weeks where it reads better; the value is always stored in days so the two
                        never drift apart. */}
                    <span className="ml-kitchen__shelflifedays">
                      {row.days >= 14 && row.days % 7 === 0
                        ? `${row.days / 7} WEEKS`
                        : `${row.days} ${row.days === 1 ? 'DAY' : 'DAYS'}`}
                    </span>

                    {/* 44px each — the mobile floor, and what makes this row 69px tall. */}
                    <Stepper
                      direction="minus"
                      label={`${row.foodKind}, one day fewer`}
                      disabled={busy || row.days <= 1}
                      onStep={() => nudge(row, -1)}
                    />
                    <Stepper
                      direction="plus"
                      label={`${row.foodKind}, one day more`}
                      disabled={busy}
                      onStep={() => nudge(row, 1)}
                    />
                  </div>
                ))}
              </CutGroup>
            </div>
          )
        })}

        {/* …and again above the reset, which is where somebody hesitating will be looking. */}
        <div className="ml-kitchen__askwhy">
          Changing these changes the order of one band on the Kitchen page. Nothing is warned about,
          and nothing goes on a list because of them.
        </div>

        <button type="button" className="ml-kitchen__errandalt" disabled={busy} onClick={reset}>
          PUT THEM BACK
        </button>
      </ScrollArea>
    </ScreenShell>
  )
}
