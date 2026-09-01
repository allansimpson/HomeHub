import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { KitchenDivider, KitchenDrillInHeader, ScreenShell, ScrollArea } from '../../components'
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
 *
 * **The order is held until `SAVE THE ORDER`**, unlike the check flow, which writes every answer as
 * it is given. The two are different kinds of thing: a check records observations, each true on its
 * own the moment it is made; an order is one arrangement, meaningful only whole. Half a
 * rearrangement, saved because somebody walked away mid-drag, is an order nobody chose.
 */
export function KitchenAisleOrderScreen() {
  const navigate = useNavigate()
  const [store, setStore] = useState(STORES[0])
  const [aisles, setAisles] = useState<AisleOrderLineDto[]>([])
  const [busy, setBusy] = useState(false)
  /** Whether anything has been moved since the last save — what `SAVE THE ORDER` acts on. */
  const [moved, setMoved] = useState(false)

  const load = useCallback(() => {
    setMoved(false)
    void api.getAisleOrder(store).then((o) => setAisles(o.aisles)).catch(() => {})
  }, [store])

  useEffect(load, [load])

  /**
   * Reordering sends the whole list rather than a move-this-one delta.
   *
   * A drag reorders the list; replaying a sequence of deltas is how two people dragging at once end
   * up with an order neither of them chose.
   */
  const move = (index: number, by: number) => {
    const next = [...aisles]
    const to = index + by
    if (to < 0 || to >= next.length) return

    ;[next[index], next[to]] = [next[to], next[index]]
    setAisles(next)
    setMoved(true)
  }

  /**
   * Commit the order.
   *
   * **Held until pressed**, which is the one place this panel differs from the check flow's write-
   * it-as-you-answer rule — and the difference is what the two are. A check records observations
   * about the world, each true on its own the moment it is given. An order is a single arrangement:
   * it is only meaningful whole, and half a rearrangement saved because somebody walked away is an
   * order nobody chose. The handoff draws the button for that reason.
   */
  const save = async () => {
    setBusy(true)
    try {
      const saved = await api.setAisleOrder(store, aisles.map((a) => a.aisle))
      setAisles(saved.aisles)
      setMoved(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <ScreenShell
      header={<KitchenDrillInHeader title="Aisle order" onExit={() => navigate(-1)} exit="BACK" />}
    >
      <ScrollArea>
        {/* Store chips lead: the order belongs to a shop, so the shop is chosen first. */}
        <div className="ml-kitchen__chips" data-hscroll>
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

        <KitchenDivider label="First to last" count={aisles.length} gap={false} />
        {aisles.length === 0 ? (
          <div>
            <div className="ml-kitchen__emptyshelf">
              Nothing on the list has an aisle yet. The order learns itself as things get ticked off.
            </div>
          </div>
        ) : (
          <div>
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
          </div>
        )}

        {/*
          Where everything the order does not name goes.

          One fixed row rather than a list, because the server sends the aisles it knows and has no
          separate word for the ones it does not. Saying it anyway is the point: an order whose foot
          is unstated reads as complete, and then a thing that never appears in it looks like a bug
          rather than the documented last place.
        */}
        <KitchenDivider label="Elsewhere" />
        <div>
          <div className="ml-row ml-kitchen__aislerow">
            {/* Not an aisle, so not `__aislename`: this is a statement about where the unnamed go,
                and the handoff sets it a step under the rows it is describing. */}
            <span className="ml-kitchen__aislesaid ml-kitchen__aislesaid--infold">Anything unfiled</span>
            <span className="ml-kitchen__aislecount">sorts last</span>
          </div>
        </div>

        <KitchenDivider label="How it was learned" />
        <div>
          <div className="ml-kitchen__askwhy">
            The order started from what got ticked off first. It is a guess — moving anything here
            replaces it for good, and nothing works it out again afterwards.
          </div>
        </div>

        {/*
          The blast radius, as on every settings panel in this section — and under its own label
          rather than as a loose paragraph. It was the latter, which is how a statement about what a
          setting *cannot* reach ends up reading as a footnote to the setting above it.
        */}
        <KitchenDivider label="What this changes" />
        <div>
          <div className="ml-row ml-kitchen__aislerow">
            <span className="ml-kitchen__aislesaid">The order of bands while shopping</span>
            {/* Verdigris: the one thing on the panel this setting *does* reach, and the section's
                colour for a fact that is live rather than remembered. */}
            <span className="ml-kitchen__aislecount ml-kitchen__aislecount--live">this shop only</span>
          </div>
          <div className="ml-kitchen__askwhy">
            Nothing about the pantry, and nothing about what gets bought. Each shop keeps its own
            order.
          </div>
        </div>

        <button
          type="button"
          className="ml-kitchen__shop"
          disabled={busy || !moved}
          onClick={() => void save()}
        >
          {/* The label does not change with state — the handoff writes one word for this control,
              and a button that renames itself is a second thing to read on a settings panel. It
              simply has nothing to do until something has moved. */}
          SAVE THE ORDER
        </button>
      </ScrollArea>
    </ScreenShell>
  )
}
