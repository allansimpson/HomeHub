import { useState } from 'react'
import { useNavigate } from 'react-router'
import { CutGroup, DrillInHeader, ScreenShell, ScrollArea, UnitField } from '../../components'
import { api } from '../../api/client'
import type { PantryLocationName } from '../../api/types'

/** What has been added on this visit, newest first — the session list. */
interface SessionLine {
  id: number
  name: string
  amount: string
  location: PantryLocationName
}

const LOCATIONS: PantryLocationName[] = ['Cupboard', 'Fridge', 'Freezer']

/**
 * ADD TO PANTRY (ADD_TO_PANTRY, panels A1–A4).
 *
 * The only surface that writes new stock by hand, and the design's central claim is that
 * **scanning is not a mode**. The viewfinder sits at the top of the ordinary add form, dormant until
 * tapped, with every manual field beneath it — so the camera is always to hand and never in the way.
 * You do not have to decide whether the thing in your hand has a barcode before you start.
 *
 * **Size and count are separate, adjacent, equally weighted, and both typed.** No steppers on
 * either: the earlier stepper-plus-picker arrangement is what made them read as one confused
 * control. `HOW BIG IS ONE` takes `12 oz`; `HOW MANY` takes `4 cans`.
 *
 * **Nothing reaches the pantry until `ADD IT · NEXT ONE` or `COMPLETE`**, which is what makes a
 * mis-scan free.
 *
 * `COMPLETE` is in the header and the repeated action is in the footer, deliberately: the footer is
 * the one used over and over, the header the one used once.
 */
