import { Fragment, useEffect, useRef, useState } from 'react'
import {
  CARE_HISTORY_DAYS, CARE_ICONS, careTitle, careWindowFor, careWindowLabel, clockLabel, countWord,
  dayLabel, elapsedParts, entriesLabel, kindLabel,
  sinceDetail, sizeLabel, valueParts, whenLabel, windowTotals,
} from '../../app/care'
import type { SinceRowSpec, WindowTotal } from '../../app/care'
import { Icon } from '../../icons/Icon'
import type { CareEntryDto, CareEntryTypeName } from '../../api/types'

/** Movement before a horizontal drag is claimed, so a tap on a row is still a tap. */
const CLAIM_PX = 8

/** Vertical travel, with no horizontal claim, that hands the gesture to the scroll for good. */
const GIVE_UP_PX = 24

/**
 * How far horizontal must lead vertical to count as a swipe.
 *
 * Below 1 on purpose: a thumb travelling across a panel arcs, so a gesture read as "sideways" by a
 * person is very rarely sideways to the pixel. Demanding strict dominance is what made this feel
 * like it had to be drawn with a ruler.
 */
const AXIS_LEAD = 0.7

/** How long the pair takes to finish travelling once the finger is off. */
const SETTLE_MS = 220

/**
 * A flick: short, fast, and over.
 *
 * Distance alone cannot tell a flick from an abandoned drag, and half a page is a long way to ask a
 * thumb to travel on a wall panel. Under this many milliseconds, {@link FLICK_PX} is enough.
 */
const FLICK_MS = 300
const FLICK_PX = 36

/** Otherwise, the share of the page that must be revealed to settle onto the next one. */
const SETTLE_FRACTION = 0.28

/** How long a finger rests on a row before the list turns into a selection. */
const LONG_PRESS_MS = 500

/** How far that finger may wander while resting. Held still is never held perfectly still. */
const PRESS_SLOP = 10

/**
 * The order the three pages sit in, and the only place it is stated.
 *
 * <b>ENTRIES leads.</b> The block used to open on SINCE, on the reasoning that "how long since the
 * last one" is the question a household asks most. In use it is not the question the screen is
 * opened *with* — the app is opened to see what has been logged, and the entries page is also the
 * one you act on, since correcting and deleting both live there. SINCE and TODAY are a swipe away
 * and both are readings rather than places you do anything.
 *
 * Everything else keys off this array, so reordering is this line and nothing else.
 */
const PAGE_ORDER = ['entries', 'since', 'today'] as const

type PageName = (typeof PAGE_ORDER)[number]

const PAGES = PAGE_ORDER.length

/** What each page calls itself, in its head row and to assistive tech. */
const PAGE_LABELS: Record<PageName, string> = { entries: 'Entries', since: 'Since', today: 'Today' }
const PIP_LABELS: Record<PageName, string> = {
  entries: 'Entries',
  since: 'Since',
  today: "Today's totals",
}

/**
 * The block at the top of the log: the week's entries, SINCE, and the 6 AM–6 AM totals, as three
 * pages.
 *
 * <b>The pages answer different questions and are not three views of one number.</b> SINCE is "how
 * long since the last one of each", TODAY is "how much in this window" — a window that runs 6 AM to
 * 6 AM, because a 1:25 AM bottle belongs to the night it happened in — and ENTRIES is the day as it
 * was logged. The handoff is explicit that the totals and the calendar-day list will disagree on any
 * night with a feed in it, and that this is correct and must not be reconciled.
 *
 * <b>Both the block's height and everything below it are fixed.</b> Only this block moves when the
 * pages swap; the header above and the LOG grid below are stationary, which is why all three pages
 * are built to one height and why the entries list scrolls inside rather than growing. It is also
 * why selection mode takes its action row out of the *list's* height rather than pushing the grid
 * down — see `listHeight` below.
 *
 * The pager wraps in both directions: ENTRIES → SINCE → TODAY → ENTRIES, and the same backwards.
 * There is no first or last page and no bounce.
 */
