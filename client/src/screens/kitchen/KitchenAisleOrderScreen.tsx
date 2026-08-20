import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { CutGroup, DrillInHeader, ScreenShell, ScrollArea } from '../../components'
import { api } from '../../api/client'
import type { AisleOrderLineDto } from '../../api/types'

/** Shops the household walks. A butcher is not a supermarket, and one order cannot serve both. */
const STORES = ['Tesco', 'Butcher']

/**
 * AISLE ORDER (SETTINGS_AND_IMPORT §2, panel S2).
 *
 * **Per shop.** The addendum first described a single household-wide order; the locked settings
 * spec supersedes it with store chips, because a butcher is not a supermarket.
 *
 * **Dragging always wins.** The initial order is a guess seeded from what got ticked off first, and
 * the panel says so — every row here is overwritable, and nothing re-infers it once a person has
 * moved something.
 *
 * **Empty aisles stay listed**, reading `empty` rather than vanishing, and anything the order does
 * not name sorts last under `ELSEWHERE`. An order you can only half see is one you cannot correct.
 */
export function KitchenAisleOrderScreen() {
  const navigate = useNavigate()
  const [store, setStore] = useState(STORES[0])
  const [aisles, setAisles] = useState<AisleOrderLineDto[]>([])
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    void api.getAisleOrder(store).then((o) => setAisles(o.aisles)).catch(() => {})
  }, [store])

  useEffect(load, [load])

  /**
   * Reordering sends the whole list rather than a move-this-one delta.
   *
   * A drag reorders the list; replaying a sequence of deltas is how two people dragging at once end
   * up with an order neither of them chose.
   */
  const move = async (index: number, by: number) => {
    const next = [...aisles]
    const to = index + by
    if (to < 0 || to >= next.length) return

    ;[next[index], next[to]] = [next[to], next[index]]
    setAisles(next)

    setBusy(true)
    try {
      const saved = await api.setAisleOrder(store, next.map((a) => a.aisle))
      setAisles(saved.aisles)
    } finally {
      setBusy(false)
    }
  }

  return (
    <ScreenShell
      header={<DrillInHeader title="Aisle order" onBack={() => navigate(-1)} backLabel="BACK" />}
    >
      <ScrollArea>
        {/* Store chips lead: the order belongs to a shop, so the shop is chosen first. */}
        <div className="ml-kitchen__chips ml-cut">
          {STORES.map((name) => (
            <button
              key={name}
              type="button"
              className={`ml-kitchen__chip${store === name ? ' ml-kitchen__chip--on' : ''}`}
              onClick={() => setStore(name)}
            >
              {name.toUpperCase()}
            </button>
          ))}
        </div>

        <div className="ml-band">
          <span className="ml-band__label">FIRST TO LAST</span>
          <span className="ml-band__meta">{aisles.length}</span>
        </div>
        {aisles.length === 0 ? (
          <div className="ml-band-shade">
            <div className="ml-kitchen__emptyshelf">
              Nothing on the list has an aisle yet. The order learns itself as things get ticked off.
            </div>
          </div>
        ) : (
          <CutGroup rows={5} rowHeight={56} className="ml-band-shade">
            {aisles.map((aisle, i) => (
              <div key={aisle.aisle} className="ml-row ml-kitchen__aislerow">
                <span className="ml-kitchen__aislepos">{i + 1}</span>
                <span className="ml-kitchen__aislename">{aisle.aisle}</span>

                {/* An aisle with nothing in it stays listed and says so, rather than disappearing
                    and leaving a hole in an order somebody is trying to read. */}
                <span
                  className={
                    'ml-kitchen__aislecount'
                    + (aisle.lineCount === 0 ? ' ml-kitchen__aislecount--empty' : '')
                  }
                >
                  {aisle.lineCount === 0 ? 'empty' : `${aisle.lineCount} on the list`}
                </span>

                {/*
                  Up/down rather than a drag handle. The panel is a wall-mounted touchscreen used
                  with wet hands; a drag that has to be held accurately down a list is the gesture
                  most likely to fail there, and two buttons cannot half-succeed.
                */}
                <span className="ml-kitchen__aislemove">
                  <button
                    type="button"
                    aria-label={`Move ${aisle.aisle} earlier`}
                    disabled={busy || i === 0}
                    onClick={() => move(i, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${aisle.aisle} later`}
                    disabled={busy || i === aisles.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    ↓
                  </button>
                </span>
              </div>
            ))}
          </CutGroup>
        )}

        <div className="ml-band ml-band--quiet">
          <span className="ml-band__label">HOW IT WAS LEARNED</span>
        </div>
        <div className="ml-band-shade">
          <div className="ml-kitchen__askwhy">
            The order started from what got ticked off first. It is a guess — moving anything here
            replaces it for good, and nothing works it out again afterwards.
          </div>
        </div>

        {/* The blast radius, as on every settings panel in this section. */}
        <div className="ml-kitchen__askwhy">
          This changes the order of the bands while shopping, in this shop only. Nothing about the
          pantry, and nothing about what gets bought.
        </div>
      </ScrollArea>
    </ScreenShell>
  )
}
