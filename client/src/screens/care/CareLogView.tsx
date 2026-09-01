import { useMemo, useState } from 'react'
import {
  CARE_ICONS, CARE_LABELS, CARE_MEDICINES, CARE_TILES, SINCE_ROWS, TIMED_TYPES, careTitle, matchesSince,
  tileCaption,
  windowTotals,
} from '../../app/care'
import { mmss, useRunningSeconds } from './runningClock'
import { useTap } from '../../app/useTap'
import { Icon } from '../../icons/Icon'
import { SincePager } from './SincePager'
import { useCareLog } from './useCareLog'
import { CareSheet } from './CareSheet'
import { CareRunning } from './CareRunning'
import { CarePumpFinish } from './CarePumpFinish'
import type { KnownMedicine } from './CareSheet'
import type { CareEntryDto, CareEntryTypeName, CareTimerDto } from '../../api/types'

/**
 * The Care tab's logging surface — ten types, a real time, and entries that can be corrected.
 *
 * <b>What changed, and why it is a different screen rather than a bigger one.</b> The old surface
 * could repeat the last entry of four kinds and nothing else: no amount, no side, no when. That was
 * not a design limitation, it was the Huckleberry integration's — it exposes seventeen Home
 * Assistant services and no more, none of which takes a timestamp, and six of the ten things a
 * household logs have no service at all. HomeHub keeps its own log now, so all ten are loggable,
 * a 2am feed can be entered at 6am, and a mistyped amount is a row rather than a permanent record.
 *
 * <b>Nothing here needs a server.</b> The grid, the sheets and the timers all work offline, and the
 * one thing that could not — the pull out of the old integration's calendar — was removed with that
 * integration on 2026-08-30. It was the only control on this screen with a connection to be gated
 * on, and the only place in Care that ever named the integration.
 */
