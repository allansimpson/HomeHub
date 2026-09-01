import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { KitchenDivider, KitchenDrillInHeader, OfflineChip, ScreenShell, ScrollArea } from '../../components'
import { api } from '../../api/client'
import { useConnection } from '../../app/ConnectionProvider'
import { provenanceLine } from '../../app/pantryDomain'
import { neededSoon } from '../../app/kitchenDomain'
import type { AisleOrderDto, GroceryLineDto, GroceryListDto } from '../../api/types'

/** The shop the household is standing in. One list, filtered — never a list per shop. */
const DEFAULT_STORE = 'Tesco'

/**
 * THE SHOP (LIST_AND_SHOPPING §3, panel G3).
 *
 * **One shopping surface, not two.** An earlier draft split a full shop from a passing-a-shop view;
 * that was replaced because two surfaces mean deciding which one you are in before you know what
 * you want.
 *
 * **Urgency is a marker, not a mode.** A brass bar and the night beneath the name on any line a
 * planned meal needs — and the `NEEDED SOON` chip narrows to exactly those. So passing a shop with
 * five minutes is a filter, not a different screen.
 *
 * **Order freezes for the duration.** A tick greys the row and strikes it *without moving it*. A
 * list that reorders itself under a thumb in a supermarket is one you lose your place in.
 *
 * Bigger type and targets throughout, because this is the one panel used one-handed while walking.
 */
export function KitchenShopScreen() {
  const navigate = useNavigate()
  const { offline } = useConnection()

  const [list, setList] = useState<GroceryListDto | null>(null)
  const [order, setOrder] = useState<AisleOrderDto | null>(null)
  const [soonOnly, setSoonOnly] = useState(false)
  /** Ticks made on this visit, so a row can grey without the list re-sorting under the thumb. */
  const [ticked, setTicked] = useState<Set<number>>(new Set())

  const load = useCallback(() => {
    void api.getGrocery().then(setList).catch(() => {})
    void api.getAisleOrder(DEFAULT_STORE).then(setOrder).catch(() => {})
  }, [])

  useEffect(load, [load])

  const open = useMemo(
    () => (list?.lines ?? []).filter((l) => l.checkedAtUtc == null),
    [list],
  )

  /**
   * The order is captured once, on arrival, and the rows are laid out against it.
   *
   * Recomputing as ticks land is what would make the list move while somebody is reading it — the
   * spec's "order freezes for the duration" is a rendering rule, not just a sort.
   */
  const [frozen, setFrozen] = useState<GroceryLineDto[] | null>(null)
  useEffect(() => {
    if (frozen == null && open.length > 0) setFrozen(open)
  }, [frozen, open])

  const rows = frozen ?? open
  // Wrapped rather than passed as a bare reference: `filter` supplies (item, index, array), so
  // `rows.filter(neededSoon)` would hand the row's index in as `now` and quietly compare every
  // date against 1970.
  const shown = soonOnly ? rows.filter((l) => neededSoon(l)) : rows
  const soonCount = rows.filter((l) => neededSoon(l)).length

  const aisleOf = (line: GroceryLineDto): string => line.aisle ?? 'Elsewhere'

  // Grouped by the household's own walk order; anything the order does not name sorts last.
  const grouped = useMemo(() => {
    const positions = new Map((order?.aisles ?? []).map((a) => [a.aisle.toLowerCase(), a.position]))
    const buckets = new Map<string, GroceryLineDto[]>()
    for (const line of shown) {
      const aisle = aisleOf(line)
      const bucket = buckets.get(aisle) ?? []
      bucket.push(line)
      buckets.set(aisle, bucket)
    }
    return [...buckets.entries()].sort((a, b) => {
      const pa = positions.get(a[0].toLowerCase()) ?? Number.MAX_SAFE_INTEGER
      const pb = positions.get(b[0].toLowerCase()) ?? Number.MAX_SAFE_INTEGER
      return pa - pb || a[0].localeCompare(b[0])
    })
  }, [shown, order])

  const tick = async (line: GroceryLineDto) => {
    setTicked((prev) => new Set(prev).add(line.id))
    // Offline is a normal mode, not a failure: the tick is kept and the strip says how many are
    // waiting. Never a modal, never a block (§3).
    try { await api.checkGroceryLine(line.id, true) } catch { /* queued */ }
  }

  const waiting = offline ? ticked.size : 0

  return (
    <ScreenShell
      nav={false}
      header={
        <KitchenDrillInHeader
          title="Shopping"
          onExit={() => navigate('/kitchen/list')}
          exit="PAUSE"
          status={`${rows.length - ticked.size} LEFT`}
        />
      }
    >
      <ScrollArea>
        {offline && (
          <div className="ml-kitchen__mirror ml-kitchen__mirror--warn">
            <OfflineChip offline />
            <span className="ml-kitchen__mirrorsub">
              SAVED ON THIS DEVICE{waiting > 0 && ` · ${waiting} ${waiting === 1 ? 'TICK' : 'TICKS'} WAITING`}
            </span>
          </div>
        )}

        {/* Chips, not modes. `EVERYTHING` leads; `NEEDED SOON` carries the same brass bar the
            urgent rows do, so the filter and the marker are visibly the same idea. */}
        <div className="ml-kitchen__chips" data-hscroll>
          <button
            type="button"
            className={`ml-kitchen__chip${soonOnly ? '' : ' ml-kitchen__chip--on'}`}
            onClick={() => setSoonOnly(false)}
          >
            EVERYTHING {rows.length}
          </button>
          <button
            type="button"
            className={`ml-kitchen__chip ml-kitchen__chip--urgent${soonOnly ? ' ml-kitchen__chip--on' : ''}`}
            onClick={() => setSoonOnly(true)}
          >
            NEEDED SOON {soonCount}
          </button>
        </div>

        {grouped.map(([aisle, lines]) => (
          <div key={aisle}>
            <KitchenDivider label={aisle} count={lines.length} gap={false} />
            {/* 63px rows here — the shop's are the biggest in the section, tapped one-handed while
                walking — so the aisle's cut is derived from that and not from a list row. */}
            <div>
              {lines.map((line) => (
                <ShopRow
                  key={line.id}
                  line={line}
                  got={ticked.has(line.id)}
                  onTick={() => tick(line)}
                />
              ))}
            </div>
          </div>
        ))}

        {grouped.length === 0 && (
          <div className="ml-kitchen__emptyshelf">
            {soonOnly ? 'Nothing is needed in the next few days.' : 'Nothing left to get.'}
          </div>
        )}

        <div className="ml-kitchen__aislefoot">
          <span>Aisle order · as you walk it</span>
          <button type="button" onClick={() => navigate('/kitchen/settings/aisles')}>CHANGE IT</button>
        </div>

        {/*
          `FINISH` is the door to putting it away, and the only one.

          It belongs here rather than on the list because this is the moment the shopping actually
          ends — and because ticked is not received: what came home is settled on the next panel,
          not by the ticks that got you to it (LIST_AND_SHOPPING §4).
        */}
        <button
          type="button"
          className="ml-kitchen__shop"
          onClick={() => navigate('/kitchen/list/put-away')}
        >
          FINISH · {ticked.size} GOT
        </button>
      </ScrollArea>
    </ScreenShell>
  )
}

