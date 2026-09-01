import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { KitchenDivider, KitchenDrillInHeader, ScreenShell, ScrollArea } from '../../components'
import { api } from '../../api/client'
import { useMeals } from '../../app/MealsProvider'
import { agoLabel, longWeekday, shortWeekday, todayKey } from '../../app/mealsDomain'
import { calendarDaysBetween, isFlagged, pluralUnit, trimNumber } from '../../app/pantryDomain'
import { collateWants, isBuyable, needsAPerson } from '../../app/kitchenDomain'
import { DecisionCard } from './DecisionCard'
import type { GroceryInput, MealPlanEntryDto, StockCheckLineDto } from '../../api/types'

/** One shortfall, carrying the night that wants it so the row can say why it is here. */
interface Want {
  line: StockCheckLineDto
  entry: MealPlanEntryDto
  title: string
}

/**
 * THE REVIEW (LIST_AND_SHOPPING §2, panel G2).
 *
 * The signature panel of the section, and a full-page errand — no chrome, `CANCEL` in the header,
 * and **the footer is the only thing that writes**. Everything above it is the app showing its
 * working.
 *
 * **The header states what it was calculated from** — how many nights, which ones, and how old the
 * pantry reading is. That is what lets one panel serve a single night and a whole week without
 * becoming two panels: the scope is data on the screen rather than a mode you had to pick.
 *
 * **Ambiguity is a card, not an error.** Two open questions never block adding the seven the panel
 * is sure about; the footer says so in as many words. An app that refused to act until every
 * question was answered would be one people stop opening.
 *
 * **`ALREADY COVERED` is stated even when nothing needs buying.** Showing the working matters most
 * when the answer is "nothing" — otherwise silence reads as a failure to calculate.
 */
