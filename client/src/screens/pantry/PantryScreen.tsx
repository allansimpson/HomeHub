import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { ScreenShell, DrillInHeader, ScrollArea } from '../../components'
import { Icon } from '../../icons/Icon'
import { usePantry } from '../../app/PantryProvider'
import { useNow } from '../../app/useNow'
import { useHandheld } from '../../app/useHandheld'
import {
  ageLabel, amountLabel, emptyShelfLine, groupByLocation, hedgeLine, rowState, tallyLine,
} from '../../app/pantryDomain'
import type { PantryItemDto } from '../../api/types'
import { Chevron, LocationSegment, PantryLabel, PrimaryButton, SecondaryButton, TickBox } from './parts'
import { MealsSegment } from '../meals/parts'
import { ItemSheet } from './ItemSheet'
import { provenanceLine } from '../../app/pantryDomain'

/**
 * The Pantry — now the third segment of Meals rather than a tab of its own (`/meals/pantry`).
 *
 * Every claim on this screen is hedged and dated, which is the section's one non-negotiable rule
 * (DECISIONS P9): the tally says `PROBABLY LOW`, the header says the panel "only knows what it was
 * told", and no row anywhere shows a quantity without an age beside it. A count without an age is a
 * lie told confidently.
 *
 * The grocery list now sits **under** the pantry rather than beside it: what the pantry is out of is
 * what the list is for. Nothing about either screen's layout, logic or copy changed in the move.
 */
