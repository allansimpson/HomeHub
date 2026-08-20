import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { DrillInHeader, ScreenShell, ScrollArea, Stepper } from '../../components'
import { api } from '../../api/client'
import { ageLabel } from '../../app/pantryDomain'
import { calendarDaysUntil, openLabel } from '../../app/kitchenDomain'
import { longWeekday } from '../../app/mealsDomain'
import type { ItemClaimDto, PantryEventDto, PantryItemDto } from '../../api/types'

/**
 * The item sheet (PANTRY_SHELVES §2, panel P2).
 *
 * **`WHAT'S HAPPENED TO IT` is the point of the sheet.** Each event names the date, what changed,
 * and *who and how* — `Aiden · scan`, `Eleanor · check`, `cooked`. A wrong number is then traceable
 * rather than arguable, which is the difference between a pantry the household corrects and one it
 * stops believing.
 *
 * **`USED BY` says when the thing is spoken for.** A night holding a claim reads `claimed for
 * Saturday` in amber — the item knowing it is reserved is what stops the same tin being counted
 * twice across two screens (KITCHEN_LOOP_ADDENDUM §1).
 *
 * Opening is one tap, never inferred, and **never changes a quantity** (§4).
 */
export function KitchenItemSheet() {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const itemId = Number(id)

  const [item, setItem] = useState<PantryItemDto | null>(null)
  const [events, setEvents] = useState<PantryEventDto[]>([])
  const [claims, setClaims] = useState<ItemClaimDto[]>([])
  /** How many events to fetch. Five to start; the link asks for the rest. */
  const [take, setAll] = useState(5)

  const load = useCallback(() => {
    if (!Number.isFinite(itemId)) return
    void api.getPantry()
      .then((p) => setItem(p.items.find((i) => i.id === itemId) ?? null))
      .catch(() => {})
    void api.getPantryEvents(itemId, take).then(setEvents).catch(() => {})
    void api.getItemClaims(itemId).then(setClaims).catch(() => {})
  }, [itemId, take])

  useEffect(load, [load])

  if (!item) {
    return (
      <ScreenShell header={<DrillInHeader title="" onBack={() => navigate(-1)} />}>
        <div />
      </ScreenShell>
    )
  }

  const opened = openLabel(item.openedAtUtc)

  const toggleOpened = async () => {
    await api.setOpened(item.id, opened != null)
    load()
  }

  /** Nudge the count by one, through the same PATCH every other correction uses. */
  const nudge = async (by: number) => {
    const next = Math.max(0, (item.quantity ?? 0) + by)
    await api.updatePantryItem(item.id, {
      name: item.name,
      location: item.location,
      tracking: item.tracking,
      quantity: next,
      unit: item.unit,
      estimateState: item.estimateState,
      packSize: item.packSize,
      packUnit: item.packUnit,
    }, item.version)
    load()
  }

  return (
    <ScreenShell
      header={
        <DrillInHeader
          // The shelf it is on, with the item's own name as the page heading below — the sheet is
          // reached from several places, so naming the shelf tells you something the row did not.
          title={item.location.toUpperCase()}
          onBack={() => navigate(-1)}
          backLabel="BACK"
        />
      }
    >
      <ScrollArea>
        <div className="ml-kitchen__sheetname">{item.name}</div>
        {/* Where the row came from. A number is easier to argue with when you know whether a phone
            scanned it, a delivery wrote it, or somebody typed it. */}
        <div className="ml-kitchen__provenance">{provenance(item)}</div>

        {/* Facts, not fields (§2). Editing happens behind EDIT — a sheet of inputs invites a
            correction nobody asked for, and these are mostly read rather than changed. */}
        <div className="ml-kitchen__facts">
          <Fact label="ONE IS" value={packLabel(item)} />
          <Fact label="GOOD UNTIL" value={item.goodUntil ?? 'no date'} />
          <Fact label="OPENED" value={opened?.replace('OPEN ', '').toLowerCase() ?? 'not yet'} />
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
                <span className="ml-kitchen__countunit">{item.unit ?? ''}</span>
              </span>
              <span className="ml-kitchen__counthow">
                {ageLabel(item.lastSeenAtUtc).toLowerCase()} · counted, not guessed
              </span>
            </div>
            <Stepper direction="minus" label="One fewer" disabled={(item.quantity ?? 0) <= 0}
              onStep={() => void nudge(-1)} />
            <Stepper direction="plus" label="One more" onStep={() => void nudge(1)} />
          </div>
        )}

        {/*
          Marking opened is one tap and moves no stock. A deduction that empties a counted item does
          not open anything either — the two facts are independent (§4).
        */}
        <button type="button" className="ml-kitchen__errandalt" onClick={toggleOpened}>
          {opened ? 'MARK FINISHED' : 'MARK OPENED'}
        </button>

        {/* ---- What it is spoken for ---- */}
        {claims.length > 0 && (
          <>
            <div className="ml-band ml-band--amber">
              <span className="ml-band__label">USED BY</span>
              <span className="ml-band__meta">{claims.length}</span>
            </div>
            <div className="ml-band-shade">
              {claims.map((claim) => (
                <div key={claim.planEntryId} className="ml-row ml-kitchen__claimrow">
                  <span className="ml-row__value">{claim.dishName ?? 'A planned night'}</span>
                  <span className="ml-kitchen__claimfor">
                    claimed for {longWeekday(claim.date)}
                    {claim.quantity != null && ` · ${claim.quantity}`}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        {/* ---- The history: date, what changed, and who and how ---- */}
        <div className="ml-band">
          <span className="ml-band__label">WHAT'S HAPPENED TO IT</span>
          <span className="ml-band__meta">{events.length}</span>
        </div>
        <div className="ml-band-shade">
          {events.length === 0 ? (
            <div className="ml-kitchen__emptyshelf">Nothing recorded yet.</div>
          ) : (
            events.map((event) => (
              <div key={event.id} className={`ml-row ml-kitchen__eventrow${event.undone ? ' ml-kitchen__eventrow--undone' : ''}`}>
                {/* Dated on the left, so the column reads as a history rather than a list. */}
                <span className="ml-kitchen__eventwhen">{eventDay(event.atUtc)}</span>
                <span className="ml-kitchen__eventwhat">{eventWords(event)}</span>
                {/* Who and how. Without it a wrong number is arguable rather than traceable. */}
                <span className="ml-kitchen__eventwho">
                  {[event.byName, event.kind.toLowerCase()].filter(Boolean).join(' · ')}
                </span>
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
              className="ml-row ml-kitchen__drillin"
              onClick={() => setAll((n) => n + 40)}
            >
              <span className="ml-row__value">
                Everything, back to {backTo(events)}
              </span>
              <span className="ml-kitchen__chev">›</span>
            </button>
          )}
        </div>
      </ScrollArea>
    </ScreenShell>
  )
}

/** `Added by scan · barcode 0 41331 12604 7`, or as much of it as the row actually knows. */
function provenance(item: PantryItemDto): string {
  const who = item.lastSeenByName ? `Last touched by ${item.lastSeenByName}` : 'Added at the panel'
  return item.catalogueRef ? `${who} · barcode ${item.catalogueRef}` : who
}

/** What one of them is — the pack size where there is one, the unit where there is not. */
function packLabel(item: PantryItemDto): string {
  if (item.packSize != null && item.packSize > 0) {
    return `${item.packSize} ${item.packUnit ?? ''}`.trim()
  }
  return item.unit ?? 'one'
}

/** How far back the history actually goes, so the link is worth pressing. */
function backTo(events: PantryEventDto[]): string {
  const oldest = events[events.length - 1]
  if (!oldest) return 'the beginning'
  const at = new Date(oldest.atUtc)
  return `${MONTHS[at.getMonth()]} ${at.getFullYear()}`
}

/** `TODAY` / `11 AUG` — the history's left column. */
function eventDay(atUtc: string): string {
  const at = new Date(atUtc)
  if (calendarDaysUntil(at, new Date()) === 0) return 'TODAY'
  return `${at.getDate()} ${MONTHS[at.getMonth()]}`
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="ml-kitchen__fact">
      <span className="ml-kitchen__factlabel">{label}</span>
      <span className="ml-kitchen__factvalue">{value}</span>
    </div>
  )
}

/**
 * One line of history, said as a change rather than as a field name.
 *
 * "had 6, now 4" reads; "Deducted −2" needs decoding. The ledger stores both numbers precisely so
 * the sheet can put the before beside the after.
 */
function eventWords(event: PantryEventDto): string {
  if (event.resultingState) return `now ${event.resultingState.toLowerCase()}`
  if (event.delta == null || event.resultingQuantity == null) return 'changed'

  const before = event.resultingQuantity - event.delta
  return `${trim(before)} → ${trim(event.resultingQuantity)}`
}

const trim = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ''))
