import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { CutGroup, KitchenHeader, KitchenQuickRow, ScreenShell, ScrollArea } from '../../components'
import { api } from '../../api/client'
import {
  ageLabel, amountLabel, emptyShelfLine, groupByLocation, rowState,
} from '../../app/pantryDomain'
import { openItems, openLabel, staleCount } from '../../app/kitchenDomain'
import { KitchenAddChoiceSheet } from './KitchenAddChoiceSheet'
import type { PantryItemDto, PantryListDto } from '../../api/types'

/**
 * How many rows of a shelf are fully visible before the cut.
 *
 * Four, and the fifth is bisected. Not a preference: `PANTRY_SHELVES` §1 fixes it because four
 * groups at the resulting height fill the panel's content area exactly, and the area clips silently
 * rather than scrolling — a fifth row per shelf would take the footer with it and show no error.
 */
const SHELF_ROWS = 4

/** `WORTH USING SOON` shows two, then cuts. A long list of guilt is not an answer. */
const TURNING_ROWS = 2

/** One shelf row's height on the 540px canvas, which is what sets every cut on this panel. */
const ROW_HEIGHT = 42

/**
 * PANTRY — the shelves (PANTRY_SHELVES §1, panel P1).
 *
 * This is the panel that settled the section's vocabulary, so it is the one to copy: full-bleed
 * bands over rows that keep the gutter, shading only directly under a band, and a group height that
 * bisects a row rather than landing on a boundary.
 *
 * **Grouped by location, not by food category.** You check the pantry against a physical shelf, so
 * the structure matches the shelf. Categories, if they are ever wanted, are a filter over this —
 * not a replacement for it.
 *
 * **The check is a tool, not a nag.** Rechecking the shelves lives in the header beside the plus,
 * as a sync control with the count of stale numbers on it — the same gesture as reconciling
 * anything else with reality. An amber row at the foot of the page read as a telling-off.
 */