export function PantryScreen() {
  const navigate = useNavigate()
  const { pantry, grocery, filter, setFilter, loading } = usePantry()
  const handheld = useHandheld()
  // An hour is the right tick: every age on this screen is in days or weeks, so a faster clock
  // would re-render the list constantly to change nothing.
  const now = new Date(useNow(60 * 60_000))
  const [editing, setEditing] = useState<PantryItemDto | null>(null)
  // `?add=1` opens the sheet on arrival — the scan screen's `TYPE ONE` lands here, for loose produce
  // with no barcode. Read from the URL rather than passed through router state so the phone can
  // reload the page mid-flow without the sheet vanishing.
  const [params, setParams] = useSearchParams()
  const [adding, setAdding] = useState(params.get('add') === '1')

  // Read off `pantry` rather than through a defaulted local: `?? []` allocates a fresh array on
  // every render, which would make both memos below re-run every time regardless of the data.
  const items = pantry?.items
  const groups = useMemo(
    () => groupByLocation(
      filter === 'All' ? (items ?? []) : (items ?? []).filter((i) => i.location === filter),
    ),
    [items, filter],
  )

  const hedge = hedgeLine(pantry?.lastTouchedByName, pantry?.lastTouchedAtUtc, now)
  const pending = pantry?.pendingImports ?? []
  const empty = !loading && (items?.length ?? 0) === 0

  return (
    <ScreenShell
      header={
        <DrillInHeader
          title="PANTRY"
          // The grocery list has a section of its own further down this screen; the header link
          // opens the full one, where adding and clearing live.
          status={
            <button type="button" className="pt-header__link" onClick={() => navigate('/meals/pantry/grocery')}>
              {`GROCERY ${grocery?.openCount ?? 0} ›`}
            </button>
          }
        />
      }
    >
      <MealsSegment active="pantry" />

      {hedge && <p className="pt-hedge">{hedge}</p>}

      <LocationSegment value={filter} onChange={setFilter} />

      {!empty && (
        <p className="pt-tally">
          {tallyLine(pantry?.total ?? 0, pantry?.probablyLow ?? 0, pantry?.probablyOut ?? 0)}
        </p>
      )}

      {/* A pending import is a single ruled row above the list, not a banner: it is a thing waiting
          to be done, not news (§4). */}
      {pending.map((imp) => (
        <button
          type="button"
          key={imp.id}
          className="pt-waiting"
          onClick={() => navigate(`/meals/pantry/import/${imp.id}`)}
        >
          <span className="pt-waiting__text">
            {`An order${imp.vendorLabel ? ` from ${imp.vendorLabel}` : ''} is waiting — ${imp.lineCount} line${imp.lineCount === 1 ? '' : 's'}`}
          </span>
          <Chevron />
        </button>
      ))}

      {empty ? (
        <div className="pt-empty">
          <span className="pt-empty__box" aria-hidden="true">
            <Icon id="ico-list" size="2.5rem" />
          </span>
          <span className="pt-empty__title serif">Nothing in the pantry yet</span>
          <span className="pt-empty__body">
            Import a delivery order or scan a few things in from your phone. It doesn&rsquo;t have to
            be complete to be useful.
          </span>
          {/* Same split on the empty state, which is where a household actually starts — and
              starting means standing in the kitchen with a phone, not sitting at the panel. */}
          <div className="pt-empty__actions">
            <SecondaryButton onClick={() => setAdding(true)}>ADD BY HAND</SecondaryButton>
            {handheld ? (
              <PrimaryButton grow={1.3} onClick={() => navigate('/meals/pantry/scan')}>SCAN IN</PrimaryButton>
            ) : (
              <PrimaryButton grow={1.3} onClick={() => navigate('/meals/pantry/import/new')}>
                IMPORT AN ORDER
              </PrimaryButton>
            )}
          </div>
        </div>
      ) : (
        <ScrollArea>
          {groups.map((group) => {
            // Never hide a section — an absent shelf reads as a bug (PANTRY_BEHAVIOURS §6). When a
            // single location is selected the other two are genuinely not in view, so they go.
            if (filter !== 'All' && filter !== group.location) return null
            return (
              <div className="pt-group" key={group.location}>
                <PantryLabel label={group.location.toUpperCase()} meta={group.items.length || undefined} />
                {group.items.length === 0 ? (
                  <p className="pt-group__empty">{emptyShelfLine(group.location)}</p>
                ) : (
                  group.items.map((item) => (
                    <button
                      type="button"
                      className={`pt-row pt-row--${rowState(item)}`}
                      key={item.id}
                      onClick={() => setEditing(item)}
                    >
                      <span className="pt-row__name">{item.name}</span>
                      <span className="pt-row__amount">{amountLabel(item)}</span>
                      {/* The age is never optional and never blank — that pairing is the copy rule
                          made structural rather than remembered. */}
                      <span className="pt-row__age">
                        {item.tracking === 'NotCounted' ? 'STAPLE' : ageLabel(item.lastSeenAtUtc, now)}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )
          })}

          <GrocerySection onOpen={() => navigate('/meals/pantry/grocery')} />
        </ScrollArea>
      )}

      {!empty && (
        <div className="pt-footer">
          {/*
            No scan button *on the panel* — it is on a wall and the barcodes are in your hand
            (§1.7). But that rule leaves the scan screen with no way in at all, so on a handheld the
            footer becomes the two things worth doing while standing at the shelves: scanning, and
            typing in the thing that has no barcode. Importing an order is the opposite kind of job
            — a sit-down review of twenty-four lines — and stays on the panel.
          */}
          <SecondaryButton onClick={() => setAdding(true)}>ADD BY HAND</SecondaryButton>
          {handheld ? (
            <PrimaryButton grow={1.3} onClick={() => navigate('/meals/pantry/scan')}>SCAN IN</PrimaryButton>
          ) : (
            <PrimaryButton grow={1.3} onClick={() => navigate('/meals/pantry/import/new')}>
              IMPORT AN ORDER
            </PrimaryButton>
          )}
        </div>
      )}

      {(editing || adding) && (
        <ItemSheet
          item={editing}
          onClose={() => {
            setEditing(null)
            setAdding(false)
            // Drop `?add=1` on the way out, so a back-navigation onto this entry doesn't re-open
            // the sheet somebody just dismissed.
            if (params.get('add')) setParams({}, { replace: true })
          }}
        />
      )}
    </ScreenShell>
  )
}

/**
 * The grocery list, as a section under the pantry rather than a screen beside it.
 *
 * The argument for folding Pantry into Meals is on these rows: **provenance**. A line says why it is
 * here — `FROM PANTRY`, `FOR THURSDAY`, `FROM CARE` — and a formula tin that arrived because Care
 * ran low is what makes this the household's list rather than the kitchen's. A mirrored list could
 * not carry any of it.
 *
 * Ticking is live here because ticking is the whole interaction and it puts stock back on a shelf.
 * Adding and clearing are not: those need a field and a destructive confirm, and both live on the
 * full screen behind `GROCERY N ›`.
 */
function GrocerySection({ onOpen }: { onOpen: () => void }) {
  const { grocery, checkGrocery } = usePantry()
  const lines = grocery?.lines ?? []
  if (lines.length === 0) return null

  const got = lines.filter((l) => l.checkedAtUtc).length

  return (
    <div className="pt-grocerysection">
      <PantryLabel
        label="GROCERY LIST"
        meta={`${lines.length} ITEM${lines.length === 1 ? '' : 'S'}${got > 0 ? ` · ${got} GOT` : ''}`}
      />
      {lines.map((line) => {
        const done = Boolean(line.checkedAtUtc)
        return (
          <div className={'pt-grow' + (done ? ' pt-grow--done' : '')} key={line.id}>
            <TickBox checked={done} label={line.text} onToggle={() => void checkGrocery(line.id, !done)} />
            <span className="pt-grow__main">
              <span className="pt-grow__name">{line.text}</span>
            </span>
            <span className="pt-grow__from">
              {/* Once ticked, provenance is replaced by the return trip: what the tick just did is
                  more use than why the line was added. */}
              {done ? (line.returnTrip ?? 'TICKED OFF') : (provenanceLine(line) || 'ADDED BY HAND')}
            </span>
          </div>
        )
      })}
      <button type="button" className="pt-grocerysection__more" onClick={onOpen}>
        THE WHOLE LIST ▸
      </button>
    </div>
  )
}