export function CareLogView({ childKey, childName }: { childKey: string; childName?: string }) {
  const care = useCareLog(childKey)
  const [sheet, setSheet] = useState<CareEntryTypeName | null>(null)
  /** An existing entry open for correction, rather than a new one of its type. */
  const [editing, setEditing] = useState<CareEntryDto | null>(null)
  const [selection, setSelection] = useState<Set<number>>(new Set())

  const selecting = selection.size > 0
  /* Tiles open on the pointer, not the click — see `useTap`. */
  const tapProps = useTap()

  /*
   * SINCE reports a fixed set of types, not the five most recent things logged.
   *
   * <b>It used to take whatever the last five were.</b> That reads fine on a busy day and quietly
   * drops a whole type on a quiet one — pump fell off the list the moment five other kinds had been
   * logged since the last session, which is exactly when "how long since" is the question worth
   * asking about it. The five here are the five the design draws, and they are the ones with a
   * rhythm somebody tracks.
   *
   * Ordered by recency, so the most recent leads; a type with nothing logged sorts last and says so
   * rather than being hidden. TODAY takes the same approach for the same reason.
   */
  const since = SINCE_ROWS
    .map((spec) => {
      /*
       * The summary's last-of-each is keyed by type, so it cannot answer "the last *wet* one".
       * The split rows search the fetched entries instead, and still consider the summary's own
       * entry — it reaches further back than the week this screen holds, and on a quiet stretch it
       * is the only thing that knows.
       */
      const summary = care.lastByType.get(spec.type) ?? null
      const candidates = spec.side
        ? [...care.recent, ...(summary ? [summary] : [])].filter((e) => matchesSince(spec, e))
        : summary ? [summary] : []
      const entry = candidates
        .sort((a, b) => Date.parse(b.atUtc) - Date.parse(a.atUtc))[0] ?? null
      return { key: spec.key, type: spec.type, label: spec.label, entry, spec }
    })
    .sort((a, b) => {
      if (!a.entry) return 1
      if (!b.entry) return -1
      return Date.parse(b.entry.atUtc) - Date.parse(a.entry.atUtc)
    })

  const openType = editing?.type ?? sheet
  // An edit is of something finished, so it never opens the running panel even mid-session.
  const session = openType && !editing ? care.running(openType) : null
  /*
   * Which of a type's three panels this tap opens.
   *
   * <b>A held pump session takes precedence over starting a new one.</b> The session is measured
   * and unwritten; offering the idle panel would mean two sessions where there is one, and the
   * measurement would be sitting somewhere the household cannot see. So PUMP returns to the finish
   * step for as long as one is held — which is the handoff's rule in as many words, and the reason
   * the hold is a row rather than something this screen remembers.
   */
  const openHeld = session?.endedUtc ? session : null
  const openRunning = session && !openHeld ? session : null

  /*
   * Starting a session hands the open panel over to the running one — it does not close it.
   *
   * Closing was wrong twice over. The thing somebody wants the instant they press START is the
   * clock, and dropping them back to the day view to find it makes them go looking for what they
   * just asked for. And on a pump, START is the *middle* of the interaction: the phases were set on
   * the panel a second ago and the countdown they govern is the next thing to watch.
   *
   * The flag suppresses the rise animation across the swap. The two panels are different components
   * so React remounts, and without this the sheet would visibly drop away and a new panel climb
   * back up — which reads as the close this change exists to remove.
   */
  const [handedOver, setHandedOver] = useState(false)
  const close = () => { setSheet(null); setEditing(null); setHandedOver(false) }
  const handOver = () => setHandedOver(true)

  /*
   * The medicine panel's WHAT list: what has been given, newest first, then the household's own.
   *
   * The log leads, so the most recently given is the card the panel opens on and the dose carried
   * over is the one actually used last time. The standing medicines are appended if the log has
   * not seen them yet — otherwise the list is empty until the first dose, which is precisely when
   * nobody wants to be typing a name.
   */
  const medicines = useMemo(() => {
    const seen = new Map<string, KnownMedicine>()
    for (const e of care.recent) {
      if (e.type !== 'Medicine' || !e.kind || seen.has(e.kind)) continue
      seen.set(e.kind, { name: e.kind, amount: e.amount, unit: e.unit })
    }
    for (const med of CARE_MEDICINES) {
      if (!seen.has(med.name)) seen.set(med.name, med)
    }
    return [...seen.values()]
  }, [care.recent])

  return (
    <>
      {care.error && <div className="ml-care__error" role="status">{care.error}</div>}

      <SincePager
        since={since}
        totals={windowTotals(care.inWindow)}
        entries={care.recent}
        loading={care.loading}
        selection={selection}
        onSelection={setSelection}
        onEdit={(entry) => { setEditing(entry); setSelection(new Set()) }}
        onDelete={(ids) => {
          setSelection(new Set())
          ids.forEach((id) => void care.remove(id))
        }}
      />

      {/*
        No LOG label above the grid.

        The design draws one; ten labelled tiles under a pager whose own label is right above them
        did not need a third heading to say what they are, and the row it occupied is height this
        screen does not have. The grid is still announced to assistive tech by its buttons.

        Logging a new event is wrong mid-selection, so the grid goes dim and inert rather than
        staying live behind a choice being made above it.
      */}
      <div className={'ml-caregrid' + (selecting ? ' ml-caregrid--inert' : '')}>
        {CARE_TILES.map((type) => {
          const running = care.running(type)
          return (
            <button
              key={type}
              type="button"
              className={'ml-caretile' + (running ? ' ml-caretile--running' : '')}
              /*
               * Opened on the pointer, not on the click.
               *
               * The first tap on a tile did nothing and the second opened it. A click is a
               * *derived* event: the browser withholds it if anything about the gesture looks like
               * something else — a scroll settling, a tap that ends a momentum, a few pixels of
               * travel — and on a wall panel reached for one-handed that happens constantly. The
               * pointer sequence is the ground truth, so the tile listens to that and applies its
               * own slop test.
               *
               * `onClick` is kept for keyboard activation only, which arrives with `detail === 0`
               * and no pointer sequence at all — without the guard, a mouse would open the panel
               * twice.
               */
              {...tapProps(() => setSheet(type))}
              onClick={(e) => { if (e.detail === 0) setSheet(type) }}
              disabled={care.writing || selecting}
            >
              <span className="ml-caretile__glyph" aria-hidden="true">
                <Icon id={CARE_ICONS[type]} size="1.5rem" />
              </span>
              <span className="ml-caretile__text">
                <span className="ml-caretile__name">{CARE_LABELS[type]}</span>
                {/* The caption *is* the value the panel will open on, so the default is visible
                    before the tap. */}
                <span className="ml-caretile__caption">
                  {running
                    ? `Running · ${Math.floor(running.elapsedMinutes)}m`
                    : tileCaption(type, care.lastByType.get(type))}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      {/*
        The live strip — a way back in, not a control panel.

        It carries no COMPLETE or CANCEL of its own. Those are the two acts the design is emphatic
        must never be casual: they sit inside the session's own panel, labelled, with a sentence
        each and a warning that they are not the same. A one-tap CANCEL on a row you brush past on
        the way to another tab is exactly the mis-tap that costs a household a feed.

        What it does do is stay visible while the rest of the app is used, and open the real panel
        when tapped.
      */}
      {care.timers.map((t) => (
        <CareRunStrip key={t.type} timer={t} onOpen={() => setSheet(t.type)} />
      ))}

      {/*
        The pump's two boundaries are announced from `App`, not here.

        <b>This mount was the bug.</b> It survived the running *panel* being closed, which was the
        case it was written for — but not the Baby *tab* being left, which unmounted it outright. So
        the switch passed in silence for anyone who had walked away, and on a panel that idles on
        the Dashboard that was most of the time. A haptic is for exactly the moment nobody is
        looking at the screen, so the one place it must not live is inside a screen.

        The note here used to say lifting it would mean putting the care log in a provider and was
        "a bigger change than this is worth". `BabyProvider` polls the log for the Dashboard's
        figures now, so it carries the running session too and `App` mounts the alert once.
      */}

      {/*
        Today's entries are not on this screen.

        They were disclosed in place under this footer while view 10 was unbuilt, and that list was
        the tallest thing below the fold — the day view could not be reached in one screen with it
        there. It is a panel of its own in the design, at the same height as the logging ones, and
        it belongs there: the day view answers "how long since" and "log this", and a scrolling
        transcript of the day answers neither.

        The `TODAY'S LOG ▸` link the design puts in this footer comes back with that panel. It is
        deliberately absent rather than dead — a link that opens nothing is worse than no link.
      */}

      {/* A session in progress opens its own panel — how long, and the two ways out — rather than
          the panel that asks how much and when. */}
      {openType && openRunning && (
        <CareRunning
          timer={openRunning}
          rise={!handedOver}
          saving={care.writing}
          onPause={() => void care.timer(openType, 'pause')}
          onResume={() => void care.timer(openType, 'resume')}
          onSwitchSide={(side) => void care.switchSide(openType, side)}
          onSwitchPhase={() => void care.pumpPhase()}
          /*
            Two stops that are not the same act, and on a pump neither of them writes here.
            FINISH measures the session and holds it, then hands this panel over to the finish
            one — where the amount is asked for and SAVE writes both together. Every other type
            is fully known when it stops, so COMPLETE writes it and closes.
          */
          onComplete={() => {
            if (openType === 'Pump') { handOver(); void care.finish(openType); return }
            void care.complete(openType)
            close()
          }}
          onDiscard={() => { void care.timer(openType, 'cancel'); close() }}
          onClose={close}
        />
      )}

      {/* The measured session, waiting for the one figure it is missing. See `CarePumpFinish`. */}
      {openType && openHeld && (
        <CarePumpFinish
          timer={openHeld}
          rise={!handedOver}
          saving={care.writing}
          // One write, at SAVE, with whatever amount is in hand — never a session written and
          // its amount added afterwards.
          onSave={(amount, atUtc) => { void care.complete(openType, amount, 'oz', atUtc); close() }}
          onDiscard={() => { void care.timer(openType, 'cancel'); close() }}
          onClose={close}
        />
      )}

      {openType && !openRunning && !openHeld && (
        <CareSheet
          type={openType}
          last={care.lastByType.get(openType)}
          editing={editing}
          medicines={medicines}
          saving={care.writing}
          onStart={(opts) => { handOver(); void care.timer(openType, 'start', opts) }}
          childName={childName}
          onCancel={close}
          onSave={(input) => {
            // Correcting an entry updates it in place. Only a *new* entry can start a timer —
            // an edit is of something that already finished.
            if (editing) {
              void care.update(editing.id, input)
            } else if (TIMED_TYPES.includes(openType) && input.durationMinutes == null) {
              // A timed type with no duration typed is a session to start, not an entry to write —
              // which is what the design's two routes off the nursing screen mean. Starting hands
              // the panel over to the clock rather than closing it, the same as the START tiles.
              handOver()
              void care.timer(openType, 'start', { side: input.side ?? undefined })
              return
            } else {
              void care.add(input)
            }
            close()
          }}
        />
      )}
    </>
  )
}

/** One running session, glanceable and tappable, on the day view. */
function CareRunStrip({ timer, onOpen }: { timer: CareTimerDto; onOpen: () => void }) {
  const elapsed = useRunningSeconds(timer)
  /*
   * A held session is not a running one, and the strip must not pretend otherwise.
   *
   * <b>Live green belongs to running timers only.</b> A finished pump is a measurement sitting
   * unwritten, and the one thing the day view owes the household is that it is still there and
   * still wants something — so the row says what it is waiting for, in brass rather than green,
   * and the clock beside it is a length rather than a count.
   */
  const held = timer.endedUtc != null
  return (
    <button
      type="button"
      className={'ml-carerun' + (held ? ' ml-carerun--held' : '')}
      onClick={onOpen}
    >
      <span className="ml-carerun__label">
        {careTitle(timer.type)} · {held ? 'awaiting amount' : timer.paused ? 'paused' : 'running'}
        {timer.side ? ` · ${timer.side}` : ''}
      </span>
      {/* Seconds, and the same interpolated figure the panel shows — a glance at one followed by a
          glance at the other must not show two different sessions. */}
      <span className="ml-carerun__clock serif">{mmss(elapsed)}</span>
      <span className="ml-carerun__chev" aria-hidden="true">▸</span>
    </button>
  )
}

/*
 * The SINCE label's old right-hand note — `8 feeds · 23.5 oz today` — is gone deliberately.
 *
 * The updated handoff gives that row to the pager pips instead, and moves the totals onto a page of
 * their own with a 6 AM window behind them. The old note was a calendar-day figure sitting on the
 * same line as the pager for a window that is not a calendar day, which is the one place the two
 * could have been mistaken for each other. See `windowTotals` in `app/care.ts`.
 */
