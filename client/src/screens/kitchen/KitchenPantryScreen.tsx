import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import {
  KitchenDivider, KitchenHeader, KitchenQuickRow, KitchenShelfSwitch, ScreenShell, ScrollArea,
  type ShelfSwitchEntry,
} from '../../components'
import { api } from '../../api/client'
import { ageLabel, amountLabel, emptyShelfLine, rowState } from '../../app/pantryDomain'
import {
  KITCHEN_SHELF_RUN, landingShelf, openItems, openLabel, staleCount,
  type PantryShelfKey,
} from '../../app/kitchenDomain'
import { KitchenAddChoiceSheet } from './KitchenAddChoiceSheet'
import type { PantryItemDto, PantryListDto, PantryLocationName } from '../../api/types'

/**
 * PANTRY — one shelf at a time (design_handoff_kitchen_lists §3, panel 5a).
 *
 * **This replaced four stacked sections.** Soon / Fridge / Cupboard / Freezer used to be drawn one
 * under another, each capped at four rows with the fifth bisected. That showed sixteen rows of
 * forty-one and made it impossible to read any shelf to its end — the cut said "there is more
 * below" on all four groups at once, and the only way to see the rest of the cupboard was to scroll
 * a group inside a scrolling page. The switch trades the glance across all four for the ability to
 * finish reading one, and the counts on the run are what preserve the glance.
 *
 * **There is no `All`.** It would be the stacked view again under another name.
 *
 * **Grouped by location, not by food category**, which is unchanged and still the point: you check
 * the pantry against a physical shelf, so the structure matches the shelf.
 *
 * **The check is a tool, not a nag.** Rechecking lives in the header beside the plus, as a sync
 * control with the count of stale numbers on it. An amber row at the foot of the page read as a
 * telling-off (PANTRY_SHELVES §1).
 */