/**
 * One line in the shop.
 *
 * Bigger than a list row on purpose — 18px name, a 24px box, a 63px row — because this is read and
 * tapped one-handed while walking. A tick greys and strikes it **in place**: moving it would cost
 * the reader their position in a list they are working down.
 */
function ShopRow({
  line, got, onTick,
}: { line: GroceryLineDto; got: boolean; onTick: () => void }) {
  const soon = neededSoon(line)

  return (
    <div className={`ml-kitchen__shoprow${got ? ' ml-kitchen__shoprow--got' : ''}`}>
      {/* The urgency marker: a brass bar, not a colour on the text. It has to survive being read
          at arm's length in bad supermarket lighting. */}
      <span className={`ml-kitchen__urgency${soon ? ' ml-kitchen__urgency--on' : ''}`} />

      <button
        type="button"
        className={`ml-kitchen__shopbox${got ? ' ml-kitchen__shopbox--on' : ''}`}
        aria-label={got ? `${line.text}, got` : `Mark ${line.text} as got`}
        aria-pressed={got}
        disabled={got}
        onClick={onTick}
      >
        {got ? '✓' : ''}
      </button>

      <span className="ml-kitchen__shoptext">
        <span className="ml-kitchen__shopname">
          {line.text}
          {line.quantity != null && (
            <span className="ml-kitchen__listqty"> ×{line.quantity}</span>
          )}
        </span>
        {/* The night beneath the name, on anything a planned meal needs. */}
        {soon && <span className="ml-kitchen__shopnight">{provenanceLine(line).toUpperCase()}</span>}
      </span>
    </div>
  )
}
