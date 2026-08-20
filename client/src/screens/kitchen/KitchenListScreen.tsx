import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { CutGroup, KitchenHeader, KitchenQuickRow, ScreenShell, ScrollArea } from '../../components'
import { api } from '../../api/client'
import { grocerySections, mirrorLines, provenanceLine } from '../../app/pantryDomain'
import { amountOf } from '../../app/kitchenDomain'
import type { GroceryLineDto, GroceryListDto } from '../../api/types'

/** A list row is taller than a shelf row — it carries a second line — so its cut is its own. */
const ROW_HEIGHT = 56

/** Rows visible per band before the cut. Five on the longest, so the panel's budget holds. */
const BAND_ROWS = 4

/**
 * LIST — the grocery list (LIST_AND_SHOPPING §1, panel G1).
 *
 * **Grouped by where a line came from, not by aisle.** Provenance is what tells you whether you can
 * argue with a line: "Saturday · Ragù" is a fact about the plan, "Eleanor · the dark ones" is a
 * request from a person, and the two invite different answers. Aisle order is right in the shop and
 * wrong at home — the shop screen does that instead.
 *
 * **A tick is a receipt.** Once a line is got, its provenance is *replaced* by what the tick
 * actually did — "2 blocks put in the fridge" — and the list stops being a to-do and becomes a
 * record of what happened.
 */
export function KitchenListScreen() {
  const navigate = useNavigate()
  const [list, setList] = useState<GroceryListDto | null>(null)
  const [typed, setTyped] = useState('')

  const load = useCallback(() => {
    void api.getGrocery().then(setList).catch(() => {})
  }, [])

  useEffect(load, [load])

  /** Add what somebody typed. Free text, because most of what a household wants is not a recipe. */
  const add = async () => {
    const text = typed.trim()
    if (!text) return
    setTyped('')
    try { await api.addGroceryLine({ text, sourceKind: 'Hand' }) } finally { load() }
  }

  const sections = grocerySections(list?.lines ?? [])
  const open = list?.openCount ?? 0
  const mirror = list ? mirrorLines(list.mirror) : null

  const tick = async (line: GroceryLineDto) => {
    // Optimistic: ticking in a shop with a phone in one hand should not wait on a round trip
    // (PANTRY_BEHAVIOURS §2). The reload behind it reconciles.
    setList((prev) => prev && {
      ...prev,
      lines: prev.lines.map((l) =>
        l.id === line.id ? { ...l, checkedAtUtc: new Date().toISOString() } : l),
      openCount: Math.max(0, prev.openCount - 1),
    })
    try { await api.checkGroceryLine(line.id, true) } finally { load() }
  }

  return (
    <ScreenShell
      header={<KitchenHeader title="THE LIST" meta={`${open} OPEN`} />}
      dock={<KitchenQuickRow active="List" counts={{ list: `${open} OPEN` }} />}
    >
      <ScrollArea>
        {/* Add field with a brass ＋ (LIST_AND_SHOPPING §1). Most of what a household wants is not
            an ingredient, so typing is the primary way a line gets here. */}
        <form
          className="ml-kitchen__searchrow"
          onSubmit={(e) => { e.preventDefault(); void add() }}
        >
          <label className="ml-kitchen__search">
            <input
              type="text"
              className="ml-kitchen__searchfield"
              placeholder="Add something"
              aria-label="Add something to the list"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          </label>
          <button
            type="submit"
            className="ml-kitchen__plus"
            aria-label="Add it"
            disabled={typed.trim().length === 0}
          >
            ＋
          </button>
        </form>

        {/*
          The mirror strip is permanent — direction and age, always. Never a toast: a mirror nobody
          can see is a mirror nobody trusts (DECISIONS PG8).
        */}
        {mirror && (
          <div className={`ml-kitchen__mirror ml-kitchen__mirror--${mirror.tone}`}>
            <span className="ml-kitchen__mirrordot" />
            <span className="ml-kitchen__mirrorlabel">{mirror.label}</span>
            <span className="ml-kitchen__mirrorsub">{mirror.detail}</span>
          </div>
        )}

        {sections.map((section) => (
          section.lines.length === 0 ? null : (
            <div key={section.key}>
              <div className={`ml-band${section.key === 'done' ? ' ml-band--quiet' : ''}`}>
                <span className="ml-band__label">{section.label}</span>
                <span className="ml-band__meta">{section.lines.length}</span>
              </div>
              <CutGroup rows={BAND_ROWS} rowHeight={ROW_HEIGHT} className="ml-band-shade">
                {section.lines.map((line) => (
                  <Line key={line.id} line={line} onTick={() => tick(line)} />
                ))}
              </CutGroup>
            </div>
          )
        ))}

        {/*
          **One footer button** (LIST_AND_SHOPPING §1).

          The review is reached from the plan's `WHAT WE NEED` and putting away from the shop's own
          commit, so neither needs a door here. Adding them made this panel a menu of the section
          rather than the list, which is what it is for.
        */}
        {open > 0 && (
          <button
            type="button"
            className="ml-kitchen__shop"
            onClick={() => navigate('/kitchen/list/shop')}
          >
            SHOP · {open} {open === 1 ? 'THING' : 'THINGS'}
          </button>
        )}
      </ScrollArea>
    </ScreenShell>
  )
}

/**
 * One line, with the box that turns it into a receipt.
 *
 * The checkbox is the whole interaction and it does two things at once: it marks the line got, and
 * it puts the stock back on a shelf. That return trip is the reason HomeHub owns this list rather
 * than mirroring one — a list you only tick cannot tell the pantry anything.
 */
function Line({ line, onTick }: { line: GroceryLineDto; onTick: () => void }) {
  const got = line.checkedAtUtc != null

  return (
    <div className={`ml-row ml-kitchen__listrow${got ? ' ml-kitchen__listrow--got' : ''}`}>
      <button
        type="button"
        className={`ml-kitchen__tick${got ? ' ml-kitchen__tick--on' : ''}`}
        aria-label={got ? `${line.text}, got` : `Mark ${line.text} as got`}
        aria-pressed={got}
        onClick={got ? undefined : onTick}
        disabled={got}
      >
        {got ? '✓' : ''}
      </button>

      <span className="ml-kitchen__listtext">
        <span className="ml-kitchen__listname">{line.text}</span>
        {/* Got lines say what the tick did, in the live ink; open ones say where they came from. */}
        <span className={`ml-kitchen__listwhy${got ? ' ml-kitchen__listwhy--done' : ''}`}>
          {got ? (line.returnTrip ?? 'Got it') : provenanceLine(line)}
        </span>
      </span>

      {/* Right-aligned in the mono column, and read as the household says it — `1.6 kg`, not
          `×1.6`. A multiplication sign in front of a weight is arithmetic nobody asked for. */}
      {line.quantity != null && (
        <span className="ml-kitchen__listqty">{amountOf(line)}</span>
      )}
    </div>
  )
}
