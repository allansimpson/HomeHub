import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import {
  KitchenDrillInHeader, KitchenQuickRow, ScreenShell, ScrollArea, SectionLabel, Stepper,
} from '../../components'
import { api } from '../../api/client'
import {
  LOCATIONS, countHow, eventWho, eventWords, packLabel, pluralUnit, usageAmount,
} from '../../app/pantryDomain'
import { openLabel } from '../../app/kitchenDomain'
import { longWeekday } from '../../app/mealsDomain'
import type {
  ItemUsageDto, PantryEventDto, PantryItemDto, PantryLocationName,
} from '../../api/types'

/**
 * The item sheet (PANTRY_SHELVES §2, panel P2).
 *
 * **`WHAT'S HAPPENED TO IT` is the point of the sheet**, and it leads the page for that reason. Each
 * event names the date, what changed, and *who and how* — `Aiden · scan`, `Eleanor · check`,
 * `cooked`. A wrong number is then traceable rather than arguable, which is the difference between a
 * pantry the household corrects and one it stops believing.
 *
 * **`USED BY` says what the thing is for**, and where a night has spoken for it, that too: a claim
 * reads `claimed for Saturday` in amber, which is what stops the same tin being counted twice across
 * two screens (KITCHEN_LOOP_ADDENDUM §1).
 *
 * **The actions sit at the foot**, under everything they act on. `MARK OPENED` was above the history
 * once, which put the one control that changes nothing in front of the block the sheet exists to
 * show. Opening is one tap, never inferred, and **never changes a quantity** (§4).
 */