export function SincePager({
  since, totals, entries, loading, selection, onSelection, onEdit, onDelete,
}: {
  since: SinceRow[]
  totals: WindowTotal[]
  entries: CareEntryDto[]
  loading: boolean
  /** Selected entry ids. Empty means the list is a plain list. */
  selection: Set<number>
  onSelection: (next: Set<number>) => void
  onEdit: (entry: CareEntryDto) => void
  onDelete: (ids: number[]) => void
}) {
  const [page, setPage] = useState(0)
  /** Live finger offset in px while a swipe is in flight; 0 at rest. */
  const [dx, setDx] = useState(0)
  const [dy, setDy] = useState(0)
  const [releasing, setReleasing] = useState(false)
  /*
   * How many days before today the TODAY page is reporting on. Zero is today.
   *
   * <b>Deliberately not persisted, and not lifted any higher than this component.</b> Paging back
   * is a question somebody asks in the moment — "did she take anything after the 2 AM one" — and
   * not a place the panel should still be sitting when it is picked up again. Held here, it is
   * gone when the Baby tab unmounts, and it is reset below the moment the pager leaves this page,
   * so a swipe across to SINCE and back also lands on today. There is nothing to get stuck in.
   */
  const [daysBack, setDaysBack] = useState(0)

  const frame = useRef<HTMLDivElement | null>(null)
  const startX = useRef<number | null>(null)
  const startY = useRef(0)
  const startedAt = useRef(0)
  const dragging = useRef(false)
  /** Which axis the live gesture was claimed on. Null until one of them wins. */
  const axis = useRef<'x' | 'y' | null>(null)
  const settle = useRef<number | null>(null)

  const selecting = selection.size > 0
  const box = frame.current?.getBoundingClientRect()
  const width = box?.width ?? 0
  const height = box?.height ?? 0

  /*
   * Only TODAY has days to walk through, and only in the directions there is something in.
   *
   * SINCE reports how long since each type, and ENTRIES is already a week in one list — neither has
   * a second day to go to. Refusing the claim at the ends rather than rubber-banding is what keeps
   * a swipe past the last day from reading as a page that failed to arrive: nothing moves, because
   * nothing was going to.
   */
  const onToday = PAGE_ORDER[page] === 'today'
  const canGoBack = onToday && daysBack < CARE_HISTORY_DAYS
  const canGoForward = onToday && daysBack > 0

  /* Back to today whenever the pager leaves this page — see `daysBack`. */
  useEffect(() => {
    if (!onToday && daysBack !== 0) setDaysBack(0)
  }, [onToday, daysBack])

  useEffect(() => () => { if (settle.current) window.clearTimeout(settle.current) }, [])

  const onDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    // Swiping is suspended while a selection is being made: the pages would carry the selection
    // somewhere it cannot be acted on.
    if (selecting) return
    if (settle.current) window.clearTimeout(settle.current)
    startX.current = e.clientX
    startY.current = e.clientY
    startedAt.current = Date.now()
    axis.current = null
    setReleasing(false)
  }

  /**
   * Decide which axis the gesture belongs to — patiently.
   *
   * <b>An ambiguous sample is not a decision.</b> This used to abandon the whole gesture the first
   * time the vertical delta happened to exceed the horizontal one, and never look again. On the
   * ENTRIES page, where the finger starts on a scrolling list, nearly every swipe opens with a
   * little vertical drift — so that page felt as though it did not swipe at all, and everywhere
   * else the swipe felt like it had to be drawn with a ruler.
   *
   * Now neither axis wins until one of them is clearly ahead: horizontal claims once it passes
   * {@link CLAIM_PX} *and* leads the vertical by a margin, and the gesture is only given up when it
   * has plainly committed to a scroll ({@link GIVE_UP_PX} of vertical with no horizontal claim).
   * Everything in between is still undecided, and keeps being re-examined on the next sample.
   */
  const onMove = (e: React.PointerEvent) => {
    if (startX.current == null) return
    const moved = e.clientX - startX.current
    const drift = e.clientY - startY.current

    if (!dragging.current) {
      const across = Math.abs(moved)
      const down = Math.abs(drift)

      /*
       * Vertical, where vertical means something.
       *
       * Asked before the give-up below and not after, because `GIVE_UP_PX` is three times
       * `CLAIM_PX`: a day swipe would otherwise be handed back to the scroller a good 16px before
       * it was ever offered the chance to claim. The direction is already known from the sign of
       * the drift, so a swipe towards a day that is not there is simply never claimed — see
       * `canGoBack` / `canGoForward`. On every page but TODAY both are false and this is dead,
       * which leaves the horizontal decision below exactly as it was.
       */
      if (down >= CLAIM_PX && down > across * AXIS_LEAD && (drift < 0 ? canGoBack : canGoForward)) {
        dragging.current = true
        axis.current = 'y'
        e.currentTarget.setPointerCapture(e.pointerId)
        setDy(drift)
        return
      }

      // Plainly a scroll: hand it back and stop watching.
      if (down > GIVE_UP_PX && across < down * AXIS_LEAD) {
        startX.current = null
        return
      }
      // Not yet enough to call either way — wait for the next sample rather than guessing.
      if (across < CLAIM_PX || across < down * AXIS_LEAD) return

      dragging.current = true
      axis.current = 'x'
      e.currentTarget.setPointerCapture(e.pointerId)
    }

    if (axis.current === 'y') setDy(drift)
    else setDx(moved)
  }

  /**
   * Finish the movement the finger started, then swap.
   *
   * The page dragged away has to keep going, not come back: resetting the offset to zero and
   * swapping contents in the same commit animates the *same* element back to centre, so the gesture
   * reads as one panel snapping into place rather than as one page leaving and another arriving.
   */
  const onUp = () => {
    if (!dragging.current) {
      startX.current = null
      return
    }

    /*
     * A day, rather than a page.
     *
     * The same two ways of meaning it the pages use — a quick flick, or a slow drag taken far
     * enough — measured against the block's height instead of its width. Up goes back: the content
     * travels up the way a page of older entries would, and the day arriving comes in from below.
     */
    if (axis.current === 'y') {
      const flicked = Date.now() - startedAt.current < FLICK_MS && Math.abs(dy) > FLICK_PX
      const dragged = height > 0 && Math.abs(dy) > height * SETTLE_FRACTION
      const step = dy < 0 ? 1 : -1

      startX.current = null
      dragging.current = false
      setReleasing(true)

      if (height === 0 || (!flicked && !dragged)) {
        setDy(0)
        settle.current = window.setTimeout(() => setReleasing(false), SETTLE_MS)
        return
      }

      setDy(step > 0 ? -height : height)
      settle.current = window.setTimeout(() => {
        // Clamped again on the way in. The claim already refused a direction with nothing in it,
        // but the ends are the one place an off-by-one would show as a blank day rather than a
        // wrong number, and the guard costs nothing.
        setDaysBack((d) => Math.min(CARE_HISTORY_DAYS, Math.max(0, d + step)))
        setDy(0)
        setReleasing(false)
        axis.current = null
      }, SETTLE_MS)
      return
    }

    const flick = Date.now() - startedAt.current < FLICK_MS && Math.abs(dx) > FLICK_PX
    const far = width > 0 && Math.abs(dx) > width * SETTLE_FRACTION

    startX.current = null
    dragging.current = false
    setReleasing(true)

    if (width === 0 || (!flick && !far)) {
      setDx(0)
      settle.current = window.setTimeout(() => setReleasing(false), SETTLE_MS)
      return
    }

    const direction = dx < 0 ? -1 : 1
    setDx(direction * width)
    settle.current = window.setTimeout(() => {
      // One commit: the arriving page takes the track, the offset goes flat, and the transition is
      // gone before either lands — so the swap is a paint, not a second animation.
      setPage((p) => (direction < 0 ? p + 1 : p + PAGES - 1) % PAGES)
      setDx(0)
      setReleasing(false)
    }, SETTLE_MS)
  }

  /* With three pages the neighbour depends on which way the finger went — dragging left brings the
     next page in from the right, dragging right brings the previous one in from the left. */
  const incoming = (dx < 0 ? page + 1 : page + PAGES - 1) % PAGES
  const live = width > 0 && Math.abs(dx) > width / 2 ? incoming : page
  const easing = releasing ? ' ml-sincepager__track--releasing' : ''

  /* The day arriving from above or below, while a vertical swipe is in flight. */
  const incomingDay = Math.min(CARE_HISTORY_DAYS, Math.max(0, daysBack + (dy < 0 ? 1 : -1)))

  /*
   * A day's totals, counted from the same rows the pages are already holding.
   *
   * <b>Today is the figure that was handed in, not one worked out again here.</b> `useCareLog`
   * derives it from a clock that ticks, which is what rolls the window over at 6 AM with no
   * refetch; recomputing it on this side would quietly opt out of that for the sake of symmetry.
   * Every other day is settled history and can be counted from `entries` — the same week the LOG
   * page lists, so paging back needs no request and works with no server.
   */
  const totalsFor = (back: number) => {
    if (back === 0) return totals
    const { from, to } = careWindowFor(back)
    const start = from.getTime()
    const end = to.getTime()
    return windowTotals(entries.filter((e) => {
      const at = Date.parse(e.atUtc)
      return at >= start && at < end
    }))
  }

  const pageProps = { since, entries, loading, selection, onSelection, selecting }

  return (
    <>
      <div
        ref={frame}
        /* The block, not the list, carries the selecting state: its `min-height` is what actually
           holds the height, so shrinking only the list inside it moved nothing. */
        className={'ml-sincepager'
          + (selecting ? ' ml-sincepager--selecting' : '')
          /* Vertical belongs to the day swipe only where there are days — see the rule itself. */
          + (onToday ? ' ml-sincepager--days' : '')}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <div
          className={'ml-sincepager__track' + easing}
          style={dx || dy ? { transform: `translate(${dx}px, ${dy}px)` } : undefined}
        >
          <Page
            index={page}
            active={live}
            onPage={setPage}
            totals={totalsFor(daysBack)}
            dayLabel={careWindowLabel(daysBack)}
            {...pageProps}
          />
        </div>
        {/* The neighbour, drawn on the side it is coming from and carrying the same easing as the
            track — the two are one moving pair, and easing only half of it looks like a snap. */}
        {dx !== 0 && (
          <div
            className={'ml-sincepager__peeking' + easing}
            style={{ transform: `translateX(${dx > 0 ? -100 : 100}%) translateX(${dx}px)` }}
            aria-hidden="true"
          >
            <Page
              index={incoming}
              active={live}
              totals={totalsFor(daysBack)}
              dayLabel={careWindowLabel(daysBack)}
              {...pageProps}
            />
          </div>
        )}
        {/* The day arriving, above or below — the same pair-travels-as-a-unit trick, turned 90°. */}
        {dy !== 0 && (
          <div
            className={'ml-sincepager__peeking' + easing}
            style={{ transform: `translateY(${dy > 0 ? -100 : 100}%) translateY(${dy}px)` }}
            aria-hidden="true"
          >
            <Page
              index={page}
              active={live}
              totals={totalsFor(incomingDay)}
              dayLabel={careWindowLabel(incomingDay)}
              {...pageProps}
            />
          </div>
        )}
      </div>

      {/*
        The actions, directly below the block.

        Deliberately not a modal and not a menu: the entries being corrected are minutes old and the
        list is right there, so the handoff puts the two verbs under the list and lets DELETE act
        immediately. Nothing below this row moves when it appears — the block gives up exactly this
        row's height plus its gap (see `--care-give` on `.ml-sincepager`).
      */}
      {selecting && (
        <div className="ml-careactions">
          <button
            type="button"
            className="ml-careactions__btn"
            // There is no multi-entry edit. It comes back the moment the selection drops to one
            // rather than disappearing, so the row never changes shape mid-choice.
            disabled={selection.size > 1}
            onClick={() => {
              const only = entries.find((e) => selection.has(e.id))
              if (only) onEdit(only)
            }}
          >
            Edit
          </button>
          <button
            type="button"
            className="ml-careactions__btn ml-careactions__btn--danger"
            onClick={() => onDelete([...selection])}
          >
            Delete
          </button>
        </div>
      )}
    </>
  )
}