export function KitchenPantryScreen() {
  const navigate = useNavigate()
  const [list, setList] = useState<PantryListDto | null>(null)
  const [adding, setAdding] = useState(false)
  const [term, setTerm] = useState('')

  useEffect(() => {
    let cancelled = false
    void api.getPantry().then((p) => { if (!cancelled) setList(p) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  const all = useMemo(() => list?.items ?? [], [list])
  // Searching narrows the shelves in place rather than opening a results screen: the question is
  // "have we got any" and the answer belongs on the shelf it would be on.
  const items = useMemo(() => {
    const needle = term.trim().toLowerCase()
    return needle ? all.filter((i) => i.name.toLowerCase().includes(needle)) : all
  }, [all, term])

  const turning = openItems(items)
  // Staples are left out of the shelves entirely (PANTRY_SHELVES §4, which amends the older
  // "staples last" rule). They are the rows nothing will ever chase anybody about, so a shelf that
  // lists them is four rows longer and no more useful — and on a group that shows four rows and
  // cuts the fifth, that is the difference between seeing the flour and not.
  const shelves = groupByLocation(items.filter((i) => i.tracking !== 'NotCounted'))
  const stale = staleCount(all)

  return (
    <ScreenShell
      header={<KitchenHeader title="PANTRY" meta={list ? `${list.total} THINGS` : undefined} />}
      dock={<KitchenQuickRow active="Pantry" counts={{ pantry: list ? `${list.total} THINGS` : undefined }} />}
    >
      <ScrollArea>
        {/*
          The search row: field, the one ＋, and the check.

          **The check lives here, as a tool.** Rechecking the shelves is the same gesture as
          reconciling anything else with reality, and §1 is explicit that framing it as a warning
          was tried and rejected — an amber row at the foot of the page read as a telling-off. The
          badge is the count of stale numbers, so the control states its own size.
        */}
        <div className="ml-kitchen__searchrow">
          <label className="ml-kitchen__search">
            <span className="ml-kitchen__searchglyph" aria-hidden="true">⌕</span>
            <input
              type="search"
              className="ml-kitchen__searchfield"
              placeholder="Search the shelves"
              aria-label="Search the shelves"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
            />
          </label>

          {/* The ＋ opens a choice sheet, not the add form — it is the only door the delivery
              import has (SETTINGS_AND_IMPORT §4). */}
          <button
            type="button"
            className="ml-kitchen__plus"
            aria-label="Add to the pantry"
            onClick={() => setAdding(true)}
          >
            ＋
          </button>

          <button
            type="button"
            className="ml-kitchen__sync"
            aria-label={stale > 0 ? `Check the shelves, ${stale} stale` : 'Check the shelves'}
            onClick={() => navigate('/kitchen/pantry/check')}
          >
            <span className="ml-kitchen__syncglyph" aria-hidden="true">⟳</span>
            {stale > 0 && <span className="ml-kitchen__syncbadge">{stale}</span>}
          </button>
        </div>

        {/*
          The soon-to-use band outranks the filing because it is the only band you might act on —
          and it disappears entirely when nothing is turning rather than showing an empty heading.
        */}
        {turning.length > 0 && (
          <>
            <div className="ml-band ml-band--amber">
              <span className="ml-band__label">WORTH USING SOON</span>
              <span className="ml-band__meta">{turning.length}</span>
            </div>
            <CutGroup rows={TURNING_ROWS} rowHeight={ROW_HEIGHT} className="ml-band-shade">
              {turning.map((item) => (
                <Row key={item.id} item={item} showOpen onOpen={() => navigate(`/kitchen/pantry/${item.id}`)} />
              ))}
            </CutGroup>
          </>
        )}

        {/* ---- The three shelves, equal in height ---- */}
        {shelves.map(({ location, items: shelf }) => (
          <div key={location}>
            <div className="ml-band">
              <span className="ml-band__label">{location.toUpperCase()}</span>
              <span className="ml-band__meta">{shelf.length}</span>
            </div>
            {shelf.length === 0 ? (
              // Never hide the section: an absent shelf reads as a bug (PANTRY_BEHAVIOURS §6).
              <div className="ml-band-shade">
                <div className="ml-kitchen__emptyshelf">{emptyShelfLine(location)}</div>
              </div>
            ) : (
              <CutGroup rows={SHELF_ROWS} rowHeight={ROW_HEIGHT} className="ml-band-shade">
                {shelf.map((item) => (
                  <Row key={item.id} item={item} onOpen={() => navigate(`/kitchen/pantry/${item.id}`)} />
                ))}
              </CutGroup>
            )}
          </div>
        ))}

        {/* Shelf life is a drill-in row rather than a band: it is consulted rarely and changes what
            floats to the top of the band above, which the settings panel states for itself. */}
        <button
          type="button"
          className="ml-row ml-kitchen__drillin"
          onClick={() => navigate('/kitchen/pantry/shelf-life')}
        >
          <span className="ml-row__value">How long things last</span>
          <span className="ml-kitchen__chev">›</span>
        </button>
      </ScrollArea>

      {adding && <KitchenAddChoiceSheet onClose={() => setAdding(false)} />}
    </ScreenShell>
  )
}

/**
 * One shelf row: name, its state, and the amount.
 *
 * **Every row carries its state.** `SEEN 2 D`, `SEEN 5 W`, `ABOUT` — this is the honesty mechanism,
 * and the list never claims more certainty than it has. A quantity without an age is the one thing
 * PANTRY_BEHAVIOURS §9 calls a bug outright.
 */
function Row({
  item, showOpen = false, onOpen,
}: { item: PantryItemDto; showOpen?: boolean; onOpen?: () => void }) {
  const state = rowState(item)
  const opened = showOpen ? openLabel(item.openedAtUtc) : null

  return (
    <button
      type="button"
      className={`ml-row ml-kitchen__shelfrow ml-kitchen__shelfrow--${state}`}
      onClick={onOpen}
    >
      <span className="ml-kitchen__shelfname">{item.name}</span>
      {/* Opened-when takes precedence in the turning band, where it is the reason the row is
          there at all; everywhere else the row says when it was last seen. */}
      <span className="ml-kitchen__shelfstate">{opened ?? ageLabel(item.lastSeenAtUtc)}</span>
      {/* 76px and nowrap. It was 56 and wrapped; do not narrow it (PANTRY_SHELVES §1). */}
      <span className="ml-kitchen__shelfamount">{amountLabel(item)}</span>
    </button>
  )
}