export function KitchenItemSheet() {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const itemId = Number(id)

  const [item, setItem] = useState<PantryItemDto | null>(null)
  const [events, setEvents] = useState<PantryEventDto[]>([])
  const [usage, setUsage] = useState<ItemUsageDto[]>([])
  /** Whether `MOVE IT` has been asked and the three shelves are showing. */
  const [moving, setMoving] = useState(false)
  /** How many events to fetch. Five to start; the link asks for the rest. */
  const [take, setAll] = useState(5)

  const load = useCallback(() => {
    if (!Number.isFinite(itemId)) return
    void api.getPantry()
      .then((p) => setItem(p.items.find((i) => i.id === itemId) ?? null))
      .catch(() => {})
    void api.getPantryEvents(itemId, take).then(setEvents).catch(() => {})
    void api.getItemUsage(itemId).then(setUsage).catch(() => {})
  }, [itemId, take])

  useEffect(load, [load])

  if (!item) {
    return (
      <ScreenShell header={<KitchenDrillInHeader exit="BACK" onExit={() => navigate(-1)} />}>
        <div className="ml-kitchen__emptyshelf">That thing is not on the shelves.</div>
      </ScreenShell>
    )
  }

  const opened = openLabel(item.openedAtUtc)

  const toggleOpened = async () => {
    await api.setOpened(item.id, opened != null)
    load()
  }

  /** The PATCH every correction on this sheet goes through, with one field varied. */
  const patch = async (changes: Partial<PantryItemDto>) => {
    await api.updatePantryItem(item.id, {
      name: item.name,
      location: item.location,
      tracking: item.tracking,
      quantity: item.quantity,
      unit: item.unit,
      estimateState: item.estimateState,
      packSize: item.packSize,
      packUnit: item.packUnit,
      ...changes,
    }, item.version)
    load()
  }

  /** Nudge the count by one — the one quantity change that needs no check (§2). */
  const nudge = (by: number) => patch({ quantity: Math.max(0, (item.quantity ?? 0) + by) })

  /** Moving changes the shelf and nothing else. It is not a count, and never touches one. */
  const moveTo = async (where: PantryLocationName) => {
    setMoving(false)
    await patch({ location: where })
  }

  return (
    <ScreenShell
      header={
        <KitchenDrillInHeader
          exit="BACK"
          onExit={() => navigate(-1)}
          // The shelf it is on, as a context label rather than a title — the sheet is reached from
          // several places, so naming the shelf tells you something the row you tapped did not. The
          // item's own name is the page heading below, where it has room to be one.
          label={item.location}
        />
      }
      dock={<KitchenQuickRow active="Pantry" />}
    >
      <ScrollArea>
        <div className="ml-kitchen__sheetname">{item.name}</div>
        {/* Where the row came from. A number is easier to argue with when you know whether a phone
            scanned it, a delivery wrote it, or somebody typed it. */}
        <div className="ml-kitchen__provenance">{provenance(item)}</div>

        {/* Facts, not fields (§2). Editing happens behind EDIT — a sheet of inputs invites a
            correction nobody asked for, and these are mostly read rather than changed. */}
        <div className="ml-kitchen__facts">
          <Fact label="ONE IS" value={packLabel(item) ?? 'no pack size'} quiet={packLabel(item) == null} />
          <Fact label="GOOD UNTIL" value={item.goodUntil ?? 'no date'} quiet={!item.goodUntil} />
          <Fact label="OPENED" value={opened?.replace('OPEN ', '').toLowerCase() ?? 'not yet'} quiet={!opened} />
        </div>

        {/*
          The count block — the one place a quantity can be nudged without running a check (§2).

          It carries the number, its unit, and **how it is known**: `seen today · counted, not
          guessed`. That third line is the sheet's whole claim to honesty, and a stepper without it
          would be a number somebody could move with nothing saying where it came from.
        */}
        {item.tracking === 'Counted' && (
          <div className="ml-kitchen__count">
            <div className="ml-kitchen__countfacts">
              <span className="ml-kitchen__factlabel">ON THE SHELF</span>
              <span className="ml-kitchen__countnum serif">
                {item.quantity ?? 0}
                <span className="ml-kitchen__countunit">{pluralUnit(item.quantity, item.unit)}</span>
              </span>
              <span className="ml-kitchen__counthow">{countHow(item)}</span>
            </div>
            <Stepper direction="minus" label="One fewer" disabled={(item.quantity ?? 0) <= 0}
              onStep={() => void nudge(-1)} />
            <Stepper direction="plus" label="One more" onStep={() => void nudge(1)} />
          </div>
        )}

        {/* ---- The history: date, what changed, and who and how ---- */}
        <SectionLabel label="WHAT'S HAPPENED TO IT" />
        <div className="ml-kitchen__sheetlist">
          {events.length === 0 ? (
            <div className="ml-kitchen__emptyshelf">Nothing recorded yet.</div>
          ) : (
            events.map((event) => (
              <div key={event.id} className={`ml-kitchen__eventrow${event.undone ? ' ml-kitchen__eventrow--undone' : ''}`}>
                {/* Dated on the left, so the column reads as a history rather than a list. */}
                <span className="ml-kitchen__eventwhen">{eventDay(event.atUtc)}</span>
                <span className="ml-kitchen__eventwhat">{eventWords(event)}</span>
                {/* Who and how. Without it a wrong number is arguable rather than traceable. */}
                <span className="ml-kitchen__eventwho">{eventWho(event)}</span>
              </div>
            ))
          )}
          {/*
            Five, then a link — not a scroller (§2).

            The recent five are what somebody checks when a number looks wrong; the rest is an
            archive, and putting an archive behind a cut would make the sheet's most-used block the
            one you have to scroll. The link says how far back it goes so it is worth pressing.
          */}
          {events.length >= 5 && (
            <button
              type="button"
              className="ml-kitchen__eventrow ml-kitchen__sheetmore"
              onClick={() => setAll((n) => n + 40)}
            >
              <span className="ml-kitchen__eventwhat">Everything, back to {backTo(events)}</span>
              <span className="ml-kitchen__chev">›</span>
            </button>
          )}
        </div>

        {/* ---- What it cooks, and what is already spoken for ---- */}
        {usage.length > 0 && (
          <>
            <div className="ml-kitchen__sheetdivide" />
            <SectionLabel label="USED BY" />
            <div className="ml-kitchen__sheetlist">
              {usage.map((used) => (
                <button
                  key={used.recipeId}
                  type="button"
                  className="ml-kitchen__usedrow"
                  onClick={() => navigate(`/kitchen/recipes/${used.recipeId}`)}
                >
                  <span className="ml-kitchen__usedname">{used.title}</span>
                  {used.claimedForDate ? (
                    /* Amber, because being spoken for is actionable: it is the difference between
                       "there are three" and "there are three and Saturday is having one". */
                    <span className="ml-kitchen__claimfor">
                      claimed for {longWeekday(used.claimedForDate)}
                    </span>
                  ) : (
                    <span className="ml-kitchen__usedamount">{usageAmount(used) ?? ''}</span>
                  )}
                </button>
              ))}
            </div>
          </>
        )}

        {/*
          The actions, at the foot, under everything they act on (§2).

          Marking opened is one tap and moves no stock. A deduction that empties a counted item does
          not open anything either — the two facts are independent (§4).

          `EDIT` is drawn as a third peer in the handoff and is not here: there is no edit surface for
          a pantry row yet, and a button that opens nothing is worse than a footer with two things in
          it. `ADD_TO_PANTRY.md` is still the only screen that writes these fields by hand.
        */}
        <div className="ml-kitchen__sheetactions">
          <button type="button" className="ml-kitchen__errandalt" onClick={toggleOpened}>
            {opened ? 'MARK FINISHED' : 'MARK OPENED'}
          </button>
          <button
            type="button"
            className="ml-kitchen__errandalt"
            aria-expanded={moving}
            onClick={() => setMoving((was) => !was)}
          >
            MOVE IT
          </button>
        </div>

        {/*
          Moving is three shelves, so it is three buttons rather than a screen.

          A drill-in for a choice between Cupboard, Fridge and Freezer would cost two taps and a page
          transition to do what fits under the control that asked for it — and the shelf it is on
          already names itself in the header, so the household can see the answer change.
        */}
        {moving && (
          <div className="ml-kitchen__sheetactions ml-kitchen__sheetactions--choice">
            {LOCATIONS.map((where) => (
              <button
                key={where}
                type="button"
                className="ml-kitchen__errandalt"
                disabled={where === item.location}
                onClick={() => void moveTo(where)}
              >
                {where.toUpperCase()}
              </button>
            ))}
          </div>
        )}
      </ScrollArea>
    </ScreenShell>
  )
}