export function KitchenPantryScreen() {
  const navigate = useNavigate()
  const [list, setList] = useState<PantryListDto | null>(null)
  const [adding, setAdding] = useState(false)
  const [term, setTerm] = useState('')
  /*
   * `null` until the rows arrive, because which shelf to open on is a question about the contents
   * and there are none yet. Resolving it early would land on the fallback every time and then have
   * to move the household to a different shelf as the request came back.
   */
  const [shelf, setShelf] = useState<PantryShelfKey | null>(null)

  useEffect(() => {
    let cancelled = false
    void api.getPantry().then((p) => { if (!cancelled) setList(p) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  const all = useMemo(() => list?.items ?? [], [list])

  useEffect(() => {
    if (list && shelf == null) setShelf(landingShelf(list.items))
  }, [list, shelf])

  /** Rows that can appear on a *place*. Soon is drawn from everything, since a staple can be open. */
  const shelved = useMemo(() => all.filter((i) => i.tracking !== 'NotCounted'), [all])
  const turning = useMemo(() => openItems(all), [all])

  const counts = useMemo(() => ({
    Soon: turning.length,
    Fridge: shelved.filter((i) => i.location === 'Fridge').length,
    Cupboard: shelved.filter((i) => i.location === 'Cupboard').length,
    Freezer: shelved.filter((i) => i.location === 'Freezer').length,
  }), [shelved, turning])

  const showing = shelf ?? 'Soon'

  /** What the shown shelf holds, in the order the shelves have always used. */
  const rows = useMemo(() => {
    if (showing === 'Soon') return turning
    return shelved
      .filter((i) => i.location === showing)
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [showing, shelved, turning])

  /*
   * Search is global across all four shelves (§3) — the question is "have we got any", and
   * answering it only about the shelf that happens to be showing is how a pantry tells you it has
   * no flour while the flour is one tap away. Every result says which shelf it is on, because a
   * name with no place is not an answer to the question that was asked.
   */
  const needle = term.trim().toLowerCase()
  const found = useMemo(() => (
    needle
      ? shelved
        .filter((i) => i.name.toLowerCase().includes(needle))
        .sort((a, b) => a.name.localeCompare(b.name))
      : []
  ), [needle, shelved])

  const stale = staleCount(all)

  const entries: ShelfSwitchEntry<PantryShelfKey>[] = KITCHEN_SHELF_RUN.map((key) => ({
    key,
    label: key.toUpperCase(),
    count: counts[key],
    amber: key === 'Soon',
  }))

  return (
    <ScreenShell
      header={<KitchenHeader title="PANTRY" meta={list ? `${list.total} THINGS` : undefined} />}
      dock={<KitchenQuickRow active="Pantry" counts={{ pantry: list ? `${list.total} THINGS` : undefined }} />}
    >
      {/*
        The search row: field, the one ＋, and the check.

        **The check lives here, as a tool.** Rechecking the shelves is the same gesture as
        reconciling anything else with reality, and §1 of the pantry spec is explicit that framing
        it as a warning was tried and rejected. The badge is the count of stale numbers, so the
        control states its own size.
      */}
      <div className="ml-kitchen__searchrow">
        <label className="ml-kitchen__search">
          <span className="ml-kitchen__searchglyph" aria-hidden="true">⌕</span>
          <input
            type="search"
            className="ml-kitchen__searchfield"
            placeholder="Search all four shelves"
            aria-label="Search all four shelves"
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
        Searching replaces the run rather than sitting above it.

        §3 fixes two things — the switch shows one shelf, and search is global — and while a term is
        typed those two cannot both be true of the same list. A switch left above a set of results
        drawn from all four shelves would be claiming to filter something it is not. The heading
        that takes its place says how many were found, which is the thing the run's counts were
        doing anyway.
      */}
      {needle ? (
        <KitchenDivider label="Found on the shelves" count={found.length} gap={false} />
      ) : (
        <KitchenShelfSwitch
          entries={entries}
          active={showing}
          onSelect={setShelf}
          label="Which shelf to show"
        />
      )}

      <ScrollArea>
        <div className="ml-kitchen__shelf">
          {needle ? (
            found.length === 0 ? (
              <p className="ml-kitchen__emptyshelf">Nothing on the shelves matches &ldquo;{term.trim()}&rdquo;</p>
            ) : (
              found.map((item) => (
                <Row
                  key={item.id}
                  item={item}
                  where={item.location}
                  onOpen={() => navigate(`/kitchen/pantry/${item.id}`)}
                />
              ))
            )
          ) : rows.length === 0 ? (
            // Never a blank body: an empty shelf reads as a bug (PANTRY_BEHAVIOURS §6).
            <p className="ml-kitchen__emptyshelf">
              {showing === 'Soon' ? 'Nothing is turning' : emptyShelfLine(showing)}
            </p>
          ) : (
            rows.map((item) => (
              <Row
                key={item.id}
                item={item}
                showOpen={showing === 'Soon'}
                onOpen={() => navigate(`/kitchen/pantry/${item.id}`)}
              />
            ))
          )}
        </div>

        {/* Shelf life is a drill-in row: it is consulted rarely and changes what turns up under
            SOON, which the settings panel states for itself. */}
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
 * One shelf row: name, where it is if that is in question, its state, and the amount.
 *
 * **Every row carries its state.** `SEEN 2 D`, `SEEN 5 W`, `ABOUT` — this is the honesty mechanism,
 * and the list never claims more certainty than it has. A quantity without an age is the one thing
 * PANTRY_BEHAVIOURS §9 calls a bug outright, which is why `where` is a cell of its own rather than
 * something that displaces the state.
 */
function Row({
  item, showOpen = false, where, onOpen,
}: {
  item: PantryItemDto
  showOpen?: boolean
  /** The shelf, shown only in search results — everywhere else the switch above has just said it. */
  where?: PantryLocationName
  onOpen?: () => void
}) {
  const state = rowState(item)
  const opened = showOpen ? openLabel(item.openedAtUtc) : null

  return (
    <button
      type="button"
      className={`ml-row ml-kitchen__shelfrow ml-kitchen__shelfrow--${state}`}
      onClick={onOpen}
    >
      <span className="ml-kitchen__shelfname">{item.name}</span>
      {where && <span className="ml-kitchen__shelfwhere">{where.toUpperCase()}</span>}
      {/* Opened-when takes precedence on SOON, where it is the reason the row is there at all;
          everywhere else the row says when it was last seen. It carries the amber for the same
          reason — an opened thing is on a clock, which is the one fact the row could not otherwise
          be read off the number beside it. */}
      <span className={'ml-kitchen__shelfstate' + (opened ? ' ml-kitchen__shelfstate--turning' : '')}>
        {opened ?? ageLabel(item.lastSeenAtUtc)}
      </span>
      {/* 76px and nowrap. It was 56 and wrapped; do not narrow it (PANTRY_SHELVES §1). */}
      <span className="ml-kitchen__shelfamount">{amountLabel(item)}</span>
    </button>
  )
}