interface PageProps {
  since: SinceRow[]
  totals: WindowTotal[]
  entries: CareEntryDto[]
  loading: boolean
  selection: Set<number>
  onSelection: (next: Set<number>) => void
  selecting: boolean
  /** What the day being counted is called — `Today`, `Yesterday`, or its own date. */
  dayLabel: string
}

function Page({
  index, active, onPage, ...rest
}: PageProps & { index: number; active: number; onPage?: (p: number) => void }) {
  const name = PAGE_ORDER[index]
  /* Selection only ever happens on the entries list, so only its head becomes a selection head. */
  const selectingHere = rest.selecting && name === 'entries'
  /*
   * TODAY says which day it means.
   *
   * It is the one page whose subject moves, so it is the one page that cannot be titled by a
   * constant. `Today` on day zero is the same word `PAGE_LABELS` held, so nothing reads differently
   * until somebody swipes — and the two after it, YESTERDAY and the date itself, are the same words
   * the LOG page puts on its day headings rather than a second way of naming a day.
   */
  const label = selectingHere
    ? (rest.selection.size === 1 ? 'One selected' : `${countWord(rest.selection.size)} selected`)
    : name === 'today' ? rest.dayLabel : PAGE_LABELS[name]

  return (
    <>
      <div className="ml-sincepager__head">
        <span className={'ml-sincepager__label' + (selectingHere ? ' ml-sincepager__label--on' : '')}>
          {label}
        </span>
        {/* The window is named on the page it governs, because these totals are the one thing on
            the screen that is not a calendar day. */}
        {name === 'today' && <span className="ml-sincepager__window">6 AM → 6 AM</span>}
        {name === 'entries' && !rest.selecting && <span className="ml-sincepager__window">Newest first</span>}

        {selectingHere ? (
          <button
            type="button"
            className="ml-sincepager__cancel"
            onClick={() => rest.onSelection(new Set())}
          >
            Cancel
          </button>
        ) : (
          <Pips active={active} onPage={onPage} />
        )}
      </div>

      {name === 'since' && <SincePage since={rest.since} loading={rest.loading} />}
      {name === 'today' && <TotalsPage totals={rest.totals} />}
      {name === 'entries' && (
        <EntriesPage
          entries={rest.entries}
          selection={rest.selection}
          onSelection={rest.onSelection}
          selecting={rest.selecting}
        />
      )}
    </>
  )
}

