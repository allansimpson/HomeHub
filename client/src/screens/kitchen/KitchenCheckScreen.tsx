import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { CutGroup, DrillInHeader, ScreenShell, ScrollArea, Stepper } from '../../components'
import { api } from '../../api/client'
import { ageLabel, amountLabel } from '../../app/pantryDomain'
import type { PantryItemDto } from '../../api/types'

/** What this run has settled, so `CORRECTED JUST NOW` can list it. */
interface Correction {
  id: number
  name: string
  said: string
}

/**
 * RUN A CHECK (PANTRY_SHELVES §3, panel P3).
 *
 * The correction pass — **a flow, not a form**, because it is done standing at a cupboard rather
 * than sitting at a desk. One card at a time, in shelf order.
 *
 * **Five answers, weighted.** Confirming is the commonest and is one tap. `CAN'T FIND IT` is
 * deliberately not `ALL GONE`: a thing you could not see is not a thing you do not have, and
 * conflating them is how a shelf count quietly becomes fiction.
 *
 * **Each answer is written the moment it is given.** Unlike the add errand there is no session to
 * commit — a check that lost its work halfway up the stairs would never be run twice.
 */
export function KitchenCheckScreen() {
  const navigate = useNavigate()

  const [queue, setQueue] = useState<PantryItemDto[]>([])
  const [at, setAt] = useState(0)
  const [nudged, setNudged] = useState<number | null>(null)
  const [done, setDone] = useState<Correction[]>([])
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    void api.getPantry()
      .then((p) => {
        // Stalest first: the point of a check is the numbers nobody has confirmed lately, and
        // walking the whole pantry in name order would spend the household's patience on rows that
        // were right anyway.
        const worth = p.items
          .filter((i) => i.tracking !== 'NotCounted')
          .sort((a, b) => (a.lastSeenAtUtc ?? '').localeCompare(b.lastSeenAtUtc ?? ''))
        setQueue(worth.slice(0, 12))
      })
      .catch(() => {})
  }, [])

  useEffect(load, [load])

  const item = queue[at]
  const advance = () => { setNudged(null); setAt((i) => i + 1) }

  /**
   * Write one answer.
   *
   * **Confirming writes too.** `THAT'S RIGHT` changes no number but it is still a sighting, and the
   * whole queue is ordered by how stale a number is: an answer that wrote nothing left the row as
   * unconfirmed as it was before, so the same handful of items headed the check every single run
   * and the ones behind them were never reached.
   *
   * `seen` is false for the one answer that is not a sighting — see the caller.
   */
  const settle = async (said: string, quantity?: number, seen = true) => {
    if (!item) return
    setBusy(true)
    try {
      if (seen) {
        await api.updatePantryItem(item.id, {
          name: item.name,
          location: item.location,
          tracking: item.tracking,
          quantity: quantity ?? item.quantity,
          unit: item.unit,
          estimateState: item.estimateState,
          packSize: item.packSize,
          packUnit: item.packUnit,
        }, item.version)
      }
      setDone((prev) => [{ id: item.id, name: item.name, said }, ...prev])
      advance()
    } finally {
      setBusy(false)
    }
  }

  if (!item) {
    return (
      <ScreenShell nav={false} header={<CheckHeader onLeave={() => navigate('/kitchen/pantry')} />}>
        <ScrollArea>
          <div className="ml-kitchen__receiptlede">
            {done.length === 0 ? 'Nothing needs checking.' : `${done.length} settled.`}
          </div>
          <button type="button" className="ml-kitchen__shop" onClick={() => navigate('/kitchen/pantry')}>
            DONE
          </button>
        </ScrollArea>
      </ScreenShell>
    )
  }

  const showing = nudged ?? item.quantity ?? 0

  return (
    <ScreenShell
      nav={false}
      header={
        <CheckHeader onLeave={() => navigate('/kitchen/pantry')} />
      }
    >
      <ScrollArea>
        {/* Progress, because a flow with no visible end is one people abandon. */}
        <div className="ml-kitchen__bar">
          <span className="ml-kitchen__barfill" style={{ width: `${((at) / queue.length) * 100}%` }} />
        </div>

        <div className="ml-kitchen__askedfor">
          <span className="ml-band__meta">{item.location.toUpperCase()}</span>
          <span className="ml-kitchen__askedname">{item.name}</span>
        </div>

        {/*
          What we believe, and how stale the belief is — in the same sentence. A count without an
          age is a lie told confidently (PANTRY_BEHAVIOURS §9).
        */}
        <div className="ml-kitchen__askwhy">
          We think {amountLabel(item)}. {ageLabel(item.lastSeenAtUtc)}.
        </div>

        <div className="ml-kitchen__partial">
          <Stepper
            direction="minus"
            label="One fewer"
            disabled={busy || showing <= 0}
            onStep={() => setNudged(Math.max(0, showing - 1))}
          />
          <span className="ml-kitchen__partialvalue">{showing}</span>
          <Stepper
            direction="plus"
            label="One more"
            disabled={busy}
            onStep={() => setNudged(showing + 1)}
          />
          <span className="ml-kitchen__partialof">{item.unit ?? ''}</span>
        </div>

        <div className="ml-kitchen__errandactions">
          {/* Confirming is the commonest answer, so it is the one that is one tap. */}
          <button
            type="button"
            className="ml-kitchen__shop"
            disabled={busy}
            onClick={() => settle("that's right", nudged ?? undefined)}
          >
            {nudged == null ? "THAT'S RIGHT" : `CORRECT IT TO ${nudged}`}
          </button>

          <div className="ml-kitchen__errandrow">
            <button
              type="button"
              className="ml-kitchen__errandalt"
              disabled={busy}
              onClick={() => settle('all gone', 0)}
            >
              ALL GONE
            </button>
            {/*
              Not `ALL GONE`. A thing you could not see is not a thing you do not have, so this
              changes no number — and, unlike every other answer here, it is **not a sighting**.
              Writing one would stamp the row as seen today on the strength of somebody failing to
              find it, which is the confident wrongness the section forbids. It costs the row its
              place at the front of the next check, and that is the correct price: the number really
              is still unconfirmed.
            */}
            <button
              type="button"
              className="ml-kitchen__errandalt"
              disabled={busy}
              onClick={() => settle("couldn't find it", undefined, false)}
            >
              CAN'T FIND IT
            </button>
            <button
              type="button"
              className="ml-kitchen__errandalt"
              disabled={busy}
              onClick={advance}
            >
              SKIP
            </button>
          </div>
        </div>

        {/* What is coming, with what we believe about it — so the run has a visible shape. */}
        {at + 1 < queue.length && (
          <>
            <div className="ml-band ml-band--quiet">
              <span className="ml-band__label">STILL TO CHECK</span>
              <span className="ml-band__meta">{queue.length - at - 1}</span>
            </div>
            <CutGroup rows={3} rowHeight={60} className="ml-band-shade">
              {queue.slice(at + 1).map((next) => (
                <div key={next.id} className="ml-row ml-kitchen__waitingrow">
                  <span className="ml-row__value">{next.name}</span>
                  <span className="ml-kitchen__eventwho">{amountLabel(next)}</span>
                </div>
              ))}
            </CutGroup>
          </>
        )}

        {done.length > 0 && (
          <>
            <div className="ml-band">
              <span className="ml-band__label">CORRECTED JUST NOW</span>
              <span className="ml-band__meta">{done.length}</span>
            </div>
            <CutGroup rows={3} rowHeight={60} className="ml-band-shade">
              {done.map((row) => (
                <div key={`${row.id}-${row.said}`} className="ml-row ml-kitchen__waitingrow">
                  <span className="ml-row__value">{row.name}</span>
                  <span className="ml-kitchen__eventwho">{row.said}</span>
                </div>
              ))}
            </CutGroup>
          </>
        )}
      </ScrollArea>
    </ScreenShell>
  )
}

/**
 * `STOP` beside `DONE`, and they are not the same word for the same thing.
 *
 * Every answer on this screen has already been written, so leaving loses nothing either way — but
 * `STOP` is walking away mid-run and `DONE` is saying the run is finished, and a household that
 * only ever sees one of them cannot tell the panel which it meant. How far through you are is on
 * the bar underneath, not in the header (PANTRY_SHELVES §3).
 */
function CheckHeader({ onLeave }: { onLeave: () => void }) {
  return (
    <DrillInHeader
      title="Check the shelves"
      onBack={onLeave}
      backLabel="STOP"
      status={
        <span className="ml-kitchen__headeraction">
          <button type="button" onClick={onLeave}>DONE</button>
        </span>
      }
    />
  )
}
