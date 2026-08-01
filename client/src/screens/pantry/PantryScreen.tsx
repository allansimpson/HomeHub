import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ScreenShell, DrillInHeader, ScrollArea } from '../../components'
import { Icon } from '../../icons/Icon'
import { usePantry } from '../../app/PantryProvider'
import { useNow } from '../../app/useNow'
import { useHandheld } from '../../app/useHandheld'
import {
  ageLabel, amountLabel, emptyShelfLine, groupByLocation, hedgeLine, rowState, tallyLine,
} from '../../app/pantryDomain'
import type { PantryItemDto } from '../../api/types'
import { Chevron, LocationSegment, PantryLabel, PrimaryButton, SecondaryButton } from './parts'
import { ItemSheet } from './ItemSheet'

/**
 * The Pantry tab (PANTRY_SCREEN §1, id 9a).
 *
 * Every claim on this screen is hedged and dated, which is the section's one non-negotiable rule
 * (DECISIONS P9): the tally says `PROBABLY LOW`, the header says the panel "only knows what it was
 * told", and no row anywhere shows a quantity without an age beside it. A count without an age is a
 * lie told confidently.
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
          // The grocery list is a drill-in from here rather than a nav tab of its own — the bar is
          // already at ten, and 9e's own header carries a back control to this screen.
          status={
            <button type="button" className="pt-header__link" onClick={() => navigate('/pantry/grocery')}>
              {`GROCERY ${grocery?.openCount ?? 0} ›`}
            </button>
          }
        />
      }
    >
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
          onClick={() => navigate(`/pantry/import/${imp.id}`)}
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
            <Icon id="ico-pantry" size="2.5rem" />
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
              <PrimaryButton grow={1.3} onClick={() => navigate('/pantry/scan')}>SCAN IN</PrimaryButton>
            ) : (
              <PrimaryButton grow={1.3} onClick={() => navigate('/pantry/import/new')}>
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
            <PrimaryButton grow={1.3} onClick={() => navigate('/pantry/scan')}>SCAN IN</PrimaryButton>
          ) : (
            <PrimaryButton grow={1.3} onClick={() => navigate('/pantry/import/new')}>
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