export function KitchenReviewScreen() {
  const navigate = useNavigate()
  const { week, recipes } = useMeals()

  const [wants, setWants] = useState<Want[]>([])
  const [covered, setCovered] = useState(0)
  const [readAt, setReadAt] = useState<string | null>(null)
  const [settled, setSettled] = useState<Map<string, 'add' | 'leave'>>(new Map())
  const [busy, setBusy] = useState(false)

  /**
   * The planned nights this was worked out from — the "3 PLANNED NIGHTS" the header names.
   *
   * Today counts. A review run at four o'clock that quietly excluded tonight's dinner would send
   * somebody to the shop without the one thing they are about to cook.
   */
  const nights = useMemo(() => {
    const from = todayKey()
    return (week?.days ?? [])
      .filter((d) => d.date >= from)
      .flatMap((d) => d.entries)
      .filter((e) => e.recipeId != null)
  }, [week])

  const load = useCallback(() => {
    if (nights.length === 0) return
    let cancelled = false

    void Promise.all(
      nights.map(async (entry) => {
        const check = await api.checkStock(
          entry.recipeId as number,
          entry.servingsOverride ?? undefined,
          entry.id,
        )
        return { check, entry }
      }),
    ).then((results) => {
      if (cancelled) return

      const found: Want[] = []
      let ok = 0
      for (const { check, entry } of results) {
        // A 204 means the night has nothing worth saying — everything it needs is in. Its lines
        // still belong in `ALREADY COVERED`, or a fully-stocked week would read as a blank panel.
        if (!check) {
          ok += recipes.find((r) => r.id === entry.recipeId)?.ingredientCount ?? 0
          continue
        }
        for (const line of check.lines) {
          if (isFlagged(line.status)) {
            found.push({ line, entry, title: check.recipeTitle })
          } else {
            ok += 1
          }
        }
      }
      setWants(found)
      setCovered(ok)
      // The freshest reading behind any of it — the header quotes the *oldest* thing it relied on.
      setReadAt(
        found.map((w) => w.line.lastSeenAtUtc).filter(Boolean).sort()[0] ?? null,
      )
    }).catch(() => {})

    return () => { cancelled = true }
  }, [nights, recipes])

  useEffect(() => { load() }, [load])

  /*
   * Sure enough to buy, versus needing a person. `NoMatch` and `Unknown` are questions, not
   * shortfalls: the app does not know what the thing is, or does not know how much is left.
   *
   * Collated to one entry per *thing*. Several nights wanting tinned tomatoes is one line on a
   * shopping list, and "what is capers?" is one question however many nights ask it — asking it
   * three times when a single answer settles all three is incoherent on its face.
   */
  const sure = collateWants(wants.filter((w) => isBuyable(w.line.status)))
  const open = collateWants(wants.filter((w) => needsAPerson(w.line.status)))
  const stillOpen = open.filter((c) => !settled.has(c.key))

  const answer = (key: string, how: 'add' | 'leave') =>
    setSettled((prev) => new Map(prev).set(key, how))

  const toAdd = [
    ...sure,
    ...open.filter((c) => settled.get(c.key) === 'add'),
  ]

  /** The only write on the panel. */
  const commit = async () => {
    setBusy(true)
    try {
      const lines: GroceryInput[] = toAdd.map(({ first }) => ({
        text: first.line.name,
        sourceKind: 'Meal',
        pantryItemId: first.line.pantryItemId,
        sourceRecipeId: first.entry.recipeId,
        sourceRecipeTitle: first.title,
        // The earliest night that wants it, which is the one that decides how soon it is needed.
        sourceDate: first.entry.date,
      }))
      if (lines.length > 0) await api.addGroceryLines(lines)
      navigate('/kitchen/list')
    } finally {
      setBusy(false)
    }
  }

  return (
    <ScreenShell
      nav={false}
      header={
        <KitchenDrillInHeader
          title="What to add"
          onExit={() => navigate('/kitchen/list')}
          exit="CANCEL"
        />
      }
    >
      <ScrollArea>
        {/* What this was worked out from. The scope is on the screen, not in a mode. */}
        <div className="ml-kitchen__from">
          FROM {nights.length} PLANNED {nights.length === 1 ? 'NIGHT' : 'NIGHTS'}
          {nights.length > 0
            && ` · ${[...new Set(nights.map((n) => shortWeekday(n.date).toUpperCase()))].join(', ')}`}
        </div>
        <div className="ml-kitchen__askwhy">
          {/* Lower-cased: `agoLabel` is written for a header slot, and `3 DAYS AGO` shouted in
              the middle of a sentence reads as a different voice from the sentence around it. */}
              {readAt ? `Pantry as it stood ${agoLabel(readAt).toLowerCase()}.` : 'Pantry as it stands now.'}
        </div>

        {stillOpen.length > 0 && (
          <div className="ml-kitchen__needsyou">
            {stillOpen.length === 1 ? 'One of these needs you' : `${stillOpen.length} of these need you`}
          </div>
        )}

        {sure.length > 0 && (
          <>
            <KitchenDivider label="Add these" count={sure.length} gap={false} />
            {/* The cards below are sized to content, deliberately — a question you have to scroll
                to find is one that gets answered by accident. This list is not a question. */}
            <div>
              {sure.map(({ key, first: w, nights: n }) => (
                <div key={key} className="ml-row ml-kitchen__wantrow">
                  <span className="ml-kitchen__wanttext">
                    <span className="ml-kitchen__shelfname">{w.line.name}</span>
                    {/* Need, have, and which night — the three facts that make a buy arguable. */}
                    <span className="ml-kitchen__wantwhy">
                      {w.line.needed ? `need ${w.line.needed}` : 'needed'}
                      {' · '}
                      {w.line.status === 'ClaimedAway'
                        ? 'spoken for'
                        : w.line.lastSeenQuantity ? `have ${w.line.lastSeenQuantity}` : 'none in'}
                      {' · '}
                      {longWeekday(w.entry.date)}
                      {n > 1 && ` and ${n - 1} more`}
                    </span>
                  </span>
                  <span className="ml-kitchen__wantbuy">{w.line.needed ?? '1'}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {open.length > 0 && (
          <>
            <KitchenDivider label="These need you" count={stillOpen.length} amber />
            <div>
              {open.map(({ key, first: w }) => {
                const chosen = settled.get(key)
                return (
                  <DecisionCard
                    key={key}
                    item={w.line.name}
                    kind={doubtKind(w.line)}
                    leftLabel="WANTED"
                    leftValue={w.line.needed ?? '—'}
                    rightLabel="IN THE PANTRY"
                    rightValue={inThePantry(w.line)}
                    why={doubtWhy(w.line, longWeekday(w.entry.date))}
                    choices={[
                      /*
                        The first choice is the one the doubt itself suggests.

                        Where the amount was never counted, going and looking settles it, so
                        `CHECK IT NOW` leads. Where it *was* counted and simply cannot be compared —
                        the night wants liquid stock and the shelf holds cubes — looking again
                        changes nothing, and the useful answer is whether what is there will do.
                        Saying so teaches the match, which is why the card says it will be
                        remembered (LIST_AND_SHOPPING §2).
                      */
                      cannotCompare(w.line)
                        ? {
                          label: `${pluralUnit(w.line.lastSeenQuantity, w.line.lastSeenUnit || 'that').toUpperCase()} WILL DO`,
                          primary: chosen == null,
                          onChoose: () => answer(key, 'leave'),
                        }
                        : {
                          label: 'CHECK IT NOW',
                          primary: chosen == null,
                          onChoose: () => navigate('/kitchen/pantry/check'),
                        },
                      {
                        label: addLabel(w.line),
                        primary: chosen === 'add',
                        onChoose: () => answer(key, 'add'),
                      },
                      {
                        label: 'LEAVE IT',
                        primary: chosen === 'leave',
                        onChoose: () => answer(key, 'leave'),
                      },
                    ]}
                  />
                )
              })}
            </div>
          </>
        )}

        {/*
          One collapsed line, always present. When the answer is "nothing to buy" this *is* the
          answer, and a blank screen would read as the panel having failed to run.
        */}
        <KitchenDivider label="Already covered" count={covered} />
        <div>
          <div className="ml-kitchen__askwhy">
            {covered === 0
              ? 'Nothing on these nights is already in.'
              : `${covered} ${covered === 1 ? 'thing is' : 'things are'} on a shelf or already on the list.`}
          </div>
        </div>
      </ScrollArea>

      <div className="ml-kitchen__errandactions">
        {/* The only control that writes, and it says exactly what it leaves behind. */}
        <button
          type="button"
          className="ml-kitchen__shop"
          disabled={busy || toAdd.length === 0}
          onClick={commit}
        >
          ADD {toAdd.length}
          {stillOpen.length > 0 && ` · ${stillOpen.length} STILL OPEN`}
        </button>
      </div>
    </ScreenShell>
  )
}

/* ---- The two doubts a review can hold, and how each is worded (LIST_AND_SHOPPING §2) ---- */

/**
 * Counted, and still not comparable — the night wants a volume and the shelf holds cubes.
 *
 * Distinct from "we never counted it": checking the cupboard again produces the same standoff, so
 * the question is not how much is there but whether it counts at all.
 */
function cannotCompare(line: StockCheckLineDto): boolean {
  return line.status !== 'NoMatch' && line.lastSeenQuantity != null && line.lastSeenState == null
}

/** The card's kind line: the reason, named, rather than a category. */
function doubtKind(line: StockCheckLineDto): string {
  if (line.status === 'NoMatch') return 'NOT SURE WHAT THIS IS'
  if (cannotCompare(line)) return "DON'T KNOW IF IT COUNTS"
  // The age *is* the doubt on an uncounted amount, so it is what the line says.
  // A digit, not a number word: this is a caps label beside `SEEN 2 D` and `OPEN 3 D`, and the
  // section spells ages in figures wherever it letterspaces them.
  return line.lastSeenAtUtc ? `LAST SEEN ${weeksAgoLabel(line.lastSeenAtUtc)}` : "CAN'T SAY HOW MUCH IS LEFT"
}

/** What the shelf actually holds, in its own words. */
function inThePantry(line: StockCheckLineDto): string {
  if (line.status === 'NoMatch') return 'nothing like it'
  // `about a bottle`, not `about plenty`. The estimate word answers "how much", and the question
  // on this card is "how much of *what*" — a container is something you can picture on a shelf.
  if (line.lastSeenState) {
    return line.lastSeenUnit ? `about a ${line.lastSeenUnit}` : `about ${line.lastSeenState.toLowerCase()}`
  }
  if (line.lastSeenQuantity != null) {
    return [trimNumber(line.lastSeenQuantity),
      pluralUnit(line.lastSeenQuantity, line.lastSeenUnit)].filter(Boolean).join(' ')
  }
  return 'unclear'
}

/** The grounds for the ruling, which the two columns cannot supply on their own. */
function doubtWhy(line: StockCheckLineDto, night: string): string | undefined {
  if (line.status === 'NoMatch') {
    return 'Nothing on the shelves answers to this name, so the panel cannot say either way.'
  }
  if (cannotCompare(line)) {
    return `${night} wants ${line.needed ?? 'it'}. What is on the shelf might do, and if you say so `
      + 'we will remember it.'
  }
  return 'The amount was never counted, so it may be wrong either way.'
}

/**
 * `ADD A BOTTLE` · `ADD STOCK` — the button names what would be bought.
 *
 * Two shapes, because the two doubts buy different things. Where the amount is merely uncounted you
 * are topping up the same item, so the pantry's own container is the word (`a bottle`). Where it
 * cannot be compared you are buying the *form the night wants*, not another of what is already
 * there — `ADD A CUBE` would be exactly the wrong instruction.
 */
function addLabel(line: StockCheckLineDto): string {
  if (!cannotCompare(line) && line.lastSeenUnit) return `ADD A ${line.lastSeenUnit.toUpperCase()}`
  const word = line.name.trim().split(/\s+/).pop() ?? line.name
  return `ADD ${word.toUpperCase()}`
}

/** `5 WEEKS AGO` — the age as figures, for the card's letterspaced kind line. */
function weeksAgoLabel(atUtc: string, now: Date = new Date()): string {
  const days = calendarDaysBetween(new Date(atUtc), now)
  if (days < 7) return 'THIS WEEK'
  if (days < 14) return 'LAST WEEK'
  return `${Math.floor(days / 7)} WEEKS AGO`
}