export function KitchenAddScreen() {
  const navigate = useNavigate()

  const [name, setName] = useState('')
  const [packSize, setPackSize] = useState('')
  const [packUnit, setPackUnit] = useState('')
  const [count, setCount] = useState('')
  const [countUnit, setCountUnit] = useState('')
  const [location, setLocation] = useState<PantryLocationName>('Cupboard')
  const [goodUntil, setGoodUntil] = useState('')

  const [session, setSession] = useState<SessionLine[]>([])
  const [guarding, setGuarding] = useState(false)
  const [busy, setBusy] = useState(false)

  // The only required field. Everything else is optional, because most of a pantry is loose produce
  // with no pack size, no barcode and no date on it.
  const canAdd = name.trim().length > 0 && !busy

  const reset = () => {
    setName(''); setPackSize(''); setPackUnit(''); setCount(''); setCountUnit(''); setGoodUntil('')
  }

  const add = async () => {
    if (!canAdd) return
    setBusy(true)
    try {
      const item = await api.createPantryItem({
        name: name.trim(),
        location,
        tracking: 'Counted',
        quantity: count.trim() === '' ? null : Number(count),
        unit: countUnit.trim() || null,
        estimateState: null,
        packSize: packSize.trim() === '' ? null : Number(packSize),
        packUnit: packUnit.trim() || null,
        goodUntil: goodUntil || null,
      })
      setSession((prev) => [
        { id: item.id, name: item.name, amount: describe(count, countUnit, packSize, packUnit), location },
        ...prev,
      ])
      reset()
    } finally {
      setBusy(false)
    }
  }

  const undoLast = async () => {
    const last = session[0]
    if (!last) return
    setBusy(true)
    try {
      // Archive, not delete: the ledger references the row, and the create that put it there is
      // still part of the household's history of that shelf.
      await api.archivePantryItem(last.id)
      setSession((prev) => prev.slice(1))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Cancelling with work in hand raises a confirm — but only then. Cancelling an empty session
   * just leaves, with no card.
   */
  const cancel = () => {
    if (session.length === 0) navigate('/kitchen/pantry')
    else setGuarding(true)
  }

  return (
    <ScreenShell
      // An errand: no quick row, no nav, no account badge. Two exits only.
      nav={false}
      header={
        <DrillInHeader
          title="Add to pantry"
          onBack={cancel}
          // Labelled, not an arrow. The two exits do different things — one abandons the session
          // and one commits it — so neither can be left to a glyph the household has to guess at.
          backLabel="CANCEL"
          status={
            <span className="ml-kitchen__headeraction">
              <button type="button" disabled={busy} onClick={() => navigate('/kitchen/pantry')}>
                COMPLETE
              </button>
            </span>
          }
        />
      }
    >
      <ScrollArea>
        {/*
          Dormant until tapped — dark fill, corner marks, and obviously not running. Scanning is
          identification, not tallying: one scan names the thing and fills its size, and scanning the
          same pack twice is not how you say you have two.
        */}
        <button type="button" className="ml-kitchen__viewfinder" onClick={() => { /* camera: M6 */ }}>
          <span className="ml-kitchen__vfcorner ml-kitchen__vfcorner--tl" />
          <span className="ml-kitchen__vfcorner ml-kitchen__vfcorner--tr" />
          <span className="ml-kitchen__vfcorner ml-kitchen__vfcorner--bl" />
          <span className="ml-kitchen__vfcorner ml-kitchen__vfcorner--br" />
          <span className="ml-kitchen__vflabel">TAP TO SCAN A BARCODE</span>
        </button>

        <Field label="WHAT IS IT">
          <input
            className="ml-kitchen__input"
            value={name}
            placeholder="Name it"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>

        {/* Two questions side by side, each asked in words that can only mean one thing. Both
            typed, so neither is privileged by having steppers on it. */}
        <div className="ml-kitchen__twoup">
          <Field label="HOW BIG IS ONE">
            <div className="ml-kitchen__amountpair">
              <input
                className="ml-kitchen__input ml-kitchen__input--num"
                inputMode="decimal"
                value={packSize}
                placeholder="12"
                onChange={(e) => setPackSize(e.target.value)}
              />
              <UnitField value={packUnit} onChange={setPackUnit} />
            </div>
          </Field>

          <Field label="HOW MANY">
            <div className="ml-kitchen__amountpair">
              <input
                className="ml-kitchen__input ml-kitchen__input--num"
                inputMode="decimal"
                value={count}
                placeholder="4"
                onChange={(e) => setCount(e.target.value)}
              />
              <UnitField value={countUnit} onChange={setCountUnit} />
            </div>
          </Field>
        </div>

        {/* Optional, and labelled so. Typed only from what the packet says — never inferred from a
            shelf-life table, and never the subject of a notification (§6). */}
        <Field label="GOOD UNTIL" optional>
          <input
            className="ml-kitchen__input"
            type="date"
            value={goodUntil}
            onChange={(e) => setGoodUntil(e.target.value)}
          />
        </Field>

        <Field label="WHERE IT GOES">
          <div className="ml-kitchen__segment">
            {LOCATIONS.map((where) => (
              <button
                key={where}
                type="button"
                className={`ml-kitchen__segcell${location === where ? ' ml-kitchen__segcell--on' : ''}`}
                aria-pressed={location === where}
                onClick={() => setLocation(where)}
              >
                {where.toUpperCase()}
              </button>
            ))}
          </div>
        </Field>

        {/* ---- Everything added on this visit ---- */}
        <div className="ml-band">
          <span className="ml-band__label">THIS SESSION</span>
          <span className="ml-band__meta">
            {session.length} {session.length === 1 ? 'THING' : 'THINGS'}
          </span>
          {session.length > 0 && (
            <button type="button" className="ml-kitchen__undolast" disabled={busy} onClick={undoLast}>
              UNDO LAST
            </button>
          )}
        </div>
        {session.length === 0 ? (
          <div className="ml-band-shade">
            <div className="ml-kitchen__emptyshelf">Nothing added yet.</div>
          </div>
        ) : (
          /* The session list is the undo — it has to keep growing and stay scrollable, because a
             long unpack is exactly when somebody needs to check what they already scanned. */
          <CutGroup rows={3} rowHeight={60} className="ml-band-shade">
            {session.map((line) => (
              <div key={line.id} className="ml-row ml-kitchen__waitingrow">
                <span className="ml-kitchen__recipetext">
                  <span className="ml-kitchen__recipename">{line.name}</span>
                  <span className="ml-kitchen__recipewhy">
                    {[line.amount, line.location.toUpperCase()].filter(Boolean).join(' · ')}
                  </span>
                </span>
              </div>
            ))}
          </CutGroup>
        )}

      </ScrollArea>

      {/*
        One control, full width, and docked rather than scrolling with the fields.
        `COMPLETE` is in the header instead: the footer action is the one used over and over, and
        the header action is the one used once (ADD_TO_PANTRY §1).
      */}
      <div className="ml-kitchen__errandactions">
        <button type="button" className="ml-kitchen__shop" disabled={!canAdd} onClick={add}>
          ADD IT · NEXT ONE
        </button>
      </div>

      {/*
        The cancel guard. Amber rather than the rust used for deleting a chat: this abandons work
        that never reached the shelves, rather than destroying something the household has kept.
        The count is in the destructive label so what is at stake is on the button itself.
      */}
      {guarding && (
        <div className="ml-kitchen__scrim">
          <div className="ml-kitchen__confirm">
            <div className="ml-kitchen__confirmtitle">Drop {session.length} things?</div>
            <div className="ml-kitchen__confirmnames">
              {session.slice(0, 3).map((l) => l.name).join(' · ')}
              {session.length > 3 && ` · ${session.length - 3} more`}
            </div>
            <div className="ml-kitchen__askwhy">
              Nothing from this session has reached the shelves. Cancelling drops all {session.length}{' '}
              and the pantry stays as it was. It cannot be undone.
            </div>
            <div className="ml-kitchen__errandrow">
              <button type="button" className="ml-kitchen__errandalt" onClick={() => setGuarding(false)}>
                GO BACK
              </button>
              <button
                type="button"
                className="ml-kitchen__drop"
                onClick={async () => {
                  for (const line of session) await api.archivePantryItem(line.id)
                  navigate('/kitchen/pantry')
                }}
              >
                DROP ({session.length})
              </button>
            </div>
          </div>
        </div>
      )}
    </ScreenShell>
  )
}

function Field({
  label, optional = false, children,
}: { label: string; optional?: boolean; children: React.ReactNode }) {
  return (
    <div className="ml-kitchen__field">
      <span className="ml-kitchen__fieldlabel">
        {label}
        {optional && <span className="ml-kitchen__optional"> OPTIONAL</span>}
      </span>
      {children}
    </div>
  )
}

/**
 * How the session row says what was added.
 *
 * The pantry row reads `4 cans`; grams and ounces stay in the item sheet. Repeating the pack size
 * here would put two numbers on a line that exists to confirm one thing went in.
 */
function describe(count: string, countUnit: string, packSize: string, packUnit: string): string {
  const many = [count.trim(), countUnit.trim()].filter(Boolean).join(' ')
  const size = [packSize.trim(), packUnit.trim()].filter(Boolean).join(' ')
  if (many && size) return `${size} × ${many}`
  return many || size
}