/** Three 6px squares. They track the live position rather than only the settled page. */
function Pips({ active, onPage }: { active: number; onPage?: (p: number) => void }) {
  return (
    <span className="ml-sincepager__pips">
      {PAGE_ORDER.map((name, i) => (
        <button
          key={name}
          type="button"
          className={'ml-sincepager__pip' + (i === active ? ' ml-sincepager__pip--on' : '')}
          onClick={() => onPage?.(i)}
          aria-label={PIP_LABELS[name]}
          aria-current={i === active}
          tabIndex={onPage ? 0 : -1}
        />
      ))}
    </span>
  )
}

/** One SINCE row: a type, and the last entry of it if there has ever been one. */
export interface SinceRow {
  key: string
  type: CareEntryTypeName
  /** What the row calls itself — `Diaper · pee`, which is not simply the type's name. */
  label: string
  entry: CareEntryDto | null
  spec: SinceRowSpec
}

function SincePage({ since, loading }: { since: SinceRow[]; loading: boolean }) {
  if (since.length === 0 && !loading) {
    return (
      /* Points at the tiles, not at the import. The pull that used to sit in this screen's footer
         is in Config → Baby settings, and sending somebody two tabs away to fill an empty log is
         the wrong first instruction — the tile below writes an entry in one tap. */
      <p className="ml-carelog__empty">
        Nothing logged yet. Start with a tile below.
      </p>
    )
  }

  return (
    /* Six rows in a six-row window, so it no longer scrolls — Pump sorts last on a day it has not
       been logged, and it was the row that fell off the bottom. Still the same fixed container the
       entries list uses: the block's height is what keeps the LOG grid still. */
    <div className="ml-carelist">
      {since.map(({ key, type, label, entry, spec }) => {
        const ago = entry ? elapsedParts(entry.atUtc) : null
        return (
          /* A row with nothing logged keeps its place and recedes, the same treatment an empty
             total gets — an absence somebody can see is worth more than a row that vanished. */
          <div key={key} className={'ml-since' + (entry ? '' : ' ml-since--none')}>
            <RowGlyph type={type} />
            <span className="ml-since__body">
              {/* Rows say the full name — `Breast feeding`. Only the tile abbreviates it, because
                  a tile is twelve characters of letterspaced caps in a 2-up grid. */}
              <span className="ml-since__name">{label}</span>
              {/* What it was. The when has its own column now — see `.ml-since__time`. */}
              <span className="ml-since__detail">
                {entry ? sinceDetail(spec, entry) : 'Never logged'}
              </span>
            </span>
            {/* `4:14 AM` today, `Aug 26` before that — `whenLabel` makes that switch, because a
                clock reading on something three days old looks precise and answers nothing. A row
                with nothing logged renders no column at all. */}
            {entry && <span className="ml-since__time">{whenLabel(entry.atUtc)}</span>}
            {/* Measured in days the row recedes — past a day the question has stopped being
                "how long" and become "has it happened at all". */}
            <span className={'ml-since__ago serif' + (ago?.stale ? ' ml-since__ago--stale' : '')}>
              {ago
                ? ago.parts.map((p) => (
                  <span key={p.unit}>
                    {p.value}<span className="ml-since__unit">{p.unit}</span>
                  </span>
                ))
                : '—'}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function TotalsPage({ totals }: { totals: WindowTotal[] }) {
  return (
    <>
      {totals.map((row) => (
        <div key={row.type} className={'ml-since' + (row.dim ? ' ml-since--none' : '')}>
          <RowGlyph type={row.type} />
          <span className="ml-since__body">
            <span className="ml-since__name">{careTitle(row.type)}</span>
            <span className="ml-since__detail">{row.detail}</span>
          </span>
          {row.time && <span className="ml-since__time">{row.time}</span>}
          <span className="ml-since__ago serif">
            {/*
              A ring or a rule where a numeral would overstate what is known — see `WindowTotal.mark`.
              Both are drawn rather than written: there is no character that means "nothing was
              recorded" as distinct from zero, and `0` is the wrong claim.
            */}
            {row.mark === 'ring' && <span className="ml-since__ring" aria-label="Nothing recorded" role="img" />}
            {row.mark === 'rule' && <span className="ml-since__rule" aria-label="Never measured" role="img" />}
            {!row.mark && (
              <>
                {row.value}
                {row.unit && <span className="ml-since__unit">{row.unit}</span>}
              </>
            )}
          </span>
        </div>
      ))}
    </>
  )
}

/**
 * The week as it was logged, in day blocks — and the only place an entry can be corrected or removed.
 *
 * <b>A plain tap does nothing.</b> Rows are targets rather than buttons, because the alternative on
 * a wall panel beside a cot is that a knuckle opens something. The way in is a 500ms press, which is
 * long enough that it cannot be arrived at by accident and short enough to be discovered by anyone
 * who has ever held a row on a phone.
 *
 * <b>The list is broken by day, and each heading sticks while its own rows pass under it.</b> The
 * list is not today's — it reaches back a week, deliberately, so that a correction to last night's
 * feed can be made and so a morning before the first entry is not a blank page. But every row read
 * the same, so eleven rows scrolled past with nothing saying where one day ended and the next began;
 * the only clue was a date buried in each row's own detail line, which is the hardest possible place
 * to see a boundary. The heading takes that date off the rows and puts it where the eye already is.
 */
function EntriesPage({
  entries, selection, onSelection, selecting,
}: {
  entries: CareEntryDto[]
  selection: Set<number>
  onSelection: (next: Set<number>) => void
  selecting: boolean
}) {
  const press = useRef<number | null>(null)
  const moved = useRef(false)
  const from = useRef({ x: 0, y: 0 })
  /** This gesture already did its work — the release must not act a second time. */
  const acted = useRef(false)

  useEffect(() => () => { if (press.current) window.clearTimeout(press.current) }, [])

  const cancelPress = () => {
    if (press.current) window.clearTimeout(press.current)
    press.current = null
  }

  const toggle = (id: number) => {
    const next = new Set(selection)
    // Deselecting the last row leaves selection mode, which is the same exit as CANCEL — one fewer
    // thing to explain, and it means a mis-press costs one tap to undo.
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onSelection(next)
  }

  if (entries.length === 0) {
    return <p className="ml-carelog__empty">Nothing logged in the last week.</p>
  }

  /*
   * The day each row belongs to, decided once for the whole list.
   *
   * Computed off a single `now` rather than per row: two rows either side of the render taking
   * their own clock reading is how a list gets two `TODAY` headings a millisecond apart at
   * midnight. The tally is counted from the rows actually here, so a heading can never claim more
   * than is under it.
   */
  const now = Date.now()
  const days = entries.map((entry) => dayLabel(entry.atUtc, now))
  const perDay = new Map<string, number>()
  for (const day of days) perDay.set(day, (perDay.get(day) ?? 0) + 1)

  return (
    /* Fixed height, scrolling inside: it is the height of six SINCE rows, which is what keeps the
       LOG grid from moving when the pages swap. The last row clipping is the scroll affordance —
       and unlike its neighbours this page genuinely has more than fits, so it earns one. */
    <div className="ml-carelist">
      {entries.map((entry, i) => {
        const selected = selection.has(entry.id)
        /* First row of its day carries the heading. Newest first, so the run is contiguous. */
        const day = days[i]
        const heading = i === 0 || days[i - 1] !== day ? day : null
        /*
         * What it was, not where it came from, and not what has happened to it since.
         *
         * `imported` used to ride along on every pulled row, which on a household mid-migration is
         * most of them — a badge that says "normal" on nearly everything is noise, and it described
         * the panel's own plumbing rather than anything about the feed. `edited` went the same way:
         * a correction is the row doing its job, and flagging it only invited a second look at a
         * figure that is already the right one.
         */
        const detail = [kindLabel(entry.kind), sizeLabel(entry), entry.side]
          .filter(Boolean).join(' · ')

        const figure = valueParts(entry)
        return (
          /*
           * A fragment, not a wrapper.
           *
           * The heading is `position: sticky`, and sticky is bounded by its own parent — wrapping
           * each heading with its first row in a div would let it stick for exactly one row's worth
           * of scrolling and then leave. As siblings of the rows they head, each one holds the top
           * of the list until the next day's heading pushes it off, which is what makes the blocks
           * legible mid-scroll rather than only at rest.
           */
          <Fragment key={entry.id}>
            {heading && (
              <div className="ml-careday">
                <span>{heading}</span>
                {/* What is under it, so a short day is visibly short rather than looking clipped
                    by the scroll. */}
                <span className="ml-careday__count">{entriesLabel(perDay.get(heading) ?? 0)}</span>
              </div>
            )}
            {/*
             * The same row as SINCE and TODAY, deliberately.
             *
             * It used to have a fixed 74px time column and a smaller value, which put the name and the
             * figure on different edges from the two pages beside it — so a swipe moved every piece of
             * text on the block rather than only its contents. The time moved into the detail line,
             * where TODAY already carries `LAST 8:25 PM`.
             */}
            <div
              className={'ml-since ml-since--tap' + (selected ? ' ml-since--on' : '')
                + (entry.pending ? ' ml-since--unsent' : '')}
              onPointerDown={(e) => {
                moved.current = false
                acted.current = false
                from.current = { x: e.clientX, y: e.clientY }
                press.current = window.setTimeout(() => {
                  if (moved.current) return
                  // Claim the gesture. The release that follows is the *end* of this press, not a
                  // fresh tap on a row that is now selected — without this the press selects and the
                  // lift immediately deselects, and a selection can never be made at all.
                  acted.current = true
                  toggle(entry.id)
                }, LONG_PRESS_MS)
              }}
              /*
               * Only travel past a threshold counts as movement.
               *
               * This used to set `moved` on any pointermove at all — and a finger held still on glass
               * emits a steady trickle of sub-pixel jitter, so the press was cancelled within a few
               * milliseconds and the long press never once fired. A press is allowed to wobble.
               */
              onPointerMove={(e) => {
                if (moved.current) return
                if (Math.abs(e.clientX - from.current.x) > PRESS_SLOP
                  || Math.abs(e.clientY - from.current.y) > PRESS_SLOP) {
                  moved.current = true
                  cancelPress()
                }
              }}
              onPointerUp={() => {
                cancelPress()
                if (acted.current) return
                // Once a selection exists a plain tap adds and removes — the long press is the way in,
                // not the way to every subsequent row.
                if (selecting && !moved.current) toggle(entry.id)
              }}
              onPointerCancel={cancelPress}
              onContextMenu={(e) => e.preventDefault()}
              role={selecting ? 'checkbox' : undefined}
              aria-checked={selecting ? selected : undefined}
            >
              <RowGlyph type={entry.type} />
              <span className="ml-since__body">
                <span className="ml-since__name">
                  {careTitle(entry.type)}
                  {/*
                    Saved, not yet sent — and said in those words rather than shown as a fault.

                    The entry is written down and safe; what is missing is the server's copy of it,
                    which is a fact about the house's wiring and not about the feed. A warning colour
                    or the word "failed" here would have somebody at 3am logging it a second time to
                    be sure, which is the one outcome this whole path exists to prevent. It clears
                    itself the moment the queue drains.
                  */}
                  {entry.pending && <span className="ml-since__unsent">Not sent yet</span>}
                </span>
                {/* What it was — the contents or the side. The when is its own column now. */}
                <span className="ml-since__detail">{detail}</span>
              </span>
              {/* The clock alone: the day is the heading above the block this row sits in, and
                  repeating it on every row is what made those boundaries invisible before. */}
              <span className="ml-since__time">{clockLabel(new Date(entry.atUtc))}</span>
              <span className="ml-since__ago serif">
                {figure.value}
                {figure.unit && <span className="ml-since__unit">{figure.unit}</span>}
              </span>
            </div>
          </Fragment>
        )
      })}
    </div>
  )
}

/**
 * The type's own mark, at the head of its row.
 *
 * The same glyph the tile below carries, so a bottle is a bottle wherever it appears — the row and
 * the tile that logs it are the same subject, and naming it twice in words while drawing it once is
 * how two vocabularies start. Decorative: the name is right beside it, so nothing here is the only
 * carrier of meaning.
 */
function RowGlyph({ type }: { type: CareEntryTypeName }) {
  return (
    <span className="ml-since__glyph" aria-hidden="true">
      <Icon id={CARE_ICONS[type]} size="1.125rem" />
    </span>
  )
}

/*
 * `TWO SELECTED` counts in words, as the notification drawer's headers do — see `countWord` in
 * `app/care.ts`. It used to keep its own copy of the word list, a second one lived in `MikaView`,
 * and the day headings below needed a third; there is one now.
 */