/**
 * `Added by scan · barcode 0 41331 12604 7`, or as much of it as the row actually knows.
 *
 * **How it got here, not who touched it last.** This line used to say `Last touched by Aiden`, which
 * is a fact the history below states with a date beside it — and states better. What the history
 * cannot say once it has scrolled past five rows is where the row came from at all, and that is what
 * decides how much a number is worth: a barcode counted a pack, and a typed row is somebody's memory.
 */
function provenance(item: PantryItemDto): string {
  const how = item.catalogueRef ? 'Added by scan' : 'Added at the panel'
  return item.catalogueRef ? `${how} · barcode ${item.catalogueRef}` : how
}

/** How far back the history actually goes, so the link is worth pressing. */
function backTo(events: PantryEventDto[]): string {
  const oldest = events[events.length - 1]
  if (!oldest) return 'the beginning'
  const at = new Date(oldest.atUtc)
  // The month in full, and no year unless it is a different one. "back to March" is how somebody
  // says it; "back to MAR 2026" is how a log file says it.
  const month = MONTHS_LONG[at.getMonth()]
  return at.getFullYear() === new Date().getFullYear() ? month : `${month} ${at.getFullYear()}`
}

/** `TODAY` / `11 AUG` — the history's left column. */
function eventDay(atUtc: string): string {
  const at = new Date(atUtc)
  const now = new Date()
  const sameDay = at.getFullYear() === now.getFullYear()
    && at.getMonth() === now.getMonth()
    && at.getDate() === now.getDate()
  if (sameDay) return 'TODAY'
  return `${at.getDate()} ${MONTHS[at.getMonth()]}`
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

function Fact({ label, value, quiet }: { label: string; value: string; quiet?: boolean }) {
  return (
    <div className="ml-kitchen__fact">
      <span className="ml-kitchen__factlabel">{label}</span>
      <span className={'ml-kitchen__factvalue' + (quiet ? ' ml-kitchen__factvalue--quiet' : '')}>
        {value}
      </span>
    </div>
  )
}
